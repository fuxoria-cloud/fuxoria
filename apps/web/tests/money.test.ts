/* 金额边界：验证元到分不会引入浮点误差。调用：node --import tsx --test apps/web/tests/money.test.ts。 */
import test from 'node:test'; // 使用Node内置测试，不启动业务服务
import assert from 'node:assert/strict'; // 金额必须逐分相等
import { toCents, money, amount } from '../features/money.js'; // 验证唯一金额来源

test('小数和边界金额按字符串与整数转换', () => {
  // 常见小额与最大金额都不能丢分
  assert.equal(toCents('0.01'), '1');
  assert.equal(toCents('0.00', true), '0'); // 明确允许的免费商品不会影响默认退款限制
  assert.equal(toCents(' 29.00 '), '2900');
  assert.equal(toCents('0.1'), '10');
  assert.equal(toCents('9999999999.99'), '999999999999');
  assert.equal(money('123456789012'), '¥1,234,567,890.12');
  assert.equal(amount('1'), '0.01');
});

test('拒绝不能用于交易的用户输入', () => {
  // 空值、零金额与歧义格式不提交给API
  for (const text of ['', '0', '0.00', '-1', '1.001', '1e2', 'Infinity', '10000000000.00'])
    assert.throws(() => toCents(text));
});
