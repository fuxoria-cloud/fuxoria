/*
插件协议验收：拒绝未知供应商、尾随结果、空资源 ID 和未授权动作，验证人工插件不会假开通。
调用：cd agent && go test ./features -run 'TestPlugin|TestManual|TestManifest'
临时程序只在测试目录创建，不连接真实供应商或读取生产凭据。
*/
package features

import (
	"context"       // 测试执行也能取消
	"encoding/json" // 构造任务载荷
	"errors"        // 核对人工等待和输出限额
	"os"            // 创建隔离的测试清单
	"path/filepath" // 临时文件集中到测试目录
	"testing"       // Go 标准测试入口
	"time"          // 保持租约大于插件超时
)

func TestManualCannotActivateService(t *testing.T) {
	plugins := Plugins{"manual": {Mode: "manual", Actions: []string{"provision"}}}                 // 人工交付只声明一个动作
	result, err := plugins.Run(context.Background(), Job{Provider: "manual", Action: "provision"}) // 不启动任何外部程序
	if !errors.Is(err, ErrManualRequired) || result.ExternalID != "" {
		t.Fatalf("人工插件必须等待确认: %+v %v", result, err)
	} // 不能凭排队返回有效资源
	_, err = plugins.Run(context.Background(), Job{Provider: "missing", Action: "provision"}) // 没安装的供应商不能兜底人工
	if err == nil {
		t.Fatal("未知供应商必须拒绝")
	} // 防止配置错误被当成功
	_, err = plugins.Run(context.Background(), Job{Provider: "manual", Action: "terminate"}) // 不是所有插件都支持销毁
	if err == nil {
		t.Fatal("未声明动作必须拒绝")
	} // 每个动作有显式授权
}

func TestPluginProtocol(t *testing.T) {
	cases := []struct {
		name, output string
		wantError    bool
	}{ // 只测试外部协议边界，不镜像内部实现
		{"real-resource", `{"externalId":"vm-123","data":{"region":"test"}}`, false},
		{"empty-resource", `{"externalId":""}`, true},
		{"malformed", `not-json`, true},
		{"second-response", `{"externalId":"vm-123"} {"externalId":"vm-456"}`, true},
		{"unknown-field", `{"externalId":"vm-123","success":true}`, true},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			directory := t.TempDir()                           // 每个程序只存在于自己的临时目录
			executable := filepath.Join(directory, "provider") // 清单调用的是程序文件，不是 shell 命令字符串
			if err := os.WriteFile(executable, []byte("#!/bin/sh\nprintf '%s' '"+test.output+"'\n"), 0700); err != nil {
				t.Fatal(err)
			} // 测试固定输出，没有真实开通
			plugins := Plugins{"test": {Mode: "command", Executable: executable, Actions: []string{"provision"}, TimeoutSeconds: 2}}     // 使用独立供应商名
			result, err := plugins.Run(context.Background(), Job{Provider: "test", Action: "provision", Payload: json.RawMessage(`{}`)}) // 通过真实子进程运行协议
			if (err != nil) != test.wantError {
				t.Fatalf("result=%+v error=%v", result, err)
			} // 坏输出必须在提交数据库之前拒绝
		})
	}
	output := limitedOutput{limit: 2} // 输出缓存必须在限额处停止
	if _, err := output.Write([]byte("abc")); !errors.Is(err, ErrOutputLimit) {
		t.Fatalf("限额未执行: %v", err)
	} // 防止供应商无限输出耗尽内存
}

func TestManifestAutoDiscoveryAndPermissions(t *testing.T) {
	directory := t.TempDir()                        // 新增清单就能被扫描到
	path := filepath.Join(directory, "manual.json") // 名字仅来自文件名
	if err := os.WriteFile(path, []byte(`{"mode":"manual","actions":["provision"]}`), 0600); err != nil {
		t.Fatal(err)
	} // 清单不含重复 ID
	plugins, err := LoadPlugins(directory, 2*time.Minute) // 自动加载，没有中央登记
	if err != nil || len(plugins) != 1 {
		t.Fatalf("未发现清单: %v %+v", err, plugins)
	} // 发现过程可以独立验证
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	} // 删除文件就是删除插件
	plugins, err = LoadPlugins(directory, 2*time.Minute) // 重新加载后不会残留已删定义
	if err != nil || len(plugins) != 0 {
		t.Fatalf("已删插件仍被登记: %v %+v", err, plugins)
	} // 不要求同步修改注册表
	if err := os.WriteFile(path, []byte(`{"mode":"manual","actions":["provision"],"typo":true}`), 0600); err != nil {
		t.Fatal(err)
	} // 模拟拼错配置字段
	if _, err = LoadPlugins(directory, 2*time.Minute); err == nil {
		t.Fatal("未知清单字段必须拒绝")
	} // 避免配置静默失效
	if err := os.WriteFile(path, []byte(`{"mode":"manual","actions":["provision"]}`), 0600); err != nil {
		t.Fatal(err)
	} // 恢复有效定义
	if err := os.Chmod(path, 0666); err != nil {
		t.Fatal(err)
	} // 共享写权限会允许其他用户换程序
	if _, err = LoadPlugins(directory, 2*time.Minute); err == nil {
		t.Fatal("公开可写清单必须拒绝")
	} // 信任边界在加载时守住
}

func TestPluginTimeoutStopsProcessGroup(t *testing.T) {
	directory := t.TempDir()                                // 所有子进程文件都在测试目录
	executable := filepath.Join(directory, "slow-provider") // 该程序故意派生一个长时间等待的后代
	script := "#!/bin/sh\nsleep 20 &\nwait\n"               // 不调用真实供应商，不产生外部副作用
	if err := os.WriteFile(executable, []byte(script), 0700); err != nil {
		t.Fatal(err)
	} // 固定测试程序不可被其他用户修改
	plugins := Plugins{"slow": {Mode: "command", Executable: executable, Actions: []string{"provision"}, TimeoutSeconds: 1}} // 一秒后必须中止整组
	started := time.Now()                                                                                                    // 检查退出是否有界
	_, err := plugins.Run(context.Background(), Job{Provider: "slow", Action: "provision", Payload: json.RawMessage(`{}`)})  // 执行真实超时边界
	if err == nil || time.Since(started) > 4*time.Second {
		t.Fatalf("超时未生效: elapsed=%s error=%v", time.Since(started), err)
	} // 不能被后代持有的管道拖住
}
