/* 严格JSON协议验收：go test ./utils；所有输入均是公开测试数据。 */
package utils

import (
	"encoding/json" // result.data同样需要检查重复键
	"testing"       // 标准Go测试
)

func TestJSONRejectsAmbiguousExternalInput(t *testing.T) {
	for _, body := range []string{`{"name":"a","name":"b"}`, `{"name":"a","data":{"id":1,"id":2}}`, `{"name":"a"} {"name":"b"}`, `{"unknown":true}`, `{"name":"a","\u006eame":"b"}`} {
		var value struct {
			Name string          `json:"name"`
			Data json.RawMessage `json:"data"`
		} // 原始嵌套data也不绕过第一轮检查
		if err := JSON([]byte(body), &value); err == nil {
			t.Fatalf("错误输入被接受: %s", body)
		} // 相同解码键不能被转义隐藏
	}
	var value struct {
		Name string          `json:"name"`
		Data json.RawMessage `json:"data"`
	} // 合法单对象仍可正常读取
	if err := JSON([]byte(`{"name":"a","data":{"id":1}}`), &value); err != nil || value.Name != "a" {
		t.Fatalf("合法输入失败: %v", err)
	} // 不靠一律拒绝实现校验
}
