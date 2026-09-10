/**
 * 可编程 mock 上游（任务13 harness）。
 *
 * 收编任务12 spike scripts/dev/mock-openai.mjs：固定 MP3 端点 +
 * TTS/Agent 固定响应端点；随机空闲端口；仅监听 localhost。
 *
 * 路由：
 * - GET  /health               → {"ok":true} 健康检查
 * - GET  /fixture.mp3          → 固定 MP3（Content-Type: audio/mpeg，支持 Range 206）
 * - POST /v1/audio/speech*     → 同固定 MP3（模拟 TTS 上游，Content-Type: audio/mpeg）
 * - POST /v1/chat/completions  → Agent 固定响应（stream=false 走 JSON，stream=true 走 SSE 含 [DONE]）
 * - 其他                       → 404
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// 中文注释：固定 MP3 字节来源（ffmpeg 生成的 1s 静音 mp3；仓库根 cwd 解析，Playwright 转 CJS 下禁用 import.meta）。
const fixturePath = join(process.cwd(), 'tests', 'support', 'fixtures', 'spike-fixed.mp3');

// 中文注释：Agent 非流固定响应（确定性文本，不访问真实上游）。
const AGENT_FIXED_REPLY = 'harness 固定 mock 回复';

// 中文注释：运行中的 mock 实例表（stop 时按 handle id 回收）。
let nextMockId = 1;

/**
 * 读入固定 MP3 字节（启动时一次，失败即抛错不掩盖）。
 * @returns MP3 字节
 */
function loadFixtureBytes() {
    if (!existsSync(fixturePath)) {
        throw new Error(`[mock-harness] fixture 缺失: ${fixturePath}`);
    }
    return readFileSync(fixturePath);
}

/**
 * 解析 Range 头，返回 [start, end]（闭区间），非法返回 null。
 * @param raw Range 头原始值
 * @param total 资源总字节数
 * @returns 闭区间或 null
 */
function parseRange(raw, total) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(raw ?? '');
    if (!match) return null;
    let start = match[1] === '' ? null : Number(match[1]);
    let end = match[2] === '' ? null : Number(match[2]);
    if (start === null && end === null) return null;
    if (start === null) {
        start = Math.max(0, total - end);
        end = total - 1;
    } else if (end === null || end >= total) {
        end = total - 1;
    }
    if (start >= total || start > end) return null;
    return [start, end];
}

/**
 * 以固定 MP3 响应（含 Range 206 支持，浏览器 <audio> 通常发 Range 请求）。
 * @param req 请求对象
 * @param res 响应对象
 * @param mp3Bytes 固定 MP3 字节
 */
function serveMp3(req, res, mp3Bytes) {
    const total = mp3Bytes.length;
    const range = parseRange(req.headers.range, total);
    if (range) {
        const [start, end] = range;
        res.writeHead(206, {
            'Content-Type': 'audio/mpeg',
            'Content-Length': end - start + 1,
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store',
        });
        res.end(mp3Bytes.subarray(start, end + 1));
        return;
    }
    res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': total,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
    });
    res.end(mp3Bytes);
}

/**
 * 读完请求体后回调查 JSON（消费掉请求体，避免 socket 挂起）。
 * @param req 请求对象
 * @returns 请求体 JSON（解析失败为空对象）
 */
function readJsonBody(req) {
    return new Promise((resolve) => {
        let raw = '';
        req.on('data', (chunk) => {
            raw += chunk;
        });
        req.on('end', () => {
            try {
                resolve(JSON.parse(raw || '{}'));
            } catch {
                resolve({});
            }
        });
    });
}

/**
 * Agent 固定响应（chat/completions）：非流回固定 JSON，流式回 SSE 含 [DONE]。
 * 兼容 LangChain functionCalling 结构化输出：带 tools 时回 tool_calls（supervisor 路由），
 * 故事类提示词定向 StoryAgent，其余定向 ChatAgent；不访问真实上游。
 * @param req 请求对象
 * @param res 响应对象
 */
async function serveAgent(req, res) {
    const body = await readJsonBody(req);
    const tools = Array.isArray(body.tools) ? body.tools : [];
    if (tools.length > 0) {
        const toolName =
            tools[0] && tools[0].function && typeof tools[0].function.name === 'string'
                ? tools[0].function.name
                : 'supervisor';
        const messages = Array.isArray(body.messages) ? body.messages : [];
        let lastUserText = '';
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m && m.role === 'user' && typeof m.content === 'string') {
                lastUserText = m.content;
                break;
            }
        }
        const wantsStory = /故事|继续|创作|续写|睡前|冒险|深海|星际|森林|动物/.test(lastUserText);
        const decision = wantsStory
            ? { next: 'StoryAgent', intent: 'Story' }
            : { next: 'ChatAgent', intent: 'Chat' };
        const argsText = JSON.stringify(decision);
        if (body.stream === true) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
            res.write(`data: {"choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_mock1","type":"function","function":{"name":"${toolName}","arguments":""}}]}}]}\n\n`);
            const mid = Math.ceil(argsText.length / 2);
            const part1 = argsText.slice(0, mid).replace(/"/g, '\\"');
            const part2 = argsText.slice(mid).replace(/"/g, '\\"');
            res.write(`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"${part1}"}}]}}]}\n\n`);
            res.write(`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"${part2}"}}]}}]}\n\n`);
            res.end(`data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n`);
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
            JSON.stringify({
                choices: [
                    {
                        message: {
                            role: 'assistant',
                            content: null,
                            tool_calls: [
                                {
                                    id: 'call_mock1',
                                    type: 'function',
                                    function: { name: toolName, arguments: argsText },
                                },
                            ],
                        },
                        finish_reason: 'tool_calls',
                    },
                ],
            }),
        );
        return;
    }
    if (body.stream === true) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        res.end(`data: {"choices":[{"delta":{"content":"${AGENT_FIXED_REPLY}"}}]}\n\ndata: [DONE]\n\n`);
        return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: AGENT_FIXED_REPLY } }] }));
}

/**
 * 分配一个当前空闲的本地 TCP 端口（绑定 0 后立即释放，仅作候选）。
 * @returns 候选端口号
 */
function allocFreePort() {
    return new Promise((resolve, reject) => {
        const srv = createServer();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address();
            const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
            srv.close((err) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(port);
            });
        });
    });
}

/**
 * 等待 server 开始监听。
 * @param server HTTP server
 * @param port 目标端口
 */
function waitListening(server, port) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve());
    });
}

/**
 * 等待 server 完全关闭。
 * @param server HTTP server
 */
function waitClosed(server) {
    return new Promise((resolve) => {
        server.close(() => resolve());
        setTimeout(() => resolve(), 5000);
    });
}

/**
 * 启动 mock 上游。
 * @param options 启动选项 { port? }（缺省取随机空闲端口）
 * @returns 句柄 { id, port, url, mp3Url, server }
 */
export async function startMockServer(options = {}) {
    const mp3Bytes = loadFixtureBytes();
    const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (req.method === 'GET' && url.pathname === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        if (req.method === 'GET' && url.pathname === '/fixture.mp3') {
            serveMp3(req, res, mp3Bytes);
            return;
        }
        if (req.method === 'POST' && url.pathname.startsWith('/v1/audio/speech')) {
            // 中文注释：消费掉请求体再回固定 MP3，避免 socket 挂起。
            req.resume();
            req.on('end', () => serveMp3(req, res, mp3Bytes));
            return;
        }
        if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
            serveAgent(req, res).catch(() => {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'mock agent failure' }));
            });
            return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    });
    const port = Number(options.port ?? (await allocFreePort()));
    await waitListening(server, port);
    const id = nextMockId;
    nextMockId += 1;
    return { id, port, url: `http://localhost:${port}`, mp3Url: `http://localhost:${port}/fixture.mp3`, server };
}

/**
 * 停止 mock 上游并确认端口释放。
 * @param handle startMockServer 返回的句柄
 */
export async function stopMockServer(handle) {
    if (!handle || !handle.server) return;
    await waitClosed(handle.server);
}

/**
 * 跨进程停止 mock（globalTeardown 用：按 pid 杀常驻进程并确认端口释放）。
 * @param pid mock 常驻进程 pid
 * @param port mock 端口
 */
export async function stopMockServerByPid(pid, port) {
    if (typeof pid === 'number') {
        try {
            process.kill(pid, 'SIGTERM');
        } catch {
            // 中文注释：已死即视为完成。
        }
        const start = Date.now();
        while (Date.now() - start < 5000) {
            try {
                process.kill(pid, 0);
                await new Promise((r) => setTimeout(r, 200));
            } catch {
                break;
            }
        }
        try {
            process.kill(pid, 0);
            process.kill(pid, 'SIGKILL');
        } catch {
            // 中文注释：已死即视为完成。
        }
    }
    if (typeof port === 'number') {
        const start = Date.now();
        const { createConnection } = await import('node:net');
        while (Date.now() - start < 10000) {
            const free = await new Promise((resolve) => {
                const sock = createConnection({ host: '127.0.0.1', port });
                sock.once('connect', () => {
                    sock.destroy();
                    resolve(false);
                });
                sock.once('error', () => {
                    sock.destroy();
                    resolve(true);
                });
            });
            if (free) return;
            await new Promise((r) => setTimeout(r, 500));
        }
        throw new Error(`[mock-harness] 端口未释放: ${port}`);
    }
}
