import type { Page } from "@playwright/test";
import { dismissOnboarding } from "./guest";

/**
 * L3 场景身份前置助手（任务13 第二段）。
 *
 * 经由 harness 被测服务真实 API 签发身份（访客/注册），测试进程直取
 * Set-Cookie 令牌后以非 Secure 写入上下文 cookie jar，再进业务页。
 * 背景：harness 本地 http 上 product 按生产要求置 Secure（生产 HTTPS 正确），
 * WebKit 拒收 http Secure（Chromium 放行 localhost 例外），致 UI 访客/注册键在
 * Safari 系Harness 内无法落盘；此处仅换测试侧传输通道，不自造令牌、不改产品语义。
 */

/** tRPC 批量包体（单 op）。 */
type BatchBody = Record<string, { json: unknown }>;

/**
 * 从 Set-Cookie 头组中提取指定 cookie 值。
 * @param setCookies Set-Cookie 头数组
 * @param name cookie 名
 * @returns 值（未命中抛错）
 */
function pickCookieValue(setCookies: string[], name: string): string {
    for (const header of setCookies) {
        const first: string = header.split(";")[0] ?? "";
        const eq: number = first.indexOf("=");
        if (eq > 0 && first.slice(0, eq).trim() === name) {
            return first.slice(eq + 1).trim();
        }
    }
    throw new Error(`[auth-helper] Set-Cookie 缺 ${name}`);
}

/**
 * 取 Node 侧 fetch 响应的全部 Set-Cookie。
 * @param res fetch 响应
 * @returns Set-Cookie 数组
 */
function readSetCookies(res: Response): string[] {
    const headers = res.headers as unknown as {
        getSetCookie?: () => string[];
        get: (name: string) => string | null;
    };
    if (typeof headers.getSetCookie === "function") {
        return headers.getSetCookie();
    }
    const single: string | null = headers.get("set-cookie");
    return single ? [single] : [];
}

/**
 * 经真实访客 API 进入创作页（双浏览器稳态）。
 * @param page Playwright 页面
 * @param appUrl harness 被测地址
 */
export async function ensureGuestByApi(page: Page, appUrl: string): Promise<void> {
    const body: BatchBody = { "0": { json: {} } };
    const res: Response = await fetch(`${appUrl}/api/trpc/auth.enterGuestMode?batch=1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        throw new Error(`[auth-helper] enterGuestMode 非 200：${res.status}`);
    }
    const guestValue: string = pickCookieValue(readSetCookies(res), "guest");
    await page.context().addCookies([
        {
            name: "guest",
            value: guestValue,
            domain: "localhost",
            path: "/",
            httpOnly: true,
            secure: false,
            sameSite: "Lax",
            expires: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
        },
    ]);
    await page.goto(`${appUrl}/chat`, { waitUntil: "networkidle", timeout: 60000 });
    await dismissOnboarding(page);
}

/**
 * 经真实注册 API 进入创作页（双浏览器稳态，合成假账号）。
 * @param page Playwright 页面
 * @param appUrl harness 被测地址
 * @param username 唯一账号
 * @param password 密码
 */
export async function ensureRegisteredByApi(
    page: Page,
    appUrl: string,
    username: string,
    password: string,
): Promise<void> {
    const body: BatchBody = { "0": { json: { username, password } } };
    const res: Response = await fetch(`${appUrl}/api/trpc/auth.register?batch=1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        throw new Error(`[auth-helper] register 非 200：${res.status}`);
    }
    const sessionValue: string = pickCookieValue(readSetCookies(res), "auth");
    await page.context().addCookies([
        {
            name: "auth",
            value: sessionValue,
            domain: "localhost",
            path: "/",
            httpOnly: true,
            secure: false,
            sameSite: "Lax",
            expires: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
        },
    ]);
    await page.goto(`${appUrl}/chat`, { waitUntil: "networkidle", timeout: 60000 });
    await dismissOnboarding(page);
}
