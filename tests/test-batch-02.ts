import fs from 'node:fs';
import assert from 'node:assert';
import { interactSchema, summarizeContextSchema } from '../lib/trpc/schemas/agent';

// 1. BUG-01: Player redirect to /setting
const playerContent = fs.readFileSync('app/(main)/player/index.tsx', 'utf-8');
assert(playerContent.includes("router.push('/setting')"), 'BUG-01: Should route to /setting');
assert(!playerContent.includes("router.push('/config')"), 'BUG-01: Should not route to /config');
console.log('BUG-01: PASS');

// 2. BUG-02: baseURL in synthesizeSpeech
const openaiContent = fs.readFileSync('lib/server/openai.ts', 'utf-8');
assert(openaiContent.includes('baseURL: openAIConfig.baseUrl'), 'BUG-02: synthesizeSpeech should pass baseURL: openAIConfig.baseUrl');
console.log('BUG-02: PASS');

// 3. REL-01: initError state & retry in AccountSyncProvider
const configStoreContent = fs.readFileSync('stores/configStore.ts', 'utf-8');
assert(configStoreContent.includes('initError: string | null'), 'REL-01: configStore should have initError type');
assert(configStoreContent.includes('initError: error instanceof Error'), 'REL-01: configStore should set initError on failure');

const syncProviderContent = fs.readFileSync('components/AccountSyncProvider/index.tsx', 'utf-8');
assert(syncProviderContent.includes('initError'), 'REL-01: AccountSyncProvider should check initError');
assert(syncProviderContent.includes('重试'), 'REL-01: AccountSyncProvider should show retry button');
console.log('REL-01: PASS');

// 4. UX-01: username in auth responses and store
const authRouterContent = fs.readFileSync('lib/trpc/routers/auth.ts', 'utf-8');
assert(authRouterContent.includes('username: user.username'), 'UX-01: authRouter should return username');

const authStoreContent = fs.readFileSync('stores/authStore.ts', 'utf-8');
assert(authStoreContent.includes('username: result.user.username'), 'UX-01: authStore should store username from result');
console.log('UX-01: PASS');

// 5. SEC-03: schema bounds
const schemaContent = fs.readFileSync('lib/trpc/schemas/agent.ts', 'utf-8');
assert(schemaContent.includes('.max(100)'), 'SEC-03: schema should constrain messages with .max(100)');
assert(schemaContent.includes('.max(10000)'), 'SEC-03: schema should constrain content with .max(10000)');

// Runtime schema test: valid payload passes
const valid = interactSchema.safeParse({
    messages: [{ role: 'user', content: 'hello' }],
});
assert.strictEqual(valid.success, true, 'SEC-03: Valid message should pass');

// Runtime schema test: >100 messages rejected
const tooManyMessages = Array.from({ length: 101 }, () => ({ role: 'user' as const, content: 'msg' }));
const rejectTooMany = interactSchema.safeParse({ messages: tooManyMessages });
assert.strictEqual(rejectTooMany.success, false, 'SEC-03: >100 messages should be rejected');

// Runtime schema test: >10000 chars rejected
const rejectTooLong = interactSchema.safeParse({
    messages: [{ role: 'user', content: 'a'.repeat(10001) }],
});
assert.strictEqual(rejectTooLong.success, false, 'SEC-03: >10000 chars should be rejected');
console.log('SEC-03: PASS');

// 6. SEC-04: password trimming removed
const authFormContent = fs.readFileSync('app/(auth)/auth/index.tsx', 'utf-8');
assert(!authFormContent.includes('loginPassword.trim()'), 'SEC-04: loginPassword should not be trimmed');
assert(!authFormContent.includes('regPassword.trim()'), 'SEC-04: regPassword should not be trimmed');
console.log('SEC-04: PASS');

// 7. ARCH-01: config.get query
const configRouterContent = fs.readFileSync('lib/trpc/routers/config.ts', 'utf-8');
assert(!configRouterContent.includes('get: publicProcedure.mutation'), 'ARCH-01: config.get should not be mutation');
assert(configRouterContent.includes('get: publicProcedure.query'), 'ARCH-01: config.get should be query');

const appConfigClientContent = fs.readFileSync('lib/client/appConfig.ts', 'utf-8');
assert(appConfigClientContent.includes('trpc.config.get.query()'), 'ARCH-01: appConfig should call .query()');
console.log('ARCH-01: PASS');

// 8. A11Y-01: tabbar onKeyDown and roving tabindex
const tabbarContent = fs.readFileSync('components/MainTabBar/index.tsx', 'utf-8');
assert(tabbarContent.includes('onKeyDown={handleKeyDown}'), 'A11Y-01: MainTabBar should have onKeyDown handler');
assert(tabbarContent.includes('tabIndex={isActive ? 0 : -1}'), 'A11Y-01: MainTabBar should use roving tabIndex');
assert(tabbarContent.includes('ArrowRight') && tabbarContent.includes('ArrowLeft'), 'A11Y-01: MainTabBar should support Arrow navigation');
console.log('A11Y-01: PASS');

console.log('ALL 8 FINDINGS VERIFIED PASS');
