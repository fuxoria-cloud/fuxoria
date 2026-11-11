/*
资源回调验收：签名请求经过真实HTTP解析与独立PostgreSQL schema，覆盖并发、重放与旧租约。
调用：YUNZOU_TEST_DATABASE_URL=postgres://... go test -race ./features -run 'TestCallback|TestQueueWaiting'。
所有供应商密钥与资源ID都是测试夹具，不调用任何真实开通接口。
*/
package features

import (
	"bytes"             // 保留参与签名的原始正文
	"crypto/hmac"       // 从供应商一侧独立构造签名
	"crypto/sha256"     // 与公开协议使用同一算法
	"encoding/hex"      // 公开测试密钥不用于实际部署
	"encoding/json"     // 构造标准资源通知
	"errors"            // 核对租约失效与空队列
	"net/http"          // 检查实际HTTP状态
	"net/http/httptest" // 不占用公共端口即可运行HTTP边界
	"strconv"           // 秒时间戳必须按原文签名
	"strings"           // 构造重复字段和超限输入
	"sync"              // 真正同时提交重复事件
	"testing"           // Go标准测试入口
	"time"              // 五分钟窗口与过期等待
)

var callbackTestKey = bytes.Repeat([]byte{0x41}, 32) // 公开测试夹具，生产密钥只从受控环境加载

// --- 构造供应商实际发送的签名HTTP请求 ---
func signedCallback(job Job, raw []byte, nonce string, seconds int64) *http.Request {
	path := "/callbacks/jobs/" + job.ID          // 路径也必须参与签名
	timestamp := strconv.FormatInt(seconds, 10)  // 保存与请求头完全一致的时间文本
	mac := hmac.New(sha256.New, callbackTestKey) // 模拟持有本测试供应商密钥的一方
	_, _ = mac.Write([]byte("POST\n" + path + "\n" + timestamp + "\n" + nonce + "\n"))
	_, _ = mac.Write(raw)
	_, _ = mac.Write([]byte("\n"))                                              // 正文原样参与签名
	request := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(raw)) // 使用标准HTTP请求解析
	request.Header.Set("Content-Type", "application/json")                      // 生产供应商同样提交JSON
	request.Header.Set("X-Yunzou-Provider", job.Provider)
	request.Header.Set("X-Yunzou-Timestamp", timestamp) // 身份与时间分别传递
	request.Header.Set("X-Yunzou-Nonce", nonce)
	request.Header.Set("X-Yunzou-Signature", hex.EncodeToString(mac.Sum(nil))) // nonce与HMAC需要完整回传
	return request                                                             // 测试可以在签名之后故意篡改单个字段
}

func callbackBody(t *testing.T, job Job) []byte {
	t.Helper()                                                                                                                                                                                                                               // 夹具失败定位到场景调用点
	raw, err := json.Marshal(resourceNotification{Provider: job.Provider, JobID: job.ID, Reference: job.CallbackReference, Status: "succeeded", Result: Result{ExternalID: "vm-callback-real", Data: json.RawMessage(`{"region":"test"}`)}}) // 真实完成结果需要资源ID
	if err != nil {
		t.Fatal(err)
	} // 不能把坏夹具当作业务失败
	return raw // 后续重试必须保留同一份原始字节
}

func TestCallbackKeysRejectMalformedConfiguration(t *testing.T) {
	for _, raw := range []string{`null`, `[]`, `{"test":"short"}`, `{"test":"` + strings.Repeat("4", 64) + `","test":"` + strings.Repeat("5", 64) + `"}`} {
		if _, err := CallbackKeys(raw); err == nil {
			t.Fatalf("不应接受配置: %s", raw)
		} // 重复供应商名不能静默覆盖密钥
	}
	keys, err := CallbackKeys(`{"test":"` + strings.Repeat("41", 32) + `"}`) // 一份标准64位hex配置
	if err != nil || !hmac.Equal(keys["test"], callbackTestKey) {
		t.Fatalf("有效配置无法读取: %v", err)
	} // 验证不是误读UTF8密钥文本
}

func TestCallbackConcurrentNonceIsIdempotent(t *testing.T) {
	ctx, queue := testQueue(t)
	queue.CallbackKeys = map[string][]byte{"test": callbackTestKey} // 数据只写隔离schema
	task(t, ctx, queue)
	job, err := queue.Claim(ctx)
	if err != nil {
		t.Fatal(err)
	} // 取得实际有效租约和回调引用
	if err = queue.Wait(ctx, job, Result{Pending: true, CallbackReference: job.CallbackReference}); err != nil {
		t.Fatal(err)
	} // 机构受理后只进入等待
	raw := callbackBody(t, job)
	handler := Callbacks{Queue: queue} // 共享只读密钥配置，可并发处理
	var group sync.WaitGroup
	statuses := make(chan int, 12) // 同一个事件真正并发重放
	for number := 0; number < 12; number++ {
		group.Add(1)
		go func() {
			defer group.Done()
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, signedCallback(job, raw, "same-nonce-callback-0001", time.Now().Unix()))
			statuses <- response.Code
		}()
	} // 每次都是独立HTTP请求
	group.Wait()
	close(statuses) // 所有请求完成后核对数据库事实
	for status := range statuses {
		if status != 200 {
			t.Fatalf("相同事件重试应返回200，实际%d", status)
		}
	} // 不能因任务已完成破坏幂等回执
	var state, resource string
	var events, successes int // 同时验证资源、nonce和审计
	if err = queue.Pool.QueryRow(ctx, `SELECT j.state,s.external_id,(SELECT count(*) FROM resource_callbacks),(SELECT count(*) FROM audit WHERE action='job.succeeded') FROM jobs j JOIN services s ON s.id=j.service_id WHERE j.id=$1`, job.ID).Scan(&state, &resource, &events, &successes); err != nil {
		t.Fatal(err)
	} // 查询实际提交结果
	if state != "succeeded" || resource != "vm-callback-real" || events != 1 || successes != 1 {
		t.Fatalf("事件没有恰好一次落库: %s %s %d %d", state, resource, events, successes)
	} // 多次HTTP只形成一个完成事实
	changed := bytes.Replace(raw, []byte("vm-callback-real"), []byte("vm-other-resource"), 1) // 同nonce改正文后重新签名
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, signedCallback(job, changed, "same-nonce-callback-0001", time.Now().Unix())) // 即使签名有效也不能改变同事件内容
	if response.Code != 409 {
		t.Fatalf("同nonce不同正文应拒绝，实际%d", response.Code)
	} // 不能覆盖已提交资源
}

func TestCallbackRejectsTamperingDuplicatesAndOldReferences(t *testing.T) {
	ctx, queue := testQueue(t)
	queue.CallbackKeys = map[string][]byte{"test": callbackTestKey, "other": callbackTestKey} // 两个供应商名也必须分别绑定任务
	id := task(t, ctx, queue)
	old, err := queue.Claim(ctx)
	if err != nil {
		t.Fatal(err)
	} // 第一个owner的引用不可复用
	if _, err = queue.Pool.Exec(ctx, `UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	} // 模拟旧进程租约失效
	job, err := queue.Claim(ctx)
	if err != nil {
		t.Fatal(err)
	} // 重领会生成新的独立引用
	if job.CallbackReference == old.CallbackReference || job.CallbackReference == job.Token {
		t.Fatal("回调引用必须独立于旧引用和租约")
	} // 不能把内部凭据交给外部
	if err = queue.Wait(ctx, job, Result{Pending: true, CallbackReference: job.CallbackReference}); err != nil {
		t.Fatal(err)
	} // 只有新owner可以进入waiting
	if err = queue.Wait(ctx, old, Result{Pending: true, CallbackReference: old.CallbackReference}); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("旧owner覆盖等待状态: %v", err)
	} // 等待转换也必须fencing
	handler := Callbacks{Queue: queue}
	raw := callbackBody(t, job) // 后续全部使用真实原始正文
	cases := []struct {
		name    string
		body    []byte
		job     Job
		seconds int64
		want    int
	}{
		{"old-reference", callbackBody(t, old), old, time.Now().Unix(), 409},                                                                                    // 旧结果即使签名正确也不能完成新一轮任务
		{"expired-signature", raw, job, time.Now().Unix() - 301, 401},                                                                                           // 超出五分钟窗口
		{"duplicate-key", bytes.Replace(raw, []byte(`"status":"succeeded"`), []byte(`"status":"failed","status":"succeeded"`), 1), job, time.Now().Unix(), 400}, // JSON覆盖字段不可接受
		{"nested-duplicate", bytes.Replace(raw, []byte(`{"region":"test"}`), []byte(`{"region":"wrong","region":"test"}`), 1), job, time.Now().Unix(), 400},     // 结果data内部也必须拒绝重复字段
		{"oversized", []byte(strings.Repeat("x", 65537)), job, time.Now().Unix(), 413},                                                                          // 在解析或入库前限制正文
	}
	for number, scenario := range cases {
		t.Run(scenario.name, func(t *testing.T) {
			reply := httptest.NewRecorder()
			handler.ServeHTTP(reply, signedCallback(scenario.job, scenario.body, "rejection-case-nonce-"+strconv.Itoa(number), scenario.seconds))
			if reply.Code != scenario.want {
				t.Fatalf("期望%d，实际%d：%s", scenario.want, reply.Code, reply.Body.String())
			}
		})
	} // 每个拒绝条件独立验证
	other := job
	other.Provider = "other" // 用另一个供应商自己的有效密钥签名
	otherRaw := callbackBody(t, other)
	reply := httptest.NewRecorder()
	handler.ServeHTTP(reply, signedCallback(other, otherRaw, "wrong-provider-nonce-01", time.Now().Unix())) // 任务供应商仍是test
	if reply.Code != 409 {
		t.Fatalf("错供应商完成了任务: %d", reply.Code)
	} // 有其它供应商密钥也不能串单
	request := signedCallback(job, raw, "tampered-path-nonce-01", time.Now().Unix())
	request.URL.Path = "/callbacks/jobs/00000000-0000-4000-8000-000000000000" // 签名后改路径
	reply = httptest.NewRecorder()
	handler.ServeHTTP(reply, request)
	if reply.Code != 401 {
		t.Fatalf("路径没有被签名绑定: %d", reply.Code)
	} // 证明HTTP路径包含在MAC中
	request = signedCallback(job, raw, "duplicate-header-nonce1", time.Now().Unix())
	request.Header.Add("X-Yunzou-Nonce", "another-value") // 重复签名头不能取第一项
	reply = httptest.NewRecorder()
	handler.ServeHTTP(reply, request)
	if reply.Code != 401 {
		t.Fatalf("重复头部未被拒绝: %d", reply.Code)
	} // 请求语义保持唯一
	var state string
	if err = queue.Pool.QueryRow(ctx, `SELECT state FROM jobs WHERE id=$1`, job.ID).Scan(&state); err != nil {
		t.Fatal(err)
	} // 全部攻击后仍是waiting
	if state != "waiting" {
		t.Fatalf("拒绝请求改变了任务: %s", state)
	} // 没有任何伪成功
}

func TestQueueWaitingTimeoutNeverReopensResource(t *testing.T) {
	ctx, queue := testQueue(t)
	queue.CallbackKeys = map[string][]byte{"test": callbackTestKey} // 本场景等待真实回调
	id := task(t, ctx, queue)
	job, err := queue.Claim(ctx)
	if err != nil {
		t.Fatal(err)
	} // 领取当前资源任务
	if err = queue.Wait(ctx, job, Result{Pending: true, CallbackReference: job.CallbackReference}); err != nil {
		t.Fatal(err)
	} // 清除内部租约并持久等待
	if _, err = queue.Pool.Exec(ctx, `INSERT INTO jobs(service_id,action,provider,dedup_key) VALUES($1,'suspend','test','blocked-behind-waiting')`, job.ServiceID); err != nil {
		t.Fatal(err)
	} // 同服务排另一个动作
	if _, err = queue.Claim(ctx); !errors.Is(err, ErrEmpty) {
		t.Fatalf("waiting没有阻挡同服务动作: %v", err)
	} // 不能并行处理正在开通的资源
	if _, err = queue.Pool.Exec(ctx, `UPDATE jobs SET callback_deadline=now()-interval '1 second' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	} // 模拟等待超时
	if err = queue.ExpireCallbacks(ctx); err != nil {
		t.Fatal(err)
	} // 超时只转人工核对
	var state string
	if err = queue.Pool.QueryRow(ctx, `SELECT state FROM jobs WHERE id=$1`, id).Scan(&state); err != nil {
		t.Fatal(err)
	} // 检查持久终态
	if state != "manual_review" {
		t.Fatalf("超时未转人工核对: %s", state)
	} // 不能重新排队开资源
	if _, err = queue.Claim(ctx); !errors.Is(err, ErrEmpty) {
		t.Fatalf("人工核对期间仍执行同服务动作: %v", err)
	} // 未确认资源继续阻挡后续操作
	reply := httptest.NewRecorder()
	Callbacks{Queue: queue}.ServeHTTP(reply, signedCallback(job, callbackBody(t, job), "late-callback-after-timeout", time.Now().Unix())) // 供应商迟到通知不能悄悄复活任务
	if reply.Code != 409 {
		t.Fatalf("超时任务被迟到回调完成: %d", reply.Code)
	} // 只有waiting且未超时可以完成
	if err = queue.Complete(ctx, job, Result{ExternalID: "late-owner"}); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("旧租约完成了waiting任务: %v", err)
	} // 内部owner也不能跨状态覆盖
}

func TestCallbackEarlyEventRetriesAfterWaitingCommit(t *testing.T) {
	ctx, queue := testQueue(t)
	queue.CallbackKeys = map[string][]byte{"test": callbackTestKey} // 快速供应商可能先推送完成再返回受理结果
	task(t, ctx, queue)
	job, err := queue.Claim(ctx)
	if err != nil {
		t.Fatal(err)
	} // 任务此时仍在running
	raw := callbackBody(t, job)
	handler := Callbacks{Queue: queue}
	reply := httptest.NewRecorder()                                                                  // 一份事件从始至终保持原nonce和正文
	handler.ServeHTTP(reply, signedCallback(job, raw, "early-event-retry-nonce", time.Now().Unix())) // 尚未持久保存pending
	if reply.Code != 503 {
		t.Fatalf("过早回调应明确要求重试，实际%d", reply.Code)
	} // 不能提前完成，也不能回不可重试的成功
	var saved int
	if err = queue.Pool.QueryRow(ctx, `SELECT count(*) FROM resource_callbacks`).Scan(&saved); err != nil {
		t.Fatal(err)
	} // 过早事件不能消费nonce
	if saved != 0 {
		t.Fatal("尚未接受的事件提前消费了nonce")
	} // 接下来重试仍应有权落库
	if err = queue.Wait(ctx, job, Result{Pending: true, CallbackReference: job.CallbackReference}); err != nil {
		t.Fatal(err)
	} // 插件现在返回真实受理结果
	reply = httptest.NewRecorder()
	handler.ServeHTTP(reply, signedCallback(job, raw, "early-event-retry-nonce", time.Now().Unix())) // 同事件按明确提示稍后重试
	if reply.Code != 200 {
		t.Fatalf("进入waiting后原事件不能完成: %d %s", reply.Code, reply.Body.String())
	} // 回调不会因到达次序丢失
}
