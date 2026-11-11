/*
队列验收：真实 PostgreSQL 中验证并发领取、同服务串行、过期 owner 隔离、退避、死信与人工等待。
调用：cd agent && YUNZOU_TEST_DATABASE_URL=postgres://... go test -race ./features -run TestQueue
每次建独立 schema 并在结束时删除，只应指向可创建测试 schema 的隔离数据库。
*/
package features

import (
	"context"       // 所有测试数据库操作都有统一取消边界
	"crypto/hmac"   // 独立核对保存的审计签名
	"crypto/rand"   // 隔离 schema 不与另一轮测试重名
	"crypto/sha256" // 与跨语言审计约定一致
	"encoding/hex"  // 生成安全的 schema 名称
	"encoding/json" // 检查签名原文里保存的业务事实
	"errors"        // 核对空队列和失效租约
	"os"            // 只从明确的测试变量读取数据库地址
	"path/filepath" // 相对测试源码找到实际迁移 SQL
	"runtime"       // 不受测试启动目录影响
	"sort"
	"sync"    // 同时发起多个真实消费者
	"testing" // Go 的标准测试入口
	"time"    // 限制测试等待时间

	"github.com/jackc/pgx/v5"         // 对 schema 名进行标识符转义
	"github.com/jackc/pgx/v5/pgxpool" // 使用与生产相同的驱动
)

// --- 创建一次测试的隔离 schema，并执行真实业务迁移 ---
func testQueue(t *testing.T) (context.Context, Queue) {
	t.Helper()                                       // 报错行指向实际测试调用处
	address := os.Getenv("YUNZOU_TEST_DATABASE_URL") // 不误连默认生产数据库
	if address == "" {
		t.Skip("请设置 YUNZOU_TEST_DATABASE_URL 运行 PostgreSQL 队列验收")
	} // 缺配置明确报告跳过
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second) // 坏锁不会让测试无限等待
	t.Cleanup(cancel)                                                        // 最后释放测试上下文
	base, err := pgxpool.New(ctx, address)                                   // 先以默认 schema 建立管理连接
	if err != nil {
		t.Fatal(err)
	} // 连接配置错误不能当跳过
	identity := make([]byte, 8) // 每轮测试独占一个随机名称
	if _, err = rand.Read(identity); err != nil {
		t.Fatal(err)
	} // 测试名不依赖时间碰撞
	schema := "yunzou_agent_test_" + hex.EncodeToString(identity) // 名称只含安全字符
	quoted := pgx.Identifier{schema}.Sanitize()                   // 即使名称变化也按标识符处理
	if _, err = base.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		t.Fatal(err)
	} // 只在隔离 schema 创建对象
	t.Cleanup(func() { _, _ = base.Exec(context.Background(), "DROP SCHEMA "+quoted+" CASCADE"); base.Close() }) // 测试数据随本轮清理
	configuration, err := pgxpool.ParseConfig(address)                                                           // 连接协议与守护进程一致
	if err != nil {
		t.Fatal(err)
	} // 参数边界由驱动检查
	configuration.ConnConfig.RuntimeParams["search_path"] = schema // 每个池连接都只访问测试 schema
	configuration.MaxConns = 20                                    // 并发测试不会被一条连接串行化
	pool, err := pgxpool.NewWithConfig(ctx, configuration)         // 单独连接池支持并发领取
	if err != nil {
		t.Fatal(err)
	} // 建池失败立即停止
	t.Cleanup(pool.Close)                                                                                    // 先关业务连接再删 schema
	_, source, _, _ := runtime.Caller(0)                                                                     // 找到本测试文件的实际位置
	migrations, err := filepath.Glob(filepath.Join(filepath.Dir(source), "../../database/migrations/*.sql")) // 执行真实迁移序列，包含跨服务任务唯一约束
	if err != nil || len(migrations) == 0 {
		t.Fatalf("找不到业务迁移: %v", err)
	} // 缺迁移时不能假装测试通过
	draft, _ := filepath.Glob(filepath.Join(filepath.Dir(source), "../../database/migrations/032_v376_catalogue_rules.draft"))
	migrations = append(migrations, draft...)
	for _, pattern := range []string{"033_v376_currencies.draft", "038_v376_resource_modules.draft"} {
		extra, _ := filepath.Glob(filepath.Join(filepath.Dir(source), "../../database/migrations/", pattern))
		migrations = append(migrations, extra...)
	}
	sort.Strings(migrations)
	for _, file := range migrations {
		migration, err := os.ReadFile(file) // 按文件名顺序读取结构变更
		if err != nil {
			t.Fatal(err)
		} // 缺文件说明测试环境不完整
		if _, err = pool.Exec(ctx, string(migration)); err != nil {
			t.Fatal(err)
		} // 真实数据库约束参与验收
	}
	return ctx, Queue{Pool: pool, Lease: 30 * time.Second, AuditKey: []byte("test-only-audit-key-at-least-thirty-two-characters")} // 测试密钥不会用于线上审计
}

// --- 用真实外键建一条尚未执行的任务 ---
func task(t *testing.T, ctx context.Context, queue Queue) string {
	t.Helper()    // 夹具错误归到调用点
	var id string // 返回任务的数据库标识
	err := queue.Pool.QueryRow(ctx, `WITH customer AS (
 INSERT INTO users(email,name,password) VALUES(gen_random_uuid()::text||'@test.invalid','验收用户','not-a-login') RETURNING id
 ), product AS (
 INSERT INTO products(name,price_cents,provider) VALUES('验收商品',100,'test') RETURNING id
 ), customer_order AS (
 INSERT INTO orders(user_id,product_id,idempotency_key,request_hash,amount_cents)
 SELECT customer.id,product.id,gen_random_uuid()::text,'test',100 FROM customer,product RETURNING *
 ), customer_service AS (
 INSERT INTO services(user_id,product_id,order_id,name) SELECT user_id,product_id,id,'验收服务' FROM customer_order RETURNING id
 ) INSERT INTO jobs(service_id,action,provider,dedup_key)
 SELECT id,'provision','test',gen_random_uuid()::text FROM customer_service RETURNING id::text`).Scan(&id) // 全部夹具由一条事务语句创建
	if err != nil {
		t.Fatal(err)
	} // 外键或实际迁移不匹配时立即暴露
	return id // 数据完全留在本次 schema
}

func TestQueueConcurrentClaimAndServiceOrder(t *testing.T) {
	ctx, queue := testQueue(t)       // 使用隔离 PostgreSQL schema
	id := task(t, ctx, queue)        // 所有消费者争抢这一条任务
	var group sync.WaitGroup         // 等待所有并发结果
	claimed := make(chan Job, 12)    // 不让发送结果阻塞消费者
	failures := make(chan error, 12) // 非空队列错误必须报告
	for number := 0; number < 12; number++ {
		group.Add(1) // 启动前登记消费者
		go func() {
			defer group.Done()
			job, err := queue.Claim(ctx)
			if err == nil {
				claimed <- job
				return
			}
			if !errors.Is(err, ErrEmpty) {
				failures <- err
			}
		}() // 真正并发调用领取 SQL
	}
	group.Wait()
	close(claimed)
	close(failures) // 全部完成后再检查结果
	for err := range failures {
		t.Fatal(err)
	} // 数据库故障不能误计为空队列
	if len(claimed) != 1 {
		t.Fatalf("同一任务被领取 %d 次", len(claimed))
	} // 不能重复调用供应商
	owner := <-claimed // 唯一 owner 拥有当前租约
	if owner.ID != id {
		t.Fatalf("领取了错误任务 %s", owner.ID)
	} // 结果来自实际夹具
	_, err := queue.Pool.Exec(ctx, `INSERT INTO jobs(service_id,action,provider,dedup_key)
 SELECT service_id,'suspend','test','second-action' FROM jobs WHERE id=$1`, id) // 同服务再排一个不同动作
	if err != nil {
		t.Fatal(err)
	} // 新任务状态由真实约束检查
	if _, err = queue.Claim(ctx); !errors.Is(err, ErrEmpty) {
		t.Fatalf("同一服务不能并发执行不同动作: %v", err)
	} // 后一个动作需等第一个完成
	if err = queue.Complete(ctx, owner, Result{ExternalID: "vm-concurrent"}); err != nil {
		t.Fatal(err)
	} // 首个动作提交后释放服务
	second, err := queue.Claim(ctx) // 下一轮才能取得同服务的暂停动作
	if err != nil || second.Action != "suspend" {
		t.Fatalf("未按服务顺序领取: %+v %v", second, err)
	} // 顺序由队列保证
}

func TestQueueExpiredOwnerCannotCommit(t *testing.T) {
	ctx, queue := testQueue(t)   // 一次 schema 只验证租约恢复
	id := task(t, ctx, queue)    // 创建可重领的任务
	old, err := queue.Claim(ctx) // 首个 owner 取得租约
	if err != nil {
		t.Fatal(err)
	} // 初始领取应成功
	if _, err = queue.Pool.Exec(ctx, `UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	} // 模拟进程失联后的真实数据库时间
	current, err := queue.Claim(ctx) // 新 owner 取得不同 token
	if err != nil || current.Token == old.Token {
		t.Fatalf("没有更新租约: %+v %v", current, err)
	} // 重领必须改变凭证
	if err = queue.Complete(ctx, old, Result{ExternalID: "wrong-resource"}); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("过期 owner 提交成功: %v", err)
	} // 旧资源结果不能覆盖新 owner
	if err = queue.Fail(ctx, old, "late error"); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("过期 owner 覆盖失败状态: %v", err)
	} // 错误结果同样受 fencing 保护
	if err = queue.Complete(ctx, current, Result{ExternalID: "real-resource"}); err != nil {
		t.Fatal(err)
	} // 新 owner 的事务正常提交
	var state, external string // 同时核对队列和业务结果
	if err = queue.Pool.QueryRow(ctx, `SELECT j.state,s.external_id FROM jobs j JOIN services s ON s.id=j.service_id WHERE j.id=$1`, id).Scan(&state, &external); err != nil {
		t.Fatal(err)
	} // 核对数据库实际内容
	if state != "succeeded" || external != "real-resource" {
		t.Fatalf("提交结果不一致: %s %s", state, external)
	} // 两张表必须同次成功
}

func TestQueueBackoffDeadLetterAndManual(t *testing.T) {
	ctx, queue := testQueue(t) // 验证重试状态不会留在内存
	id := task(t, ctx, queue)  // 默认任务允许五次，这里明确缩成两次
	if _, err := queue.Pool.Exec(ctx, `UPDATE jobs SET max_attempts=2 WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	} // 由配置决定重试上限
	first, err := queue.Claim(ctx) // 第一次真实尝试
	if err != nil {
		t.Fatal(err)
	} // 初次领取成功
	if err = queue.Fail(ctx, first, "temporary failure"); err != nil {
		t.Fatal(err)
	} // 临时错误应安排未来重试
	if _, err = queue.Claim(ctx); !errors.Is(err, ErrEmpty) {
		t.Fatalf("退避期间被立即重试: %v", err)
	} // 不能在故障期间忙循环开通
	if _, err = queue.Pool.Exec(ctx, `UPDATE jobs SET run_at=now() WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	} // 测试推进到下一次重试而非实际等待
	second, err := queue.Claim(ctx) // 重试次数从数据库恢复
	if err != nil || second.Attempts != 2 {
		t.Fatalf("重试计数错误: %+v %v", second, err)
	} // 不能因重启恢复为第一次
	if err = queue.Fail(ctx, second, "terminal failure"); err != nil {
		t.Fatal(err)
	} // 第二次失败进入死信
	var state, serviceStatus string // 后台和客户都能看到最终失败
	if err = queue.Pool.QueryRow(ctx, `SELECT j.state,s.status FROM jobs j JOIN services s ON s.id=j.service_id WHERE j.id=$1`, id).Scan(&state, &serviceStatus); err != nil {
		t.Fatal(err)
	} // 检查真实状态
	if state != "failed" || serviceStatus != "failed" {
		t.Fatalf("没有进入死信: %s %s", state, serviceStatus)
	} // 不能无限重试或误报 active
	manualID := task(t, ctx, queue) // 人工交付和失败重试分开验收
	manual, err := queue.Claim(ctx) // 人工插件仍通过同一领取路径
	if err != nil {
		t.Fatal(err)
	} // 有新任务可领
	if err = queue.Hold(ctx, manual); err != nil {
		t.Fatal(err)
	} // 等待管理员不会写成功
	var attempts int // 人工等待不消耗故障重试次数
	if err = queue.Pool.QueryRow(ctx, `SELECT state,attempts FROM jobs WHERE id=$1`, manualID).Scan(&state, &attempts); err != nil {
		t.Fatal(err)
	} // 核对持久化结果
	if state != "queued" || attempts != 0 {
		t.Fatalf("人工交付状态错误: %s %d", state, attempts)
	} // 不激活服务，也不计失败
}

func TestQueueExhaustedLeaseBecomesDeadLetter(t *testing.T) {
	ctx, queue := testQueue(t) // 最后一次进程崩溃也必须有终态
	id := task(t, ctx, queue)  // 创建即将耗尽的任务
	if _, err := queue.Pool.Exec(ctx, `UPDATE jobs SET max_attempts=1 WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	} // 只允许本次尝试
	if _, err := queue.Claim(ctx); err != nil {
		t.Fatal(err)
	} // 模拟执行中进程消失
	if _, err := queue.Pool.Exec(ctx, `UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	} // 租约已真实过期
	if err := queue.Reap(ctx); err != nil {
		t.Fatal(err)
	} // 维护语句收拢耗尽任务
	var state string // 不允许永远停留 running
	if err := queue.Pool.QueryRow(ctx, `SELECT state FROM jobs WHERE id=$1`, id).Scan(&state); err != nil {
		t.Fatal(err)
	} // 查询实际终态
	if state != "failed" {
		t.Fatalf("租约耗尽没有进入死信: %s", state)
	} // 支持后台人工处理
}

func TestQueueConcurrentDifferentActionsStaySerial(t *testing.T) {
	ctx, queue := testQueue(t) // 模拟同一服务大量不同动作同时排队
	id := task(t, ctx, queue)  // 首个真实服务任务
	if _, err := queue.Pool.Exec(ctx, `INSERT INTO jobs(service_id,action,provider,dedup_key)
 SELECT service_id,'suspend','test',gen_random_uuid()::text FROM jobs WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	} // 第二个动作在首次领取前就已存在
	var group sync.WaitGroup         // 所有查询同时争抢两条不同任务
	successes := make(chan Job, 16)  // 只收集真正持有租约的任务
	failures := make(chan error, 16) // 约束以外的数据库错误仍需报告
	for number := 0; number < 16; number++ {
		group.Add(1) // 不让测试提前检查结果
		go func() {
			defer group.Done()
			job, err := queue.Claim(ctx)
			if err == nil {
				successes <- job
				return
			}
			if !errors.Is(err, ErrEmpty) {
				failures <- err
			}
		}() // 不能靠单连接把测试串行化
	}
	group.Wait()
	close(successes)
	close(failures) // 完成所有并发请求后检查
	for err := range failures {
		t.Fatal(err)
	} // 数据库故障不算成功保护
	if len(successes) != 1 {
		t.Fatalf("同一服务同时执行了 %d 个动作", len(successes))
	} // 数据库唯一约束守住跨行竞态
}

func TestQueueAuditCanonicalChainAndImmutability(t *testing.T) {
	ctx, queue := testQueue(t)   // 真实数据库约束也参与审计验证
	id := task(t, ctx, queue)    // 第一笔结果写入空链
	job, err := queue.Claim(ctx) // 取得可以写回的有效owner
	if err != nil {
		t.Fatal(err)
	} // 没租约不能写成功审计
	if err = queue.Complete(ctx, job, Result{ExternalID: "vm-<&>-测试"}); err != nil {
		t.Fatal(err)
	} // 特殊字符不能破坏签名原文
	secondID := task(t, ctx, queue) // 再接一笔人工等待结果
	second, err := queue.Claim(ctx) // 队列动作和审计在同一事务里
	if err != nil {
		t.Fatal(err)
	} // 此处应有新任务
	if err = queue.Hold(ctx, second); err != nil {
		t.Fatal(err)
	} // 人工交付也不能跳过审计
	rows, err := queue.Pool.Query(ctx, `SELECT previous_hash,hash,canonical_body FROM audit ORDER BY id`) // 保存的原文就是跨语言验证输入
	if err != nil {
		t.Fatal(err)
	} // 缺原文字段说明迁移不完整
	previous := "0000000000000000000000000000000000000000000000000000000000000000" // 与主业务的零锚点一致
	targets := map[string]bool{id: false, secondID: false}                         // 每个已提交动作都应该留记录
	count := 0                                                                     // 确认没有漏审计或重复审计
	for rows.Next() {
		var linked, signature, canonical string // 从数据库读取真实链节点
		if err = rows.Scan(&linked, &signature, &canonical); err != nil {
			rows.Close()
			t.Fatal(err)
		} // 读取失败时终止验收
		if linked != previous {
			rows.Close()
			t.Fatal("审计链断开")
		} // 新节点必须接前一笔签名
		expected := hmac.New(sha256.New, queue.AuditKey) // 直接按原文字节验证，不依赖JSON键重排
		_, _ = expected.Write([]byte(canonical))         // 与Node的update(body)行为一致
		if hex.EncodeToString(expected.Sum(nil)) != signature {
			rows.Close()
			t.Fatal("审计HMAC不匹配")
		} // 字符转义、换行或密钥不同都会失败
		var body struct {
			Actor, Action, Target, PreviousHash string
			Details                             map[string]any
		} // 同时核实原文里的业务事实
		if err = json.Unmarshal([]byte(canonical), &body); err != nil {
			rows.Close()
			t.Fatal(err)
		} // 原文必须能独立解释
		if body.Actor != "agent" || body.PreviousHash != linked {
			rows.Close()
			t.Fatal("签名事实与链元数据不一致")
		} // 元数据不能指向另一条链
		targets[body.Target] = true // 两次动作都要有对应目标
		previous = signature        // 下一笔应链接当前签名
		count++                     // 不以仅有一笔有效记录掩盖漏审计
	}
	err = rows.Err()
	rows.Close() // 先读完结果，再发不可变约束检查
	if err != nil {
		t.Fatal(err)
	} // 游标中途失败不能忽略
	if count != 2 || !targets[id] || !targets[secondID] {
		t.Fatalf("审计覆盖不完整: count=%d targets=%+v", count, targets)
	} // 每次业务提交对应一笔审计
	if _, err = queue.Pool.Exec(ctx, `UPDATE audit SET action='forged'`); err == nil {
		t.Fatal("审计记录不应允许修改")
	} // 数据库约束禁止历史改写
}
