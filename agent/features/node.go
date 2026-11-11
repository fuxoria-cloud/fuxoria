/*
运行节点：每30秒登记当前守护进程实际加载的插件能力，不上传路径、环境变量或密钥。
调用：node,err := NewNode(pool,"0.1.0",plugins)；err=node.Heartbeat(ctx)。
每次进程启动生成独立UUID；退出不删除历史心跳，后台按90秒窗口判定在线。
*/
package features

import (
	"context"       // 退出时取消下一次心跳写入
	"crypto/rand"   // 节点标识不依赖主机名或私有网络地址
	"encoding/hex"  // 将随机字节表示为规范UUID
	"encoding/json" // 插件能力只上传白名单字段
	"os"
	"sort" // 节点能力顺序固定，便于人比较

	"github.com/jackc/pgx/v5/pgxpool" // 复用有上限的数据库连接池
)

// Node 是一个实际运行的守护进程，仅保存允许展示的能力摘要。
type Node struct {
	Pool         *pgxpool.Pool
	ID           string
	Version      string
	capabilities []byte
} // 不包含供应商密钥或程序路径

// NewNode 为本次进程生成随机UUID，并保存此时实际加载的插件白名单能力。
func NewNode(pool *pgxpool.Pool, version string, plugins Plugins) (Node, error) {
	identity := make([]byte, 16) // UUID使用128位随机字节
	if _, err := rand.Read(identity); err != nil {
		return Node{}, err
	} // 随机源失败不能生成可预测标识
	identity[6] = (identity[6] & 15) | 64
	identity[8] = (identity[8] & 63) | 128                                                                     // 设置UUIDv4版本和变体位
	encoded := hex.EncodeToString(identity)                                                                    // 规范UUID不带任何机器信息
	id := encoded[:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:] // 后台可直接用UUID字段保存
	type capability struct {
		ID       string              `json:"id"`
		Mode     string              `json:"mode"`
		Actions  []string            `json:"actions"`
		Resource *ResourceCapability `json:"resource,omitempty"`
		Callback bool                `json:"callback,omitempty"`
	} // 只允许这三个公开字段
	names := make([]string, 0, len(plugins)) // 只按真正加载的文件名列出能力
	for name := range plugins {
		names = append(names, name)
	}
	sort.Strings(names)                               // 不依赖Go map的随机顺序
	capabilities := make([]capability, 0, len(names)) // 空插件也明确上传空数组
	for _, name := range names {
		plugin := plugins[name]
		var resource *ResourceCapability
		if key, err := ResourceKey(os.Getenv("RESOURCE_KEY")); err == nil && len(key) == 32 {
			resource = plugin.Resource
		}
		capabilities = append(capabilities, capability{name, plugin.Mode, append([]string{}, plugin.Actions...), resource, plugin.Callback})
	} // 不把exec路径或env白名单复制进去
	body, err := json.Marshal(capabilities)                                    // 固定JSON结构用于数据库JSONB
	return Node{Pool: pool, ID: id, Version: version, capabilities: body}, err // 返回可独立定时调用的节点主体
}

// Heartbeat 登记实际运行节点及能力，历史记录在退出后自然变为离线。
func (node Node) Heartbeat(ctx context.Context) error {
	_, err := node.Pool.Exec(ctx, `INSERT INTO agent_presence(id,version,plugins,heartbeat_at) VALUES($1,$2,$3,now())
    ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version,plugins=EXCLUDED.plugins,heartbeat_at=now()`, node.ID, node.Version, node.capabilities) // 只更新当前进程自己的节点
	return err // 心跳失败交给入口记录，不伪造在线状态
}

// Capabilities 供本节点队列限定领取范围，不暴露可执行路径或私有环境。
func (node Node) Capabilities() []byte { return append([]byte{}, node.capabilities...) }
