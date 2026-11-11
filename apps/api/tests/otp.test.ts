/* 一次性口令标准向量：执行 node --import tsx --test apps/api/tests/otp.test.ts。
 * 密钥全部来自公开RFC测试向量，不是任何真实账号的凭据。
 */
import test from 'node:test';                                  // 使用标准测试运行器
import assert from 'node:assert/strict';                        // 与RFC固定结果逐个对照
import { base32, unbase32, hotp, totp, counter } from '../src/utils/otp.js'; // 测试实际认证算法

const secret='GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';                // RFC公开ASCII密钥12345678901234567890的Base32

test('RFC4226十个HOTP计数器向量',()=>{
  const expected=['755224','287082','359152','969429','338314','254676','287922','162583','399871','520489']; // RFC4226附录D
  for (let moving=0;moving<expected.length;moving++) assert.equal(hotp(secret,BigInt(moving)),expected[moving]); // 比较动态截断、前导零和大端计数器
});

test('RFC6238六个SHA1时间向量，包含2038年以后的时间',()=>{
  const vectors=[[59,'94287082'],[1111111109,'07081804'],[1111111111,'14050471'],[1234567890,'89005924'],[2000000000,'69279037'],[20000000000,'65353130']] as const; // RFC6238附录B
  for (const [seconds,code] of vectors) assert.equal(totp(secret,seconds,8),code); // 64位计数器不会受32位时间溢出影响
});

test('Base32按字节往返，口令容忍相邻周期且拒绝已消费计数器',()=>{
  const raw=Buffer.from('12345678901234567890');                  // 公开的标准测试密钥
  assert.equal(base32(raw),secret);                             // 编码与认证器使用同一字母表
  assert.deepEqual(unbase32(secret),raw);                       // HMAC实际使用原始密钥字节
  const seconds=1234567890;                                    // 固定测试时间，不等待真实时钟
  const moving=BigInt(Math.floor(seconds/30));                  // 当前30秒周期
  assert.equal(counter(secret,totp(secret,seconds),moving-1n,seconds),moving); // 本周期可消费一次
  assert.equal(counter(secret,totp(secret,seconds),moving,seconds),null); // 同一口令不能重放
  assert.equal(counter(secret,totp(secret,seconds+30),moving-1n,seconds),moving+1n); // 容忍未来一个周期的时钟偏差
  assert.equal(counter(secret,totp(secret,seconds-30),moving-2n,seconds),moving-1n); // 容忍过去一个周期
  assert.equal(counter(secret,totp(secret,seconds-60),-1n,seconds),null); // 两个周期之外不接受
});
