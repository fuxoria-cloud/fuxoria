/*
任务队列：从 PostgreSQL 领取任务，带租约提交结果，重试和人工交付也写回同一张表。
调用：queue := Queue{Pool: pool, Lease: 2*time.Minute}; job, err := queue.Claim(ctx)
完成：err = queue.Complete(ctx, job, Result{ExternalID: "vm-123"})
任务 id 也是外部开通的幂等键；租约只防旧进程回写，外部插件仍需保证自己的幂等性。
*/
package features

import (
	"context"       // 退出时停止数据库请求
	"encoding/json" // 保留任务载荷的原始 JSON
	"errors"        // 区分空队列和租约已失效
	"fmt"           // 返回明确的协议错误
	"time"          // 表达租约和重试等待

	"github.com/jackc/pgx/v5"         // 事务会统一回滚没有成功提交的写入
	"github.com/jackc/pgx/v5/pgconn"  // 识别数据库对同服务执行的唯一约束
	"github.com/jackc/pgx/v5/pgxpool" // 多个消费者共享有上限的连接池
)

var ErrEmpty = errors.New("没有到期任务")      // 空队列是正常状态
var ErrLeaseLost = errors.New("任务租约已失效") // 旧消费者不能再修改业务结果

// Job 是单次已领取的任务；Token 每次领取都会变化。
type Job struct {
	ID                string          `json:"id"`                          // 外部系统按此键去重
	ServiceID         string          `json:"serviceId"`                   // 本次操作对应的客户服务
	Action            string          `json:"action"`                      // provision、suspend、resume、terminate、renew 或 upgrade
	Provider          string          `json:"provider"`                    // 对应 plugins 目录下的文件名
	Payload           json.RawMessage `json:"payload"`                     // 主业务提交的开通参数
	Token             string          `json:"-"`                           // 不交给外部插件，避免泄露队列写入凭证
	Attempts          int             `json:"attempt"`                     // 插件可据此识别重试
	ExternalID        *string         `json:"externalId"`                  // 已开通资源的真实平台 ID
	Name              string          `json:"name"`                        // 服务显示名称
	Configuration     json.RawMessage `json:"configuration"`               // 订单确认的资源选择，直接交给供应商插件
	BillingPeriod     string          `json:"billingPeriod"`               // 服务合同周期，不读取后来产品价格
	BillingMonths     int             `json:"billingMonths"`               // 一次性为0，其余按日历月计费
	BillingCurrency   string          `json:"billingCurrency"`             // 服务合同币种，不跟随后来商品换价
	BillingSeconds    int             `json:"billingSeconds"`              // 时付、日付和一次试用使用独立秒数
	CallbackReference string          `json:"callbackReference,omitempty"` // 每次领取生成的独立回调引用，不是租约凭证
	CallbackURL       string          `json:"callbackUrl,omitempty"`       // 运维配置的供应商回调地址
}

// Result 是插件成功后返回的结果；provision 必须提供真实 ExternalID。
type Result struct {
	privateCipher     string
	privateExpires    time.Time
	ExternalID        string          `json:"externalId,omitempty"`        // 供应商返回的真实资源标识
	Data              json.RawMessage `json:"data,omitempty"`              // 可选的非敏感结果，不存储密码
	Pending           bool            `json:"pending,omitempty"`           // 机构受理但尚未确认资源动作完成
	CallbackReference string          `json:"callbackReference,omitempty"` // pending时必须原样回显任务的独立引用
}

// Queue 把业务结果和队列状态放进同一个 PostgreSQL 事务。
type Queue struct {
	Capabilities   []byte            // 本节点实际插件能力；nil只用于旧隔离夹具
	ResourceKey    []byte            // 独立AES-GCM密钥，不传递给供应商
	Pool           *pgxpool.Pool     // 数据库持久化是任务状态的唯一来源
	Lease          time.Duration     // 必须大于插件超时，留出提交事务的时间
	AuditKey       []byte            // 与主业务共用的外置审计签名密钥
	CallbackKeys   map[string][]byte // 只有显式启用监听且配置了该供应商才接受异步任务
	CallbackOrigin string            // 可选的公开HTTPS回调来源，不包含路径
	CallbackWait   time.Duration     // 等待资源回调的最长时间，超时转人工核对
}

// Claim 领取一个到期或租约过期的任务；并发消费者跳过被锁定的行。
func (queue Queue) Claim(ctx context.Context) (Job, error) {
	var job Job // 只将成功领取的任务交给执行器
	err := queue.Pool.QueryRow(ctx, `
  WITH candidate AS (
   SELECT j.id FROM jobs j JOIN services s ON s.id=j.service_id
   WHERE ($2::jsonb IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements($2::jsonb) p WHERE p->>'id'=j.provider AND p->'actions' ? j.action AND (j.action<>'resource' OR (p->'resource'=j.payload->'capability' AND CASE j.payload->>'operation' WHEN 'action' THEN EXISTS(SELECT 1 FROM jsonb_array_elements(p->'resource'->'clientActions') a WHERE a->>'id'=j.payload->>'actionId') WHEN 'inspect' THEN jsonb_array_length(p->'resource'->'inspect')>0 WHEN 'metrics' THEN jsonb_array_length(p->'resource'->'metrics')>0 WHEN 'console' THEN jsonb_array_length(p->'resource'->'consoleOrigins')>0 WHEN 'credentials' THEN jsonb_array_length(p->'resource'->'credentialFields')>0 ELSE false END)))) AND j.attempts < j.max_attempts AND
    ((j.state='queued' AND j.run_at<=now()) OR (j.state='running' AND j.lease_until<=now()))
    AND NOT EXISTS (SELECT 1 FROM jobs busy WHERE busy.service_id=j.service_id AND busy.id<>j.id
     AND busy.state IN ('running','waiting','manual_review'))
    AND NOT (j.action='suspend' AND COALESCE(j.payload->>'reason','')='overdue' AND j.payload->>'dueAt' IS NOT NULL AND
      (s.termination_requested_at IS NOT NULL OR s.status<>'active' OR s.due_at IS NULL OR s.due_at>now() OR s.due_at<>(j.payload->>'dueAt')::timestamptz
       OR EXISTS(SELECT 1 FROM users u JOIN client_groups g ON g.id=u.client_group_id WHERE u.id=COALESCE(s.current_owner_id,s.user_id) AND g.suspend_exempt)))
   ORDER BY j.run_at,j.id FOR UPDATE OF j,s SKIP LOCKED LIMIT 1
  ), claimed AS (
   UPDATE jobs SET state='running',attempts=attempts+1,lease_token=gen_random_uuid(),
    lease_until=now()+($1::double precision*interval '1 second'),
    callback_reference=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-',''),callback_deadline=NULL,updated_at=now()
   WHERE id=(SELECT id FROM candidate)
   RETURNING id,service_id,action,provider,payload,lease_token,attempts,callback_reference
  )
  SELECT j.id::text,j.service_id::text,j.action,j.provider,j.payload,j.lease_token::text,j.attempts,s.external_id,s.name,j.callback_reference,CASE WHEN j.action='upgrade' THEN COALESCE(j.payload->'configuration',s.configuration) ELSE s.configuration END,
   CASE WHEN j.action='upgrade' THEN COALESCE(j.payload->>'billingPeriod',s.billing_period) ELSE s.billing_period END,
   CASE WHEN j.action='upgrade' THEN COALESCE((j.payload->>'billingMonths')::integer,s.billing_months) ELSE s.billing_months END,
   CASE WHEN j.action='upgrade' THEN COALESCE((j.payload->>'billingSeconds')::integer,s.billing_seconds) ELSE s.billing_seconds END,s.billing_currency
  FROM claimed j JOIN services s ON s.id=j.service_id`, queue.Lease.Seconds(), queue.Capabilities).Scan(
		&job.ID, &job.ServiceID, &job.Action, &job.Provider, &job.Payload, &job.Token, &job.Attempts, &job.ExternalID, &job.Name, &job.CallbackReference, &job.Configuration, &job.BillingPeriod, &job.BillingMonths, &job.BillingSeconds, &job.BillingCurrency) // 一条语句完成锁定和领取
	if err == nil && queue.CallbackOrigin != "" {
		job.CallbackURL = queue.CallbackOrigin + "/callbacks/jobs/" + job.ID
	} // 外部插件只看到资源回调地址
	var databaseError *pgconn.PgError // 同服务并发竞态由数据库唯一约束兜住
	if errors.As(err, &databaseError) && databaseError.Code == "23505" && databaseError.ConstraintName == "jobs_one_running_per_service" {
		return job, ErrEmpty
	} // 另一消费者刚领取了同服务任务，下一轮再检查
	if errors.Is(err, pgx.ErrNoRows) {
		return job, ErrEmpty
	} // 没任务时让消费者等待下一轮
	return job, err // 数据库故障交给守护进程统一记录
}

// Complete 在租约仍有效时，原子写入任务完成和服务状态。
func (queue Queue) Complete(ctx context.Context, job Job, result Result) error {
	if result.Pending {
		return fmt.Errorf("异步结果必须进入waiting，不能直接完成")
	} // 未确认的资源不能先写成功
	if job.Action == "provision" && result.ExternalID == "" {
		return fmt.Errorf("开通插件没有返回真实资源 ID")
	} // 外部协议结果在此边界核实
	var err error
	result, err = queue.protectResource(job, result)
	if err != nil {
		return err
	}
	encoded, err := json.Marshal(result) // 首次写入前剥离并加密私有结果
	if err != nil {
		return fmt.Errorf("插件结果不是合法 JSON: %w", err)
	} // 插件结果错误不能写成成功
	return pgx.BeginFunc(ctx, queue.Pool, func(transaction pgx.Tx) error {
		changed, err := transaction.Exec(ctx, `UPDATE jobs SET state='succeeded',result=$3,last_error=NULL,
   lease_token=NULL,lease_until=NULL,updated_at=now()
   WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_until>now()`, job.ID, job.Token, encoded) // 只有当前有效 owner 可以提交
		if err != nil {
			return err
		} // 事务库负责统一回滚
		if changed.RowsAffected() != 1 {
			return ErrLeaseLost
		} // 旧 owner 不得触碰服务
		return queue.apply(ctx, transaction, job, result) // 同步结果与回调共用同一条资源状态主线
	})
}

// --- 已验证任务完成后，统一改变资源状态并追加审计 ---
func (queue Queue) apply(ctx context.Context, transaction pgx.Tx, job Job, result Result) error {
	if job.Action == "resource" {
		return queue.applyResource(ctx, transaction, job, result)
	}
	if job.Action == "upgrade" {
		if _, err := transaction.Exec(ctx, `SELECT apply_service_upgrade($1::uuid)`, job.ID); err != nil {
			return err
		} // 实际成功才更新当前商品、配置和续费价，原成交行保持不可变
		return queue.audit(ctx, transaction, "job.succeeded", job, map[string]any{"serviceId": job.ServiceID, "action": job.Action, "provider": job.Provider, "attempt": job.Attempts})
	}
	_, err := transaction.Exec(ctx, `UPDATE services SET
   status=CASE $2 WHEN 'provision' THEN 'active' WHEN 'resume' THEN 'active' WHEN 'suspend' THEN 'suspended'
    WHEN 'terminate' THEN 'cancelled' WHEN 'renew' THEN status END,
   external_id=CASE WHEN $2='provision' THEN $3 ELSE external_id END,
   due_at=CASE WHEN $2 IN ('provision','renew') AND billing_months=0 AND billing_seconds=0 THEN NULL
    WHEN $2='provision' THEN COALESCE(due_at,now()+make_interval(months=>billing_months,secs=>billing_seconds))
    WHEN $2='renew' THEN greatest(COALESCE(due_at,now()),now())+make_interval(months=>billing_months,secs=>billing_seconds) ELSE due_at END,
   suspend_type=CASE WHEN $2='suspend' THEN CASE WHEN $4::jsonb->>'reason'='overdue' AND $4::jsonb->>'dueAt' IS NOT NULL THEN 'overdue' ELSE 'manual' END WHEN $2='resume' THEN '' ELSE suspend_type END,
   suspend_reason=CASE WHEN $2='suspend' AND $4::jsonb->>'reason'='overdue' AND $4::jsonb->>'dueAt' IS NOT NULL THEN '服务到期，等待续费'
    WHEN $2='suspend' THEN COALESCE($4::jsonb->>'reason','管理员暂停') WHEN $2='resume' THEN '' ELSE suspend_reason END,
   suspended_at=CASE WHEN $2='suspend' THEN now() WHEN $2='resume' THEN NULL ELSE suspended_at END
   WHERE id=$1`, job.ServiceID, job.Action, result.ExternalID, job.Payload) // 队列成功与业务状态只提交一次
	if err != nil {
		return err
	} // 服务更新失败则不写成功审计
	if job.Action == "suspend" { // 到期任务执行期间可能刚好收到了续费
		_, err = transaction.Exec(ctx, `INSERT INTO jobs(service_id,action,provider,payload,dedup_key)
     SELECT s.id,'resume',$2,jsonb_build_object('reason','renewed_during_suspend','suspendJobId',$3::text),'resume-after-overdue:'||$3::text
     FROM services s WHERE s.id=$1 AND s.termination_requested_at IS NULL AND (s.due_at>now() OR EXISTS(SELECT 1 FROM users u JOIN client_groups g ON g.id=u.client_group_id WHERE u.id=COALESCE(s.current_owner_id,s.user_id) AND g.suspend_exempt)) AND $4::jsonb->>'reason'='overdue' AND $4::jsonb->>'dueAt' IS NOT NULL ON CONFLICT(dedup_key) DO NOTHING`, job.ServiceID, job.Provider, job.ID, job.Payload) // 有原到期快照的真实逾期暂停才安排恢复，人工说明相同也不能解除风控暂停
		if err != nil {
			return err
		} // 恢复意图与暂停状态同事务持久化
	}
	if job.Action == "terminate" {
		if _, err = transaction.Exec(ctx, `UPDATE service_cancellations SET status='executed',updated_at=now() WHERE service_id=$1 AND job_id=$2 AND status='executing'`, job.ServiceID, job.ID); err != nil {
			return err
		}
	} // 只有供应商真正终止成功才完成相应取消申请
	return queue.audit(ctx, transaction, "job.succeeded", job, map[string]any{"serviceId": job.ServiceID, "action": job.Action, "provider": job.Provider, "attempt": job.Attempts, "externalId": result.ExternalID}) // 审计和业务结果一起提交
}

// Fail 保留错误原因，按指数退避重试；达到上限后进入 failed 死信状态。
func (queue Queue) Fail(ctx context.Context, job Job, reason string) error {
	if job.Action == "resource" {
		reason = "资源操作失败，请核对供应商真实状态"
	}
	return pgx.BeginFunc(ctx, queue.Pool, func(transaction pgx.Tx) error {
		var state string // 最后一次失败还要更新服务的可见状态
		err := transaction.QueryRow(ctx, `UPDATE jobs SET
   state=CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'queued' END,
   run_at=now()+(least(3600,power(2,least(attempts,10))*5)::double precision*interval '1 second'),
   last_error=$3,lease_token=NULL,lease_until=NULL,updated_at=now()
   WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_until>now() RETURNING state`, job.ID, job.Token, reason).Scan(&state) // 错误写入也必须持有有效租约
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrLeaseLost
		} // 已被重领的任务由新 owner 处理
		if err != nil {
			return err
		} // 不在业务内部吞掉数据库故障
		if state == "failed" && job.Action == "provision" {
			_, err = transaction.Exec(ctx, `UPDATE services SET status='failed' WHERE id=$1 AND status IN ('pending','provisioning')`, job.ServiceID) // 只有未开通的服务展示失败
			if err != nil {
				return err
			} // 不覆盖已经存在资源的真实状态
		}
		return queue.audit(ctx, transaction, "job."+state, job, map[string]any{"serviceId": job.ServiceID, "action": job.Action, "provider": job.Provider, "attempt": job.Attempts, "reason": reason}) // 重试与死信都留不可变审计
	})
}

// Hold 把人工交付任务留给后台确认，不将排队误报为已开通。
func (queue Queue) Hold(ctx context.Context, job Job) error {
	return pgx.BeginFunc(ctx, queue.Pool, func(transaction pgx.Tx) error {
		changed, err := transaction.Exec(ctx, `UPDATE jobs SET state='queued',attempts=greatest(attempts-1,0),
   run_at=now()+interval '365 days',last_error='manual_required',result='{"manualRequired":true}',
   lease_token=NULL,lease_until=NULL,updated_at=now()
   WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_until>now()`, job.ID, job.Token) // 人工等待不消耗失败重试次数
		if err != nil {
			return err
		} // 审计和等待状态由事务一起回滚
		if changed.RowsAffected() != 1 {
			return ErrLeaseLost
		} // 后台已处理的任务不能重新排队
		return queue.audit(ctx, transaction, "job.manual_required", job, map[string]any{"serviceId": job.ServiceID, "action": job.Action, "provider": job.Provider}) // 等待也有可追踪的系统操作者
	})
}

// Reap 将最后一次尝试后失联的任务转为死信，避免永远停在 running。
func (queue Queue) Reap(ctx context.Context) error {
	return pgx.BeginFunc(ctx, queue.Pool, func(transaction pgx.Tx) error {
		rows, err := transaction.Query(ctx, `WITH candidates AS (
   SELECT id FROM jobs WHERE state='running' AND lease_until<=now() AND attempts>=max_attempts
   ORDER BY lease_until FOR UPDATE SKIP LOCKED LIMIT 100
  ) UPDATE jobs SET state='failed',lease_token=NULL,lease_until=NULL,last_error='最后一次执行的租约已过期',updated_at=now()
   WHERE id IN (SELECT id FROM candidates) RETURNING id::text,service_id::text,action,provider,attempts`) // 每轮有界回收，不一次锁住全部积压
		if err != nil {
			return err
		} // 数据库故障由入口统一记录
		exhausted := []Job{} // 最多保留本轮一百条耗尽记录
		for rows.Next() {
			var job Job // 回收只需记录业务身份和尝试次数
			if err = rows.Scan(&job.ID, &job.ServiceID, &job.Action, &job.Provider, &job.Attempts); err != nil {
				rows.Close()
				return err
			} // 数据库协议错误不能跳过
			exhausted = append(exhausted, job) // 先读完游标，再在当前连接写其他表
		}
		err = rows.Err() // 游标读取失败也要回滚
		rows.Close()     // 释放连接上的结果集
		if err != nil {
			return err
		} // 不提交部分回收结果
		for _, job := range exhausted {
			if job.Action == "provision" {
				_, err = transaction.Exec(ctx, `UPDATE services SET status='failed' WHERE id=$1 AND status IN ('pending','provisioning')`, job.ServiceID) // 未开通服务显示最终失败
				if err != nil {
					return err
				} // 服务与任务保持同次提交
			}
			if err = queue.audit(ctx, transaction, "job.failed", job, map[string]any{"serviceId": job.ServiceID, "action": job.Action, "attempt": job.Attempts, "reason": "lease_exhausted"}); err != nil {
				return err
			} // 每个耗尽任务都有不可变审计
		}
		return nil // 本轮无耗尽任务也是正常状态
	})
}
