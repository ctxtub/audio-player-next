import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

/**   视觉验收截图输出目录（gitignored 证据域）。 */
const JOURNEY_VISUAL_DIR = join(
    process.cwd(),
    ".e2e-results",
    "2026-09-15-story-collection-continuous-creation",
    "",
    "visual",
);

/**
 * 保存  视觉验收截图（桌面/移动端逐屏证据）。
 * @param page Playwright 页面
 * @param name 截图名（不含扩展名）
 */
export async function captureJourneyVisual(page: Page, name: string): Promise<void> {
    mkdirSync(JOURNEY_VISUAL_DIR, { recursive: true });
    await page.screenshot({
        path: join(JOURNEY_VISUAL_DIR, `${name}.png`),
        fullPage: true,
    });
}
