/* 增量密钥配置：为已有.env补独立实名/验证密钥，其他配置和已有密钥不变。
 * 调用：node scripts/keys.ts；只回报字段名，不输出任何密钥内容。
 */
import { readFile, writeFile, rename } from "node:fs/promises"; // 临时配置原子替换，保留原文件直到完整写入
import { randomBytes, randomUUID } from "node:crypto"; // 每个用途独立生成
const file = new URL("../.env", import.meta.url);
let content = await readFile(file, "utf8"); // 已有配置必须存在
const added: string[] = []; // 日志只记录字段名
for (const name of ["CERTIFICATION_KEY", "VERIFICATION_KEY", "RESOURCE_KEY"]) {
  const line = new RegExp(`^${name}=(.*)$`, "m"),
    found = line.exec(content);
  if (found?.[1]?.trim()) continue; // 不轮换任何已保存密文所依赖的密钥
  const value = randomBytes(32).toString("hex");
  content = found
    ? content.replace(line, `${name}=${value}`)
    : content.trimEnd() + `\n${name}=${value}\n`;
  added.push(name); // 仅补缺失或空字段
}
if (added.length) {
  const temporary = new URL(
    `../.env.keys-${randomUUID()}.tmp`,
    import.meta.url,
  );
  await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
  await rename(temporary, file);
} // 写入失败不会截断原配置，成功后保持600权限
console.log(
  added.length ? `已补齐独立密钥：${added.join("、")}。` : "独立密钥已齐全。",
); // 不将凭据发到终端或报告
