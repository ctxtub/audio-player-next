import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../../../lib/db';
import {
    getOrCreateConfig,
    updateConfig,
    toConfigDto,
    mapPatchToDbFields,
} from '../../../lib/server/unifiedConfig';
import {
    DEFAULT_USER_CONFIG,
    normalizeUserConfigPatch,
    userConfigDtoSchema,
    userConfigPatchSchema,
} from '../../../lib/trpc/schemas/config';
import { TRPCError } from '@trpc/server';

async function runDesktopMigrationTests() {
    console.log('=== M6-01-A: 新 DTO 只暴露 desktopFloatingPlayerEnabled ===');
    const dtoKeys = Object.keys(userConfigDtoSchema.shape).sort();
    assert.deepStrictEqual(
        dtoKeys,
        ['desktopFloatingPlayerEnabled', 'playDuration', 'speed', 'themeMode', 'voiceId'],
        'DTO 必须只暴露新字段（含其余四字段），不得含 legacy'
    );
    assert.ok(!('floatingPlayerEnabled' in userConfigDtoSchema.shape), 'DTO shape 不得含 legacy 别名');
    const parsed = userConfigDtoSchema.parse({
        playDuration: 30,
        voiceId: '',
        speed: 1.0,
        desktopFloatingPlayerEnabled: true,
        themeMode: 'system',
    });
    assert.strictEqual(parsed.desktopFloatingPlayerEnabled, true);
    assert.ok(!('floatingPlayerEnabled' in parsed), 'DTO 解析结果不得含 legacy');
    console.log('PASS: M6-01-A DTO single field');

    console.log('=== M6-01-B: 默认 true（guest + user）===');
    assert.strictEqual(DEFAULT_USER_CONFIG.desktopFloatingPlayerEnabled, true, '系统默认必须 true');
    assert.ok(!('floatingPlayerEnabled' in DEFAULT_USER_CONFIG), 'DEFAULT 不得含 legacy');
    const guestDefaultId = `g_m6_default_${Date.now()}`;
    await prisma.guestConfig.deleteMany({ where: { guestId: guestDefaultId } });
    const guestDefault = await getOrCreateConfig({ type: 'guest', id: guestDefaultId });
    assert.strictEqual(guestDefault.desktopFloatingPlayerEnabled, true, '全新访客默认 true');
    assert.ok(!('floatingPlayerEnabled' in guestDefault), '返回 DTO 不得含 legacy');
    console.log('PASS: M6-01-B default true');

    console.log('=== M6-01-C: true↔false 可持久化，刷新保持 ===');
    const guestPersistId = `g_m6_persist_${Date.now()}`;
    await prisma.guestConfig.deleteMany({ where: { guestId: guestPersistId } });
    await getOrCreateConfig({ type: 'guest', id: guestPersistId });
    const toFalse = await updateConfig(
        { type: 'guest', id: guestPersistId },
        { desktopFloatingPlayerEnabled: false }
    );
    assert.strictEqual(toFalse.desktopFloatingPlayerEnabled, false, '置 false 应生效');
    const rereadFalse = await getOrCreateConfig({ type: 'guest', id: guestPersistId });
    assert.strictEqual(rereadFalse.desktopFloatingPlayerEnabled, false, '刷新重读应保持 false');
    const toTrue = await updateConfig(
        { type: 'guest', id: guestPersistId },
        { desktopFloatingPlayerEnabled: true }
    );
    assert.strictEqual(toTrue.desktopFloatingPlayerEnabled, true, '置 true 应生效');
    const rereadTrue = await getOrCreateConfig({ type: 'guest', id: guestPersistId });
    assert.strictEqual(rereadTrue.desktopFloatingPlayerEnabled, true, '刷新重读应保持 true');
    // user 主体同样。
    const userPersistId = 997001;
    await prisma.userConfig.deleteMany({ where: { userId: userPersistId } });
    await prisma.user.deleteMany({ where: { id: userPersistId } });
    await prisma.user.create({ data: { id: userPersistId, username: `u_m6_${Date.now()}`, password: 'hash' } });
    await getOrCreateConfig({ type: 'user', id: userPersistId });
    await updateConfig({ type: 'user', id: userPersistId }, { desktopFloatingPlayerEnabled: false });
    const userReread = await getOrCreateConfig({ type: 'user', id: userPersistId });
    assert.strictEqual(userReread.desktopFloatingPlayerEnabled, false, 'user false 持久化');
    console.log('PASS: M6-01-C persist true<->false');

    console.log('=== M6-01-D: 旧物理列数据读取无损（false→wide-docked 语义）===');
    const guestLegacyId = `g_m6_legacy_${Date.now()}`;
    await prisma.guestConfig.deleteMany({ where: { guestId: guestLegacyId } });
    // 经 Prisma 新逻辑字段写入 false（物理列仍为 floatingPlayerEnabled）。
    await prisma.guestConfig.create({
        data: {
            guestId: guestLegacyId,
            playDurationMinutes: 30,
            voiceId: '',
            speed: 1.0,
            desktopFloatingPlayerEnabled: false,
            themeMode: 'system',
        },
    });
    // 直读物理列，验证列未 rename 且值无损。
    const rawRows = (await prisma.$queryRawUnsafe(
        `SELECT "floatingPlayerEnabled" as v FROM "GuestConfig" WHERE "guestId" = '${guestLegacyId}'`
    )) as Array<{ v: number | boolean }>;
    assert.strictEqual(rawRows.length, 1, '物理列 floatingPlayerEnabled 必须存在');
    assert.ok(rawRows[0].v === 0 || rawRows[0].v === false, `物理列值必须为 false 无损（得 ${String(rawRows[0].v)}）`);
    const legacyRead = await getOrCreateConfig({ type: 'guest', id: guestLegacyId });
    assert.strictEqual(legacyRead.desktopFloatingPlayerEnabled, false, '旧 false 行读取为新 false（wide-docked 语义）');
    // 物理表列名集合断言：不得出现 desktopFloatingPlayerEnabled 物理列。
    const cols = (await prisma.$queryRawUnsafe(`PRAGMA table_info("GuestConfig")`)) as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    assert.ok(colNames.includes('floatingPlayerEnabled'), '物理表必须保留 floatingPlayerEnabled 列');
    assert.ok(!colNames.includes('desktopFloatingPlayerEnabled'), '物理表不得新增 desktopFloatingPlayerEnabled 列（逻辑 rename 而已）');
    const userCols = (await prisma.$queryRawUnsafe(`PRAGMA table_info("UserConfig")`)) as Array<{ name: string }>;
    const userColNames = userCols.map((c) => c.name);
    assert.ok(userColNames.includes('floatingPlayerEnabled'), 'UserConfig 物理表必须保留旧列');
    assert.ok(!userColNames.includes('desktopFloatingPlayerEnabled'), 'UserConfig 物理表不得新增新列');
    console.log('PASS: M6-01-D physical column lossless');

    console.log('=== M6-01-E: legacy PATCH 兼容收敛 + 冲突 BAD_REQUEST ===');
    const guestCompatId = `g_m6_compat_${Date.now()}`;
    await prisma.guestConfig.deleteMany({ where: { guestId: guestCompatId } });
    await getOrCreateConfig({ type: 'guest', id: guestCompatId });
    // 仅旧字段 → 映射成功。
    const legacyOnly = await updateConfig(
        { type: 'guest', id: guestCompatId },
        { floatingPlayerEnabled: false } as unknown as { desktopFloatingPlayerEnabled?: boolean }
    );
    assert.strictEqual(legacyOnly.desktopFloatingPlayerEnabled, false, '仅旧字段应映射为新 false');
    assert.ok(!('floatingPlayerEnabled' in legacyOnly), '兼容返回不得透出 legacy');
    // 仅新字段 → 正常。
    const newOnly = await updateConfig(
        { type: 'guest', id: guestCompatId },
        { desktopFloatingPlayerEnabled: true }
    );
    assert.strictEqual(newOnly.desktopFloatingPlayerEnabled, true);
    // 两者相同 → 以新为准成功。
    const bothSame = await updateConfig(
        { type: 'guest', id: guestCompatId },
        {
            desktopFloatingPlayerEnabled: true,
            floatingPlayerEnabled: true,
        } as unknown as { desktopFloatingPlayerEnabled?: boolean }
    );
    assert.strictEqual(bothSame.desktopFloatingPlayerEnabled, true, '两者相同应成功');
    // 两者不同 → BAD_REQUEST（facade 层）。
    await assert.rejects(
        async () => {
            await updateConfig(
                { type: 'guest', id: guestCompatId },
                {
                    desktopFloatingPlayerEnabled: true,
                    floatingPlayerEnabled: false,
                } as unknown as { desktopFloatingPlayerEnabled?: boolean }
            );
        },
        (err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST',
        '新旧不同值必须 BAD_REQUEST'
    );
    // zod 层同样拒绝（tRPC input 校验映射为 BAD_REQUEST 的前置）。
    const zodConflict = userConfigPatchSchema.safeParse({
        desktopFloatingPlayerEnabled: true,
        floatingPlayerEnabled: false,
    });
    assert.strictEqual(zodConflict.success, false, 'zod 必须拒绝冲突 patch');
    // normalize 纯函数行为。
    assert.deepStrictEqual(normalizeUserConfigPatch({ floatingPlayerEnabled: false } as never), {
        desktopFloatingPlayerEnabled: false,
    });
    assert.deepStrictEqual(normalizeUserConfigPatch({ desktopFloatingPlayerEnabled: true }), {
        desktopFloatingPlayerEnabled: true,
    });
    assert.throws(
        () =>
            normalizeUserConfigPatch({
                desktopFloatingPlayerEnabled: true,
                floatingPlayerEnabled: false,
            } as never),
        /CONFLICTING_FLOATING_PLAYER_FIELDS/
    );
    // mapPatchToDbFields 只产出新逻辑字段。
    const mapped = mapPatchToDbFields({ floatingPlayerEnabled: false } as never);
    assert.deepStrictEqual(mapped, { desktopFloatingPlayerEnabled: false });
    assert.ok(!('floatingPlayerEnabled' in mapped), 'DB 映射不得含旧逻辑字段');
    // toConfigDto 只读新逻辑行。
    const dto = toConfigDto({
        playDurationMinutes: 30,
        voiceId: '',
        speed: 1,
        desktopFloatingPlayerEnabled: false,
        themeMode: 'dark',
    });
    assert.strictEqual(dto.desktopFloatingPlayerEnabled, false);
    assert.ok(!('floatingPlayerEnabled' in dto), 'DTO 不得含旧字段');
    console.log('PASS: M6-01-E legacy compat boundary');

    console.log('=== M6-01-F: Schema guard 防物理列 rename ===');
    const schemaText = fs.readFileSync(path.join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');
    const userBlock = schemaText.slice(schemaText.indexOf('model UserConfig'));
    const guestBlock = schemaText.slice(schemaText.indexOf('model GuestConfig'));
    for (const [name, block] of [['UserConfig', userBlock], ['GuestConfig', guestBlock]] as const) {
        assert.ok(
            block.includes('desktopFloatingPlayerEnabled') && block.includes('@map("floatingPlayerEnabled")'),
            `${name} 必须为 desktopFloatingPlayerEnabled @map("floatingPlayerEnabled")`
        );
    }
    // 剥离新字段声明后，不得残留裸旧逻辑字段（防回退）。
    const stripped = schemaText.split('desktopFloatingPlayerEnabled').join('');
    assert.ok(
        !stripped.includes('floatingPlayerEnabled Boolean'),
        'schema 不得残留裸 floatingPlayerEnabled Boolean 逻辑字段（物理列仅经 @map 引用）'
    );
    // @map 目标必须恰为旧物理列名（防 rename）。
    const mapHits = schemaText.match(/@map\("floatingPlayerEnabled"\)/g) ?? [];
    assert.ok(mapHits.length >= 2, `User/Guest 必须各一处 @map("floatingPlayerEnabled")（得 ${mapHits.length}）`);
    console.log('PASS: M6-01-F schema guard');

    console.log('=== M6-01-G: FloatingPlayer 行为回归（仅字段 rename）===');
    const fpSrc = fs.readFileSync(
        path.join(process.cwd(), 'components', 'FloatingPlayer', 'index.tsx'),
        'utf8'
    );
    assert.ok(fpSrc.includes('state.apiConfig.desktopFloatingPlayerEnabled'), 'FloatingPlayer 必须读新字段');
    const fpStripped = fpSrc.split('desktopFloatingPlayerEnabled').join('').split('isDesktopFloatingPlayerEnabled').join('');
    assert.ok(!fpStripped.includes('floatingPlayerEnabled'), 'FloatingPlayer 不得残留旧字段引用');
    // 行为骨架不变：三条件显隐 + show/hide 联动 + drag/clamp + hasTrack。
    assert.ok(fpSrc.includes('shouldShowFloatingPanel'), '显隐变量保留');
    assert.ok(fpSrc.includes('isVisible && hasTrack'), '三条件显隐保留');
    assert.ok(fpSrc.includes('currentAudioUrl !== null || isRehydratedReady'), 'hasTrack 推导保留');
    assert.ok(fpSrc.includes('useDrag'), 'drag 保留');
    assert.ok(fpSrc.includes('clampValue'), 'clamp 保留');
    assert.ok(fpSrc.includes('show()') && fpSrc.includes('hide()'), 'show/hide 联动保留');
    console.log('PASS: M6-01-G FloatingPlayer regression');

    console.log('\nALL DESKTOP CONFIG MIGRATION INTEGRATION TESTS PASSED SUCCESSFULLY!');
}

const testPromise = runDesktopMigrationTests()
    .then(() => {
        console.log('ALL DESKTOP CONFIG MIGRATION INTEGRATION TESTS PASSED SUCCESSFULLY!');
    })
    .catch((err) => {
        console.error('Desktop config migration test failed:', err);
        process.exit(1);
    });

export default testPromise;
