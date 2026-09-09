import fs from 'node:fs';
import assert from 'node:assert';

/**
 * 批量源码锁 Static 迁移（任务11 STEP-1）。
 * 来源：tests/legacy/batch-source-locks.legacy.test.ts（原 test-batch-02）。
 * 拆分：本文件收容全部纯源码字符串断言（7 组 findings + SEC-03 文本锁 2 条）；
 * SEC-03 运行时 schema 行为（3 条 safeParse）已拆至
 * tests/unit/persistence-config/agent-schema-bounds.unit.test.ts（真实导出）。
 * Static 层允许文本锁；断言语义与旧位置一致（向量保持）。
 */

// 中文注释：1. BUG-01: Player 跳转 /setting 锁（源码文本）。
const playerContent = fs.readFileSync('app/(main)/player/index.tsx', 'utf-8');
assert(playerContent.includes("router.push('/setting')"), 'BUG-01: Should route to /setting');
assert(!playerContent.includes("router.push('/config')"), 'BUG-01: Should not route to /config');
console.log('BUG-01: PASS');

// 中文注释：2. BUG-02: synthesizeSpeech 透传 baseURL 锁。
const openaiContent = fs.readFileSync('lib/server/openai.ts', 'utf-8');
assert(openaiContent.includes('baseURL: openAIConfig.baseUrl'), 'BUG-02: synthesizeSpeech should pass baseURL: openAIConfig.baseUrl');
console.log('BUG-02: PASS');

// 中文注释：3. REL-01: initError 状态与重试入口锁。
const configStoreContent = fs.readFileSync('stores/configStore.ts', 'utf-8');
assert(configStoreContent.includes('initError: string | null'), 'REL-01: configStore should have initError type');
assert(configStoreContent.includes('initError: error instanceof Error'), 'REL-01: configStore should set initError on failure');

const syncProviderContent = fs.readFileSync('components/AccountSyncProvider/index.tsx', 'utf-8');
assert(syncProviderContent.includes('initError'), 'REL-01: AccountSyncProvider should check initError');
assert(syncProviderContent.includes('重试'), 'REL-01: AccountSyncProvider should show retry button');
console.log('REL-01: PASS');

// 中文注释：4. UX-01: auth 用户名回传与存储锁。
const authRouterContent = fs.readFileSync('lib/trpc/routers/auth.ts', 'utf-8');
assert(authRouterContent.includes('username: user.username'), 'UX-01: authRouter should return username');

const authStoreContent = fs.readFileSync('stores/authStore.ts', 'utf-8');
assert(authStoreContent.includes('username: result.user.username'), 'UX-01: authStore should store username from result');
console.log('UX-01: PASS');

// 中文注释：5. SEC-03 文本锁部分：schema 边界字符串（运行时行为见 L1 对应文件）。
const schemaContent = fs.readFileSync('lib/trpc/schemas/agent.ts', 'utf-8');
assert(schemaContent.includes('.max(100)'), 'SEC-03: schema should constrain messages with .max(100)');
assert(schemaContent.includes('.max(10000)'), 'SEC-03: schema should constrain content with .max(10000)');
console.log('SEC-03-TEXT: PASS');

// 中文注释：6. SEC-04: 密码去空格移除锁（否定断言仍为源码锁）。
const authFormContent = fs.readFileSync('app/(auth)/auth/index.tsx', 'utf-8');
assert(!authFormContent.includes('loginPassword.trim()'), 'SEC-04: loginPassword should not be trimmed');
assert(!authFormContent.includes('regPassword.trim()'), 'SEC-04: regPassword should not be trimmed');
console.log('SEC-04: PASS');

// 中文注释：7. ARCH-01: config.get 须为 query 锁。
const configRouterContent = fs.readFileSync('lib/trpc/routers/config.ts', 'utf-8');
assert(!configRouterContent.includes('get: publicProcedure.mutation'), 'ARCH-01: config.get should not be mutation');
assert(configRouterContent.includes('get: publicProcedure.query'), 'ARCH-01: config.get should be query');

const appConfigClientContent = fs.readFileSync('lib/client/appConfig.ts', 'utf-8');
assert(appConfigClientContent.includes('trpc.config.get.query()'), 'ARCH-01: appConfig should call .query()');
console.log('ARCH-01: PASS');

// 中文注释：8. A11Y-01: TabBar 键盘与 roving tabindex 锁。
const tabbarContent = fs.readFileSync('components/MainTabBar/index.tsx', 'utf-8');
assert(tabbarContent.includes('onKeyDown={handleKeyDown}'), 'A11Y-01: MainTabBar should have onKeyDown handler');
assert(tabbarContent.includes('tabIndex={isActive ? 0 : -1}'), 'A11Y-01: MainTabBar should use roving tabIndex');
assert(tabbarContent.includes('ArrowRight') && tabbarContent.includes('ArrowLeft'), 'A11Y-01: MainTabBar should support Arrow navigation');
console.log('A11Y-01: PASS');

console.log('ALL 8 FINDINGS VERIFIED PASS (STATIC)');
