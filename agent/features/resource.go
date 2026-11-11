/*
	客户资源扩展：白名单能力、执行前解密、首次持久化前分离私有输出。

调用：清单resource声明clientActions/inspect/metrics/consoleOrigins/credentialFields，并在actions加入resource。
供应商仅接收解密后的本次input，不接触RESOURCE_KEY；公共字段不渲染HTML，私有结果AES-GCM绑定服务和任务。
*/
package features

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"os"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/fuxoria-cloud/fuxoria/agent/utils"
	"github.com/jackc/pgx/v5"
)

type ResourceField struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	Secret   bool   `json:"secret,omitempty"`
	Required bool   `json:"required,omitempty"`
}
type ClientAction struct {
	ID          string          `json:"id"`
	Label       string          `json:"label"`
	Destructive bool            `json:"destructive,omitempty"`
	Fields      []ResourceField `json:"fields,omitempty"`
}
type ResourceMetric struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Unit  string `json:"unit,omitempty"`
}
type ResourceCapability struct {
	ClientActions    []ClientAction   `json:"clientActions,omitempty"`
	Inspect          []ResourceField  `json:"inspect,omitempty"`
	Metrics          []ResourceMetric `json:"metrics,omitempty"`
	ConsoleOrigins   []string         `json:"consoleOrigins,omitempty"`
	CredentialFields []ResourceField  `json:"credentialFields,omitempty"`
}
type resourcePayload struct {
	Operation      string             `json:"operation"`
	ActionID       string             `json:"actionId"`
	Capability     ResourceCapability `json:"capability"`
	EncryptedInput string             `json:"encryptedInput"`
}
type metricPoint struct {
	At    string  `json:"at"`
	Value float64 `json:"value"`
}
type resourceConsole struct {
	URL       string `json:"url"`
	ExpiresAt string `json:"expiresAt"`
}
type resourceData struct {
	Fields      map[string]string        `json:"fields,omitempty"`
	Metrics     map[string][]metricPoint `json:"metrics,omitempty"`
	Console     *resourceConsole         `json:"console,omitempty"`
	Credentials map[string]string        `json:"credentials,omitempty"`
}

var resourceName = regexp.MustCompile(`^[a-z][a-zA-Z0-9_]{0,39}$`)

// ResourceKey 单独解析资源密钥，空值表示尚未启用；错误不回显原配置。
func ResourceKey(raw string) ([]byte, error) {
	if raw == "" {
		return nil, nil
	}
	key, err := hex.DecodeString(raw)
	if err != nil || len(key) != 32 {
		return nil, fmt.Errorf("RESOURCE_KEY必须为独立32字节hex密钥")
	}
	return key, nil
}
func resourceAAD(job Job, direction string) []byte {
	return []byte("yunzou-resource:v1:" + job.ServiceID + ":" + job.ID + ":" + direction)
}
func resourceSeal(key []byte, job Job, direction string, plain []byte) (string, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("资源加密密钥不可用")
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return "", err
	}
	ciphertext := gcm.Seal(nil, nonce, plain, resourceAAD(job, direction))
	tagAt := len(ciphertext) - gcm.Overhead()
	enc := base64.RawURLEncoding.EncodeToString
	return "v1." + enc(nonce) + "." + enc(ciphertext[:tagAt]) + "." + enc(ciphertext[tagAt:]), nil
}
func resourceOpen(key []byte, job Job, direction, encoded string) ([]byte, error) {
	parts := strings.Split(encoded, ".")
	if len(parts) != 4 || parts[0] != "v1" {
		return nil, fmt.Errorf("资源加密载荷无效")
	}
	values := make([][]byte, 3)
	for i := range values {
		v, err := base64.RawURLEncoding.DecodeString(parts[i+1])
		if err != nil {
			return nil, fmt.Errorf("资源加密载荷无效")
		}
		values[i] = v
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("资源加密密钥不可用")
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil || len(values[0]) != gcm.NonceSize() || len(values[2]) != gcm.Overhead() {
		return nil, fmt.Errorf("资源加密载荷无效")
	}
	plain, err := gcm.Open(nil, values[0], append(values[1], values[2]...), resourceAAD(job, direction))
	if err != nil {
		return nil, fmt.Errorf("资源加密载荷校验失败")
	}
	return plain, nil
}
func validResource(cap *ResourceCapability) error {
	if cap == nil {
		return nil
	}
	validFields := func(fields []ResourceField) bool {
		seen := map[string]bool{}
		for _, f := range fields {
			if !resourceName.MatchString(f.Key) || len(f.Label) == 0 || len(f.Label) > 240 || seen[f.Key] {
				return false
			}
			seen[f.Key] = true
		}
		return true
	}
	if len(cap.ClientActions) > 30 || len(cap.Inspect) > 30 || len(cap.Metrics) > 12 || len(cap.ConsoleOrigins) > 10 || len(cap.CredentialFields) > 20 || !validFields(cap.Inspect) || !validFields(cap.CredentialFields) {
		return fmt.Errorf("资源能力字段无效")
	}
	seen := map[string]bool{}
	for _, a := range cap.ClientActions {
		if !resourceName.MatchString(a.ID) || len(a.Label) == 0 || len(a.Label) > 240 || seen[a.ID] || len(a.Fields) > 20 || !validFields(a.Fields) {
			return fmt.Errorf("客户动作无效")
		}
		seen[a.ID] = true
	}
	seen = map[string]bool{}
	for _, m := range cap.Metrics {
		if !resourceName.MatchString(m.Key) || seen[m.Key] || len(m.Label) == 0 || len(m.Label) > 240 || len(m.Unit) > 60 {
			return fmt.Errorf("监控字段无效")
		}
		seen[m.Key] = true
	}
	for _, origin := range cap.ConsoleOrigins {
		u, err := url.Parse(origin)
		if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
			return fmt.Errorf("控制台必须声明不带路径与凭据的HTTPS来源")
		}
	}
	return nil
}
func parseResource(job Job) (resourcePayload, error) {
	var payload resourcePayload
	if err := utils.JSON(job.Payload, &payload); err != nil {
		return payload, fmt.Errorf("资源任务协议无效")
	}
	if err := validResource(&payload.Capability); err != nil {
		return payload, err
	}
	switch payload.Operation {
	case "action":
		if !slices.ContainsFunc(payload.Capability.ClientActions, func(a ClientAction) bool { return a.ID == payload.ActionID }) {
			return payload, fmt.Errorf("客户动作未声明")
		}
	case "inspect":
		if len(payload.Capability.Inspect) == 0 {
			return payload, fmt.Errorf("未声明资源状态")
		}
	case "metrics":
		if len(payload.Capability.Metrics) == 0 {
			return payload, fmt.Errorf("未声明资源监控")
		}
	case "console":
		if len(payload.Capability.ConsoleOrigins) == 0 {
			return payload, fmt.Errorf("未声明控制台")
		}
	case "credentials":
		if len(payload.Capability.CredentialFields) == 0 {
			return payload, fmt.Errorf("未声明凭据")
		}
	default:
		return payload, fmt.Errorf("资源操作无效")
	}
	if payload.Operation != "action" && payload.ActionID != "" {
		return payload, fmt.Errorf("资源动作名无效")
	}
	return payload, nil
}
func prepareResourceJob(job Job, plugin Plugin) (Job, error) {
	payload, err := parseResource(job)
	if err != nil {
		return job, err
	}
	if plugin.Resource == nil {
		return job, fmt.Errorf("插件未声明资源能力")
	}
	expected, _ := json.Marshal(plugin.Resource)
	actual, _ := json.Marshal(payload.Capability)
	if !bytes.Equal(expected, actual) {
		return job, fmt.Errorf("插件能力已变化，请重新提交资源操作")
	}
	key, err := ResourceKey(os.Getenv("RESOURCE_KEY"))
	if err != nil || len(key) != 32 {
		return job, fmt.Errorf("资源独立加密密钥不可用")
	}
	plain, err := resourceOpen(key, job, "input", payload.EncryptedInput)
	if err != nil {
		return job, err
	}
	var input map[string]string
	if err = utils.JSON(plain, &input); err != nil || len(input) > 20 {
		return job, fmt.Errorf("资源参数无效")
	}
	fields := []ResourceField{}
	if payload.Operation == "action" {
		for _, a := range payload.Capability.ClientActions {
			if a.ID == payload.ActionID {
				fields = a.Fields
			}
		}
	}
	if payload.Operation == "metrics" {
		for k := range input {
			if !slices.Contains([]string{"from", "to", "metric"}, k) {
				return job, fmt.Errorf("监控参数未声明")
			}
		}
		if input["metric"] != "" && !slices.ContainsFunc(payload.Capability.Metrics, func(m ResourceMetric) bool { return m.Key == input["metric"] }) {
			return job, fmt.Errorf("监控指标未声明")
		}
		if (input["from"] == "") != (input["to"] == "") {
			return job, fmt.Errorf("监控时间段不完整")
		}
		if input["from"] != "" {
			from, e1 := time.Parse(time.RFC3339, input["from"])
			to, e2 := time.Parse(time.RFC3339, input["to"])
			if e1 != nil || e2 != nil || !to.After(from) || to.Sub(from) > 31*24*time.Hour || to.After(time.Now().Add(time.Minute)) {
				return job, fmt.Errorf("监控时间段无效")
			}
		}
		fields = []ResourceField{{Key: "from"}, {Key: "to"}, {Key: "metric"}}
	}
	for k, v := range input {
		if len(v) > 4096 || !slices.ContainsFunc(fields, func(f ResourceField) bool { return f.Key == k }) {
			return job, fmt.Errorf("资源参数不在声明内")
		}
	}
	for _, f := range fields {
		if f.Required && input[f.Key] == "" {
			return job, fmt.Errorf("缺少资源必填参数")
		}
	}
	job.Payload, err = json.Marshal(map[string]any{"operation": payload.Operation, "actionId": payload.ActionID, "input": input})
	return job, err
}

// ValidateResource 在外部执行前再次检查当前归属、账号版本及转移/取消/升级，防止排队期间授权变化。
func (queue Queue) ValidateResource(ctx context.Context, job Job) error {
	if job.Action != "resource" {
		return nil
	}
	var allowed bool
	err := queue.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM resource_requests r JOIN jobs j ON j.id=r.job_id AND j.state='running' AND j.lease_token=$2::uuid AND j.lease_until>now() JOIN services s ON s.id=r.service_id JOIN users u ON u.id=r.actor_id JOIN users owner ON owner.id=r.user_id WHERE NOT owner.disabled AND (r.api_key_id IS NULL OR EXISTS(SELECT 1 FROM api_keys k WHERE k.id=r.api_key_id AND k.revoked_at IS NULL AND k.expires_at>now() AND k.session_version=u.session_version)) AND r.job_id=$1 AND r.user_id=COALESCE(s.current_owner_id,s.user_id) AND NOT u.disabled AND u.session_version=r.actor_version AND s.status IN ('active','suspended') AND s.external_id IS NOT NULL AND s.termination_requested_at IS NULL AND NOT EXISTS(SELECT 1 FROM service_transfers t WHERE t.service_id=s.id AND t.status='pending') AND NOT EXISTS(SELECT 1 FROM service_cancellations c WHERE c.service_id=s.id AND c.status IN ('pending','approved','executing')) AND NOT EXISTS(SELECT 1 FROM service_upgrades g WHERE g.service_id=s.id AND g.status IN ('quoted','unpaid','queued','review')))`, job.ID, job.Token).Scan(&allowed)
	if err != nil || !allowed {
		return fmt.Errorf("资源授权或服务状态已变化，未执行供应商操作")
	}
	return nil
}

// protectResource 在任何结果INSERT/UPDATE之前调用，明文私有输出从不写入jobs.result或审计。
func (queue Queue) protectResource(job Job, result Result) (Result, error) {
	if job.Action != "resource" {
		return result, nil
	}
	payload, err := parseResource(job)
	if err != nil {
		return Result{}, err
	}
	if result.Pending {
		return Result{Pending: true, CallbackReference: result.CallbackReference}, nil
	}
	if result.ExternalID != "" {
		if job.ExternalID == nil || result.ExternalID != *job.ExternalID {
			return Result{}, fmt.Errorf("资源结果不能改变供应商标识")
		}
	}
	var data resourceData
	if len(result.Data) > 0 {
		if err = utils.JSON(result.Data, &data); err != nil {
			return Result{}, fmt.Errorf("资源结果包含未声明的数据结构")
		}
	}
	public := map[string]any{"operation": payload.Operation}
	private := map[string]any{}
	expires := time.Now().Add(5 * time.Minute)
	switch payload.Operation {
	case "inspect":
		if len(data.Metrics) > 0 || data.Console != nil || len(data.Credentials) > 0 {
			return Result{}, fmt.Errorf("状态结果不接受其它能力数据")
		}
		for k, v := range data.Fields {
			if len(v) > 4096 || !slices.ContainsFunc(payload.Capability.Inspect, func(f ResourceField) bool { return f.Key == k }) {
				return Result{}, fmt.Errorf("状态字段未声明")
			}
		}
		public["fields"] = data.Fields
	case "metrics":
		if len(data.Fields) > 0 || data.Console != nil || len(data.Credentials) > 0 || len(data.Metrics) > 12 {
			return Result{}, fmt.Errorf("监控结果结构无效")
		}
		for k, points := range data.Metrics {
			if !slices.ContainsFunc(payload.Capability.Metrics, func(m ResourceMetric) bool { return m.Key == k }) || len(points) > 300 {
				return Result{}, fmt.Errorf("监控字段未声明或超过300点")
			}
			var previous time.Time
			for _, point := range points {
				at, err := time.Parse(time.RFC3339, point.At)
				if err != nil || math.IsNaN(point.Value) || math.IsInf(point.Value, 0) || (!previous.IsZero() && at.Before(previous)) || at.After(time.Now().Add(time.Minute)) {
					return Result{}, fmt.Errorf("监控数据无效")
				}
				previous = at
			}
		}
		public["metrics"] = data.Metrics
	case "console":
		if data.Console == nil || len(data.Fields) > 0 || len(data.Metrics) > 0 || len(data.Credentials) > 0 {
			return Result{}, fmt.Errorf("控制台结果结构无效")
		}
		u, err := url.Parse(data.Console.URL)
		until, timeErr := time.Parse(time.RFC3339, data.Console.ExpiresAt)
		if err != nil || u.Scheme != "https" || u.User != nil || u.Host == "" || !slices.Contains(payload.Capability.ConsoleOrigins, u.Scheme+"://"+u.Host) || len(data.Console.URL) > 8192 || timeErr != nil || !until.After(time.Now()) || until.After(expires) {
			return Result{}, fmt.Errorf("控制台链接来源或有效期无效")
		}
		private["console"] = data.Console
		expires = until
	case "credentials":
		if len(data.Credentials) == 0 || len(data.Credentials) > 20 || len(data.Fields) > 0 || len(data.Metrics) > 0 || data.Console != nil {
			return Result{}, fmt.Errorf("凭据结果结构无效")
		}
		for k, v := range data.Credentials {
			if len(v) > 4096 || !slices.ContainsFunc(payload.Capability.CredentialFields, func(f ResourceField) bool { return f.Key == k }) {
				return Result{}, fmt.Errorf("凭据字段未声明")
			}
		}
		private["credentials"] = data.Credentials
	case "action":
		if len(data.Fields) > 0 || len(data.Metrics) > 0 || data.Console != nil || len(data.Credentials) > 0 {
			return Result{}, fmt.Errorf("动作结果不接受额外数据")
		}
	}
	result = Result{}
	if len(private) > 0 {
		plain, _ := json.Marshal(private)
		encrypted, err := resourceSeal(queue.ResourceKey, job, "output", plain)
		if err != nil {
			return result, err
		}
		result.privateCipher = encrypted
		result.privateExpires = expires
		public["privateAvailable"] = true
		public["expiresAt"] = expires.UTC().Format(time.RFC3339)
	}
	result.Data, err = json.Marshal(public)
	return result, err
}
func (queue Queue) applyResource(ctx context.Context, tx pgx.Tx, job Job, result Result) error {
	var valid bool
	err := tx.QueryRow(ctx, `SELECT r.user_id=COALESCE(s.current_owner_id,s.user_id) FROM resource_requests r JOIN services s ON s.id=r.service_id WHERE r.job_id=$1 FOR UPDATE OF s`, job.ID).Scan(&valid)
	if err != nil {
		return err
	}
	if !valid {
		return fmt.Errorf("资源归属已变化，结果未提交")
	}
	if result.privateCipher != "" {
		if _, err = tx.Exec(ctx, `INSERT INTO resource_private_outputs(job_id,ciphertext,expires_at) VALUES($1,$2,$3)`, job.ID, result.privateCipher, result.privateExpires); err != nil {
			return err
		}
	}
	return queue.audit(ctx, tx, "resource.completed", job, map[string]any{"serviceId": job.ServiceID, "jobId": job.ID})
}
