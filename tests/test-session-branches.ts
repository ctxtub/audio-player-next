import assert from 'node:assert';
import { createHmac } from 'node:crypto';
import {
    encodeSession,
    decodeSession,
    encodeGuestId,
    decodeGuestCookie,
    assertSessionSecret,
    getSessionSecret,
    SESSION_MAX_AGE,
} from '../lib/session';

process.env.SESSION_SECRET = 'test-secret-session-branches-12345';
const SECRET = process.env.SESSION_SECRET;

// 中文注释：R14 认证单元补强——覆盖 lib/session.ts 纯函数尚未覆盖的分支。
// 已有覆盖（不再重复）：session 正常往返 + 篡改（test-sec-01）、
// guest 往返/篡改/异密钥/过期/密钥缺失/裸值（test-guest-signed-cookie）。
// 本文件只补：畸形 token 形状、过期（时间旅行）、合法签名+非法 payload 形状
// （用标准 HMAC-SHA256 独立构造，不依赖实现内部）、session 密钥缺失与异密钥、
// 签发函数缺密钥抛错。正/反成对出现，证明断言绑定真实行为。

/** 中文注释：用 Node 标准库独立计算签名，构造“签名合法但内容非法”的 token。 */
const sign = (payloadB64: string, secret: string = SECRET): string =>
    createHmac('sha256', secret).update(payloadB64).digest('base64url');

/** 中文注释：对象 JSON → base64url。 */
const b64 = (obj: unknown): string =>
    Buffer.from(JSON.stringify(obj), 'utf-8').toString('base64url');

/** 中文注释：原始字符串（可能是非 JSON）→ base64url。 */
const b64raw = (s: string): string => Buffer.from(s, 'utf-8').toString('base64url');

const futureExp = (): number => Math.floor(Date.now() / 1000) + 3600;

console.log('--- 1. 畸形 token 形状 → 双解码器一律 null ---');
for (const bad of ['', 'abc', 'a.b.c', 'x.y.z.w', '.sig', 'payload.', '.', '...']) {
    assert.strictEqual(decodeSession(bad), null, `decodeSession 畸形应 null: ${bad}`);
    assert.strictEqual(decodeGuestCookie(bad), null, `decodeGuestCookie 畸形应 null: ${bad}`);
}
console.log('PASS: 畸形 token 形状');

console.log('--- 2. session 过期：时间旅行前后成对断言 ---');
const freshToken = encodeSession(11, 'ExpireTester');
assert.deepStrictEqual(
    decodeSession(freshToken),
    { userId: 11, nickname: 'ExpireTester' },
    '未过期 session 必须解码成功（正对照）'
);
const realNow = Date.now;
Date.now = () => realNow() + (SESSION_MAX_AGE + 10) * 1000;
try {
    assert.strictEqual(decodeSession(freshToken), null, '过期 session 必须返回 null');
} finally {
    Date.now = realNow;
}
assert.deepStrictEqual(
    decodeSession(freshToken),
    { userId: 11, nickname: 'ExpireTester' },
    '时间恢复后 session 必须再次解码成功（反证绑定真实过期判断）'
);
console.log('PASS: session 过期分支');

console.log('--- 3. session 合法签名 + 非法 payload 形状 → null ---');
const sessionCases: Array<[string, unknown]> = [
    ['缺 exp', { userId: 1, nickname: 'A' }],
    ['exp 非 number', { userId: 1, nickname: 'A', exp: 'tomorrow' }],
    ['userId 非 number', { userId: '1', nickname: 'A', exp: futureExp() }],
    ['缺 nickname', { userId: 1, exp: futureExp() }],
    ['nickname 空串', { userId: 1, nickname: '', exp: futureExp() }],
    ['nickname 非 string', { userId: 1, nickname: 7, exp: futureExp() }],
];
for (const [name, payload] of sessionCases) {
    const token = `${b64(payload)}.${sign(b64(payload))}`;
    assert.strictEqual(decodeSession(token), null, `decodeSession 非法形状应 null: ${name}`);
}
const nonJsonSession = `${b64raw('not-json-at-all')}.${sign(b64raw('not-json-at-all'))}`;
assert.strictEqual(decodeSession(nonJsonSession), null, 'decodeSession 非 JSON 内容应 null');
console.log('PASS: session 非法 payload 形状分支');

console.log('--- 4. session 异密钥签名 → null ---');
const forgedSessionPayload = b64({ userId: 1, nickname: 'A', exp: futureExp() });
assert.strictEqual(
    decodeSession(`${forgedSessionPayload}.${sign(forgedSessionPayload, 'wrong-secret-xyz')}`),
    null,
    '异密钥签发的 session 必须返回 null'
);
console.log('PASS: session 异密钥分支');

console.log('--- 5. 密钥缺失：解码 fail-closed、签发抛错 ---');
const savedSecret = process.env.SESSION_SECRET;
const goodSessionToken = encodeSession(5, 'NoSecret');
const goodGuestToken = encodeGuestId('g_nosecret_probe');
delete process.env.SESSION_SECRET;
try {
    assert.strictEqual(decodeSession(goodSessionToken), null, '无密钥时 session 验签必须失败');
    assert.strictEqual(decodeGuestCookie(goodGuestToken), null, '无密钥时 guest 验签必须失败');
    assert.throws(
        () => encodeSession(5, 'NoSecret'),
        /SESSION_SECRET/,
        '无密钥时 encodeSession 必须抛错'
    );
    assert.throws(
        () => encodeGuestId('g_x'),
        /SESSION_SECRET/,
        '无密钥时 encodeGuestId 必须抛错'
    );
    assert.throws(() => assertSessionSecret(), /SESSION_SECRET/, 'assertSessionSecret 必须抛错');
    assert.throws(() => getSessionSecret(), /SESSION_SECRET/, 'getSessionSecret 必须抛错');
} finally {
    process.env.SESSION_SECRET = savedSecret;
}
assert.deepStrictEqual(
    decodeSession(goodSessionToken),
    { userId: 5, nickname: 'NoSecret' },
    '密钥恢复后 session 必须可解（反证绑定真实密钥判断）'
);
console.log('PASS: 密钥缺失分支');

console.log('--- 6. guest 合法签名 + 非法 payload 形状 → null ---');
const guestCases: Array<[string, unknown]> = [
    ['gid 无 g_ 前缀', { gid: 'plain-no-prefix', exp: futureExp() }],
    ['gid 本体为空', { gid: 'g_', exp: futureExp() }],
    ['gid 非 string', { gid: 123, exp: futureExp() }],
    ['缺 gid', { exp: futureExp() }],
    ['缺 exp', { gid: 'g_valid_shape' }],
    ['exp 非 number', { gid: 'g_valid_shape', exp: 'later' }],
];
for (const [name, payload] of guestCases) {
    const token = `${b64(payload)}.${sign(b64(payload))}`;
    assert.strictEqual(decodeGuestCookie(token), null, `decodeGuestCookie 非法形状应 null: ${name}`);
}
const nonJsonGuest = `${b64raw('not-json')}.${sign(b64raw('not-json'))}`;
assert.strictEqual(decodeGuestCookie(nonJsonGuest), null, 'decodeGuestCookie 非 JSON 内容应 null');
// 正对照：同密钥同方法签发的合法 guest 必须通过
const legitGid = 'g_branch_probe';
assert.strictEqual(
    decodeGuestCookie(encodeGuestId(legitGid)),
    legitGid,
    '合法 guest 签发必须可验签（正对照）'
);
console.log('PASS: guest 非法 payload 形状分支');

console.log('ALL SESSION BRANCH TESTS PASSED');
