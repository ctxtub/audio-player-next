import type { Page } from "@playwright/test";

/**
 * 浏览器端故事作品（StoryWork）创建入参
 */
export interface CreateStoryWorkInput {
    title?: string;
    prompt: string;
    storyText: string;
    voiceId?: string;
    sourceMessageId?: string;
}

/**
 * 故事作品创建返回结果 DTO
 */
export interface CreatedStoryWorkResult {
    id: number;
    title: string;
    excerpt: string;
    voiceId: string;
    contentHash: string;
    favoritedAt: string | null;
    deletedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

/**
 * 在当前浏览器会话中通过真实 tRPC API 创建 Subject-owned 故事作品。
 * 遵循零猜测、真实 API 返回 ID 契约。
 *
 * @param page Playwright 页面
 * @param input 作品创作输入
 * @returns 包含真实 ID 的作品对象
 */
export async function createStoryWorkByPage(
    page: Page,
    input: CreateStoryWorkInput,
): Promise<CreatedStoryWorkResult> {
    return await page.evaluate(async (data) => {
        const body = {
            "0": {
                json: {
                    title: data.title,
                    prompt: data.prompt,
                    storyText: data.storyText,
                    voiceId: data.voiceId,
                    sourceMessageId: data.sourceMessageId,
                },
            },
        };
        const res = await fetch("/api/trpc/library.create?batch=1", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`[library-helper] library.create HTTP ${res.status}: ${errText}`);
        }
        const json = await res.json();
        const first = json[0];
        if (first.error) {
            throw new Error(`[library-helper] library.create tRPC error: ${JSON.stringify(first.error)}`);
        }
        return first.result.data.json as CreatedStoryWorkResult;
    }, input);
}

/**
 * 批量在当前浏览器会话中创建作品（用于验证分页、列表筛选等 L3 场景）。
 *
 * @param page Playwright 页面
 * @param items 作品列表
 * @returns 包含真实 ID 的作品数组
 */
export async function bulkCreateStoryWorksByPage(
    page: Page,
    items: CreateStoryWorkInput[],
): Promise<CreatedStoryWorkResult[]> {
    return await page.evaluate(async (dataList) => {
        const results: CreatedStoryWorkResult[] = [];
        for (const data of dataList) {
            const body = {
                "0": {
                    json: {
                        title: data.title,
                        prompt: data.prompt,
                        storyText: data.storyText,
                        voiceId: data.voiceId,
                        sourceMessageId: data.sourceMessageId,
                    },
                },
            };
            const res = await fetch("/api/trpc/library.create?batch=1", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`[library-helper] bulk library.create HTTP ${res.status}: ${errText}`);
            }
            const json = await res.json();
            const first = json[0];
            if (first.error) {
                throw new Error(`[library-helper] bulk library.create tRPC error: ${JSON.stringify(first.error)}`);
            }
            results.push(first.result.data.json as CreatedStoryWorkResult);
        }
        return results;
    }, items);
}
