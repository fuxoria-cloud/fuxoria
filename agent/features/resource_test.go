/*
	资源私密边界验收：协议、独立密钥与本节点领取能力；数据库只使用随机schema。

调用：YUNZOU_TEST_DATABASE_URL=... go test -race ./features -run TestResource。
*/
package features

import (
	"bytes"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func resourceFixture(t *testing.T) (Job, []byte, ResourceCapability) {
	t.Helper()
	key := bytes.Repeat([]byte{0x57}, 32)
	cap := ResourceCapability{Inspect: []ResourceField{{Key: "status", Label: "状态"}}, ConsoleOrigins: []string{"https://console.resource.invalid"}, CredentialFields: []ResourceField{{Key: "password", Label: "密码"}}, ClientActions: []ClientAction{{ID: "reset", Label: "重置", Destructive: true, Fields: []ResourceField{{Key: "password", Label: "密码", Secret: true, Required: true}}}}}
	job := Job{ID: "30000000-0000-4000-8000-000000000038", ServiceID: "30000000-0000-4000-8000-000000000039", Action: "resource", Provider: "test"}
	enc, err := resourceSeal(key, job, "input", []byte(`{"password":"input-secret"}`))
	if err != nil {
		t.Fatal(err)
	}
	job.Payload, _ = json.Marshal(resourcePayload{Operation: "action", ActionID: "reset", Capability: cap, EncryptedInput: enc})
	return job, key, cap
}
func TestResourceInputAuthenticatedAndBoundToJob(t *testing.T) {
	job, key, cap := resourceFixture(t)
	t.Setenv("RESOURCE_KEY", strings.Repeat("57", 32))
	prepared, err := prepareResourceJob(job, Plugin{Resource: &cap})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(prepared.Payload), "input-secret") || strings.Contains(string(job.Payload), "input-secret") {
		t.Fatal("输入仅执行副本可以解密")
	}
	wrong := job
	wrong.ID = "30000000-0000-4000-8000-000000000040"
	if _, err = prepareResourceJob(wrong, Plugin{Resource: &cap}); err == nil {
		t.Fatal("跨任务密文被接受")
	}
	payload, _ := parseResource(job)
	if _, err = resourceOpen(bytes.Repeat([]byte{9}, 32), job, "input", payload.EncryptedInput); err == nil {
		t.Fatal("错误密钥被接受")
	}
	if len(key) != 32 {
		t.Fatal("fixture")
	}
	changed := cap
	changed.Inspect = []ResourceField{{Key: "changed", Label: "不同版本"}}
	if _, err = prepareResourceJob(job, Plugin{Resource: &changed}); err == nil {
		t.Fatal("变更后的能力不能执行旧任务")
	}
}
func TestResourcePrivateResultNeverInPublicJSON(t *testing.T) {
	job, key, cap := resourceFixture(t)
	job.Payload, _ = json.Marshal(resourcePayload{Operation: "credentials", Capability: cap, EncryptedInput: "v1.test"})
	queue := Queue{ResourceKey: key}
	result, err := queue.protectResource(job, Result{Data: json.RawMessage(`{"credentials":{"password":"supplier-secret"}}`)})
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(result)
	if strings.Contains(string(encoded), "supplier-secret") || result.privateCipher == "" {
		t.Fatal("私有数据进入公共JSON")
	}
	plain, err := resourceOpen(key, job, "output", result.privateCipher)
	if err != nil || !strings.Contains(string(plain), "supplier-secret") {
		t.Fatalf("私有结果无法解密 %v", err)
	}
	for _, raw := range []string{`{"credentials":{"unknown":"secret"}}`, `{"credentials":{"password":"secret"},"html":"<script>"}`, `{"credentials":{"password":"a","password":"b"}}`} {
		if _, err = queue.protectResource(job, Result{Data: json.RawMessage(raw)}); err == nil {
			t.Fatalf("不应接受未声明/重复字段%s", raw)
		}
	}
	pending, err := queue.protectResource(job, Result{Pending: true, Data: json.RawMessage(`{"credentials":{"password":"pending-secret"}}`)})
	encoded, _ = json.Marshal(pending)
	if err != nil || strings.Contains(string(encoded), "pending-secret") {
		t.Fatal("等待态不应复制敏感输出")
	}
}
func TestResourceSSOOriginAndExpiry(t *testing.T) {
	job, key, cap := resourceFixture(t)
	job.Payload, _ = json.Marshal(resourcePayload{Operation: "console", Capability: cap, EncryptedInput: "v1.test"})
	queue := Queue{ResourceKey: key}
	for _, u := range []string{"http://console.resource.invalid/sso", "https://console.resource.invalid.evil/sso", "https://user:pass@console.resource.invalid/sso", "javascript:alert(1)"} {
		raw, _ := json.Marshal(resourceData{Console: &resourceConsole{URL: u, ExpiresAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339)}})
		if _, err := queue.protectResource(job, Result{Data: raw}); err == nil {
			t.Fatalf("来源不应接受%s", u)
		}
	}
	for _, expiry := range []time.Time{time.Now().Add(-time.Second), time.Now().Add(6 * time.Minute)} {
		raw, _ := json.Marshal(resourceData{Console: &resourceConsole{URL: "https://console.resource.invalid/sso?token=secret", ExpiresAt: expiry.UTC().Format(time.RFC3339)}})
		if _, err := queue.protectResource(job, Result{Data: raw}); err == nil {
			t.Fatal("超期链接不应接受")
		}
	}
}
func TestResourceManifestRejectsMasterKeyEnvironment(t *testing.T) {
	directory := t.TempDir()
	program := filepath.Join(directory, "run")
	if err := os.WriteFile(program, []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	manifest := filepath.Join(directory, "test.json")
	raw, _ := json.Marshal(Plugin{Mode: "command", Executable: program, Actions: []string{"resource"}, Environment: []string{"RESOURCE_KEY"}, TimeoutSeconds: 5, Resource: &ResourceCapability{Inspect: []ResourceField{{Key: "status", Label: "状态"}}}})
	if err := os.WriteFile(manifest, raw, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadPlugins(directory, 30*time.Second); err == nil {
		t.Fatal("独立主密钥不得传给外部程序")
	}
}
func TestResourceClaimsOnlyInstalledCapability(t *testing.T) {
	ctx, queue := testQueue(t)
	jobID := task(t, ctx, queue)
	provision, err := queue.Claim(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err = queue.Complete(ctx, provision, Result{ExternalID: "vm-resource"}); err != nil {
		t.Fatal(err)
	}
	template, key, cap := resourceFixture(t)
	queue.ResourceKey = key
	var service, user string
	if err = queue.Pool.QueryRow(ctx, `SELECT s.id::text,s.user_id::text FROM jobs j JOIN services s ON s.id=j.service_id WHERE j.id=$1`, jobID).Scan(&service, &user); err != nil {
		t.Fatal(err)
	}
	var id string
	if err = queue.Pool.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	template.ID = id
	template.ServiceID = service
	encrypted, err := resourceSeal(key, template, "input", []byte(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(resourcePayload{Operation: "inspect", Capability: cap, EncryptedInput: encrypted})
	err = pgx.BeginFunc(ctx, queue.Pool, func(tx pgx.Tx) error {
		if _, e := tx.Exec(ctx, `INSERT INTO jobs(id,service_id,provider,action,payload,dedup_key) VALUES($1,$2,'test','resource',$3,($1::uuid)::text)`, id, service, payload); e != nil {
			return e
		}
		_, e := tx.Exec(ctx, `INSERT INTO resource_requests(job_id,service_id,user_id,actor_id,actor_version,idempotency_key,request_hash,operation) SELECT $1,$2,id,id,session_version,($1::uuid)::text,repeat('0',64),'inspect' FROM users WHERE id=$3`, id, service, user)
		return e
	})
	if err != nil {
		t.Fatal(err)
	}
	wrongCapability := cap
	wrongCapability.Inspect = []ResourceField{{Key: "uptime", Label: "不同版本"}}
	queue.Capabilities, _ = json.Marshal([]map[string]any{{"id": "test", "mode": "command", "actions": []string{"resource"}, "resource": wrongCapability}})
	if _, err = queue.Claim(ctx); !errors.Is(err, ErrEmpty) {
		t.Fatalf("不支持的节点不应领取资源 %v", err)
	}
	var attempts int
	if err = queue.Pool.QueryRow(ctx, `SELECT attempts FROM jobs WHERE id=$1`, id).Scan(&attempts); err != nil || attempts != 0 {
		t.Fatal("能力不匹配不能消耗重试")
	}
	queue.Capabilities, _ = json.Marshal([]map[string]any{{"id": "test", "mode": "command", "actions": []string{"resource"}, "resource": cap}})
	job, err := queue.Claim(ctx)
	if err != nil || job.ID != id {
		t.Fatalf("匹配节点未领取 %v", err)
	}
	if job.BillingCurrency != "CNY" {
		t.Fatal("未传服务合同币种")
	}
	if err = queue.ValidateResource(ctx, job); err != nil {
		t.Fatal(err)
	}
	if err = queue.Complete(ctx, job, Result{Data: json.RawMessage(`{"fields":{"status":"running"}}`)}); err != nil {
		t.Fatal(err)
	}
	var status string
	if err = queue.Pool.QueryRow(ctx, `SELECT status FROM services WHERE id=$1`, service).Scan(&status); err != nil || status != "active" {
		t.Fatal("状态查询不得篡改服务生命周期")
	}
}

func TestResourceMetricsWhitelistedTimeRange(t *testing.T) {
	job, _, cap := resourceFixture(t)
	cap.Metrics = []ResourceMetric{{Key: "traffic", Label: "流量"}}
	t.Setenv("RESOURCE_KEY", strings.Repeat("57", 32))
	key := bytes.Repeat([]byte{0x57}, 32)
	cases := []struct {
		input string
		valid bool
	}{{`{}`, true}, {`{"metric":"traffic","from":"2026-01-01T00:00:00Z","to":"2026-01-02T00:00:00Z"}`, true}, {`{"metric":"undeclared"}`, false}, {`{"from":"2026-01-01T00:00:00Z"}`, false}, {`{"from":"2026-01-01T00:00:00Z","to":"2026-03-01T00:00:00Z"}`, false}, {`{"from":"bad","to":"2026-01-02T00:00:00Z"}`, false}, {`{"password":"secret"}`, false}}
	for _, item := range cases {
		encrypted, err := resourceSeal(key, job, "input", []byte(item.input))
		if err != nil {
			t.Fatal(err)
		}
		job.Payload, _ = json.Marshal(resourcePayload{Operation: "metrics", Capability: cap, EncryptedInput: encrypted})
		_, err = prepareResourceJob(job, Plugin{Resource: &cap})
		if (err == nil) != item.valid {
			t.Fatalf("时间范围验证不符 %s %v", item.input, err)
		}
	}
}
