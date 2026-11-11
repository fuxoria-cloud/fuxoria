/* 升降级任务验收：真实PostgreSQL下核对租约、目标配置、回调和原成交记录。
 * 调用：YUNZOU_TEST_DATABASE_URL=postgres://... go test -race ./features -run 'TestQueueUpgrade|TestCallbackUpgrade'。
 */
package features

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// upgradeTask 创建已有资源上的0元降配单，不创建第二台资源或虚构现金收款。
func upgradeTask(t *testing.T, ctx context.Context, queue Queue) (Job, string, string) {
	t.Helper()
	task(t, ctx, queue)
	original, err := queue.Claim(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err = queue.Complete(ctx, original, Result{ExternalID: "vm-upgrade-original"}); err != nil {
		t.Fatal(err)
	}
	var jobID, upgradeID, targetID string
	err = pgx.BeginFunc(ctx, queue.Pool, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `INSERT INTO products(name,price_cents,provider) VALUES('降配目标',50,'test') RETURNING id::text`).Scan(&targetID); err != nil {
			return err
		}
		var orderID string
		if err := tx.QueryRow(ctx, `INSERT INTO orders(user_id,product_id,idempotency_key,request_hash,amount_cents,kind,status) SELECT user_id,$2,gen_random_uuid()::text,'upgrade-fixture',0,'upgrade','paid' FROM services WHERE id=$1 RETURNING id::text`, original.ServiceID, targetID).Scan(&orderID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO invoices(order_id,user_id,amount_cents,status,paid_at) SELECT $1,user_id,0,'paid',now() FROM services WHERE id=$2`, orderID, original.ServiceID); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `INSERT INTO jobs(service_id,action,provider,dedup_key) VALUES($1,'upgrade','test',gen_random_uuid()::text) RETURNING id::text`, original.ServiceID).Scan(&jobID); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `INSERT INTO service_upgrades(service_id,user_id,source_product_id,target_product_id,provider,source_configuration,target_configuration,target_labels,source_renew_cents,target_renew_cents,billing_period,billing_months,due_at,remaining_ms,period_ms,amount_cents,currency,product_name,order_id,job_id,status)
  SELECT s.id,s.user_id,s.product_id,$2,'test',s.configuration,'{"disk":2}','{"数据盘":"2"}',100,50,s.billing_period,s.billing_months,s.due_at,1,1,0,'CNY','降配目标',$3,$4,'queued' FROM services s WHERE s.id=$1 RETURNING id::text`, original.ServiceID, targetID, orderID, jobID).Scan(&upgradeID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `UPDATE jobs SET payload=jsonb_build_object('upgradeId',$2::text,'configuration','{"disk":2}'::jsonb,'productId',$3::text) WHERE id=$1`, jobID, upgradeID, targetID)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	job, err := queue.Claim(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if job.ID != jobID || !strings.Contains(string(job.Configuration), `"disk": 2`) {
		t.Fatalf("插件没有收到目标配置: %+v", job)
	}
	return job, targetID, upgradeID
}

func TestQueueUpgradeAppliesOnlyAfterValidLeaseSuccess(t *testing.T) {
	ctx, queue := testQueue(t)
	job, targetID, upgradeID := upgradeTask(t, ctx, queue)
	var beforeDue, oldProduct, oldOrder string
	if err := queue.Pool.QueryRow(ctx, `SELECT due_at::text,product_id::text,order_id::text FROM services WHERE id=$1`, job.ServiceID).Scan(&beforeDue, &oldProduct, &oldOrder); err != nil {
		t.Fatal(err)
	}
	stale := job
	stale.Token = "00000000-0000-4000-8000-000000000001"
	if err := queue.Complete(ctx, stale, Result{}); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("失效租约修改了变更: %v", err)
	}
	var unchanged bool
	if err := queue.Pool.QueryRow(ctx, `SELECT current_product_id IS NULL AND configuration='{}'::jsonb FROM services WHERE id=$1`, job.ServiceID).Scan(&unchanged); err != nil || !unchanged {
		t.Fatalf("确认前配置已改变: %v", err)
	}
	if err := queue.Complete(ctx, job, Result{ExternalID: "vm-upgrade-original"}); err != nil {
		t.Fatal(err)
	}
	var correct bool
	if err := queue.Pool.QueryRow(ctx, `SELECT current_product_id=$2 AND product_id::text=$3 AND order_id::text=$4 AND due_at::text=$5 AND renew_amount_cents=50 AND configuration='{"disk":2}'::jsonb AND status='active' AND external_id='vm-upgrade-original' FROM services WHERE id=$1`, job.ServiceID, targetID, oldProduct, oldOrder, beforeDue).Scan(&correct); err != nil || !correct {
		t.Fatalf("真实结果未原子应用: %v", err)
	}
	var status string
	if err := queue.Pool.QueryRow(ctx, `SELECT status FROM service_upgrades WHERE id=$1`, upgradeID).Scan(&status); err != nil || status != "succeeded" {
		t.Fatalf("变更状态错误: %s %v", status, err)
	}
	if err := queue.Complete(ctx, job, Result{}); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("重复租约再次应用配置: %v", err)
	}
}

func TestCallbackUpgradeUsesSameConfirmedResourceRules(t *testing.T) {
	ctx, queue := testQueue(t)
	queue.CallbackKeys = map[string][]byte{"test": callbackTestKey}
	job, targetID, _ := upgradeTask(t, ctx, queue)
	if err := queue.Wait(ctx, job, Result{Pending: true, CallbackReference: job.CallbackReference}); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(resourceNotification{Provider: job.Provider, JobID: job.ID, Reference: job.CallbackReference, Status: "succeeded", Result: Result{ExternalID: "vm-upgrade-original"}})
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler := Callbacks{Queue: queue}
	handler.ServeHTTP(response, signedCallback(job, raw, "upgrade-complete-nonce-0001", time.Now().Unix()))
	if response.Code != 200 {
		t.Fatalf("回调失败 %d: %s", response.Code, response.Body.String())
	}
	var correct bool
	if err = queue.Pool.QueryRow(ctx, `SELECT current_product_id=$2 AND configuration='{"disk":2}'::jsonb FROM services WHERE id=$1`, job.ServiceID, targetID).Scan(&correct); err != nil || !correct {
		t.Fatalf("异步确认未应用配置: %v", err)
	}
	repeated := httptest.NewRecorder()
	handler.ServeHTTP(repeated, signedCallback(job, raw, "upgrade-complete-nonce-0001", time.Now().Unix()))
	if repeated.Code != 200 {
		t.Fatalf("同nonce回放不幂等: %d", repeated.Code)
	}
}
