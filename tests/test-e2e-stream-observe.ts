import assert from 'node:assert';

import type {
    ObserveRecord,
    ObservingFetchOptions,
    StreamSuccessEvidence,
} from '../scripts/e2e-stream-observe.mjs';
import {
    NON_STREAM_PREVIEW_CAP,
    STREAM_SUCCESS_EVIDENCE,
    classifyObserveError,
    createObservingFetch,
    summarizeBodySafely,
} from '../scripts/e2e-stream-observe.mjs';

/**
 * tRPC 流观察 hook 契约测试（缺陷 #7，测试基建）。
 *
 * 背景：旧观察 hook 用 `clone().text()` 读取 tRPC 流响应做证据；当应用已持有
 * 流 reader（tRPC httpBatchStreamLink 常态）时 clone 必抛 body 消费类异常，
 * 旧 hook 把它记为请求失败——成功流也被报 `user aborted` 类失败，观察证据失真。
 *
 * 覆盖行为：
 * RED（旧误报基线，永久钉住缺陷机制）：
 * 1. 真实 ReadableStream 被应用锁定后，旧 `clone().text()` 范式必抛且被记为失败，
 *    而应用仍能完整读出全部字节（成功流被误报为失败）。
 * 2. 中止风味异常（AbortError）同样被旧范式记为失败。
 * GREEN（修复后契约）：
 * 3. 流式响应只记元数据（状态、content-type、响应建立）， verdict 为
 *    `stream-established`，且从不调用 clone/text/cancel，应用 body 照常可读。
 * 4. body 已锁定（locked）的响应一律按流处理，不触碰 body。
 * 5. 消费/取消类异常（AbortError/terminated/Body has already been consumed 等）
 *     verdict 为 `cancelled`，绝不记为失败。
 * 6. 真实传输错误（fetch failed） verdict 为 `error`。
 * 7. 非流响应保留安全 body 摘要（截断上限 + truncated 标记）。
 * 8. 记录只含 pathname，不泄露 query（tRPC GET 批输入在 query 中）。
 * 9. 流成功证据固定为 UI + 后端日志 + 下游调用三角互证。
 *
 * 隔离约束：全程纯内存 mock（真实 WHATWG Response/ReadableStream + 手工 mock），
 * 不建 socket、不绑定端口，禁止触碰 :9301 / :31111 / :38080 / prisma/dev.db /
 * 既有 .e2e-runtime 资产；不写任何密钥（body 夹具仅为无意义占位文本）。
 */

// 中文注释：旧误报基线复现（缺陷 #7 产生机制；生产代码禁用，仅本测试用于 RED 钉住）。
async function legacyObserveWithCloneText(res: Response): Promise<{ verdict: string; detail: string }> {
    try {
        await res.clone().text();
        return { verdict: 'ok', detail: '' };
    } catch (err) {
        return { verdict: 'failed', detail: err instanceof Error ? err.message : String(err) };
    }
}

// 中文注释：无意义占位流文本（断言载荷完整性用，不含任何真实数据）。
const streamChunkA: string = 'stream-chunk-alpha';
const streamChunkB: string = 'stream-chunk-beta';

// 中文注释：构造一个应用已锁定的真实流式响应（tRPC 流被消费中的常态）。
function makeLockedStreamResponse(): { res: Response; appRead: Promise<string> } {
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(streamChunkA));
            controller.enqueue(new TextEncoder().encode(streamChunkB));
            controller.close();
        },
    });
    const res = new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
    });
    const reader: ReadableStreamDefaultReader<Uint8Array> = res.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const appRead: Promise<string> = (async () => {
        const parts: string[] = [];
        for (;;) {
            const next: ReadableStreamReadResult<Uint8Array> = await reader.read();
            if (next.done) {
                break;
            }
            parts.push(Buffer.from(next.value).toString('utf8'));
        }
        return parts.join(',');
    })();
    return { res, appRead };
}

// 中文注释：RED 用例 1——锁定流上旧 clone 范式必误报失败，而应用读取成功。
async function caseLegacyRedLockedStream(): Promise<void> {
    const locked: { res: Response; appRead: Promise<string> } = makeLockedStreamResponse();
    const verdict: { verdict: string; detail: string } = await legacyObserveWithCloneText(locked.res);
    assert.strictEqual(verdict.verdict, 'failed', '旧范式在锁定流上必须误报 failed（RED 基线）');
    assert.match(verdict.detail, /consumed|abort|disturbed|unusable|locked/i, '误报应为消费/取消类异常');
    assert.strictEqual(await locked.appRead, `${streamChunkA},${streamChunkB}`, '应用必须仍完整读出流（成功流被误报）');
}

// 中文注释：RED 用例 2——AbortError 风味同样被旧范式记为失败。
async function caseLegacyRedAbortFlavor(): Promise<void> {
    const aborting = {
        clone(): { text(): Promise<string> } {
            return {
                text(): Promise<string> {
                    return Promise.reject(new DOMException('This operation was aborted', 'AbortError'));
                },
            };
        },
    } as unknown as Response;
    const verdict: { verdict: string; detail: string } = await legacyObserveWithCloneText(aborting);
    assert.strictEqual(verdict.verdict, 'failed', '旧范式把 AbortError 记为 failed（RED 基线）');
}

// 中文注释：可计数 mock 响应（断言 hook 从不触碰流 body）。
interface CountingMockBody {
    /** cancel 被调用次数（必须恒为 0）。 */
    cancelCalls: number;
    /** 是否处于锁定态。 */
    locked: boolean;
}

// 中文注释：构造可计数 mock 响应。
function makeCountingResponse(opts: {
    /** HTTP 状态码。 */
    status: number;
    /** content-type 响应头。 */
    contentType: string;
    /** body 是否表现为已锁定。 */
    locked: boolean;
    /** 非流 body 文本（流式时忽略）。 */
    text?: string;
    /** 调用计数器。 */
    calls: { clone: number; text: number };
}): {
    /** mock 响应。 */
    res: Response;
    /** mock body。 */
    body: CountingMockBody;
} {
    const body: CountingMockBody & { cancel(): void } = {
        cancelCalls: 0,
        locked: opts.locked,
        cancel(): void {
            body.cancelCalls += 1;
        },
    };
    const res = {
        status: opts.status,
        headers: {
            get(name: string): string | null {
                return name.toLowerCase() === 'content-type' ? opts.contentType : null;
            },
        },
        body,
        clone(): Response {
            opts.calls.clone += 1;
            return this as unknown as Response;
        },
        text(): Promise<string> {
            opts.calls.text += 1;
            return Promise.resolve(opts.text ?? '');
        },
    } as unknown as Response;
    return { res, body };
}

// 中文注释：构造返回固定 mock 响应的 fetch 打桩。
function stubFetch(res: Response): (url: string) => Promise<Response> {
    return () => Promise.resolve(res);
}

// 中文注释：GREEN 用例 3——流式只记元数据，不碰 body，三角互证标记齐全。
async function caseFixedStreamMetadataOnly(): Promise<void> {
    const calls: { clone: number; text: number } = { clone: 0, text: 0 };
    const built: { res: Response; body: CountingMockBody } = makeCountingResponse({
        status: 200,
        contentType: 'text/event-stream',
        locked: false,
        calls,
    });
    const hook = createObservingFetch(stubFetch(built.res));
    const observed: Response = await hook.fetch('https://mock.invalid/api/trpc/agent.interact?batch=1&input=canary-query-payload');
    assert.strictEqual(observed, built.res, 'hook 必须原样返回响应（不替换/不消费）');
    assert.strictEqual(calls.clone, 0, '流式响应不得调用 clone');
    assert.strictEqual(calls.text, 0, '流式响应不得读取 body');
    assert.strictEqual(built.body.cancelCalls, 0, '流式响应不得取消 body');
    assert.strictEqual(hook.records.length, 1, '应恰记录一条');
    const record: ObserveRecord = hook.records[0];
    assert.strictEqual(record.kind, 'stream', '流式应记为 stream 记录');
    assert.strictEqual(record.verdict, 'stream-established', '成功流 verdict 应为 stream-established');
    if (record.kind === 'stream') {
        assert.strictEqual(record.status, 200, '应记录状态码');
        assert.ok(record.contentType.includes('text/event-stream'), '应记录 content-type');
        assert.strictEqual(record.established, true, '应记录响应已建立');
        assert.ok(!record.path.includes('canary-query-payload') && !record.path.includes('?'), '记录不得含 query（防批输入泄露）');
        assert.deepStrictEqual(record.successEvidence, ['ui', 'server-log', 'downstream'], '流成功证据必须为三角互证');
        const evidence: StreamSuccessEvidence = record.successEvidence;
        assert.deepStrictEqual([...evidence], [...STREAM_SUCCESS_EVIDENCE], '三角互证常量应一致');
    }
}

// 中文注释：GREEN 用例 4——locked body 即使 content-type 非流也按流处理。
async function caseFixedLockedBodyAsStream(): Promise<void> {
    const calls: { clone: number; text: number } = { clone: 0, text: 0 };
    const built: { res: Response; body: CountingMockBody } = makeCountingResponse({
        status: 200,
        contentType: 'application/json',
        locked: true,
        text: '{"ok":true}',
        calls,
    });
    const hook = createObservingFetch(stubFetch(built.res));
    await hook.fetch('https://mock.invalid/api/trpc/agent.interact');
    assert.strictEqual(calls.clone, 0, 'locked body 不得 clone');
    assert.strictEqual(calls.text, 0, 'locked body 不得读 text');
    assert.strictEqual(hook.records[0].kind, 'stream', 'locked body 应记为 stream 记录');
    assert.strictEqual(hook.records[0].verdict, 'stream-established', 'locked 流 verdict 应为 stream-established');
}

// 中文注释：GREEN 用例 5——消费/取消类异常 verdict 为 cancelled，绝不为失败。
async function caseFixedCancelNeverFailed(): Promise<void> {
    const failures: Array<unknown> = [
        new DOMException('This operation was aborted', 'AbortError'),
        new TypeError('terminated'),
        new TypeError('Response.clone: Body has already been consumed.'),
        new Error('Body is unusable: Body has already been read'),
        new Error('user aborted the stream'),
    ];
    for (const failure of failures) {
        assert.strictEqual(classifyObserveError(failure), 'cancelled', `应归类为取消：${String(failure)}`);
        const hook = createObservingFetch(() => Promise.reject(failure));
        await hook.fetch('https://mock.invalid/api/trpc/chat.send').catch(() => {
            // 中文注释：hook 记录后原样重抛（对应用透明），此处只断言记录。
        });
        assert.strictEqual(hook.records[0].verdict, 'cancelled', '取消类异常 verdict 应为 cancelled');
        assert.notStrictEqual(hook.records[0].verdict, 'failed', '取消类异常绝不能记为 failed');
        assert.notStrictEqual(hook.records[0].verdict, 'error', '取消类异常绝不能记为 error');
    }
}

// 中文注释：GREEN 用例 6——真实传输错误 verdict 为 error。
async function caseFixedGenuineError(): Promise<void> {
    const genuine = new TypeError('fetch failed');
    assert.strictEqual(classifyObserveError(genuine), 'error', '真实传输错误应归类为 error');
    const hook = createObservingFetch(() => Promise.reject(genuine));
    await hook.fetch('https://mock.invalid/api/trpc/chat.send').catch(() => {
        // 中文注释：hook 记录后原样重抛（对应用透明），此处只断言记录。
    });
    assert.strictEqual(hook.records[0].verdict, 'error', '真实错误 verdict 应为 error');
}

// 中文注释：GREEN 用例 7——非流保留截断 body 摘要。
async function caseFixedNonStreamSummary(): Promise<void> {
    const longBody: string = `{"data":"${'x'.repeat(2000)}"}`;
    const calls: { clone: number; text: number } = { clone: 0, text: 0 };
    const built: { res: Response; body: CountingMockBody } = makeCountingResponse({
        status: 200,
        contentType: 'application/json',
        locked: false,
        text: longBody,
        calls,
    });
    const hook = createObservingFetch(stubFetch(built.res));
    await hook.fetch('https://mock.invalid/api/trpc/chat.list');
    const record: ObserveRecord = hook.records[0];
    assert.strictEqual(record.kind, 'body', '非流应记为 body 记录');
    assert.strictEqual(record.verdict, 'ok', '2xx 非流 verdict 应为 ok');
    if (record.kind === 'body') {
        assert.strictEqual(record.summary.length, longBody.length, '摘要应记录原文长度');
        assert.ok(record.summary.preview.length <= NON_STREAM_PREVIEW_CAP, '摘要预览不得超截断上限');
        assert.strictEqual(record.summary.truncated, true, '超长 body 应标记 truncated');
        assert.deepStrictEqual(summarizeBodySafely(longBody), record.summary, '摘要应与工具函数一致');
    }
    const errCalls: { clone: number; text: number } = { clone: 0, text: 0 };
    const errBuilt: { res: Response; body: CountingMockBody } = makeCountingResponse({
        status: 500,
        contentType: 'application/json',
        locked: false,
        text: '{"error":"boom"}',
        calls: errCalls,
    });
    const errHook = createObservingFetch(stubFetch(errBuilt.res));
    await errHook.fetch('https://mock.invalid/api/trpc/chat.list');
    assert.strictEqual(errHook.records[0].verdict, 'http-error', '非 2xx 非流 verdict 应为 http-error');
}

// 中文注释：GREEN 用例 8——自定义流路径同样按流处理。
async function caseFixedCustomStreamingPath(): Promise<void> {
    const calls: { clone: number; text: number } = { clone: 0, text: 0 };
    const built: { res: Response; body: CountingMockBody } = makeCountingResponse({
        status: 200,
        contentType: 'application/octet-stream',
        locked: false,
        calls,
    });
    const options: ObservingFetchOptions = { streamingPaths: ['custom.stream'] };
    const hook = createObservingFetch(stubFetch(built.res), options);
    await hook.fetch('https://mock.invalid/api/trpc/custom.stream?batch=1');
    assert.strictEqual(calls.clone, 0, '自定义流路径不得 clone');
    assert.strictEqual(hook.records[0].kind, 'stream', '自定义流路径应记为 stream');
}

/**
 * 测试入口：串行执行 RED 基线与 GREEN 契约（全内存 mock，无网络/端口）。
 */
async function main(): Promise<void> {
    await caseLegacyRedLockedStream();
    await caseLegacyRedAbortFlavor();
    await caseFixedStreamMetadataOnly();
    await caseFixedLockedBodyAsStream();
    await caseFixedCancelNeverFailed();
    await caseFixedGenuineError();
    await caseFixedNonStreamSummary();
    await caseFixedCustomStreamingPath();
}

export default main();
