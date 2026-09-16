import { test as base, expect } from "@playwright/test";
import type { BrowserContextOptions } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface HarnessEnv {
    runId: string;
    appUrl: string;
    mockUrl: string;
    mockMp3Url: string;
}

interface HarnessFixtures {
    harnessEnv: HarnessEnv;
}

const pointerPath = join(".e2e-runtime", "browser-harness", "active.json");

function readHarnessEnv(): HarnessEnv {
    const absolutePath = join(process.cwd(), pointerPath);
    if (!existsSync(absolutePath)) throw new Error(`浏览器运行环境未启动：${absolutePath}`);
    const parsed = JSON.parse(readFileSync(absolutePath, "utf8")) as Partial<HarnessEnv>;
    if (!parsed.runId || !parsed.appUrl || !parsed.mockUrl || !parsed.mockMp3Url) {
        throw new Error("浏览器运行环境信息不完整");
    }
    return parsed as HarnessEnv;
}

export const test = base.extend<HarnessFixtures>({
    contextOptions: async ({}, use) => {
        const options: BrowserContextOptions = { storageState: { cookies: [], origins: [] } };
        await use(options);
    },
    harnessEnv: async ({}, use) => {
        await use(readHarnessEnv());
    },
});

export { expect };
