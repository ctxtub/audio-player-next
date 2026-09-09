import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
    CHAT_ONBOARDING_SEEN_KEY,
    markOnboardingSeen,
    shouldShowOnboarding,
} from '../../../utils/chatOnboarding';

/**
 * 创建内存 Storage stub（mockStorage 范式）。
 * @returns 内存 Storage 实现
 */
function createMockStorage(): { storage: Storage; map: Map<string, string> } {
    const map = new Map<string, string>();
    const storage: Storage = {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => {
            map.set(k, String(v));
        },
        removeItem: (k: string) => {
            map.delete(k);
        },
        clear: () => {
            map.clear();
        },
        key: (index: number) => Array.from(map.keys())[index] ?? null,
        get length() {
            return map.size;
        },
    };
    return { storage, map };
}

async function runChatOnboardingTests() {
    console.log('=== R6-01: 首次访问（无键）应弹窗 ===');
    {
        const { storage } = createMockStorage();
        assert.strictEqual(shouldShowOnboarding(storage), true, '无 v1 键时必须弹窗');
    }
    console.log('PASS: R6-01 首次访问弹窗');

    console.log('=== R6-02: 确认后写入 v1，再次访问不弹 ===');
    {
        const { storage, map } = createMockStorage();
        markOnboardingSeen(storage);
        assert.strictEqual(map.get(CHAT_ONBOARDING_SEEN_KEY), 'true', '确认后必须写入 v1 键');
        assert.strictEqual(shouldShowOnboarding(storage), false, '写入 v1 后再次访问不得弹窗');
    }
    console.log('PASS: R6-02 确认写入 v1 后不再弹窗');

    console.log('=== R6-03: 旧 sessionStorage 键存在时仍弹（旧键不迁移） ===');
    {
        const { storage, map } = createMockStorage();
        map.set('chat_onboarding_seen', 'true');
        assert.strictEqual(shouldShowOnboarding(storage), true, '仅有旧键时必须仍弹窗（各版本只看自己的键）');
        markOnboardingSeen(storage);
        assert.strictEqual(map.get('chat_onboarding_seen'), 'true', '旧键不得被改写或迁移');
        assert.strictEqual(map.get(CHAT_ONBOARDING_SEEN_KEY), 'true', '确认后只写 v1 键');
    }
    console.log('PASS: R6-03 旧键不迁移');

    console.log('=== R6-04: 组件接线锁定（localStorage + v1 键，禁用 sessionStorage） ===');
    {
        const source = readFileSync(
            path.join(process.cwd(), 'app/(main)/chat/components/OnboardingModal/index.tsx'),
            'utf8',
        );
        assert.strictEqual(CHAT_ONBOARDING_SEEN_KEY, 'chat_onboarding_seen_v1', '版本化键必须为 v1');
        assert.ok(source.includes('shouldShowOnboarding'), '组件必须经 shouldShowOnboarding 判定是否弹窗');
        assert.ok(source.includes('markOnboardingSeen'), '组件确认后必须经 markOnboardingSeen 写入');
        assert.ok(source.includes('getSafeLocalStorage'), '组件必须复用安全 localStorage 工具');
        assert.ok(!source.includes('sessionStorage'), '组件不得再读写旧 sessionStorage 键');
    }
    console.log('PASS: R6-04 组件接线锁定');
}

const testPromise = runChatOnboardingTests()
    .then(() => {
        console.log('ALL CHAT ONBOARDING TESTS PASSED SUCCESSFULLY');
    })
    .catch((err) => {
        console.error('Chat onboarding test failed:', err);
        process.exit(1);
    });

export default testPromise;
