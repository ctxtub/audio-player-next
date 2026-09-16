/**
 * 统一配置服务层
 *
 * 为已登录用户（UserConfig）与具名访客（GuestConfig）提供多主体的统一配置抽象。
 * 领域字段 desktopFloatingPlayerEnabled（Prisma 逻辑名，物理列仍为旧列 via @map）；legacy patch 别名仅在此 boundary 收敛。
 * 领域字段 defaultSleepTimerMinutes（逻辑名，物理列仍为 playDurationMinutes via @map）
 * + defaultSleepTimerEnabled；legacy patch 别名 playDuration 仅在此 boundary 收敛为
 * defaultSleepTimerMinutes（保留一个发布周期，与  策略一致）。
 */

import { TRPCError } from '@trpc/server';

import type { ThemeMode } from '@/types/theme';
import { prisma } from '@/lib/db';
import {
    DEFAULT_USER_CONFIG,
    normalizeUserConfigPatch,
    type UserConfigDTO,
    type UserConfigPatch,
} from '@/lib/trpc/schemas/config';

export type ConfigSubject =
    | { type: 'user'; id: number }
    | { type: 'guest'; id: string };

type ConfigRow = {
    defaultSleepTimerMinutes: number;
    defaultSleepTimerEnabled: boolean;
    voiceId: string;
    speed: number;
    desktopFloatingPlayerEnabled: boolean;
    themeMode: string;
};

/**
 * 将 DB 存储的 themeMode 字符串收敛为合法枚举，非法值回落默认。
 */
export const normalizeThemeMode = (value: string): ThemeMode =>
    value === 'dark' || value === 'light' || value === 'system'
        ? value
        : DEFAULT_USER_CONFIG.themeMode;

/**
 * DB 行 → 前端 DTO（只暴露新产品语义字段 + playDuration 兼容别名一个周期）。
 */
export const toConfigDto = (row: ConfigRow): UserConfigDTO => ({
    defaultSleepTimerMinutes: row.defaultSleepTimerMinutes,
    defaultSleepTimerEnabled: row.defaultSleepTimerEnabled,
    playDuration: row.defaultSleepTimerMinutes,
    voiceId: row.voiceId,
    speed: row.speed,
    desktopFloatingPlayerEnabled: row.desktopFloatingPlayerEnabled,
    themeMode: normalizeThemeMode(row.themeMode),
});

/**
 * 将 UserConfigPatch 映射到数据库字段名。
 *  compatibility boundary：先经 normalizeUserConfigPatch 收敛 legacy 别名；
 * 冲突（新旧不同值）抛 BAD_REQUEST。
 * CONFLICTING_SLEEP_TIMER_FIELDS 同理映射为 BAD_REQUEST。
 */
export const mapPatchToDbFields = (patch: UserConfigPatch) => {
    let normalized: ReturnType<typeof normalizeUserConfigPatch>;
    try {
        normalized = normalizeUserConfigPatch(patch);
    } catch (err) {
        const message = err instanceof Error ? err.message : '';
        throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
                message === 'CONFLICTING_SLEEP_TIMER_FIELDS'
                    ? 'CONFLICTING_SLEEP_TIMER_FIELDS'
                    : 'CONFLICTING_FLOATING_PLAYER_FIELDS',
        });
    }
    const updateData: {
        defaultSleepTimerMinutes?: number;
        defaultSleepTimerEnabled?: boolean;
        voiceId?: string;
        speed?: number;
        desktopFloatingPlayerEnabled?: boolean;
        themeMode?: string;
    } = {};
    if (normalized.defaultSleepTimerMinutes !== undefined) {
        updateData.defaultSleepTimerMinutes = normalized.defaultSleepTimerMinutes;
    }
    if (normalized.defaultSleepTimerEnabled !== undefined) {
        updateData.defaultSleepTimerEnabled = normalized.defaultSleepTimerEnabled;
    }
    if (normalized.voiceId !== undefined) updateData.voiceId = normalized.voiceId;
    if (normalized.speed !== undefined) updateData.speed = normalized.speed;
    if (normalized.desktopFloatingPlayerEnabled !== undefined) {
        updateData.desktopFloatingPlayerEnabled = normalized.desktopFloatingPlayerEnabled;
    }
    if (normalized.themeMode !== undefined) updateData.themeMode = normalized.themeMode;
    return updateData;
};

/**
 * 获取统一配置：主体不存在时以系统默认建行。
 */
export async function getOrCreateConfig(subject: ConfigSubject): Promise<UserConfigDTO> {
    if (subject.type === 'user') {
        const existing = await prisma.userConfig.findUnique({ where: { userId: subject.id } });
        if (existing) {
            return toConfigDto(existing);
        }

        const userExists = await prisma.user.findUnique({
            where: { id: subject.id },
            select: { id: true },
        });
        if (!userExists) {
            throw new TRPCError({ code: 'UNAUTHORIZED', message: 'SESSION_USER_NOT_FOUND' });
        }

        const created = await prisma.userConfig.create({
            data: {
                userId: subject.id,
                defaultSleepTimerMinutes: DEFAULT_USER_CONFIG.defaultSleepTimerMinutes,
                defaultSleepTimerEnabled: DEFAULT_USER_CONFIG.defaultSleepTimerEnabled,
                voiceId: DEFAULT_USER_CONFIG.voiceId,
                speed: DEFAULT_USER_CONFIG.speed,
                desktopFloatingPlayerEnabled: DEFAULT_USER_CONFIG.desktopFloatingPlayerEnabled,
                themeMode: DEFAULT_USER_CONFIG.themeMode,
            },
        });
        return toConfigDto(created);
    } else {
        const row = await prisma.guestConfig.upsert({
            where: { guestId: subject.id },
            create: {
                guestId: subject.id,
                defaultSleepTimerMinutes: DEFAULT_USER_CONFIG.defaultSleepTimerMinutes,
                defaultSleepTimerEnabled: DEFAULT_USER_CONFIG.defaultSleepTimerEnabled,
                voiceId: DEFAULT_USER_CONFIG.voiceId,
                speed: DEFAULT_USER_CONFIG.speed,
                desktopFloatingPlayerEnabled: DEFAULT_USER_CONFIG.desktopFloatingPlayerEnabled,
                themeMode: DEFAULT_USER_CONFIG.themeMode,
            },
            update: {},
        });
        return toConfigDto(row);
    }
}

/**
 * 增量更新配置：统一 upsert。
 * legacy 别名在此收敛；冲突抛 BAD_REQUEST。
 */
export async function updateConfig(
    subject: ConfigSubject,
    patch: UserConfigPatch
): Promise<UserConfigDTO> {
    let normalized: ReturnType<typeof normalizeUserConfigPatch>;
    try {
        normalized = normalizeUserConfigPatch(patch);
    } catch (err) {
        const message = err instanceof Error ? err.message : '';
        throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
                message === 'CONFLICTING_SLEEP_TIMER_FIELDS'
                    ? 'CONFLICTING_SLEEP_TIMER_FIELDS'
                    : 'CONFLICTING_FLOATING_PLAYER_FIELDS',
        });
    }
    const fields = mapPatchToDbFields(patch);

    if (subject.type === 'user') {
        const row = await prisma.userConfig.upsert({
            where: { userId: subject.id },
            create: {
                userId: subject.id,
                defaultSleepTimerMinutes:
                    normalized.defaultSleepTimerMinutes ?? DEFAULT_USER_CONFIG.defaultSleepTimerMinutes,
                defaultSleepTimerEnabled:
                    normalized.defaultSleepTimerEnabled ?? DEFAULT_USER_CONFIG.defaultSleepTimerEnabled,
                voiceId: normalized.voiceId ?? DEFAULT_USER_CONFIG.voiceId,
                speed: normalized.speed ?? DEFAULT_USER_CONFIG.speed,
                desktopFloatingPlayerEnabled:
                    normalized.desktopFloatingPlayerEnabled ??
                    DEFAULT_USER_CONFIG.desktopFloatingPlayerEnabled,
                themeMode: normalized.themeMode ?? DEFAULT_USER_CONFIG.themeMode,
            },
            update: fields,
        });
        return toConfigDto(row);
    } else {
        const row = await prisma.guestConfig.upsert({
            where: { guestId: subject.id },
            create: {
                guestId: subject.id,
                defaultSleepTimerMinutes:
                    normalized.defaultSleepTimerMinutes ?? DEFAULT_USER_CONFIG.defaultSleepTimerMinutes,
                defaultSleepTimerEnabled:
                    normalized.defaultSleepTimerEnabled ?? DEFAULT_USER_CONFIG.defaultSleepTimerEnabled,
                voiceId: normalized.voiceId ?? DEFAULT_USER_CONFIG.voiceId,
                speed: normalized.speed ?? DEFAULT_USER_CONFIG.speed,
                desktopFloatingPlayerEnabled:
                    normalized.desktopFloatingPlayerEnabled ??
                    DEFAULT_USER_CONFIG.desktopFloatingPlayerEnabled,
                themeMode: normalized.themeMode ?? DEFAULT_USER_CONFIG.themeMode,
            },
            update: fields,
        });
        return toConfigDto(row);
    }
}

/**
 * 注册时访客配置迁移：将当前 guest 的配置拷贝至新用户 UserConfig。
 */
export async function migrateGuestConfigToUser(
    guestId: string,
    userId: number
): Promise<boolean> {
    const guestConfig = await prisma.guestConfig.findUnique({
        where: { guestId },
    });
    if (!guestConfig) {
        return false;
    }

    await prisma.userConfig.create({
        data: {
            userId,
            defaultSleepTimerMinutes: guestConfig.defaultSleepTimerMinutes,
            defaultSleepTimerEnabled: guestConfig.defaultSleepTimerEnabled,
            voiceId: guestConfig.voiceId,
            speed: guestConfig.speed,
            desktopFloatingPlayerEnabled: guestConfig.desktopFloatingPlayerEnabled,
            themeMode: guestConfig.themeMode,
        },
    });
    return true;
}
