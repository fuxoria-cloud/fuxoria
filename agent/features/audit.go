/*
审计：把守护进程的任务结果追加到主业务共用的 HMAC 哈希链，和服务状态同事务提交。
调用：err := queue.audit(ctx, transaction, "job.succeeded", job, map[string]any{"externalId":"vm-123"})
锁号、零锚点和签名内容字段与 apps/api/src/features/audit.ts 一致；canonical_body 保存实际签名文本。
*/
package features

import (
	"bytes"         // JSON 编码器写入没有额外内容的签名文本
	"context"       // 与任务状态使用同一事务生命周期
	"crypto/hmac"   // 审计密钥不保存在数据库里
	"crypto/sha256" // 与 TypeScript 端使用同一个签名算法
	"encoding/hex"  // 以固定长度十六进制保存链锚点
	"encoding/json" // 序列化有固定字段顺序的内容
	"errors"        // 第一笔记录没有上一笔是正常情况
	"strings"       // 去掉编码器的末尾换行

	"github.com/jackc/pgx/v5" // 只允许使用当前业务事务的连接
)

// --- 在同一事务内接上新的审计锚点 ---
func (queue Queue) audit(ctx context.Context, transaction pgx.Tx, action string, job Job, details map[string]any) error {
	if _, err := transaction.Exec(ctx, `SELECT pg_advisory_xact_lock(812431)`); err != nil {
		return err
	} // 和主业务串行接链，防止多进程分叉
	previousHash := strings.Repeat("0", 64)                                                                 // 第一笔记录使用公开的零锚点
	err := transaction.QueryRow(ctx, `SELECT hash FROM audit ORDER BY id DESC LIMIT 1`).Scan(&previousHash) // 从事务内读取最后一次提交的锚点
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	} // 数据库故障不能悄悄重开一条链
	body := struct {
		Actor        string         `json:"actor"`        // 守护进程使用明确的系统操作者
		Action       string         `json:"action"`       // 记录任务成功、失败、重试或人工等待
		Target       string         `json:"target"`       // 目标是不可变的任务 ID
		Details      map[string]any `json:"details"`      // 只记录脱敏后的资源操作事实
		PreviousHash string         `json:"previousHash"` // 锚点串起完整顺序
	}{"agent", action, job.ID, details, previousHash} // 字段顺序与 TypeScript JSON.stringify 的对象一致
	var encoded bytes.Buffer             // 保存实际参与签名的原文
	encoder := json.NewEncoder(&encoded) // 编码器可关闭 HTML 转义
	encoder.SetEscapeHTML(false)         // 不因普通 <>& 字符改变签名文本
	if err = encoder.Encode(body); err != nil {
		return err
	} // JSON 错误会回滚整个任务结果
	canonical := strings.TrimSuffix(encoded.String(), "\n") // Go 编码器默认末尾换行不属于签名内容
	signature := hmac.New(sha256.New, queue.AuditKey)       // 只有受控运行环境持有密钥
	_, _ = signature.Write([]byte(canonical))               // HMAC 写入固定文本不会失败
	hash := hex.EncodeToString(signature.Sum(nil))          // 链锚点固定为 64 个十六进制字符
	detailsBody, err := json.Marshal(details)               // details 同时保留为可查询的 JSONB
	if err != nil {
		return err
	} // 与签名事实使用相同数据
	_, err = transaction.Exec(ctx, `INSERT INTO audit(actor,action,target,details,previous_hash,hash,canonical_body)
  VALUES($1,$2,$3,$4,$5,$6,$7)`, "agent", action, job.ID, detailsBody, previousHash, hash, canonical) // 原文使不同语言能按同一字节校验
	return err // 审计追加成功后，调用方才可提交服务状态
}
