/*
	多周期交付验收：真实任务完成使用合同月数，一次性资源不设置到期日。

调用：YUNZOU_TEST_DATABASE_URL=postgres://... go test -race ./features -run TestQueueBillingPeriods
*/
package features

import "testing"

func TestQueueBillingPeriods(t *testing.T) {
	ctx, queue := testQueue(t)
	for _, cycle := range []struct {
		period  string
		months  int
		seconds int
	}{{"hour", 0, 3600}, {"day", 0, 86400}, {"ontrial", 0, 604800}, {"month", 1, 0}, {"quarter", 3, 0}, {"halfyear", 6, 0}, {"year", 12, 0}, {"biennium", 24, 0}, {"triennium", 36, 0}, {"onetime", 0, 0}} {
		t.Run(cycle.period, func(t *testing.T) {
			id := task(t, ctx, queue)
			if _, err := queue.Pool.Exec(ctx, `UPDATE services SET billing_period=$2,billing_months=$3,billing_seconds=$4,configuration='{"disk":3,"region":"jp"}' WHERE id=(SELECT service_id FROM jobs WHERE id=$1)`, id, cycle.period, cycle.months, cycle.seconds); err != nil {
				t.Fatal(err)
			}
			job, err := queue.Claim(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if job.BillingPeriod != cycle.period || job.BillingMonths != cycle.months || job.BillingSeconds != cycle.seconds || string(job.Configuration) != `{"disk": 3, "region": "jp"}` {
				t.Fatalf("供应商任务缺少成交资源合同: %+v", job)
			}
			if err = queue.Complete(ctx, job, Result{ExternalID: "cycle-" + cycle.period}); err != nil {
				t.Fatal(err)
			}
			var correct bool
			if err = queue.Pool.QueryRow(ctx, `SELECT CASE WHEN billing_months=0 AND billing_seconds=0 THEN due_at IS NULL ELSE due_at BETWEEN now()+make_interval(months=>billing_months,secs=>billing_seconds)-interval '2 seconds' AND now()+make_interval(months=>billing_months,secs=>billing_seconds)+interval '2 seconds' END FROM services WHERE id=$1`, job.ServiceID).Scan(&correct); err != nil || !correct {
				t.Fatalf("首次交付周期错误: %v", err)
			}
			if cycle.period == "ontrial" {
				return
			}
			if _, err = queue.Pool.Exec(ctx, `UPDATE services SET due_at='2099-01-31T12:00:00Z' WHERE id=$1`, job.ServiceID); err != nil {
				t.Fatal(err)
			}
			if _, err = queue.Pool.Exec(ctx, `INSERT INTO jobs(service_id,action,provider,dedup_key) VALUES($1,'renew','test',gen_random_uuid()::text)`, job.ServiceID); err != nil {
				t.Fatal(err)
			}
			renewal, err := queue.Claim(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if err = queue.Complete(ctx, renewal, Result{}); err != nil {
				t.Fatal(err)
			}
			if err = queue.Pool.QueryRow(ctx, `SELECT CASE WHEN billing_months=0 AND billing_seconds=0 THEN due_at IS NULL ELSE due_at='2099-01-31T12:00:00Z'::timestamptz+make_interval(months=>billing_months,secs=>billing_seconds) END FROM services WHERE id=$1`, job.ServiceID).Scan(&correct); err != nil || !correct {
				t.Fatalf("续费日历月边界错误: %v", err)
			}
		})
	}
}
