/*
资源回调：验证供应商HMAC、时间和nonce，再完成waiting任务与真实资源状态。
调用：handler := Callbacks{Queue: queue}；仅在显式开启监听后交给http.Server。
异步：queue.Wait(ctx, job, Result{Pending:true,CallbackReference:job.CallbackReference})。
资金通知不经过本文件；回调从不接受lease_token，也不提供手工伪造成功接口。
*/
package features

import (
	"context"       // HTTP取消与数据库事务共用生命周期
	"crypto/hmac"   // 每个供应商独立验证签名
	"crypto/sha256" // 正文与回调引用只留下摘要证据
	"encoding/hex"  // 固定十六进制签名与密钥格式
	"encoding/json" // 结果按固定业务结构存储
	"errors"        // 区分业务冲突和基础设施失败
	"fmt"           // 明确的启动配置错误
	"io"            // 限额读取原始正文
	"log/slog"      // 只记录任务标识与内部故障
	"net/http"      // 使用Go标准HTTP服务
	"regexp"        // 回调路径、供应商和nonce不接受模糊值
	"strconv"       // 签名时间戳使用十进制秒
	"strings"       // 处理固定路径和外部错误的控制符
	"time"          // 五分钟签名窗口与等待超时

	"github.com/fuxoria-cloud/fuxoria/agent/utils" // JSON重复字段属于外部输入错误
	"github.com/jackc/pgx/v5"                      // 原子更新任务、资源、nonce与审计
)

var ErrCallbackConflict = errors.New("资源回调与当前任务不一致或已过期")                                                                  // 旧引用与不同正文重放都不修改资源
var ErrCallbackMissing = errors.New("资源任务不存在")                                                                            // 未知目标不能创建一份新任务
var ErrCallbackEarly = errors.New("资源受理状态尚未提交，请按原nonce和正文稍后重试")                                                           // 机构可能在插件返回pending前就推送完成事件
var providerName = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,63}$`)                                                          // 与插件文件名规则一致
var callbackPath = regexp.MustCompile(`^/callbacks/jobs/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`) // 只接受规范UUID路径
var callbackNonce = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)                                                         // 请求随机数不得为空或极短
var referenceFormat = regexp.MustCompile(`^[0-9a-f]{64}$`)                                                                // 引用由领取任务时生成，不与租约共享

// CallbackKeys 从显式配置读取供应商独立64位hex密钥，不返回原始配置到日志。
func CallbackKeys(raw string) (map[string][]byte, error) {
	result := map[string][]byte{} // 未配置时保持空集合，入口不会打开监听
	if raw == "" {
		return result, nil
	} // 不猜测默认共享密钥
	var values map[string]string // 每个供应商只对应一个当前受信任密钥
	if len(raw) > 64*1024 || utils.JSON([]byte(raw), &values) != nil || values == nil {
		return nil, fmt.Errorf("PROVISION_CALLBACK_KEYS_JSON必须是无重复字段的JSON对象")
	} // 配置边界也限制大小
	for name, value := range values {
		if !providerName.MatchString(name) || len(value) != 64 {
			return nil, fmt.Errorf("资源回调密钥需要有效供应商名与64位hex")
		} // 防止短密钥或错误名称
		key, err := hex.DecodeString(value) // hex解码后必须恰好32字节
		if err != nil {
			return nil, fmt.Errorf("资源回调密钥必须是64位hex")
		} // 不在错误里附加密钥值
		result[name] = key // 配置只在启动时加载，运行期并发只读
	}
	return result, nil // 没有任何密钥时不代表可以匿名回调
}

// Callbacks 是资源HTTP回调入口，签名使用Queue中已验证的独立供应商密钥。
type Callbacks struct{ Queue Queue } // 不复用支付密钥或AUDIT_KEY作为供应商密钥

type resourceNotification struct {
	Provider  string `json:"provider"`        // 还要与签名头和数据库任务供应商核对
	JobID     string `json:"jobId"`           // 与实际HTTP路径绑定
	Reference string `json:"reference"`       // 只接受当前领取产生的随机引用
	Status    string `json:"status"`          // succeeded或failed，受理结果不能假报成功
	Result    Result `json:"result"`          // 最终资源事实，不能再次声明pending
	Error     string `json:"error,omitempty"` // 供应商应只传脱敏说明
}

// ServeHTTP 验证原始HTTP协议后才进入数据库资源事务。
func (handler Callbacks) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-store")        // 回调结果不能被代理缓存
	path := callbackPath.FindStringSubmatch(request.URL.Path) // 路径必须只有一个规范资源任务
	if len(path) != 2 || request.URL.RawQuery != "" || request.URL.RawPath != "" {
		callbackReply(response, 404, "资源回调路径不存在")
		return
	} // 不接受编码别名与未签名查询参数
	if request.Method != http.MethodPost {
		callbackReply(response, 405, "资源回调只接受POST")
		return
	} // 签名方法不能降级为GET
	provider := singleHeader(request, "X-Yunzou-Provider")   // 重复头部不能悄悄取其中一个值
	timestamp := singleHeader(request, "X-Yunzou-Timestamp") // Unix秒时间戳
	nonce := singleHeader(request, "X-Yunzou-Nonce")         // 每个新事件有独立随机数
	signature := singleHeader(request, "X-Yunzou-Signature") // 64位hex HMAC-SHA256
	key, known := handler.Queue.CallbackKeys[provider]       // 未登记供应商一律拒绝
	if !known || !callbackNonce.MatchString(nonce) || len(timestamp) != 10 || len(signature) != 64 {
		callbackReply(response, 401, "资源回调签名无效")
		return
	} // 不暴露具体密钥配置
	seconds, err := strconv.ParseInt(timestamp, 10, 64) // 不接受科学计数法或模糊日期
	if err != nil || seconds < time.Now().Unix()-300 || seconds > time.Now().Unix()+300 {
		callbackReply(response, 401, "资源回调签名已过期")
		return
	} // 允许五分钟时钟偏差
	request.Body = http.MaxBytesReader(response, request.Body, 64*1024) // 签名前限制正文读取量
	raw, err := io.ReadAll(request.Body)                                // 签名必须覆盖机构发送的原始字节
	if err != nil {
		callbackReply(response, 413, "资源回调正文超过64KiB或读取失败")
		return
	} // 不继续读取超大正文
	received, err := hex.DecodeString(signature)                                                                // 签名按实际字节比较
	mac := hmac.New(sha256.New, key)                                                                            // 不使用任务租约或审计密钥作为外部凭据
	_, _ = mac.Write([]byte(request.Method + "\n" + request.URL.Path + "\n" + timestamp + "\n" + nonce + "\n")) // 方法、路径、时间和nonce全部参与签名
	_, _ = mac.Write(raw)
	_, _ = mac.Write([]byte("\n")) // 正文后固定一个换行，双方按同一规则构造
	if err != nil || !hmac.Equal(received, mac.Sum(nil)) {
		callbackReply(response, 401, "资源回调签名无效")
		return
	} // 恒定时间比较，不泄漏首个差异位置
	var input resourceNotification // 验签之后仍要严格检查JSON与业务身份
	if err = utils.JSON(raw, &input); err != nil {
		callbackReply(response, 400, "资源回调JSON无效或字段重复")
		return
	} // 所有嵌套字段都拒绝重复键
	if input.Provider != provider || input.JobID != path[1] || !referenceFormat.MatchString(input.Reference) || (input.Status != "succeeded" && input.Status != "failed") || input.Result.Pending || input.Result.CallbackReference != "" || len(input.Result.ExternalID) > 512 || len(input.Error) > 500 {
		callbackReply(response, 400, "资源回调身份或结果格式无效")
		return
	} // 不能以pending确认最终开通
	digest := sha256.Sum256(raw) // nonce幂等绑定完整原始正文
	ctx, cancel := context.WithTimeout(request.Context(), 5*time.Second)
	defer cancel()                                                                 // 不能让有效签名无限占用数据库连接
	err = handler.Queue.callback(ctx, input, nonce, hex.EncodeToString(digest[:])) // 事务提交前绝不回200
	switch {
	case errors.Is(err, ErrCallbackConflict):
		callbackReply(response, 409, ErrCallbackConflict.Error()) // 旧引用或同nonce不同正文不能重放
	case errors.Is(err, ErrCallbackMissing):
		callbackReply(response, 404, ErrCallbackMissing.Error()) // 未知目标不落新任务
	case errors.Is(err, ErrCallbackEarly):
		callbackReply(response, 503, ErrCallbackEarly.Error()) // 尚未waiting时不确认，也不让正常快速回调被当作永久失败
	case err != nil:
		slog.Error("写入资源回调失败", "job", input.JobID, "error", err.Error())
		callbackReply(response, 500, "资源回调暂未提交，请按原nonce与正文重试") // 故障不会伪造成功回执
	default:
		callbackReply(response, 200, "已接收") // 包括已提交的同nonce同正文重复请求
	}
}

func singleHeader(request *http.Request, name string) string {
	values := request.Header.Values(name) // 只接受单值签名头
	if len(values) != 1 {
		return ""
	} // 多值不会被框架静默覆盖
	return values[0] // 不去掉可能改变签名语义的空白
}

func callbackReply(response http.ResponseWriter, status int, message string) {
	response.Header().Set("Content-Type", "application/json;charset=utf-8")                       // 错误与成功都可预测
	response.WriteHeader(status)                                                                  // 只有事务已提交才会使用200
	_ = json.NewEncoder(response).Encode(map[string]any{"ok": status == 200, "message": message}) // 不回传密钥、引用或原始载荷
}

// Wait 将当前有效租约转换成有截止时间的等待，不再允许队列重新开通。
func (queue Queue) Wait(ctx context.Context, job Job, result Result) error {
	if _, known := queue.CallbackKeys[job.Provider]; !known || !result.Pending || result.CallbackReference != job.CallbackReference || !referenceFormat.MatchString(job.CallbackReference) {
		return queue.Uncertain(ctx, job, "异步结果缺少可信回调配置或本次引用，需要人工核对")
	} // 已受理的外部操作不能自动重做
	wait := queue.CallbackWait // 部署可以显式设置机构允许的等待窗口
	if wait <= 0 {
		wait = 30 * time.Minute
	} // 未指定时有限等待半小时
	if job.Action == "resource" {
		result = Result{Pending: true}
	}
	result.CallbackReference = ""        // 随机引用不进入后台可见的结果JSON
	encoded, err := json.Marshal(result) // 只保存脱敏资源受理事实
	if err != nil {
		return err
	} // 数据格式错误不会确认进入waiting
	return pgx.BeginFunc(ctx, queue.Pool, func(transaction pgx.Tx) error {
		changed, err := transaction.Exec(ctx, `UPDATE jobs SET state='waiting',result=$3,callback_deadline=now()+($4::double precision*interval '1 second'),lease_token=NULL,lease_until=NULL,last_error=NULL,updated_at=now()
      WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_until>now() AND callback_reference=$5`, job.ID, job.Token, encoded, wait.Seconds(), job.CallbackReference) // 旧租约不能把新任务变成等待
		if err != nil {
			return err
		}
		if changed.RowsAffected() != 1 {
			return ErrLeaseLost
		} // 不修改其他owner的任务
		return queue.audit(ctx, transaction, "job.waiting", job, map[string]any{"serviceId": job.ServiceID, "provider": job.Provider, "action": job.Action, "attempt": job.Attempts}) // 等待状态与审计一起提交
	})
}

// Uncertain 保存未知外部结果并阻挡后续同服务动作，不自动重新开通。
func (queue Queue) Uncertain(ctx context.Context, job Job, reason string) error {
	if job.Action == "resource" {
		reason = "资源操作结果待人工核对"
	}
	return pgx.BeginFunc(ctx, queue.Pool, func(transaction pgx.Tx) error {
		changed, err := transaction.Exec(ctx, `UPDATE jobs SET state='manual_review',lease_token=NULL,lease_until=NULL,last_error=$3,updated_at=now() WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_until>now()`, job.ID, job.Token, reason) // 必须仍持有当前有效租约
		if err != nil {
			return err
		}
		if changed.RowsAffected() != 1 {
			return ErrLeaseLost
		} // 不覆盖新owner已提交的结果
		return queue.audit(ctx, transaction, "job.manual_review", job, map[string]any{"serviceId": job.ServiceID, "provider": job.Provider, "reason": reason}) // 管理员可追到转人工核对的具体原因
	})
}

// --- 资源任务、nonce与审计的唯一提交主线 ---
func (queue Queue) callback(ctx context.Context, input resourceNotification, nonce, digest string) error {
	return pgx.BeginFunc(ctx, queue.Pool, func(transaction pgx.Tx) error {
		var action string
		if err := transaction.QueryRow(ctx, `SELECT action FROM jobs WHERE id=$1`, input.JobID).Scan(&action); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrCallbackMissing
			}
			return err
		}
		if action == "resource" {
			if len(queue.ResourceKey) != 32 {
				return ErrCallbackConflict
			}
			keyed := hmac.New(sha256.New, queue.ResourceKey)
			_, _ = keyed.Write([]byte("resource-callback-body:v1:" + digest))
			digest = hex.EncodeToString(keyed.Sum(nil))
		} // 私有结果的重放摘要也使用外置密钥，避免裸摘要成为弱密码的离线猜测依据。
		if _, err := transaction.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "resource-callback:"+input.Provider+":"+nonce); err != nil {
			return err
		} // 同nonce的并发请求串行读取落库事实
		var savedJob, savedHash string                                                                                                                                              // 先识别已提交的同事件重放
		err := transaction.QueryRow(ctx, `SELECT job_id::text,body_hash FROM resource_callbacks WHERE provider=$1 AND nonce=$2`, input.Provider, nonce).Scan(&savedJob, &savedHash) // 不让任务已完成影响合法重试
		if err == nil {
			if savedJob == input.JobID && savedHash == digest {
				return nil
			}
			return ErrCallbackConflict
		} // 相同nonce只能绑定完全相同的原始正文
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		} // 数据库故障不能当作没有历史事件
		var job Job
		var state, reference string
		var timely bool
		var previous []byte                                                                                                                                                                                                                                                                                                                                                                          // 业务身份全部从数据库读取
		err = transaction.QueryRow(ctx, `SELECT id::text,service_id::text,action,provider,payload,attempts,state,COALESCE(callback_reference,''),COALESCE(callback_deadline>now(),false),COALESCE(result,'{}'::jsonb) FROM jobs WHERE id=$1 FOR UPDATE`, input.JobID).Scan(&job.ID, &job.ServiceID, &job.Action, &job.Provider, &job.Payload, &job.Attempts, &state, &reference, &timely, &previous) // 只对当前waiting任务持锁
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrCallbackMissing
		}
		if err != nil {
			return err
		} // 不根据外部结果创建任务
		if state == "running" && job.Provider == input.Provider && hmac.Equal([]byte(reference), []byte(input.Reference)) {
			return ErrCallbackEarly
		} // 只允许供应商按原事件重试，仍不提前完成running任务
		if state != "waiting" || !timely || job.Provider != input.Provider || !hmac.Equal([]byte(reference), []byte(input.Reference)) {
			return ErrCallbackConflict
		} // 旧引用、错供应商与过期任务都无法完成
		if input.Status == "succeeded" {
			if job.Action == "provision" && strings.TrimSpace(input.Result.ExternalID) == "" {
				return ErrCallbackConflict
			} // 没真实资源标识不能激活服务
			var pending Result // 若受理时已返回资源ID，最终确认必须属于同一资源
			if err = json.Unmarshal(previous, &pending); err != nil {
				return err
			} // 这是本项目已经验证写入的数据
			if pending.ExternalID != "" && pending.ExternalID != input.Result.ExternalID {
				return ErrCallbackConflict
			} // 不能串用另一份资源的完成通知
			if job.Action == "resource" {
				if err = transaction.QueryRow(ctx, `SELECT external_id FROM services WHERE id=$1`, job.ServiceID).Scan(&job.ExternalID); err != nil {
					return err
				}
			}
			protected, err := queue.protectResource(job, input.Result)
			if err != nil {
				return ErrCallbackConflict
			}
			input.Result = protected
			encoded, err := json.Marshal(input.Result)
			if err != nil {
				return err
			} // 结果中不包含租约或回调引用
			if _, err = transaction.Exec(ctx, `UPDATE jobs SET state='succeeded',result=$2,last_error=NULL,callback_deadline=NULL,updated_at=now() WHERE id=$1`, job.ID, encoded); err != nil {
				return err
			} // 先通过waiting检查再写终态
			if err = queue.apply(ctx, transaction, job, input.Result); err != nil {
				return err
			} // 与同步结果共用动作状态和审计
		} else {
			reason := strings.Map(func(letter rune) rune {
				if letter < 32 {
					return ' '
				}
				return letter
			}, input.Error) // 供应商失败说明不得包含控制符
			if job.Action == "resource" {
				reason = "供应商报告资源操作失败，请管理员核对"
			}
			if reason == "" {
				reason = "供应商报告操作失败，请核对真实资源状态"
			} // 不把失败当作需要再开一台资源
			if _, err = transaction.Exec(ctx, `UPDATE jobs SET state='manual_review',last_error=$2,updated_at=now() WHERE id=$1`, job.ID, reason); err != nil {
				return err
			} // 失败回调不自动重开未知资源
			if err = queue.audit(ctx, transaction, "job.callback_failed", job, map[string]any{"serviceId": job.ServiceID, "provider": job.Provider, "reason": reason}); err != nil {
				return err
			} // 机构失败事实与任务状态共同提交
		}
		referenceHash := sha256.Sum256([]byte(input.Reference))                                                                                                                                                              // 事件表只存引用摘要，不再复制随机引用
		_, err = transaction.Exec(ctx, `INSERT INTO resource_callbacks(provider,nonce,job_id,body_hash,reference_hash) VALUES($1,$2,$3,$4,$5)`, input.Provider, nonce, job.ID, digest, hex.EncodeToString(referenceHash[:])) // nonce与资源确认要么全部提交，要么全部回滚
		return err                                                                                                                                                                                                           // 事务提交完成后HTTP入口才回200
	})
}

// ExpireCallbacks 将等待超时转人工核对，保持同服务动作串行且不重新开资源。
func (queue Queue) ExpireCallbacks(ctx context.Context) error {
	return pgx.BeginFunc(ctx, queue.Pool, func(transaction pgx.Tx) error {
		rows, err := transaction.Query(ctx, `WITH due AS (SELECT id FROM jobs WHERE state='waiting' AND callback_deadline<=now() ORDER BY callback_deadline FOR UPDATE SKIP LOCKED LIMIT 100)
      UPDATE jobs SET state='manual_review',last_error='资源回调等待超时，请核对供应商真实结果；不会自动重开',updated_at=now() WHERE id IN(SELECT id FROM due) RETURNING id::text,service_id::text,action,provider,attempts`) // 有界扫描并发可跳过已锁任务
		if err != nil {
			return err
		} // 不提交部分超时处理
		jobs := []Job{} // 最多保留本轮一百条记录
		for rows.Next() {
			var job Job
			if err = rows.Scan(&job.ID, &job.ServiceID, &job.Action, &job.Provider, &job.Attempts); err != nil {
				rows.Close()
				return err
			}
			jobs = append(jobs, job)
		} // 先读完结果再写审计
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		} // 游标失败也会回滚状态
		for _, job := range jobs {
			if err = queue.audit(ctx, transaction, "job.callback_timeout", job, map[string]any{"serviceId": job.ServiceID, "provider": job.Provider, "action": job.Action}); err != nil {
				return err
			}
		} // 每个转人工动作都有审计
		return nil // 不改变真实资源状态，不重新入队
	})
}
