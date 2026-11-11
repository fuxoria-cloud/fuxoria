/* 验证消息发送插件：配置受控可执行文件，stdin接收JSON，stdout只接受{"accepted":true}。
 * 调用：MESSAGE_SENDER_CONFIG=/absolute/private/senders.json；文件内容按email/sms配置{executable,arguments?,environment?}。
 * 程序须真实调用机构发送接口；无配置不会启用。参数数组不经过shell，不继承未授权环境变量。
 */
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { DeliveryError } from '../utils/delivery.js';
import type { MessageSender, MessageEnvelope } from '../features/verification.js';
const entry = z.object({ executable: z.string().refine(isAbsolute), arguments: z.array(z.string().max(1000)).max(30).default([]), environment: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(30).default([]) }).strict();
const schema = z.object({ email: entry.optional(), sms: entry.optional() }).strict();
async function configuration() {
    const path = process.env.MESSAGE_SENDER_CONFIG;
    if (!path)
        return null;
    if (!isAbsolute(path))
        throw new Error('发送配置文件需要绝对路径');
    const info = await stat(path);
    if (!info.isFile() || info.size > 16384 || info.mode & 0o022)
        throw new Error('发送配置须为不可被组或其他用户修改的小型普通文件');
    return schema.parse(JSON.parse(await readFile(path, 'utf8')));
}
const sender: MessageSender = {
    async available(channel) { return !!(await configuration())?.[channel]; },
    async send(message: MessageEnvelope) {
        const selected = (await configuration())?.[message.channel];
        if (!selected)
            throw new DeliveryError('此消息渠道未配置', false);
        const info = await stat(selected.executable);
        if (!info.isFile() || !(info.mode & 0o111) || (info.mode & 0o022))
            throw new DeliveryError('发送程序必须可执行且不可被其他用户修改', false);
        const environment: Record<string, string> = { LANG: 'C.UTF-8' };
        for (const name of selected.environment)
            if (process.env[name] !== undefined)
                environment[name] = process.env[name]!;
        await new Promise<void>((resolve, reject) => {
            const child = spawn(selected.executable, selected.arguments, { shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: environment });
            let output = '', bytes = 0, finished = false;
            const timeout = setTimeout(() => finish(new DeliveryError('发送超时，机构结果未知', true)), 10000);
            function finish(error?: Error) {
                if (finished)
                    return;
                finished = true;
                clearTimeout(timeout);
                if (error) {
                    if (child.pid)
                        try {
                            process.kill(-child.pid, 'SIGKILL');
                        }
                        catch (failure) {
                            if ((failure as NodeJS.ErrnoException).code !== 'ESRCH') {
                                reject(failure);
                                return;
                            }
                        }
                    reject(error);
                }
                else
                    resolve();
            }
            child.on('error', () => finish(new DeliveryError('发送程序未能启动', false, true)));
            child.stdin.on('error', () => finish(new DeliveryError('发送程序未能接收消息，结果未知', true)));
            child.stdout.on('data', (chunk: Buffer) => {
                bytes += chunk.length;
                if (bytes > 65536)
                    return finish(new DeliveryError('发送输出超限，机构结果未知', true));
                output += chunk.toString('utf8');
            });
            child.stderr.on('data', (chunk: Buffer) => {
                bytes += chunk.length;
                if (bytes > 65536)
                    finish(new DeliveryError('发送输出超限，机构结果未知', true));
            }); // 机构错误可能含凭据，不回显stderr
            child.on('close', code => {
                if (finished)
                    return;
                if (code !== 0)
                    return finish(new DeliveryError('发送程序异常退出，机构结果未知', true));
                try {
                    const answer = z.union([z.object({ accepted: z.literal(true) }).strict(), z.object({ accepted: z.literal(false), retryable: z.boolean().default(false) }).strict()]).parse(JSON.parse(output));
                    if (!answer.accepted)
                        return finish(new DeliveryError('机构明确未受理发送', false, answer.retryable));
                    finish();
                }
                catch {
                    finish(new DeliveryError('发送程序没有返回明确接受事实', true));
                }
            });
            child.stdin.end(JSON.stringify(message)); // 明文验证码仅在当前进程和受控发送程序内流转
        });
    },
};
export default sender;
