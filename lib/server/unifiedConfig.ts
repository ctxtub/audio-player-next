/**
 * 统一配置服务层
 *
 * 为已登录用户（UserConfig）与具名访客（GuestConfig）提供多主体的统一配置抽象。
 */

import { TRPCError } from '@trpc/server';

import type { ThemeMode } from '@/types/theme';
import { prisma } from '@/lib/db';
import {
    DEFAULT_USER_CONFIG,
    type UserConfigDTO,
    type UserConfigPatch,
} from '@/lib/trpc/schemas/config';

export type ConfigSubject =
    | { type: 'user'; id: number }
    | { type: 'guest'; id: string };

type ConfigRow = {
    playDurationMinutes: number;
    voiceId: string;
    speed: number;
    floatingPlayerEnabled: boolean;
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
 * DB 行 → 前端 DTO。
 */
export const toConfigDto = (row: ConfigRow): UserConfigDTO => ({
    playDuration: row.playDurationMinutes,
    voiceId: row.voiceId,
    speed: row.speed,
    floatingPlayerEnabled: row.floatingPlayerEnabled,
    themeMode: normalizeThemeMode(row.themeMode),
});

/**
 * 将 UserConfigPatch 映射到数据库字段名。
 */
export const mapPatchToDbFields = (patch: UserConfigPatch) => {
    const updateData: {
        playDurationMinutes?: number;
        voiceId?: string;
        speed?: number;
        floatingPlayerEnabled?: boolean;
        themeMode?: string;
    } = {};
    if (patch.playDuration !== undefined) updateData.playDurationMinutes = patch.playDuration;
    if (patch.voiceId !== undefined) updateData.voiceId = patch.voiceId;
    if (patch.speed !== undefined) updateData.speed = patch.speed;
    if (patch.floatingPlayerEnabled !== undefined) {
        updateData.floatingPlayerEnabled = patch.floatingPlayerEnabled;
    }
    if (patch.themeMode !== undefined) updateData.themeMode = patch.themeMode;
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
                playDurationMinutes: DEFAULT_USER_CONFIG.playDuration,
                voiceId: DEFAULT_USER_CONFIG.voiceId,
                speed: DEFAULT_USER_CONFIG.speed,
                floatingPlayerEnabled: DEFAULT_USER_CONFIG.floatingPlayerEnabled,
                themeMode: DEFAULT_USER_CONFIG.themeMode,
            },
        });
        return toConfigDto(created);
    } else {
        const existing = await prisma.guestConfig.findUnique({ where: { guestId: subject.id } });
        if (existing) {
            return toConfigDto(existing);
        }

        const created = await prisma.guestConfig.create({
            data: {
                guestId: subject.id,
                playDurationMinutes: DEFAULT_USER_CONFIG.playDuration,
                voiceId: DEFAULT_USER_CONFIG.voiceId,
                speed: DEFAULT_USER_CONFIG.speed,
                floatingPlayerEnabled: DEFAULT_USER_CONFIG.floatingPlayerEnabled,
                themeMode: DEFAULT_USER_CONFIG.themeMode,
            },
        });
        return toConfigDto(created);
    }
}

/**
 * 增量更新配置：统一 upsert。
 */
export async function updateConfig(
    subject: ConfigSubject,
    patch: UserConfigPatch
): Promise<UserConfigDTO> {
    const fields = mapPatchToDbFields(patch);

    if (subject.type === 'user') {
        const row = await prisma.userConfig.upsert({
            where: { userId: subject.id },
            create: {
                userId: subject.id,
                playDurationMinutes: patch.playDuration ?? DEFAULT_USER_CONFIG.playDuration,
                voiceId: patch.voiceId ?? DEFAULT_USER_CONFIG.voiceId,
                speed: patch.speed ?? DEFAULT_USER_CONFIG.speed,
                floatingPlayerEnabled:
                    patch.floatingPlayerEnabled ?? DEFAULT_USER_CONFIG.floatingPlayerEnabled,
                themeMode: patch.themeMode ?? DEFAULT_USER_CONFIG.themeMode,
            },
            update: fields,
        });
        return toConfigDto(row);
    } else {
        const row = await prisma.guestConfig.upsert({
            where: { guestId: subject.id },
            create: {
                guestId: subject.id,
                playDurationMinutes: patch.playDuration ?? DEFAULT_USER_CONFIG.playDuration,
                voiceId: patch.voiceId ?? DEFAULT_USER_CONFIG.voiceId,
                speed: patch.speed ?? DEFAULT_USER_CONFIG.speed,
                floatingPlayerEnabled:
                    patch.floatingPlayerEnabled ?? DEFAULT_USER_CONFIG.floatingPlayerEnabled,
                themeMode: patch.themeMode ?? DEFAULT_USER_CONFIG.themeMode,
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
            playDurationMinutes: guestConfig.playDurationMinutes,
            voiceId: guestConfig.voiceId,
            speed: guestConfig.speed,
            floatingPlayerEnabled: guestConfig.floatingPlayerEnabled,
            themeMode: guestConfig.themeMode,
        },
    });
    return true;
}
