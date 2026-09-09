/**
 * mock 上游常驻进程入口（任务13 harness）。
 *
 * 用法：node mock-standalone.mjs --port-file <path> [--port <n>]
 * 启动后把 { port, pid } 写进 port-file 并常驻，直到 SIGTERM/SIGINT。
 * （globalSetup 进程退出后服务必须继续存活，故用 detached 常驻进程承载。）
 */

import { writeFileSync } from 'node:fs';
import { startMockServer, stopMockServer } from './mock-openai.mjs';

// 中文注释：命令行参数（--port-file 必填，--port 缺省则随机空闲端口）。
const args = process.argv.slice(2);
let portFile = null;
let port = undefined;
for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--port-file') {
        portFile = args[i + 1];
        i += 1;
    } else if (args[i] === '--port') {
        port = Number(args[i + 1]);
        i += 1;
    }
}
if (!portFile) {
    console.error('[mock-standalone] 缺 --port-file');
    process.exit(2);
}

// 中文注释：当次 mock 句柄（信号处理回收用）。
let handle = null;

/**
 * 优雅退出（关 server 后再结束进程）。
 */
async function shutdown() {
    try {
        if (handle) await stopMockServer(handle);
    } finally {
        process.exit(0);
    }
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

handle = await startMockServer(port === undefined ? {} : { port });
writeFileSync(portFile, `${JSON.stringify({ port: handle.port, pid: process.pid })}\n`);
// eslint-disable-next-line no-console
console.log(`[mock-standalone] listening on ${handle.url}`);
