/*
严格JSON输入：拒绝重复字段、额外对象、未知结构字段和过深嵌套。
调用：err := utils.JSON(raw, &notification)，raw应已由HTTP或插件边界限制大小。
此工具只检查数据语法，不执行脚本，不决定业务状态。
*/
package utils

import (
	"bytes"         // 每轮解析都从同一份原始字节读取
	"encoding/json" // 使用标准JSON词法，不自行猜测转义规则
	"fmt"           // 返回外部输入可以修正的错误
	"io"            // 要求正文只有一个完整JSON值
)

// JSON 将唯一字段的严格JSON解码到目标结构，拒绝多份或不认识的字段。
func JSON(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw)) // 第一遍只检查词法与重复键
	decoder.UseNumber()                              // 不把金额等数字提前转成浮点数
	if err := value(decoder, 0); err != nil {
		return err
	} // 所有嵌套对象都检查
	if _, err := decoder.Token(); err != io.EOF {
		return fmt.Errorf("正文只能包含一个JSON值")
	} // 禁止尾随第二份对象
	decoder = json.NewDecoder(bytes.NewReader(raw)) // 第二遍使用实际业务结构
	decoder.DisallowUnknownFields()                 // 拼错字段应立即报错
	return decoder.Decode(target)                   // 标准库负责结构类型与字段格式
}

// --- 递归读取一个JSON值，记录当前对象已经出现的字段 ---
func value(decoder *json.Decoder, depth int) error {
	if depth > 64 {
		return fmt.Errorf("JSON嵌套不能超过64层")
	} // 限制外部输入的递归成本
	token, err := decoder.Token() // 标准库处理字符串转义与数字语法
	if err != nil {
		return err
	} // 不把截断正文当作有效结果
	delimiter, object := token.(json.Delim) // 普通字符串、数字或布尔值无需递归
	if !object {
		return nil
	} // 一个原子值已经读完
	if delimiter != '{' && delimiter != '[' {
		return fmt.Errorf("JSON结构无效")
	} // 只能从容器起点开始
	keys := map[string]bool{} // 每一层对象拥有自己的字段集合
	for decoder.More() {
		if delimiter == '{' {
			key, err := decoder.Token() // 对象下一项必须是字段名
			if err != nil {
				return err
			} // 标准库拒绝损坏的键
			name, ok := key.(string) // 数字或容器不能做JSON键
			if !ok || keys[name] {
				return fmt.Errorf("JSON包含重复或无效字段")
			} // 解码后的同名转义键也会被拒绝
			keys[name] = true // 只登记当前对象，不影响子对象
		}
		if err := value(decoder, depth+1); err != nil {
			return err
		} // 递归验证当前字段值或数组成员
	}
	_, err = decoder.Token() // 标准库同时验证对应的结束括号
	return err               // 不吞掉结尾截断错误
}
