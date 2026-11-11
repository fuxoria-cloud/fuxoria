/*
批准取消与客户组免暂停：真实PostgreSQL中核对调度、租约及结果回写。
调用：YUNZOU_TEST_DATABASE_URL=postgres://... go test -race ./features -run 'TestApprovedCancellation|TestExemptGroup'。
每次沿用独立schema，不修改开发服务；资源状态只由实际Complete确认。
*/
package features

import (
	"errors"  // 空队列和真正数据库失败分开核对
	"sync"    // 两个调度节点竞争同一个批准事实
	"testing" // 使用同一真实队列验收夹具
)

func TestApprovedCancellationSchedulesOnceAndCompletes(t *testing.T) {
	ctx, queue, service := expiring(t) // 已实际开通且到期的服务
	if _, err := queue.Pool.Exec(ctx, `UPDATE services SET termination_requested_at=now() WHERE id=$1`, service.ServiceID); err != nil {
		t.Fatal(err)
	} // 批准取消阻止欠费暂停和续费
	var id string // 本申请的稳定终止依据
	if err := queue.Pool.QueryRow(ctx, `INSERT INTO service_cancellations(service_id,user_id,mode,reason,status,execute_at) SELECT id,user_id,'end_of_period','测试客户批准的到期取消','approved',now()-interval '1 minute' FROM services WHERE id=$1 RETURNING id::text`, service.ServiceID).Scan(&id); err != nil {
		t.Fatal(err)
	} // 保存真实已批准申请
	var wait sync.WaitGroup
	results := make(chan int, 4)
	failures := make(chan error, 4) // 多节点调度不重复排队
	for round := 0; round < 4; round++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			count, err := queue.Schedule(ctx)
			results <- count
			if err != nil {
				failures <- err
			}
		}()
	}
	wait.Wait()
	close(results)
	close(failures)
	for err := range failures {
		t.Fatal(err)
	} // 每个SQL错误都暴露
	count := 0
	for number := range results {
		count += number
	}
	if count != 1 {
		t.Fatalf("同一批准取消排队%d次", count)
	} // 固定申请ID去重
	job, err := queue.Claim(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if job.Action != "terminate" {
		t.Fatalf("批准终止变成%s", job.Action)
	} // 没有相反的欠费暂停任务
	var status string
	if err = queue.Pool.QueryRow(ctx, `SELECT status FROM service_cancellations WHERE id=$1`, id).Scan(&status); err != nil || status != "executing" {
		t.Fatalf("排队尚未实际结束: %s %v", status, err)
	} // 不提前宣告已终止
	if err = queue.Complete(ctx, job, Result{}); err != nil {
		t.Fatal(err)
	} // 代表供应商返回明确执行成功
	if err = queue.Pool.QueryRow(ctx, `SELECT c.status||':'||s.status FROM service_cancellations c JOIN services s ON s.id=c.service_id WHERE c.id=$1`, id).Scan(&status); err != nil || status != "executed:cancelled" {
		t.Fatalf("真实完成未原子回写: %s %v", status, err)
	} // 申请与服务同事务完成
}

func TestExemptGroupCancelsStalePauseAndCanScheduleAfterRevocation(t *testing.T) {
	ctx, queue, service := expiring(t)
	var group string // 先构造普通欠费任务
	if count, err := queue.Schedule(ctx); err != nil || count != 1 {
		t.Fatalf("普通客户未排任务: %d %v", count, err)
	}
	if err := queue.Pool.QueryRow(ctx, `INSERT INTO client_groups(name,suspend_exempt) VALUES('免暂停验收',true) RETURNING id::text`).Scan(&group); err != nil {
		t.Fatal(err)
	} // 管理员授予免暂停策略
	if _, err := queue.Pool.Exec(ctx, `UPDATE users SET client_group_id=$1 WHERE id=(SELECT COALESCE(current_owner_id,user_id) FROM services WHERE id=$2)`, group, service.ServiceID); err != nil {
		t.Fatal(err)
	} // 策略属于当前持有人
	if _, err := queue.Claim(ctx); !errors.Is(err, ErrEmpty) {
		t.Fatalf("免暂停后仍领取旧任务: %v", err)
	} // 政策变更前的快照不能执行
	if err := queue.SkipRenewed(ctx); err != nil {
		t.Fatal(err)
	} // 旧任务保留已跳过事实
	if count, err := queue.Schedule(ctx); err != nil || count != 0 {
		t.Fatalf("免暂停客户仍被排队: %d %v", count, err)
	}
	if _, err := queue.Pool.Exec(ctx, `UPDATE client_groups SET suspend_exempt=false WHERE id=$1`, group); err != nil {
		t.Fatal(err)
	} // 撤销免暂停，不改变原到期日
	if count, err := queue.Schedule(ctx); err != nil || count != 1 {
		t.Fatalf("撤销后原到期日无法重新排队: %d %v", count, err)
	} // 跳过事实参与下一轮去重代次
	job, err := queue.Claim(ctx)
	if err != nil || job.Action != "suspend" {
		t.Fatalf("新任务不能正常领取: %s %v", job.Action, err)
	} // 新策略确实重新生效
}
