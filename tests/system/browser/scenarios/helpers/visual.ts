import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

/** M9-C1 T2 视觉验收截图输出目录（gitignored 证据域）。 */
const T2_VISUAL_DIR = join(
    process.cwd(),
    ".e2e-results",
    "2026-09-15-story-collection-continuous-creation",
    "T2",
    "visual",
);

/**
 * 保存 T2 视觉验收截图（桌面/移动端逐屏证据）。
 * @param page Playwright 页面
 * @param name 截图名（不含扩展名）
 */
export async function captureT2Visual(page: Page, name: string): Promise<void> {
    mkdirSync(T2_VISUAL_DIR, { recursive: true });
    await page.screenshot({
        path: join(T2_VISUAL_DIR, `${name}.png`),
        fullPage: true,
    });
}
