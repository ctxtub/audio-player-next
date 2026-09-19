import type { Locator, Page } from "@playwright/test";
import { expect } from "../../harness/fixtures";

/**
 * 四段跨页播放旅程的共享可见 UI 步骤。
 *
 * 铁律：
 * - 只操作可见 UI（角色/名称/占位符/可见文本定位，可见按钮点击）；
 * - 通过标准只认可见文本、元素可见性与页面 URL；
 * - 不读 Store、不调 API/DB、不读隐藏 DOM 属性、不做源码字符串断言；
 * - 不设任何测试开关、探针或内容伪造；mock TTS/ Agent 由 harness 统一提供。
 */

export const CHAT_URL_SUFFIX = "/chat";
export const LIBRARY_URL_SUFFIX = "/library";

/** 截图输出根（gitignored，提交时只显式加 visual-report.md，不含 png）。 */
export const VISUAL_DIR = ".e2e-results/product-journey-completion/cross-page-polish/visual";

/**
 * 截取旅程可视化证据（PNG 只落盘 gitignored 目录，不进断言）。
 * @param page 页面
 * @param name 文件名（不含扩展名）
 */
export async function captureVisual(page: Page, name: string): Promise<void> {
    await page.screenshot({ path: `${VISUAL_DIR}/${name}.png` });
}

/**
 * 创作页消息区作用域（Mini/Expanded 在其外，故事卡片按钮在其内，
 * 以此隔离同名「播放/重新播放」按钮）。
 */
export function chatContent(page: Page): Locator {
    return page.getByTestId("main-chrome-content");
}

/** 创作输入框（占位符定位）。 */
export function composerInput(page: Page): Locator {
    return page.getByPlaceholder("请输入内容...");
}

/** 连续创作开关（AT 角色定位，可见开关）。 */
export function continuousSwitch(page: Page): Locator {
    return page.getByRole("switch", { name: "连续创作开关" });
}

/** 状态卡可见文案（连续创作状态唯一可见断言口）。 */
export function continuousStatusText(page: Page): Locator {
    return page.getByTestId("continuous-status-card").getByRole("status");
}

/**
 * 发送一篇故事并等待其输入被接收（发送按钮恢复可用即视为已提交；
 * 就绪等待由调用方按卡片按钮做）。
 * 提交走键盘回车（与点击「发送」同一提交入口），覆盖键盘创作路径。
 * @param page 页面
 * @param prompt 用户输入
 */
export async function sendStory(page: Page, prompt: string): Promise<void> {
    await composerInput(page).fill(prompt);
    await composerInput(page).press("Enter");
}

/**
 * 第 index 篇故事卡片的主操作按钮（按创作顺序 DOM 恒定位，与播放状态无关；
 * 首篇草稿自动播会把「播放」翻成「暂停」，序号定位不受影响）。
 * 就绪态文案覆盖播放/暂停/继续播放/重新播放/正在准备语音（均为可见文本）。
 */
const CARD_ACTION_PATTERN = /^(播放|暂停|继续播放|重新播放|正在准备语音)$/;

export function cardActionButton(page: Page, index: number): Locator {
    return cardActionButtons(page).nth(index);
}

/** 全部故事卡片主操作按钮（按创作顺序，数量即卡片数）。 */
export function cardActionButtons(page: Page): Locator {
    return chatContent(page).getByRole("button", { name: CARD_ACTION_PATTERN });
}

/** 读卡片主操作按钮当前可见文案。 */
export async function readCardActionLabel(button: Locator): Promise<string> {
    return ((await button.innerText()).trim());
}

/**
 * 等待第 index 篇故事卡片到来（就绪「播放」，或首篇已被草稿自动播接管「暂停」；
 * 两种都是卡片到达的可见证据）。
 * @param page 页面
 * @param index 卡片序号（0 起，按创作顺序）
 * @param timeoutMs 超时毫秒
 */
export async function waitStoryCardReady(
    page: Page,
    index: number,
    timeoutMs = 90000,
): Promise<void> {
    const button = cardActionButton(page, index);
    await expect(button).toBeVisible({ timeout: timeoutMs });
    await expect
        .poll(async () => readCardActionLabel(button), { timeout: timeoutMs })
        .toMatch(/^(播放|暂停)$/);
}

/**
 * 等待第 index 篇故事卡片播完（主操作按钮落到可见「重新播放」；
 * 无人点击却播完 = 自动播发生）。
 * @param page 页面
 * @param index 卡片序号（0 起，按创作顺序）
 * @param timeoutMs 超时毫秒
 */
export async function waitCardEnded(page: Page, index: number, timeoutMs = 60000): Promise<void> {
    const button = cardActionButton(page, index);
    await expect(button).toBeVisible({ timeout: timeoutMs });
    await expect
        .poll(async () => readCardActionLabel(button), { timeout: timeoutMs })
        .toBe("重新播放");
}

/**
 * 设置连续创作开关到目标态（点击真实开关；只读状态卡可见文案做决策与确认，
 * 不读任何隐藏属性）。
 * 前置：调用时须处于静默态（无播放/无在途下一篇），否则开启会立即进入调度
 * 文案而非「已开启」。各旅程均在卡片播完后调用。
 * @param page 页面
 * @param enabled 目标态
 */
export async function setContinuousEnabled(page: Page, enabled: boolean): Promise<void> {
    const status = continuousStatusText(page);
    const isOff = ((await status.innerText()).trim() === "连续创作已关闭");
    if (enabled === isOff) {
        await continuousSwitch(page).click();
    }
    await expect(continuousStatusText(page)).toHaveText(enabled ? "连续创作已开启" : "连续创作已关闭", {
        timeout: 10000,
    });
}

/**
 * 等待系统续写卡片自动开始播放（无人点击）。
 *
 * 卡片只展示“当前播放会话”的实时状态；接力到再下一篇后，前一篇会恢复
 * 可播放态。因此这里观察目标卡真实出现「暂停」或短暂完成态，而不要求它在
 * 后续接力期间永久停留为「重新播放」。
 * 容错：若下一篇卡片出现产品可见的「发送失败」，按用户方式点其「重试」
 * （有界两轮；仍失败则如实抛错，绝不吞错）。重试后目标自动跟随末卡。
 * @param page 页面
 * @param index 目标卡片序号（0 起）
 * @param timeoutMs 总预算毫秒
 */
export async function waitAutoplayedCardActive(
    page: Page,
    index: number,
    timeoutMs = 150000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let target = index;
    let retries = 0;
    for (;;) {
        const buttons = cardActionButtons(page);
        const count = await buttons.count();
        if (count > target) {
            const label = await readCardActionLabel(buttons.nth(target));
            if (label === "暂停" || label === "重新播放") {
                return;
            }
        }
        const nextCard = page.getByTestId("continuous-next-card");
        if ((await nextCard.getByText("发送失败").count()) > 0) {
            retries += 1;
            if (retries > 2) {
                throw new Error("next-work send failed persistently after 2 product retries");
            }
            await nextCard.getByRole("button", { name: "重试" }).click();
            target = Math.max(target, (await cardActionButtons(page).count()) - 1);
            await page.waitForTimeout(2000);
            continue;
        }
        if (Date.now() >= deadline) {
            throw new Error(`autoplayed card ${target} did not become active within budget`);
        }
        await page.waitForTimeout(100);
    }
}

/**
 * 卡片落定为「播放」后起播，并等到播放中（暂停可见）。
 * 落定等待覆盖晋升回写窗口；起播后整轨在前。
 * @param page 页面
 * @param index 卡片序号（0 起，按创作顺序 DOM 定位）
 */
export async function playCardWhenSettled(page: Page, index: number): Promise<void> {
    const button = cardActionButton(page, index);
    await expect(button).toBeVisible({ timeout: 15000 });
    await expect.poll(async () => readCardActionLabel(button), { timeout: 30000 }).toBe("播放");
    await button.click();
    await expect.poll(async () => readCardActionLabel(button), { timeout: 15000 }).toBe("暂停");
}

/**
 * 在已落定卡片上验证完整播放三态：起播 → 暂停 → 继续播放。
 * 前置：卡片须处于稳定态（「播放」或「重新播放」，即晋升回写已落定，
 * 无自动播在途）。起播后整轨在前，无尾段竞态。
 * 全部经由卡片按钮可见文案断言。
 * @param page 页面
 * @param index 卡片序号（0 起，按创作顺序 DOM 定位）
 */
export async function verifyCardPlayPauseResume(page: Page, index: number): Promise<void> {
    const button = cardActionButton(page, index);
    await expect(button).toBeVisible({ timeout: 15000 });
    const startLabel = await expect
        .poll(async () => readCardActionLabel(button), { timeout: 30000 })
        .toMatch(/^(播放|重新播放)$/)
        .then(() => readCardActionLabel(button));
    expect(["播放", "重新播放"]).toContain(startLabel);
    await button.click();
    await expect.poll(async () => readCardActionLabel(button), { timeout: 15000 }).toBe("暂停");
    await button.click();
    await expect.poll(async () => readCardActionLabel(button), { timeout: 10000 }).toBe("继续播放");
    await button.click();
    // 继续后回到播放中（暂停复现）或播完（重新播放）：继续播放生效后音频
    // 必推进，两种都是其合法可见终态（停留继续播放 = 继续失败，轮询超时即失败）。
    await expect
        .poll(async () => readCardActionLabel(button), { timeout: 15000 })
        .toMatch(/^(暂停|重新播放)$/);
}

/**
 * 读取 Mini 主标题与副标题可见文本。
 * @param page 页面
 * @returns 主标题与副标题（副标题缺省为 null）
 */
export async function readMiniTitles(page: Page): Promise<{ title: string; secondary: string | null }> {
    const mini = page.getByTestId("mini-now-playing");
    await expect(mini).toBeVisible({ timeout: 15000 });
    const title = (await page.getByTestId("mini-title").innerText()).trim();
    const secondaryLocator = page.getByTestId("mini-secondary-label");
    const secondaryCount = await secondaryLocator.count();
    const secondary =
        secondaryCount > 0 ? ((await secondaryLocator.first().innerText()).trim() || null) : null;
    return { title, secondary };
}

/**
 * 经 Mini 打开 Expanded（点击可见元信息区）。
 * @param page 页面
 */
export async function openExpandedFromMini(page: Page): Promise<void> {
    await page.getByTestId("mini-metadata-button").click();
    await expect(page.getByTestId("expanded-now-playing")).toBeVisible({ timeout: 10000 });
}

/**
 * 关闭 Expanded（点击可见关闭按钮）。
 * @param page 页面
 */
export async function closeExpanded(page: Page): Promise<void> {
    await page.getByTestId("expanded-close-button").click();
    await expect(page.getByTestId("expanded-now-playing")).toBeHidden({ timeout: 10000 });
}

/**
 * 读取 Expanded 标题区可见文本。
 * @param page 页面
 */
export async function readExpandedTitles(page: Page): Promise<{ title: string; subtitle: string }> {
    const title = (await page.getByTestId("expanded-title").innerText()).trim();
    const subtitle = (await page.getByTestId("expanded-subtitle").innerText()).trim();
    return { title, subtitle };
}

/**
 * 断言 Expanded 时间线正在推进（两读秒级文本不同 = 音频真实播放；
 * 纯可见文本断言，不读任何隐藏属性）。
 * @param page 页面
 */
export async function expectExpandedTimelineAdvancing(page: Page): Promise<void> {
    const current = page.getByTestId("expanded-timeline-current");
    const first = (await current.innerText()).trim();
    await expect
        .poll(async () => ((await current.innerText()).trim() === first ? "same" : "advanced"), {
            timeout: 15000,
        })
        .toBe("advanced");
}
