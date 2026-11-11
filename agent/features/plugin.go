/*
开通插件：启动时自动读取 plugins/*.json；每份清单对应一个受信任的外部程序或人工交付。
调用：plugins, err := LoadPlugins("/opt/yunzou/plugins", 2*time.Minute)
执行：result, err := plugins.Run(ctx, job)
外部程序从 stdin 读一个 JSON，从 stdout 返回一个 JSON；不经过 shell，不执行清单里的代码字符串。
*/
package features

import (
	"bytes"         // 读取 JSON 并保存有上限的外部输出
	"context"       // 插件超时和退出都能终止子进程
	"encoding/json" // 只接受约定的清单和结果字段
	"errors"        // 区分人工等待与执行失败
	"fmt"           // 把清单错误定位到具体插件
	"io"            // 检查 JSON 后面没有第二个响应
	"os"            // 读取清单、检查权限和挑选环境变量
	"os/exec"       // 直接启动程序，绝不交给 shell
	"path/filepath" // 相对程序路径基于清单位置解析
	"regexp"        // 插件名称只允许可预测的文件名
	"slices"        // 核对插件公开支持的业务动作
	"strings"       // 提取环境变量的名字
	"syscall"       // 停止整个供应商进程组，避免子进程继续修改资源
	"time"          // 插件超时必须短于队列租约

	"github.com/fuxoria-cloud/fuxoria/agent/utils" // 所有外部JSON都拒绝重复字段
)

var ErrManualRequired = errors.New("等待管理员人工交付")    // 人工交付不返回伪造资源
var ErrOutputLimit = errors.New("插件输出超出 64 KiB")   // 外部输出也是系统输入边界
var ErrAsyncUncertain = errors.New("异步开通结果需要人工核对") // 已受理的外部动作不能因协议错误自动重开

// Plugins 由文件名自动登记，增删一份清单不用修改中央注册表。
type Plugins map[string]Plugin

// Plugin 描述一个受信任程序的调用方式；环境只列名字，不把密钥写入清单。
type Plugin struct {
	Mode           string              `json:"mode"`                     // manual 或 command
	Executable     string              `json:"executable,omitempty"`     // 相对路径以清单所在目录为准
	Arguments      []string            `json:"arguments,omitempty"`      // 原样作为 argv，不进行字符串拼接
	Actions        []string            `json:"actions"`                  // 只允许明确列出的业务动作
	Environment    []string            `json:"environment,omitempty"`    // 指定向子进程传递哪些环境变量
	TimeoutSeconds int                 `json:"timeoutSeconds,omitempty"` // 留出至少十秒提交队列结果
	Resource       *ResourceCapability `json:"resource,omitempty"`       // 客户可见的结构化资源能力
	Callback       bool                `json:"callback,omitempty"`       // 此供应商可能异步受理，执行前必须有可用回调地址
}

// LoadPlugins 扫描目录并验证清单；调用示例：LoadPlugins("/opt/yunzou/plugins", 2*time.Minute)。
func LoadPlugins(directory string, lease time.Duration) (Plugins, error) {
	files, err := filepath.Glob(filepath.Join(directory, "*.json")) // 只加载约定格式的清单
	if err != nil {
		return nil, err
	} // 路径配置错误在启动时立即暴露
	plugins := Plugins{} // 同一名称只有文件名一个来源
	for _, file := range files {
		name := strings.TrimSuffix(filepath.Base(file), ".json") // 不要求清单再次填写插件 ID
		if !regexp.MustCompile(`^[a-z][a-z0-9_-]{0,63}$`).MatchString(name) {
			return nil, fmt.Errorf("插件文件名无效: %s", name)
		} // 运行前检查外部文件边界
		plugin, err := readPlugin(file, lease) // 每份清单的定义全部放在自己文件里
		if err != nil {
			return nil, fmt.Errorf("插件 %s: %w", name, err)
		} // 错误直接指出应修改哪份清单
		plugins[name] = plugin // 下一次启动自动反映目录变化
	}
	return plugins, nil // 空目录允许启动，未知供应商会明确失败
}

// --- 读取并检查一份外部插件清单 ---
func readPlugin(file string, lease time.Duration) (Plugin, error) {
	var plugin Plugin          // 验证成功之前不对外发布定义
	info, err := os.Stat(file) // 文件权限决定谁能改变受信任程序的定义
	if err != nil {
		return plugin, err
	} // 不忽略无法读取的清单
	if !info.Mode().IsRegular() || info.Mode().Perm()&0022 != 0 {
		return plugin, fmt.Errorf("清单必须是普通文件且不可被组或其他用户写入")
	} // 防止共享目录任意篡改插件
	if info.Size() > 32*1024 {
		return plugin, fmt.Errorf("清单不得超过 32 KiB")
	} // 配置边界限制读取量
	data, err := os.ReadFile(file) // 只在启动时读取清单
	if err != nil {
		return plugin, err
	} // 读取错误保留原位置
	if err = utils.JSON(data, &plugin); err != nil {
		return plugin, err
	} // 必须是完整 JSON 清单
	if plugin.Mode != "manual" && plugin.Mode != "command" {
		return plugin, fmt.Errorf("mode 只允许 manual 或 command")
	} // 只有明确支持的执行方式
	if len(plugin.Actions) == 0 {
		return plugin, fmt.Errorf("至少声明一个支持的 action")
	} // 不以隐藏默认值扩展权限
	for _, action := range plugin.Actions {
		if !slices.Contains([]string{"provision", "suspend", "resume", "terminate", "renew", "upgrade", "resource"}, action) {
			return plugin, fmt.Errorf("不支持动作 %s", action)
		} // 支持动作与业务契约一致
	}
	if plugin.Resource != nil {
		if plugin.Mode != "command" || !slices.Contains(plugin.Actions, "resource") {
			return plugin, fmt.Errorf("资源能力只允许声明resource动作的受控程序")
		}
		if err := validResource(plugin.Resource); err != nil {
			return plugin, err
		}
	}
	if plugin.Mode == "manual" {
		return plugin, nil
	} // 人工插件不加载外部可执行文件
	if plugin.TimeoutSeconds <= 0 {
		plugin.TimeoutSeconds = 60
	} // 默认一分钟，避免坏插件长期占用任务
	if time.Duration(plugin.TimeoutSeconds)*time.Second >= lease-10*time.Second {
		return plugin, fmt.Errorf("插件超时必须比租约短至少十秒")
	} // 结果提交期间不会正常丢失租约
	if !filepath.IsAbs(plugin.Executable) {
		plugin.Executable = filepath.Join(filepath.Dir(file), plugin.Executable)
	} // 换启动目录也指向同一个插件
	plugin.Executable, err = filepath.Abs(plugin.Executable) // 后续 exec 不搜索用户当前目录
	if err != nil {
		return plugin, err
	} // 路径无法解释时拒绝加载
	info, err = os.Stat(plugin.Executable) // 程序必须明确存在
	if err != nil {
		return plugin, err
	} // 不让缺失程序在运行时假装成功
	if !info.Mode().IsRegular() || info.Mode().Perm()&0111 == 0 || info.Mode().Perm()&0022 != 0 {
		return plugin, fmt.Errorf("程序必须可执行且不可被组或其他用户写入")
	} // 清单只允许受信任的普通程序
	for _, name := range plugin.Environment {
		if name == "RESOURCE_KEY" || !regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`).MatchString(name) {
			return plugin, fmt.Errorf("环境变量名无效")
		} // 只接收名字，不在清单保存键值
	}
	return plugin, nil // 验证结束后，内部执行不重复检查定义
}

// Run 调用所选供应商；每个插件必须以 job.id 为幂等键查询或创建真实资源。
func (plugins Plugins) Run(ctx context.Context, job Job) (Result, error) {
	var result Result                       // 只有完成协议检查的结果才能交给队列提交
	plugin, exists := plugins[job.Provider] // 供应商直接对应插件文件名
	if !exists {
		return result, fmt.Errorf("未安装供应商插件 %s", job.Provider)
	} // 缺插件明确失败，不使用演示供应商兜底
	if !slices.Contains(plugin.Actions, job.Action) {
		return result, fmt.Errorf("供应商插件未声明支持动作 %s", job.Action)
	} // 每个动作都需在清单授权
	if plugin.Mode == "manual" {
		return result, ErrManualRequired
	} // 人工交付由后台审核，守护进程不代为确认
	if plugin.Callback && (job.CallbackURL == "" || job.CallbackReference == "") {
		return result, fmt.Errorf("异步供应商回调尚未配置，未执行外部程序")
	} // 不发出无法等待完成的外部请求
	if job.Action == "resource" {
		prepared, err := prepareResourceJob(job, plugin)
		if err != nil {
			return result, err
		}
		job = prepared
	}
	input, err := json.Marshal(job) // 输入统一携带 job.id、服务和当前资源 ID
	if err != nil {
		return result, fmt.Errorf("任务载荷不是合法 JSON")
	} // 外部输入错误不交给插件猜测
	if len(input) > 256*1024 {
		return result, fmt.Errorf("插件输入不得超过 256 KiB")
	} // 输入边界有限，避免大任务耗尽内存
	runContext, cancel := context.WithTimeout(ctx, time.Duration(plugin.TimeoutSeconds)*time.Second) // 一次执行有明确最长时间
	defer cancel()                                                                                   // 插件结束立即释放定时器
	command := exec.CommandContext(runContext, plugin.Executable, plugin.Arguments...)               // 无 shell，无拼接命令字符串
	command.WaitDelay = 2 * time.Second                                                              // 子进程错误持有输出管道时也能有界退出
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}                                        // 供应商及其子进程使用独立进程组
	command.Cancel = func() error { return syscall.Kill(-command.Process.Pid, syscall.SIGKILL) }     // 超时或停机时同时终止后代进程
	command.Stdin = bytes.NewReader(input)                                                           // 机密载荷不出现在进程参数里
	command.Dir = filepath.Dir(plugin.Executable)                                                    // 插件自身文件按安装位置寻找
	command.Env = []string{"PATH=" + os.Getenv("PATH")}                                              // 不把数据库和支付密钥默认传给插件
	for _, name := range plugin.Environment {
		if value, exists := os.LookupEnv(name); exists {
			command.Env = append(command.Env, name+"="+value)
		} // 只传清单明确要求的环境变量
	}
	output := limitedOutput{limit: 64 * 1024} // 限制供应商返回的结果大小
	command.Stdout = &output                  // stdout 是唯一结果协议
	command.Stderr = io.Discard               // 不把可能含密钥的供应商诊断写入客户可见错误
	if err = command.Run(); err != nil {
		if plugin.Callback && command.Process != nil {
			return result, fmt.Errorf("%w: 异步供应商程序已执行但未给出可确认结果", ErrAsyncUncertain)
		} // 请求可能已被机构受理，不能因超时自动重开
		if runContext.Err() != nil {
			return result, fmt.Errorf("供应商插件执行中止: %w", runContext.Err())
		} // 超时或退出都留下可重试原因
		return result, fmt.Errorf("供应商插件执行失败或输出超限") // 不把外部程序的完整错误泄露到后台接口
	}
	if err = utils.JSON(output.buffer.Bytes(), &result); err != nil {
		if plugin.Callback {
			return result, fmt.Errorf("%w: 异步供应商返回的JSON无法验证", ErrAsyncUncertain)
		} // 坏输出也可能发生在机构受理以后
		return result, fmt.Errorf("供应商插件没有返回约定的 JSON")
	} // 错误响应不能写成成功
	if result.Pending && (!plugin.Callback || result.CallbackReference == "" || result.CallbackReference != job.CallbackReference) {
		return result, fmt.Errorf("%w: 回调声明或引用与本次任务不一致", ErrAsyncUncertain)
	} // 明确异步受理后不能再走自动失败重试
	if job.Action == "provision" && !result.Pending && strings.TrimSpace(result.ExternalID) == "" {
		if plugin.Callback {
			return result, fmt.Errorf("%w: 异步供应商没有返回真实资源ID或待确认结果", ErrAsyncUncertain)
		} // 未确认资源不能因为缺ID重新创建
		return result, fmt.Errorf("开通插件必须返回真实 externalId")
	} // 空响应不能激活客户服务
	if len(result.ExternalID) > 512 {
		if plugin.Callback || result.Pending {
			return result, fmt.Errorf("%w: 供应商资源ID超过长度限制", ErrAsyncUncertain)
		} // 已受理但协议异常只能人工核对
		return result, fmt.Errorf("供应商资源 ID 超过长度限制")
	} // 限制外部文本进入数据库的长度
	return result, nil // 资金写入始终留在主业务，插件只负责资源动作
}

// --- 保存有限的外部输出 ---
type limitedOutput struct {
	buffer bytes.Buffer // 结果保留到 JSON 解析结束
	limit  int          // 超过约定大小立即返回写入错误
}

func (output *limitedOutput) Write(value []byte) (int, error) {
	if output.buffer.Len()+len(value) > output.limit {
		return 0, ErrOutputLimit
	} // 不分配无限大小的输出缓存
	return output.buffer.Write(value) // 只保存限额内的完整内容
}
