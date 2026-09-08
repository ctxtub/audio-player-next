/**
 * tRPC 流观察 hook（仓库跟踪资产，缺陷 #7 修复）。
 *
 * 职责：为 E2E `network.json` 证据包装 fetch，记录 tRPC 调用观测记录。
 * 缺陷 #7 根因：旧实现对一切响应调用 `clone().text()`；当应用已持有流
 * reader（tRPC httpBatchStreamLink 流式常态）时 clone 必抛 body 消费类异常，
 * 旧实现把它记为请求失败——成功流也被报 `user aborted` 类失败，证据失真。
 *
 * 修复后铁律：
 * 1. 流式响应（或 body 已锁定）只记可验证元数据（状态、content-type、
 *    响应建立），绝不调用 clone/text/cancel，绝不消费或取消流。
 * 2. 消费/取消类异常（AbortError、terminated、Body has already been consumed
 *    等） verdict 一律为 `cancelled`，绝不记为失败；本模块不存在 `failed`
 *    verdict，结构上杜绝误记。
 * 3. 流成功证据固定为 UI + 后端日志 + 下游调用三角互证
 *    （见 STREAM_SUCCESS_EVIDENCE），hook 不对流做成功断言。
 * 4. 非流响应保留安全 body 摘要（截断上限 + truncated 标记）；记录只含
 *    pathname，不记录 query（tRPC GET 批输入在 query 中，防载荷泄露）。
 * 5. hook 对应用完全透明：原样返回响应原对象；请求异常记录后原样重抛。
 *
 * 说明：本模块零依赖、兼容浏览器与 Node（WHATWG fetch 语义），不读取任何
 * .env 文件，不含绝对路径、端口与密钥；测试一律用纯内存 mock。
 */

// 中文注释：非流 body 摘要预览截断上限（字符数）。
export const NON_STREAM_PREVIEW_CAP = 512;

// 中文注释：错误信息记录截断上限（字符数，避免长堆栈污染证据）。
export const OBSERVE_MESSAGE_CAP = 200;

// 中文注释：流成功证据三角互证固定项：UI 断言 + 后端日志 + 下游调用。
export const STREAM_SUCCESS_EVIDENCE = ['ui', 'server-log', 'downstream'];

// 中文注释：默认流式路径片段（tRPC httpBatchStreamLink 端点名）。
export const DEFAULT_STREAMING_PATHS = ['agent.interact'];

// 中文注释：流式 content-type 标记（大小写不敏感匹配）。
const STREAMING_CONTENT_TYPES = ['text/event-stream', 'application/x-ndjson'];

// 中文注释：消费/取消类异常匹配模式（命中即 cancelled，绝不记为失败）。
const CANCEL_PATTERNS = [
    /abort/i,
    /cancel/i,
    /terminat/i,
    /already been consumed/i,
    /body is unusable/i,
    /body used/i,
    /disturbed/i,
    /locked/i,
];

/**
 * 从请求地址提取仅 pathname 的观测路径（query 一律丢弃）。
 * @param url 请求地址（绝对或相对）。
 * @returns pathname，解析失败时为 `unknown`。
 */
export function extractObservePath(url) {
    try {
        return new URL(url, 'http://localhost').pathname;
    } catch {
        return 'unknown';
    }
}

/**
 * 读取响应的 content-type 主值（去参数、小写）。
 * @param res fetch 响应。
 * @returns content-type 主值，缺失为空字符串。
 */
function readContentType(res) {
    try {
        const raw = res?.headers?.get?.('content-type') ?? '';
        return String(raw).split(';')[0].trim().toLowerCase();
    } catch {
        return '';
    }
}

/**
 * 判定响应是否应按流处理（流式标记命中其一即按流处理）。
 * @param args 判定入参（含路径、content-type、body 锁定态与流路径表）。
 * @returns 按流处理返回 true。
 */
export function isStreamingLike(args) {
    if (args.bodyLocked) {
        return true;
    }
    if (STREAMING_CONTENT_TYPES.some((mark) => args.contentType.includes(mark))) {
        return true;
    }
    const paths = args.streamingPaths ?? DEFAULT_STREAMING_PATHS;
    return paths.some((fragment) => fragment !== '' && args.path.includes(fragment));
}

/**
 * 把观察期异常归类为取消或真实错误。
 * @param err 捕获到的异常。
 * @returns `cancelled`（消费/取消类）或 `error`（真实错误）。
 */
export function classifyObserveError(err) {
    const name = err?.name ?? '';
    if (name === 'AbortError') {
        return 'cancelled';
    }
    const message = err?.message ?? '';
    const haystack = `${name}: ${message}`;
    return CANCEL_PATTERNS.some((pattern) => pattern.test(haystack)) ? 'cancelled' : 'error';
}

/**
 * 对非流 body 文本生成安全摘要（截断预览 + 原长 + 截断标记）。
 * @param text body 文本。
 * @returns 安全摘要。
 */
export function summarizeBodySafely(text) {
    const source = text ?? '';
    return {
        length: source.length,
        preview: source.slice(0, NON_STREAM_PREVIEW_CAP),
        truncated: source.length > NON_STREAM_PREVIEW_CAP,
    };
}

/**
 * 截断错误信息后记录（防长堆栈污染证据）。
 * @param err 捕获到的异常。
 * @returns 截断后的单行信息。
 */
function capErrorMessage(err) {
    const raw = err?.message ?? String(err);
    return String(raw).replace(/\s+/g, ' ').slice(0, OBSERVE_MESSAGE_CAP);
}

/**
 * 创建观察 fetch 包装（对应用透明，只追加观测记录）。
 * @param fetchImpl 底层 fetch 实现。
 * @param options 选项（流路径表覆盖）。
 * @returns 包装后 fetch 与观测记录数组。
 */
export function createObservingFetch(fetchImpl, options) {
    const streamingPaths = options?.streamingPaths ?? DEFAULT_STREAMING_PATHS;
    const records = [];

    async function observingFetch(url, init) {
        const path = extractObservePath(url);
        let res;
        try {
            res = await fetchImpl(url, init);
        } catch (err) {
            const verdict = classifyObserveError(err);
            records.push({
                kind: 'request',
                path,
                verdict,
                message: verdict === 'error' ? capErrorMessage(err) : String(err?.name ?? 'cancelled'),
            });
            throw err;
        }

        const contentType = readContentType(res);
        let bodyLocked = false;
        try {
            bodyLocked = res?.body?.locked === true;
        } catch {
            bodyLocked = false;
        }
        const status = typeof res?.status === 'number' ? res.status : 0;

        if (isStreamingLike({ path, contentType, bodyLocked, streamingPaths })) {
            records.push({
                kind: 'stream',
                path,
                status,
                contentType,
                established: true,
                successEvidence: [...STREAM_SUCCESS_EVIDENCE],
                verdict: status >= 400 ? 'http-error' : 'stream-established',
            });
            return res;
        }

        try {
            const text = await res.clone().text();
            records.push({
                kind: 'body',
                path,
                status,
                summary: summarizeBodySafely(text),
                verdict: status >= 400 ? 'http-error' : 'ok',
            });
            return res;
        } catch (err) {
            records.push({
                kind: 'body',
                path,
                status,
                summary: summarizeBodySafely(''),
                note: 'body-unreadable',
                verdict: classifyObserveError(err),
            });
            return res;
        }
    }

    return { fetch: observingFetch, records };
}
