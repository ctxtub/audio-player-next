#!/usr/bin/env node
/**
 * 本地 mock 上游（任务12 spike 专用）。
 *
 * 用途：模拟 OpenAI 上游的固定 MP3 响应，供真实浏览器产生
 * loadedmetadata/ended 真媒体事件；同时承载应用的 OPENAI_BASE_URL 重定向。
 *
 * 路由：
 * - GET  /health               → {"ok":true} 健康检查
 * - GET  /fixture.mp3          → 固定 MP3（Content-Type: audio/mpeg，支持 Range 206）
 * - POST /v1/audio/speech*     → 同固定 MP3（模拟 TTS 上游，Content-Type: audio/mpeg）
 * - 其他                       → 404
 *
 * 运行：node scripts/dev/mock-openai.mjs [port]（默认 9301，环境变量 MOCK_PORT 覆盖）。
 * 仅监听 localhost，不访问外网。
 */

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// 中文注释：固定 MP3 字节来源（ffmpeg 生成的 1s 静音 mp3，4387 字节）。
const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "..", "..", "tests", "support", "fixtures", "spike-fixed.mp3");

if (!existsSync(fixturePath)) {
    console.error(`[mock-openai] fixture 缺失: ${fixturePath}`);
    process.exit(1);
}

// 中文注释：启动时一次性读入内存，spike 期间只读不写。
const mp3Bytes = readFileSync(fixturePath);
console.log(`[mock-openai] fixture 已加载: ${fixturePath} (${mp3Bytes.length} bytes)`);

/**
 * 解析 Range 头，返回 [start, end]（闭区间），非法返回 null。
 * @param raw Range 头原始值
 * @param total 资源总字节数
 */
const parseRange = (raw, total) => {
    const match = /^bytes=(\d*)-(\d*)$/.exec(raw ?? "");
    if (!match) return null;
    let start = match[1] === "" ? null : Number(match[1]);
    let end = match[2] === "" ? null : Number(match[2]);
    if (start === null && end === null) return null;
    if (start === null) {
        start = Math.max(0, total - end);
        end = total - 1;
    } else if (end === null || end >= total) {
        end = total - 1;
    }
    if (start >= total || start > end) return null;
    return [start, end];
};

/**
 * 以固定 MP3 响应（含 Range 206 支持，浏览器 <audio> 通常发 Range 请求）。
 * @param req 请求对象
 * @param res 响应对象
 */
const serveMp3 = (req, res) => {
    const total = mp3Bytes.length;
    const range = parseRange(req.headers.range, total);
    if (range) {
        const [start, end] = range;
        res.writeHead(206, {
            "Content-Type": "audio/mpeg",
            "Content-Length": end - start + 1,
            "Content-Range": `bytes ${start}-${end}/${total}`,
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-store",
        });
        res.end(mp3Bytes.subarray(start, end + 1));
        return;
    }
    res.writeHead(200, {
        "Content-Type": "audio/mpeg",
        "Content-Length": total,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
    });
    res.end(mp3Bytes);
};

const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    console.log(`[mock-openai] ${req.method} ${url.pathname}`);
    if (req.method === "GET" && url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
    }
    if (req.method === "GET" && url.pathname === "/fixture.mp3") {
        serveMp3(req, res);
        return;
    }
    if (req.method === "POST" && url.pathname.startsWith("/v1/audio/speech")) {
        // 中文注释：消费掉请求体再回固定 MP3，避免 socket 挂起。
        req.resume();
        req.on("end", () => serveMp3(req, res));
        return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
});

const port = Number(process.env.MOCK_PORT ?? process.argv[2] ?? 9301);
server.listen(port, "127.0.0.1", () => {
    console.log(`[mock-openai] listening on http://localhost:${port}`);
});
