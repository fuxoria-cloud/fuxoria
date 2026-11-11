/*
到期调度与运行节点验收：真实PostgreSQL验证去重、续费竞争与能力白名单。
调用：YUNZOU_TEST_DATABASE_URL=postgres://... go test -race ./features -run 'TestSchedule|TestNode'。
资源操作只在测试边界确认结果，不向真实供应商开通、暂停或销毁。
*/
package features

import (
	"context"       // 公用夹具返回真实数据库上下文
	"encoding/json" // 核对持久载荷与心跳白名单
	"errors"        // 检查过时暂停确实不能领取
	"strings"       // 机密路径与环境名不能进入节点心跳
	"sync"          // 模拟多个实际调度节点
	"testing"       // 标准Go测试入口
)

// --- 已交付且真实到期的资源，供终止/人工等待边界验收使用 ---
func expiring(t *testing.T) (context.Context, Queue, Job) {
	t.Helper() // 失败定位到具体业务场景
	ctx, queue := testQueue(t)
	task(t, ctx, queue)
	job, err := queue.Claim(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err = queue.Complete(ctx, job, Result{ExternalID: "vm-lifecycle-expiring"}); err != nil {
		t.Fatal(err)
	} // 使用真实开通完成规则，不直接伪造active
	if _, err = queue.Pool.Exec(ctx, `UPDATE services SET due_at=now()-interval '1 minute' WHERE id=$1`, job.ServiceID); err != nil {
		t.Fatal(err)
	} // 只在测试边界推进到期时钟
	return ctx, queue, job // 所有记录仍留在本测试的随机schema
}

func TestScheduleTerminationIntentNeverAddsOverdue(t *testing.T) {
	ctx, queue, service := expiring(t)
	if _, err := queue.Pool.Exec(ctx, `UPDATE services SET termination_requested_at=now() WHERE id=$1`, service.ServiceID); err != nil {
		t.Fatal(err)
	} // 终止意图已持久化，供应商真实状态仍是active
	if count, err := queue.Schedule(ctx); err != nil || count != 0 {
		t.Fatalf("已有终止意图仍安排逾期暂停: %d %v", count, err)
	} // 即使终止任务不在可消费集合，也不能重新调度相反操作
	var status string
	if err := queue.Pool.QueryRow(ctx, `SELECT status FROM services WHERE id=$1`, service.ServiceID).Scan(&status); err != nil || status != "active" {
		t.Fatalf("调度改变了供应商真实状态: %s %v", status, err)
	} // 不把终止意图伪装成已实际销毁
}

func TestScheduleQueuedAndManualHeldActionsBlockNewOverdue(t *testing.T) {
	for _, action := range []string{"suspend", "resume", "terminate"} {
		t.Run(action, func(t *testing.T) {
			ctx, queue, service := expiring(t)
			if _, err := queue.Pool.Exec(ctx, `INSERT INTO jobs(service_id,action,provider,payload,dedup_key) VALUES($1,$2,'manual','{"reason":"管理员已授权操作"}',gen_random_uuid()::text)`, service.ServiceID, action); err != nil {
				t.Fatal(err)
			} // 所有排队操作都会阻止自动调度，不只检查运行中的任务
			if action == "terminate" {
				if _, err := queue.Pool.Exec(ctx, `UPDATE services SET termination_requested_at=now() WHERE id=$1`, service.ServiceID); err != nil {
					t.Fatal(err)
				} // 人工终止等待同时保留真实active和已确认的终止意图
			}
			if count, err := queue.Schedule(ctx); err != nil || count != 0 {
				t.Fatalf("%s排队期间仍安排逾期暂停: %d %v", action, count, err)
			}
			job, err := queue.Claim(ctx)
			if err != nil || job.Action != action {
				t.Fatalf("未领取原来的人工动作: %+v %v", job, err)
			}
			if err = queue.Hold(ctx, job); err != nil {
				t.Fatal(err)
			} // 实际人工插件把任务放回queued，执行时间延后但意图仍有效
			if count, err := queue.Schedule(ctx); err != nil || count != 0 {
				t.Fatalf("%s人工等待期间仍安排逾期暂停: %d %v", action, count, err)
			}
			var count int
			if err = queue.Pool.QueryRow(ctx, `SELECT count(*) FROM jobs WHERE service_id=$1 AND state='queued'`, service.ServiceID).Scan(&count); err != nil || count != 1 {
				t.Fatalf("人工等待出现额外操作: %d %v", count, err)
			} // 一项明确操作保持一项，不为同一资源并排另一项
		})
	}
}

func TestScheduleTerminationIntentBeforeClaimSkipsQueuedOverdue(t *testing.T) {
	ctx, queue, service := expiring(t)
	if count, err := queue.Schedule(ctx); err != nil || count != 1 {
		t.Fatalf("未建立原始逾期暂停: %d %v", count, err)
	} // 暂停意图先入队，供应商尚未收到动作
	if _, err := queue.Pool.Exec(ctx, `UPDATE services SET termination_requested_at=now() WHERE id=$1`, service.ServiceID); err != nil {
		t.Fatal(err)
	} // 终止意图在下一次领取以前已先提交
	if _, err := queue.Claim(ctx); !errors.Is(err, ErrEmpty) {
		t.Fatalf("终止意图提交后仍把旧暂停交给供应商执行: %v", err)
	} // 消费者即使尚未做维护，也不能领走过时动作
	if err := queue.SkipRenewed(ctx); err != nil {
		t.Fatal(err)
	} // 维护明确保存跳过事实并追加同事务审计
	var status, state, reason string
	var skipped bool
	if err := queue.Pool.QueryRow(ctx, `SELECT s.status,j.state,(j.result->>'skipped')::boolean,j.result->>'reason' FROM jobs j JOIN services s ON s.id=j.service_id WHERE j.service_id=$1 AND j.action='suspend'`, service.ServiceID).Scan(&status, &state, &skipped, &reason); err != nil {
		t.Fatal(err)
	}
	if status != "active" || state != "succeeded" || !skipped || reason != "termination_requested" {
		t.Fatalf("旧暂停没有按终止意图跳过: %s %s %v %s", status, state, skipped, reason)
	} // 任务成功指已处理跳过，资源仍保留供应商真实状态
	var audits int
	if err := queue.Pool.QueryRow(ctx, `SELECT count(*) FROM audit WHERE action='job.overdue_skipped' AND details->>'reason'='termination_requested'`).Scan(&audits); err != nil || audits != 1 {
		t.Fatalf("终止跳过没有唯一审计依据: %d %v", audits, err)
	}
}

func TestScheduleManualHoldIsNotDiscardedAfterRenewal(t *testing.T) {
	ctx, queue, service := expiring(t)
	if count, err := queue.Schedule(ctx); err != nil || count != 1 {
		t.Fatalf("未建立实际逾期动作: %d %v", count, err)
	}
	job, err := queue.Claim(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err = queue.Hold(ctx, job); err != nil {
		t.Fatal(err)
	} // 实际人工插件交接后，管理员可能已经开始在供应商平台暂停资源
	if _, err = queue.Pool.Exec(ctx, `UPDATE services SET due_at=now()+interval '1 month' WHERE id=$1`, service.ServiceID); err != nil {
		t.Fatal(err)
	} // 期间续费先到账，供应商动作是否已经执行仍不能由调度器猜测
	if err = queue.SkipRenewed(ctx); err != nil {
		t.Fatal(err)
	}
	var state, reason string
	var required bool
	if err = queue.Pool.QueryRow(ctx, `SELECT state,last_error,(result->>'manualRequired')::boolean FROM jobs WHERE id=$1`, job.ID).Scan(&state, &reason, &required); err != nil {
		t.Fatal(err)
	}
	if state != "queued" || reason != "manual_required" || !required {
		t.Fatalf("人工未核对前自动丢弃了旧暂停: %s %s %v", state, reason, required)
	} // 保留真实待核对状态，由管理员确认实际暂停或明确没有执行
	if _, err = queue.Claim(ctx); !errors.Is(err, ErrEmpty) {
		t.Fatalf("已续费的人工暂停被再次交给供应商: %v", err)
	} // 不自动重发，也不自动当成成功
}

func TestScheduleManualReasonOverdueWithoutExpiryIsNotAutomatic(t *testing.T) {
	ctx, queue, service := expiring(t)
	if _, err := queue.Pool.Exec(ctx, `INSERT INTO jobs(service_id,action,provider,payload,dedup_key) VALUES($1,'suspend','manual','{"reason":"overdue"}',gen_random_uuid()::text)`, service.ServiceID); err != nil {
		t.Fatal(err)
	} // 管理员的自由文字碰巧叫overdue，没有调度器保存的到期快照
	if _, err := queue.Pool.Exec(ctx, `UPDATE services SET due_at=now()+interval '1 month' WHERE id=$1`, service.ServiceID); err != nil {
		t.Fatal(err)
	} // 此时收到续费也不能改变管理员核查意图
	if err := queue.SkipRenewed(ctx); err != nil {
		t.Fatal(err)
	} // 维护不能把同名人工说明当作自动逾期任务跳过
	job, err := queue.Claim(ctx)
	if err != nil || job.Action != "suspend" {
		t.Fatalf("人工暂停说明被当成自动逾期而拒绝领取: %+v %v", job, err)
	}
	if err = queue.Complete(ctx, job, Result{}); err != nil {
		t.Fatal(err)
	} // 供应商明确成功后才记录真实暂停
	var status, kind string
	var resumes int
	if err = queue.Pool.QueryRow(ctx, `SELECT status,suspend_type,(SELECT count(*) FROM jobs WHERE service_id=$1 AND action='resume') FROM services WHERE id=$1`, service.ServiceID).Scan(&status, &kind, &resumes); err != nil {
		t.Fatal(err)
	}
	if status != "suspended" || kind != "manual" || resumes != 0 {
		t.Fatalf("人工核查被错误自动解除: %s %s %d", status, kind, resumes)
	} // 真实人工暂停不能因文字碰巧相同而触发自动恢复
}

func TestScheduleConcurrentDedupAndRealStateTransition(t *testing.T) {
	ctx, queue := testQueue(t)
	task(t, ctx, queue) // 先使用真实队列完成一次开通
	initial, err := queue.Claim(ctx)
	if err != nil {
		t.Fatal(err)
	} // 服务从pending开始
	if err = queue.Complete(ctx, initial, Result{ExternalID: "vm-expiring"}); err != nil {
		t.Fatal(err)
	} // 真实完成后才成为active
	if _, err = queue.Pool.Exec(ctx, `UPDATE services SET due_at=now()-interval '1 minute' WHERE id=$1`, initial.ServiceID); err != nil {
		t.Fatal(err)
	} // 明确已到期
	var group sync.WaitGroup
	counts := make(chan int, 8)
	failures := make(chan error, 8) // 八个调度节点竞争同一服务
	for index := 0; index < 8; index++ {
		group.Add(1)
		go func() {
			defer group.Done()
			count, err := queue.Schedule(ctx)
			counts <- count
			if err != nil {
				failures <- err
			}
		}()
	} // 使用实际FOR UPDATE SKIP LOCKED与唯一键
	group.Wait()
	close(counts)
	close(failures) // 所有事务提交后再核对
	for err := range failures {
		t.Fatal(err)
	} // 数据库错误不能算去重成功
	total := 0
	for count := range counts {
		total += count
	}
	if total != 1 {
		t.Fatalf("同一到期时间安排%d次暂停", total)
	} // 到期时间参与稳定去重
	var status string
	if err = queue.Pool.QueryRow(ctx, `SELECT status FROM services WHERE id=$1`, initial.ServiceID).Scan(&status); err != nil {
		t.Fatal(err)
	} // 调度本身不能改变资源状态
	if status != "active" {
		t.Fatalf("尚未调用供应商已变为%s", status)
	} // 不假装资源已经暂停
	suspend, err := queue.Claim(ctx)
	if err != nil || suspend.Action != "suspend" {
		t.Fatalf("没有生成暂停任务: %+v %v", suspend, err)
	} // 消费者按正常路径领取
	var payload map[string]any
	if err = json.Unmarshal(suspend.Payload, &payload); err != nil {
		t.Fatal(err)
	} // 载荷显式写到期原因与时点
	if payload["reason"] != "overdue" || payload["dueAt"] == nil {
		t.Fatalf("到期暂停载荷不完整: %s", suspend.Payload)
	} // 后续可识别排队期间的续费
	if err = queue.Complete(ctx, suspend, Result{}); err != nil {
		t.Fatal(err)
	} // 模拟供应商现在明确暂停完成
	var kind, reason string
	var recorded bool // 同时检查状态与暂停来源
	if err = queue.Pool.QueryRow(ctx, `SELECT status,suspend_type,suspend_reason,suspended_at IS NOT NULL FROM services WHERE id=$1`, initial.ServiceID).Scan(&status, &kind, &reason, &recorded); err != nil {
		t.Fatal(err)
	} // 读取实际业务结果
	if status != "suspended" || kind != "overdue" || reason == "" || !recorded {
		t.Fatalf("暂停事实不完整: %s %s %s %v", status, kind, reason, recorded)
	} // 只有供应商成功后才写暂停标记
	if count, err := queue.Schedule(ctx); err != nil || count != 0 {
		t.Fatalf("已暂停服务重复调度: %d %v", count, err)
	} // 不自动重复暂停或销毁
}

func TestScheduleRenewedBeforeClaimSkipsOldSuspension(t *testing.T) {
	ctx, queue := testQueue(t)
	task(t, ctx, queue)
	job, err := queue.Claim(ctx)
	if err != nil {
		t.Fatal(err)
	} // 一条真实客户服务
	if err = queue.Complete(ctx, job, Result{ExternalID: "vm-renew-before"}); err != nil {
		t.Fatal(err)
	} // 已开通后才能到期调度
	if _, err = queue.Pool.Exec(ctx, `UPDATE services SET due_at=now()-interval '1 minute' WHERE id=$1`, job.ServiceID); err != nil {
		t.Fatal(err)
	} // 到期产生暂停意图
	if _, err = queue.Schedule(ctx); err != nil {
		t.Fatal(err)
	} // 尚未执行供应商暂停
	if _, err = queue.Pool.Exec(ctx, `UPDATE services SET due_at=now()+interval '1 month' WHERE id=$1`, job.ServiceID); err != nil {
		t.Fatal(err)
	} // 此时真实续费入账延长到期
	if _, err = queue.Claim(ctx); !errors.Is(err, ErrEmpty) {
		t.Fatalf("续费后旧暂停仍可执行: %v", err)
	} // 领取本身先阻止过时动作
	if err = queue.SkipRenewed(ctx); err != nil {
		t.Fatal(err)
	} // 维护将过时排队动作记为跳过
	var status, state string
	var skipped bool // 保留可审计的跳过事实
	if err = queue.Pool.QueryRow(ctx, `SELECT s.status,j.state,(j.result->>'skipped')::boolean FROM jobs j JOIN services s ON s.id=j.service_id WHERE j.service_id=$1 AND j.action='suspend'`, job.ServiceID).Scan(&status, &state, &skipped); err != nil {
		t.Fatal(err)
	} // 不靠内存标志证明完成
	if status != "active" || state != "succeeded" || !skipped {
		t.Fatalf("过时暂停没有安全跳过: %s %s %v", status, state, skipped)
	} // 不会向供应商发送旧暂停
}

func TestScheduleRenewedDuringSuspendQueuesRealResume(t *testing.T) {
	ctx, queue := testQueue(t)
	task(t, ctx, queue)
	job, err := queue.Claim(ctx)
	if err != nil {
		t.Fatal(err)
	} // 创建已交付资源
	if err = queue.Complete(ctx, job, Result{ExternalID: "vm-renew-during"}); err != nil {
		t.Fatal(err)
	} // 资源已真实active
	if _, err = queue.Pool.Exec(ctx, `UPDATE services SET due_at=now()-interval '1 minute' WHERE id=$1`, job.ServiceID); err != nil {
		t.Fatal(err)
	} // 服务到期
	if _, err = queue.Schedule(ctx); err != nil {
		t.Fatal(err)
	} // 安排暂停
	suspend, err := queue.Claim(ctx)
	if err != nil {
		t.Fatal(err)
	} // 暂停请求此时已经发往机构
	if _, err = queue.Pool.Exec(ctx, `UPDATE services SET due_at=now()+interval '1 month' WHERE id=$1`, job.ServiceID); err != nil {
		t.Fatal(err)
	} // 供应商执行中恰好收到续费
	if err = queue.Complete(ctx, suspend, Result{}); err != nil {
		t.Fatal(err)
	} // 机构实际已暂停，不能谎称仍active
	var state string
	if err = queue.Pool.QueryRow(ctx, `SELECT status FROM services WHERE id=$1`, job.ServiceID).Scan(&state); err != nil {
		t.Fatal(err)
	} // 保留真实短暂停机状态
	if state != "suspended" {
		t.Fatalf("实际暂停的资源被假写为%s", state)
	} // 续费不能替代真实恢复操作
	resume, err := queue.Claim(ctx)
	if err != nil || resume.Action != "resume" {
		t.Fatalf("没有持久化恢复补偿: %+v %v", resume, err)
	} // 真实恢复意图已与暂停同事务写入
	if err = queue.Complete(ctx, resume, Result{}); err != nil {
		t.Fatal(err)
	} // 恢复也必须由供应商明确成功
	var kind, reason string
	var suspended bool // 清除历史暂停标记
	if err = queue.Pool.QueryRow(ctx, `SELECT status,suspend_type,suspend_reason,suspended_at IS NOT NULL FROM services WHERE id=$1`, job.ServiceID).Scan(&state, &kind, &reason, &suspended); err != nil {
		t.Fatal(err)
	} // 检查最终业务状态
	if state != "active" || kind != "" || reason != "" || suspended {
		t.Fatalf("真实恢复没有清理暂停标记: %s %s %s %v", state, kind, reason, suspended)
	} // 客户与后台看到同一真实资源事实
}

func TestNodeHeartbeatOnlyReportsActualSafeCapabilities(t *testing.T) {
	ctx, queue := testQueue(t)                                                                                                                                                                                                                  // 心跳同样写真实隔离数据库
	plugins := Plugins{"provider": {Mode: "command", Executable: "/private/credentials/program", Environment: []string{"SECRET_TOKEN"}, Actions: []string{"provision", "suspend"}}, "manual": {Mode: "manual", Actions: []string{"provision"}}} // 明确加入不允许公开的信息
	node, err := NewNode(queue.Pool, "test-version", plugins)
	if err != nil {
		t.Fatal(err)
	} // 启动即生成实际节点UUID
	if err = node.Heartbeat(ctx); err != nil {
		t.Fatal(err)
	} // 第一次插入
	if err = node.Heartbeat(ctx); err != nil {
		t.Fatal(err)
	} // 同进程续期不新增第二行
	var body, version string
	var count int // 检查实际保存的公开能力
	if err = queue.Pool.QueryRow(ctx, `SELECT plugins::text,version,(SELECT count(*) FROM agent_presence) FROM agent_presence WHERE id=$1`, node.ID).Scan(&body, &version, &count); err != nil {
		t.Fatal(err)
	} // 从数据库读取而非只看本地结构
	if count != 1 || version != "test-version" || strings.Contains(body, "private") || strings.Contains(body, "SECRET") || strings.Contains(body, "executable") {
		t.Fatalf("心跳泄露实现或未去重: %s", body)
	} // 密钥环境和路径都不能进入后台能力列表
	var capabilities []map[string]any
	if err = json.Unmarshal([]byte(body), &capabilities); err != nil {
		t.Fatal(err)
	} // 白名单只有三个字段
	if len(capabilities) != 2 || len(capabilities[0]) != 3 || capabilities[0]["id"] != "manual" {
		t.Fatalf("能力白名单或排序错误: %s", body)
	} // 文件名与实际加载动作清楚可读
}
