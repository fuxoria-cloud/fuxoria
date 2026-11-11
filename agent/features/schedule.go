/*
到期调度：排真实欠费暂停与已批准的到期取消任务，不直接改变客户资源状态。
调用：count,err := queue.Schedule(ctx)，入口只有显式--schedule才每60秒调用。
同一到期时间生成固定dedup_key；销毁必须有管理员已批准的取消申请。
*/
package features

import (
	"context"       // 停止信号立即中止下一轮调度
	"encoding/json" // 到期时间与暂停原因保存为普通业务载荷

	"github.com/jackc/pgx/v5" // 调度意图与审计处于同一事务
)

// Schedule 将到期服务写成待执行暂停任务；不在本函数调用任何供应商或更新服务状态。
func (queue Queue) Schedule(ctx context.Context) (int, error) {
	count := 0 // 只统计本次实际新增的调度意图
	err := pgx.BeginFunc(ctx, queue.Pool, func(transaction pgx.Tx) error {
		rows, err := transaction.Query(ctx, `WITH due AS (
      SELECT s.id,s.due_at,p.provider,(SELECT count(*) FROM jobs previous WHERE previous.service_id=s.id AND previous.state='succeeded' AND previous.result->>'skipped'='true' AND previous.payload->>'reason'='overdue' AND (previous.payload->>'dueAt')::timestamptz=s.due_at) AS generation FROM services s JOIN products p ON p.id=COALESCE(s.current_product_id,s.product_id)
      WHERE s.status='active' AND s.due_at<now() AND s.termination_requested_at IS NULL
       AND NOT EXISTS(SELECT 1 FROM users u JOIN client_groups g ON g.id=u.client_group_id WHERE u.id=COALESCE(s.current_owner_id,s.user_id) AND g.suspend_exempt)
       AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.service_id=s.id AND j.state IN('queued','running','waiting','manual_review'))
      ORDER BY s.due_at,s.id FOR UPDATE OF s SKIP LOCKED LIMIT 100
    ) INSERT INTO jobs(service_id,action,provider,payload,dedup_key)
      SELECT id,'suspend',provider,jsonb_build_object('reason','overdue','dueAt',due_at),
       'overdue:'||id::text||':'||floor(extract(epoch FROM due_at)*1000000)::text||':'||generation::text FROM due
      ON CONFLICT(dedup_key) DO NOTHING RETURNING id::text,service_id::text,provider,payload`) // 不同调度节点也共用同一到期去重键
		if err != nil {
			return err
		} // 数据库失败不能只记一部分意图
		jobs := []Job{} // 每次最多安排一百个到期服务
		for rows.Next() {
			var job Job
			job.Action = "suspend"
			if err = rows.Scan(&job.ID, &job.ServiceID, &job.Provider, &job.Payload); err != nil {
				rows.Close()
				return err
			}
			jobs = append(jobs, job)
		} // 先读完游标再追加审计
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		} // 游标失败回滚所有插入
		cancellations, err := queue.scheduleCancellations(ctx, transaction) // 只接受管理员已批准且实际到期的取消
		if err != nil {
			return err
		} // 两类调度统一回滚
		jobs = append(jobs, cancellations...) // 同一轮审计覆盖所有真实入队
		for _, job := range jobs {
			var details map[string]any // 载荷来自本函数，不包含供应商密钥
			if err = json.Unmarshal(job.Payload, &details); err != nil {
				return err
			} // 审计与入队载荷保持同一事实
			details["serviceId"] = job.ServiceID
			details["provider"] = job.Provider // 调度来源一眼可追踪
			action := "job.overdue_scheduled"  // 保留原到期暂停审计语义
			if job.Action == "terminate" {
				action = "job.cancellation_scheduled"
			} // 取消来自独立批准事实
			if err = queue.audit(ctx, transaction, action, job, details); err != nil {
				return err
			} // 调度和审计一起提交
		}
		count = len(jobs) // 只有本事务成功才向入口返回计数
		return nil        // 服务仍为active，直到供应商确认暂停
	})
	return count, err // 失败时入口不会宣称调度成功
}

// SkipRenewed 跳过已续费或状态变化的排队到期任务，不向供应商发送过时暂停。
func (queue Queue) SkipRenewed(ctx context.Context) error {
	return pgx.BeginFunc(ctx, queue.Pool, func(transaction pgx.Tx) error {
		rows, err := transaction.Query(ctx, `WITH stale AS (
      SELECT j.id,CASE WHEN s.termination_requested_at IS NOT NULL THEN 'termination_requested' WHEN EXISTS(SELECT 1 FROM users u JOIN client_groups g ON g.id=u.client_group_id WHERE u.id=COALESCE(s.current_owner_id,s.user_id) AND g.suspend_exempt) THEN 'suspend_exempt' ELSE 'expiry_changed' END AS reason
      FROM jobs j JOIN services s ON s.id=j.service_id
      WHERE j.state='queued' AND j.action='suspend' AND j.payload->>'reason'='overdue' AND j.payload->>'dueAt' IS NOT NULL
       AND COALESCE(j.result->>'manualRequired','false')<>'true'
       AND (s.termination_requested_at IS NOT NULL OR s.status<>'active' OR s.due_at IS NULL OR s.due_at>now() OR s.due_at<>(j.payload->>'dueAt')::timestamptz OR EXISTS(SELECT 1 FROM users u JOIN client_groups g ON g.id=u.client_group_id WHERE u.id=COALESCE(s.current_owner_id,s.user_id) AND g.suspend_exempt))
      ORDER BY j.run_at,j.id FOR UPDATE OF j,s SKIP LOCKED LIMIT 100
    ) UPDATE jobs j SET state='succeeded',result=jsonb_build_object('skipped',true,'reason',stale.reason),last_error=NULL,updated_at=now()
      FROM stale WHERE j.id=stale.id RETURNING j.id::text,j.service_id::text,j.action,j.provider,stale.reason`) // 已移交人工的动作可能已在平台执行，只能由管理员核对，不能自动宣称安全跳过
		if err != nil {
			return err
		} // 不吞掉实际数据库故障
		type skipped struct { // 跳过原因与任务结果一致，避免把终止意图误记为续费
			Job
			Reason string
		}
		jobs := []skipped{} // 有界保存本次跳过的任务
		for rows.Next() {
			var job skipped
			if err = rows.Scan(&job.ID, &job.ServiceID, &job.Action, &job.Provider, &job.Reason); err != nil {
				rows.Close()
				return err
			}
			jobs = append(jobs, job)
		} // 先释放查询结果
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		} // 读取失败时仍回滚
		for _, job := range jobs {
			if err = queue.audit(ctx, transaction, "job.overdue_skipped", job.Job, map[string]any{"serviceId": job.ServiceID, "provider": job.Provider, "reason": job.Reason}); err != nil {
				return err
			}
		} // 不把跳过伪装成供应商已暂停
		return nil // 不修改服务真实状态或到期时间
	})
}

// scheduleCancellations 把已批准的到期取消排成终止任务；服务仍保持真实状态。
func (queue Queue) scheduleCancellations(ctx context.Context, transaction pgx.Tx) ([]Job, error) {
	rows, err := transaction.Query(ctx, `WITH due AS (
  SELECT c.id AS cancellation_id,s.id AS service_id,p.provider,c.reason FROM service_cancellations c
  JOIN services s ON s.id=c.service_id JOIN products p ON p.id=COALESCE(s.current_product_id,s.product_id)
  WHERE c.status='approved' AND c.execute_at<=now() AND s.termination_requested_at IS NOT NULL
   AND s.status IN ('active','suspended') AND c.user_id=COALESCE(s.current_owner_id,s.user_id)
   AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.service_id=s.id AND j.state IN ('queued','running','waiting','manual_review'))
  ORDER BY c.execute_at,c.id FOR UPDATE OF s,c SKIP LOCKED LIMIT 100
 ), inserted AS (
  INSERT INTO jobs(service_id,action,provider,payload,dedup_key)
  SELECT service_id,'terminate',provider,jsonb_build_object('reason',reason,'cancellationId',cancellation_id),'cancellation:'||cancellation_id::text FROM due
  ON CONFLICT(dedup_key) DO NOTHING RETURNING id,service_id,provider,payload
 ), changed AS (
  UPDATE service_cancellations c SET status='executing',job_id=j.id,updated_at=now() FROM inserted j
  WHERE c.id=(j.payload->>'cancellationId')::uuid RETURNING c.job_id
 ) SELECT j.id::text,j.service_id::text,j.provider,j.payload FROM inserted j JOIN changed c ON c.job_id=j.id`) // 固定申请ID使多节点/重启不会重复终止
	if err != nil {
		return nil, err
	} // 任何结构或约束故障向上返回
	defer rows.Close() // 当前连接读取完才能写审计
	jobs := []Job{}    // 有界收集本次真正新增的任务
	for rows.Next() {
		var job Job
		job.Action = "terminate" // 本函数只处理已授权终止
		if err = rows.Scan(&job.ID, &job.ServiceID, &job.Provider, &job.Payload); err != nil {
			return nil, err
		} // 不跳过无法核对的记录
		jobs = append(jobs, job) // 交由上层与暂停任务一起记审计
	}
	return jobs, rows.Err() // 游标故障使整个调度事务回滚
}
