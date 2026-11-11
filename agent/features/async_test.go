/*
异步插件协议验收：直接启动当前Go测试程序模拟供应商，不通过shell。
调用：go test -race ./features -run 'TestPluginAsync'。
子进程只读取测试任务并输出固定协议结果，不访问供应商或生产凭据。
*/
package features

import (
	"context"       // 外部程序同样受执行期限约束
	"encoding/json" // 以真实stdin/stdout合同交换一次任务
	"errors"        // 不确定异步结果不能被当作普通可重试失败
	"fmt"           // 只输出固定测试协议
	"os"            // 使用当前受信任Go测试二进制作为子程序
	"strings"       // 引用是独立64位随机文本
	"testing"       // Go标准测试入口
)

func TestPluginAsyncHelper(t *testing.T) {
	mode := os.Getenv("YUNZOU_ASYNC_TEST_MODE") // 只允许测试通过显式白名单环境启动此分支
	if mode == "" {
		return
	} // 正常测试运行器不会退出整个进程
	var job Job
	if err := json.NewDecoder(os.Stdin).Decode(&job); err != nil {
		os.Exit(2)
	} // 使用实际任务输入
	switch mode {
	case "pending":
		_ = json.NewEncoder(os.Stdout).Encode(Result{Pending: true, CallbackReference: job.CallbackReference}) // 机构受理必须回显本次引用
	case "wrong-reference":
		_ = json.NewEncoder(os.Stdout).Encode(Result{Pending: true, CallbackReference: strings.Repeat("0", 64)}) // 模拟串用旧引用
	case "malformed":
		fmt.Fprint(os.Stdout, `{"pending":true,"pending":false}`) // 不能让JSON覆盖把异步受理改成同步成功
	case "failure":
		os.Exit(3) // 程序已启动后未知失败，可能已经发送外部请求
	}
	os.Exit(0) // 不让Go测试框架额外输出PASS破坏插件JSON协议
}

func TestPluginAsyncPendingContract(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	} // 直接执行当前Go二进制，不启动脚本解释器
	plugin := Plugin{Mode: "command", Executable: executable, Arguments: []string{"-test.run=^TestPluginAsyncHelper$"}, Actions: []string{"provision"}, Environment: []string{"YUNZOU_ASYNC_TEST_MODE"}, TimeoutSeconds: 5, Callback: true} // 供应商明确声明异步能力
	job := Job{ID: "test-job", Provider: "async", Action: "provision", Payload: json.RawMessage(`{}`), CallbackReference: strings.Repeat("1", 64), CallbackURL: "https://cloud.example/callbacks/jobs/test-job"}                            // 租约Token从不序列化给子进程
	for _, mode := range []string{"pending", "wrong-reference", "malformed", "failure"} {
		t.Run(mode, func(t *testing.T) {
			t.Setenv("YUNZOU_ASYNC_TEST_MODE", mode)
			result, err := Plugins{"async": plugin}.Run(context.Background(), job)
			if mode == "pending" {
				if err != nil || !result.Pending || result.CallbackReference != job.CallbackReference {
					t.Fatalf("合法受理协议未通过: %+v %v", result, err)
				}
			} else if !errors.Is(err, ErrAsyncUncertain) {
				t.Fatalf("未知外部结果不应自动重试: %+v %v", result, err)
			}
		})
	} // 每个未知结果都必须转人工核对
	t.Setenv("YUNZOU_ASYNC_TEST_MODE", "pending")
	job.CallbackURL = "" // 未配置接收地址时不能先发出异步请求
	if _, err = (Plugins{"async": plugin}).Run(context.Background(), job); err == nil {
		t.Fatal("缺少回调配置仍执行异步程序")
	} // 配置错误在外部调用之前发现
}
