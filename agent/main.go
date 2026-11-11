/*
狐岚云守护进程入口：连接数据库，加载供应商插件，并启动有并发上限的任务消费者。
开发调用：cd agent && DATABASE_URL=postgres://... go run . --plugins "$PWD/plugins"
构建调用：go build -o /opt/yunzou/agent .；默认加载 /opt/yunzou/plugins，可用 --plugins 指定绝对路径。
资金入账由 NestJS 主业务完成；本进程只执行已入队的资源操作。
*/
package main

import (
	"context"       // 操作系统退出信号会取消所有消费者
	"errors"        // 区分空队列、人工等待和过期结果
	"flag"          // 显式设置插件目录、并发和任务租约
	"fmt"           // 参数错误带上可理解的原因
	"log/slog"      // 结构日志只写任务标识，不输出密钥载荷
	"net"           // 显式开启回调监听，不在默认启动时暴露端口
	"net/http"      // 资源回调使用标准HTTP服务
	"net/url"       // 对外回调地址由运维明确配置
	"os"            // 读取受控的数据库配置和程序位置
	"os/signal"     // 捕获正常停止信号
	"path/filepath" // 默认插件路径跟随程序而非启动目录
	"strings"       // 规范化显式配置的回调来源
	"sync"          // 退出前等待所有执行中任务结束
	"syscall"       // 兼容容器的 SIGTERM
	"time"          // 轮询、租约和停止后的有限写回时间

	"github.com/fuxoria-cloud/fuxoria/agent/features" // 队列和插件主体在各自文件里
	"github.com/jackc/pgx/v5/pgxpool"                 // 连接数量随消费者上限确定
)

func main() {
	if err := run(); err != nil { // 只有入口统一报告无法继续的故障
		slog.Error("守护进程停止", "error", err.Error()) // 数据库连接字符串不会主动写日志
		os.Exit(1)                                 // 容器或服务管理器可据此重启
	}
}

// --- 启动消费者，直到收到停止信号 ---
func run() error {
	binary, err := os.Executable() // 默认配置随安装位置固定
	if err != nil {
		return err
	} // 找不到程序位置时不猜插件目录
	directory := flag.String("plugins", filepath.Join(filepath.Dir(binary), "plugins"), "插件清单目录")                      // 允许明确配置另一处安装位置
	workers := flag.Int("concurrency", 4, "同时执行的任务数，范围 1 至 32")                                                        // 防止积压时无限启动子进程
	lease := flag.Duration("lease", 2*time.Minute, "任务租约，必须长于所有插件超时")                                                  // 超时后其他进程才可领取
	poll := flag.Duration("poll", 500*time.Millisecond, "空队列轮询间隔")                                                     // 不依赖 Redis 唤醒也能恢复积压任务
	callbackListen := flag.String("callback-listen", "127.0.0.1:3310", "资源回调地址；只有显式提供此参数才开启监听")                        // 默认值不代表默认对外监听
	callbackOrigin := flag.String("callback-origin", os.Getenv("PROVISION_CALLBACK_ORIGIN"), "供应商使用的公开HTTPS回调来源，不含路径") // 不猜测供应商能够访问的地址
	callbackWait := flag.Duration("callback-wait", 30*time.Minute, "等待异步资源回调的最长时间，1分钟至24小时")                           // 超时只转人工核对
	schedule := flag.Bool("schedule", false, "显式启用每60秒到期暂停调度，不自动销毁服务")                                                 // 默认只消费已授权任务
	flag.Parse()                                                                                                       // 外部参数只在进程入口读取
	callbacksEnabled := false                                                                                          // 无显式参数就完全不打开HTTP监听
	flag.Visit(func(value *flag.Flag) {
		if value.Name == "callback-listen" {
			callbacksEnabled = true
		}
	}) // 标准flag记录是否由用户主动配置
	if *workers < 1 || *workers > 32 || *lease < 30*time.Second || *poll < 100*time.Millisecond {
		return fmt.Errorf("并发需为 1 至 32，租约至少 30s，轮询至少 100ms")
	} // 配置错误启动即报出
	if os.Getenv("DATABASE_URL") == "" {
		return fmt.Errorf("请配置 DATABASE_URL")
	} // 没有数据库时不启动空壳消费者
	if len(os.Getenv("AUDIT_KEY")) < 32 {
		return fmt.Errorf("AUDIT_KEY 至少需要32字符，且必须与主业务相同")
	} // 审计密钥不足时不能消费任务
	keys, err := features.CallbackKeys(os.Getenv("PROVISION_CALLBACK_KEYS_JSON")) // 每个供应商独立32字节密钥
	if err != nil {
		return err
	} // 不在日志输出原配置
	if callbacksEnabled && len(keys) == 0 {
		return fmt.Errorf("显式开启资源回调监听前，请配置PROVISION_CALLBACK_KEYS_JSON")
	} // 没密钥绝不开放匿名回调
	if *callbackWait < time.Minute || *callbackWait > 24*time.Hour {
		return fmt.Errorf("资源回调等待窗口必须为1分钟至24小时")
	} // 不无限等待外部结果
	origin := strings.TrimSuffix(*callbackOrigin, "/") // 规范化仅允许来源部分
	if origin != "" {
		parsed, err := url.Parse(origin)
		if err != nil {
			return fmt.Errorf("资源回调来源无效")
		} // 不回显可能含凭据的原地址
		local := parsed.Hostname() == "localhost"
		if ip := net.ParseIP(parsed.Hostname()); ip != nil {
			local = ip.IsLoopback()
		} // HTTP只用于本机开发
		if parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Path != "" || (parsed.Scheme != "https" && !(parsed.Scheme == "http" && local)) {
			return fmt.Errorf("资源回调来源须为不带路径与凭据的HTTPS地址，本机可用HTTP")
		} // 外部供应商凭据不走明文网络
	}
	plugins, err := features.LoadPlugins(*directory, *lease) // 增删供应商只改清单目录
	if err != nil {
		return err
	} // 坏插件定义必须在处理任务前发现
	for name, plugin := range plugins {
		if plugin.Callback && (!callbacksEnabled || len(keys[name]) != 32 || origin == "") {
			return fmt.Errorf("异步插件%s需要显式回调监听、该供应商密钥和callback-origin", name)
		}
	} // 不发出无法验证完成结果的异步请求
	configuration, err := pgxpool.ParseConfig(os.Getenv("DATABASE_URL")) // 驱动检查连接配置
	if err != nil {
		return fmt.Errorf("DATABASE_URL 格式无效")
	} // 防止驱动错误意外带出原密钥
	configuration.MaxConns = int32(*workers + 6)                                           // 回调、心跳和调度共享有界连接池
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM) // 容器停止会终止子进程
	defer stop()                                                                           // 离开入口时释放信号监听
	pool, err := pgxpool.NewWithConfig(ctx, configuration)                                 // 池按需建立连接
	if err != nil {
		return fmt.Errorf("数据库连接池创建失败")
	} // 不记录完整连接配置
	defer pool.Close() // 所有消费者退出后再关闭连接
	if err = pool.Ping(ctx); err != nil {
		return fmt.Errorf("无法连接 PostgreSQL，请检查数据库服务和凭据")
	} // 真正连通后才报告可消费
	resourceKey, err := features.ResourceKey(os.Getenv("RESOURCE_KEY"))
	if err != nil {
		return err
	}
	queue := features.Queue{Pool: pool, Lease: *lease, AuditKey: []byte(os.Getenv("AUDIT_KEY")), ResourceKey: resourceKey} // 数据库是任务的唯一持久来源
	if callbacksEnabled {
		queue.CallbackKeys = keys
		queue.CallbackOrigin = origin
		queue.CallbackWait = *callbackWait
	} // 未启用监听就不给执行器假回调能力
	node, err := features.NewNode(pool, "0.1.0", plugins)
	if err != nil {
		return err
	} // 每次启动生成独立运行节点标识
	queue.Capabilities = node.Capabilities()
	if err = node.Heartbeat(ctx); err != nil {
		return fmt.Errorf("节点心跳写入失败，请确认已执行数据库迁移")
	} // 真正登记后才能对外宣告运行
	var consumers sync.WaitGroup // 用一个等待组收拢全部后台工作
	consumers.Add(1)
	go func() {
		defer consumers.Done()
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := node.Heartbeat(ctx); err != nil {
					slog.Error("运行节点心跳失败", "node", node.ID, "error", err.Error())
				}
			}
		}
	}() // 不上传插件路径、环境或密钥
	if *schedule {
		consumers.Add(1)
		go func() {
			defer consumers.Done()
			ticker := time.NewTicker(60 * time.Second)
			defer ticker.Stop()
			for {
				if _, err := queue.Schedule(ctx); err != nil && ctx.Err() == nil {
					slog.Error("到期任务调度失败", "error", err.Error())
				}
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
				}
			}
		}()
	} // 只有显式开关才创建到期暂停任务
	var server *http.Server // 无显式参数时保持nil，不占端口
	if callbacksEnabled {
		listener, err := net.Listen("tcp", *callbackListen)
		if err != nil {
			stop()
			consumers.Wait()
			return fmt.Errorf("无法监听资源回调地址")
		} // 监听失败不得继续接受异步任务
		server = &http.Server{Handler: features.Callbacks{Queue: queue}, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8 * 1024, BaseContext: func(net.Listener) context.Context { return ctx }} // 请求退出也会取消未提交事务
		consumers.Add(1)
		go func() {
			defer consumers.Done()
			if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
				slog.Error("资源回调监听停止", "error", err.Error())
				stop()
			}
		}() // 失去回调接收能力时停止新的开通消费
	}
	for number := 0; number < *workers; number++ {
		consumers.Add(1)                                                            // 先登记，再启动消费者
		go func() { defer consumers.Done(); consume(ctx, queue, plugins, *poll) }() // 每个消费者顺序执行一个任务
	}
	slog.Info("狐岚云守护进程已启动", "concurrency", *workers, "plugins", len(plugins)) // 不把任何配置密钥写日志
	<-ctx.Done()                                                              // 等待系统退出或容器停止
	if server != nil {
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = server.Shutdown(shutdown)
		cancel()
	} // 不再接收新回调，正在提交的事务有界结束
	consumers.Wait() // 任务中止和租约写回完成后再退出
	return nil       // 正常停止让服务管理器识别为成功
}

// --- 顺序领取、执行、回写，空队列时等待 ---
func consume(ctx context.Context, queue features.Queue, plugins features.Plugins, poll time.Duration) {
	ticker := time.NewTicker(poll) // 一个消费者只有一个定时器
	defer ticker.Stop()            // 退出不留下定时器
	for {
		if ctx.Err() != nil {
			return
		} // 停止后不再领取新任务
		if err := queue.Reap(ctx); err != nil {
			slog.Error("清理过期任务失败", "error", err.Error())
		} // 最后一次失联也会进入死信
		if err := queue.ExpireCallbacks(ctx); err != nil {
			slog.Error("资源回调等待清理失败", "error", err.Error())
		} // 超时不自动重开资源
		if err := queue.SkipRenewed(ctx); err != nil {
			slog.Error("过期暂停任务清理失败", "error", err.Error())
		} // 已续费的排队任务不再请求暂停
		job, err := queue.Claim(ctx)           // 领取与更新租约是同一条 SQL
		if errors.Is(err, features.ErrEmpty) { // 没有任务是正常等待
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				continue
			} // 可立即响应停止信号
		}
		if err != nil { // 数据库故障不能被当成空队列
			slog.Error("领取任务失败", "error", err.Error()) // 下次轮询会重新检查数据库
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				continue
			} // 避免故障期间忙循环
		}
		execute(ctx, queue, plugins, job) // 一个任务的执行和结果在这一处读完
	}
}

// --- 一个任务只有一种结果写回 ---
func execute(ctx context.Context, queue features.Queue, plugins features.Plugins, job features.Job) {
	executionError := queue.ValidateResource(ctx, job)
	var result features.Result
	if executionError == nil {
		result, executionError = plugins.Run(ctx, job)
	}
	if executionError != nil && job.Action == "resource" {
		if errors.Is(executionError, features.ErrAsyncUncertain) {
			executionError = fmt.Errorf("%w: 资源操作结果需要人工核对", features.ErrAsyncUncertain)
		} else {
			executionError = fmt.Errorf("资源操作失败，请管理员核对供应商状态")
		}
	}
	writeContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second) // 停机时仍给租约释放留五秒
	defer cancel()                                                                         // 不把写回等待拖成无限退出
	var err error                                                                          // 写回故障由本入口统一记录
	switch {
	case errors.Is(executionError, features.ErrManualRequired):
		err = queue.Hold(writeContext, job) // 人工交付留给后台确认
	case errors.Is(executionError, features.ErrAsyncUncertain):
		err = queue.Uncertain(writeContext, job, executionError.Error()) // 已异步受理但协议不完整时不重新开通
	case result.Pending && executionError != nil:
		err = queue.Uncertain(writeContext, job, "供应商已报告异步受理，但结果无法确认") // 已知pending不能进入普通失败重试
	case executionError != nil:
		err = queue.Fail(writeContext, job, executionError.Error()) // 重试次数和死信状态持久化
	case result.Pending:
		err = queue.Wait(writeContext, job, result) // 先等待签名回调，不把机构受理当作真实完成
	default:
		err = queue.Complete(writeContext, job, result) // 外部成功不代表有权提交，仍检查租约
	}
	if errors.Is(err, features.ErrLeaseLost) {
		slog.Warn("忽略过期消费者结果", "job", job.ID)
		return
	} // 新 owner 的结果不会被旧 owner 覆盖
	if err != nil {
		slog.Error("写回任务结果失败", "job", job.ID, "error", err.Error())
		return
	} // 租约过期后其他进程会恢复
	if executionError != nil {
		slog.Info("任务等待或重试", "job", job.ID, "reason", executionError.Error())
		return
	} // 不输出载荷和外部密钥
	if result.Pending {
		slog.Info("资源任务等待签名回调", "job", job.ID, "action", job.Action)
		return
	} // 日志也不能把等待伪装成完成
	slog.Info("任务完成", "job", job.ID, "action", job.Action) // 成功日志在事务提交之后
}
