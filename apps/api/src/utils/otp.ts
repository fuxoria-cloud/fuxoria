/* 一次性口令：按RFC 4226/6238计算HOTP/TOTP，不依赖外部验证服务。
 * 调用：const secret=base32(randomBytes(20)); const code=totp(secret,Date.now()/1000)。
 * 校验：const used=counter(secret,code,lastCounter)，返回本次可消费计数器或null。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';       // HMAC-SHA1是标准口令算法，比较使用恒定字节时间

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';            // RFC 4648无歧义Base32字母表

/** @param bytes 原始随机字节。@returns 不含填充的Base32密钥。 */
export function base32(bytes:Buffer) {
  let text='',value=0,bits=0;                                    // 只保留还没有输出的低位
  for (const byte of bytes) {
    value=(value<<8)|byte; bits+=8;                              // 每次加入一个原始字节
    while (bits>=5) { bits-=5; text+=alphabet[(value>>>bits)&31]; } // 每五位转换一个Base32字符
    value &= (1<<bits)-1;                                       // 丢掉已经输出的位，避免整数累积溢出
  }
  if (bits) text+=alphabet[(value<<(5-bits))&31];                 // 最后不足五位补零，不增加明文信息
  return text;                                                  // 认证器接受无填充的标准密钥
}

/** @param secret 标准Base32密钥。@returns 解码后的原始字节。 */
export function unbase32(secret:string) {
  let value=0,bits=0;                                            // 按原始字节宽度恢复
  const bytes:number[]=[];                                       // 密钥较短，最多几十字节
  for (const letter of secret.toUpperCase().replace(/=+$/,'')) {
    const position=alphabet.indexOf(letter);                    // 不接受非Base32字符
    if (position<0) throw new Error('一次性口令密钥编码无效');    // 内部密文损坏不能使用猜测密钥
    value=(value<<5)|position; bits+=5;                         // 每个字符恢复五位
    if (bits>=8) { bits-=8; bytes.push((value>>>bits)&255); }    // 每八位恢复一个字节
    value &= (1<<bits)-1;                                       // 只保留尚未输出的部分
  }
  return Buffer.from(bytes);                                    // 返回HMAC需要的原始密钥
}

/** @param secret Base32密钥。@param moving RFC计数器。@param digits 业务用6位，RFC向量可用8位。@returns 固定位数口令。 */
export function hotp(secret:string,moving:bigint,digits:6|8=6) {
  const bytes=Buffer.alloc(8); bytes.writeBigUInt64BE(moving);   // RFC要求八字节大端计数器
  const digest=createHmac('sha1',unbase32(secret)).update(bytes).digest(); // 使用标准HMAC-SHA1
  const offset=digest[digest.length-1]&15;                       // 动态截断位置由摘要最后四位决定
  const value=digest.readUInt32BE(offset)&0x7fffffff;            // 截取31位非负整数
  return String(value%(10**digits)).padStart(digits,'0');       // 前导零是口令的一部分
}

/** @param secret Base32密钥。@param seconds Unix秒时间。@param digits 输出位数。@returns 30秒周期口令。 */
export function totp(secret:string,seconds=Date.now()/1000,digits:6|8=6) {
  return hotp(secret,BigInt(Math.floor(seconds/30)),digits);     // T0=0，步长固定30秒
}

/** @param secret Base32密钥。@param code 已校验格式的6位口令。@param after 已消费的最大计数器。@param seconds 当前Unix秒时间。@returns 可消费计数器或null。 */
export function counter(secret:string,code:string,after:bigint,seconds=Date.now()/1000) {
  const current=BigInt(Math.floor(seconds/30));                  // 时间只读取一次，避免跨周期中途变化
  let match:bigint|null=null;                                    // 三个窗口都比较，不因命中位置提前返回
  for (const drift of [-1n,0n,1n]) {
    const moving=current+drift;                                // 允许认证器与服务器相差一个周期
    if (moving<0n) continue;                                    // 纪元起点之前没有合法计数器
    const equal=timingSafeEqual(Buffer.from(code),Buffer.from(hotp(secret,moving))); // 已验证的6位输入总是等长比较
    if (equal && moving>after) match=moving;                    // 相同或更旧计数器不能重放
  }
  return match;                                                 // 取匹配中的最大计数器，保持单调消费
}
