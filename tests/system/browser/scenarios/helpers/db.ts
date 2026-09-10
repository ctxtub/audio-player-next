import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * L3 场景隔离库直查助手（任务13 第二段）。
 *
 * 隔离库由 harness app-server 注入（快照内独占文件），路径经
 * `.e2e-runtime/browser-harness/app-handle-<runId>.json` 的 dbFile 字段
 * 由 evidence-recorder 记录（fixtures 自动记 step，本助手仅直读同一路径，
 * 不自造库、不碰 prisma/dev.db）。
 *
 * 直查经 sqlite3 CLI 只读 SELECT（参数数组传参，不走 shell），由测试进程
 * 在页面关闭后执行，不靠页面内日志自证。
 */

/** harness 运行时目录（与 fixtures 同口径）。 */
const runtimeDir: string = join(process.cwd(), ".e2e-runtime", "browser-harness");

/** 允许直查的表白名单。 */
const allowedTables: readonly string[] = [
    "GuestGenerationHistory",
    "GuestPromptHistory",
    "GuestChatMessage",
    "GuestPlaybackProgress",
    "GenerationHistory",
    "PromptHistory",
    "ChatMessage",
    "UserPlaybackProgress",
];

/**
 * 解析当次运行的隔离库文件路径。
 * @param runId harness 运行标识
 * @returns 隔离库绝对路径
 */
export function resolveIsolationDbPath(runId: string): string {
    const handlePath: string = join(runtimeDir, `app-handle-${runId}.json`);
    const raw: string = readFileSync(handlePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    const dbFile: unknown = (parsed as Record<string, unknown>)["dbFile"];
    if (typeof dbFile !== "string" || dbFile.length === 0) {
        throw new Error("[db-helper] app-handle 缺 dbFile 字段");
    }
    return dbFile;
}

/**
 * 对隔离库执行只读 SELECT 并返回 stdout 裁剪串。
 * @param dbFile 隔离库文件路径
 * @param sql 只读 SQL（调用方保证仅 SELECT 且表名已白名单校验）
 * @returns stdout 文本
 */
function queryReadOnly(dbFile: string, sql: string): string {
    const out: string = execFileSync("sqlite3", [dbFile, sql], {
        encoding: "utf8",
        timeout: 15000,
    });
    return out.trim();
}

/**
 * 转义 SQL 单引号字面量。
 * @param value 原始字符串
 * @returns 转义后可嵌入单引号的字面量
 */
function escapeLiteral(value: string): string {
    return value.replace(/'/g, "''");
}

/**
 * 统计单表总行数（隔离库内仅当次运行数据，无需按 guestId 过滤）。
 * @param dbFile 隔离库文件路径
 * @param table 表名（白名单内）
 * @returns 行数
 */
export function countTableRows(dbFile: string, table: string): number {
    if (!allowedTables.includes(table)) {
        throw new Error(`[db-helper] 非法表名：${table}`);
    }
    const out: string = queryReadOnly(dbFile, `SELECT COUNT(*) FROM "${table}";`);
    return Number(out);
}

/**
 * 访客聊天是否含指定片段（尾部落库内容断言）。
 * @param dbFile 隔离库文件路径
 * @param fragment 内容片段（转义后 LIKE 匹配）
 * @returns 命中返回 true
 */
export function guestChatContains(dbFile: string, fragment: string): boolean {
    const out: string = queryReadOnly(
        dbFile,
        `SELECT COUNT(*) FROM GuestChatMessage WHERE content LIKE '%${escapeLiteral(fragment)}%';`,
    );
    return Number(out) > 0;
}

/**
 * 按提示词精确查询访客生成历史（含故事正文，供回放 source/text 匹配断言）。
 * @param dbFile 隔离库文件路径
 * @param prompt 提示词原文
 * @returns 命中行（id/prompt/storyText）
 */
export function findGuestGenerationsByPrompt(
    dbFile: string,
    prompt: string,
): Array<{ id: number; prompt: string; storyText: string }> {
    const out: string = queryReadOnly(
        dbFile,
        `SELECT id || char(31) || prompt || char(31) || substr(storyText, 1, 2000) FROM GuestGenerationHistory WHERE prompt = '${escapeLiteral(prompt)}' ORDER BY id ASC;`,
    );
    if (out.length === 0) {
        return [];
    }
    const rows: Array<{ id: number; prompt: string; storyText: string }> = [];
    for (const line of out.split("\n")) {
        const parts: string[] = line.split("");
        if (parts.length < 3) {
            continue;
        }
        rows.push({
            id: Number(parts[0]),
            prompt: parts[1] ?? "",
            storyText: parts[2] ?? "",
        });
    }
    return rows;
}
