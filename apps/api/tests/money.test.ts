/* 金额边界测试：npm test；验证二进制浮点最容易出错的人民币金额和超精度输入。 */
import test from 'node:test';                                     // 使用Node自带测试器
import assert from 'node:assert/strict';                            // 错误也必须明确验证
import { cents,yuan } from '../src/utils/money.js';                 // 测试实际业务使用的金额规则

test('一角加两角准确得到三角',()=>{
  assert.equal(cents('0.1')+cents('0.2'),30n);                      // 不允许出现浮点尾数
  assert.equal(yuan(30n),'0.30');                                  // 页面始终两位小数
});
test('金额上下文保留正负与前导空格',()=>{
  assert.equal(cents(' 9999999999.99 '),999999999999n);             // 在边界先整理用户文本
  assert.equal(yuan(-10001n),'-100.01');                           // 退款展示不丢失负号
});
test('拒绝舍入、科学计数和非金额输入',()=>{
  for (const value of ['0.001','1e3','NaN','-10','1; DROP TABLE users','']) assert.throws(()=>cents(value)); // 不做隐式金额修正
});
