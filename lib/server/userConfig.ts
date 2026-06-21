/**
 * 用户配置服务层
 *
 * 封装 UserConfig 表的 DB↔DTO 映射、懒建行（支持本地 seed 迁移）与增量更新。
 * 将 prisma 细节从 tRPC router 剥离，便于复用与维护。
 */

import { TRPCError } from '@trpc/server';

import type { ThemeMode } from '@/types/theme';
import { prisma } from '@/lib/db';
import {
    DEFAULT_USER_CONFIG,
    type UserConfigDTO,
    type UserConfigPatch,
    type UserConfigSeed,
} from '@/lib/trpc/schemas/config';

/** UserConfig 行中本服务关心的字段子集。 */
type UserConfigRow = {
    playDurationMinutes: number;
    voiceId: string;
    speed: number;
    floatingPlayerEnabled: boolean;
    themeMode: string;
};

/**
 * 将 DB 存储的 themeMode 字符串收敛为合法枚举，非法值回落默认。
 * @param value DB 中的 themeMode 原始字符串。
 */
const normalizeThemeMode = (value: string): ThemeMode =>
    value === 'dark' || value === 'light' || value === 'system'
        ? value
        : DEFAULT_USER_CONFIG.themeMode;

/**
 * DB 行 → 前端 DTO。
 * @param row UserConfig 行。
 */
const toDto = (row: UserConfigRow): UserConfigDTO => ({
    playDuration: row.playDurationMinutes,
    voiceId: row.voiceId,
    speed: row.speed,
    floatingPlayerEnabled: row.floatingPlayerEnabled,
    themeMode: normalizeThemeMode(row.themeMode),
});

/**
 * 构造建行所需的 data，seed 缺省字段回落系统默认。
 * @param userId 关联用户 ID。
 * @param source seed 或 patch（取其中已提供的字段）。
 */
const buildCreateData = (userId: number, source?: UserConfigSeed) => ({
    userId,
    playDurationMinutes: source?.playDuration ?? DEFAULT_USER_CONFIG.playDuration,
    voiceId: source?.voiceId ?? DEFAULT_USER_CONFIG.voiceId,
    speed: source?.speed ?? DEFAULT_USER_CONFIG.speed,
    floatingPlayerEnabled:
        source?.floatingPlayerEnabled ?? DEFAULT_USER_CONFIG.floatingPlayerEnabled,
    themeMode: source?.themeMode ?? DEFAULT_USER_CONFIG.themeMode,
});

/**
 * 获取当前用户配置；行不存在时用 seed 建行（首次绑定迁移），之后服务端为准。
 * @param userId 用户 ID。
 * @param seed 仅在行不存在时消费的本地初始配置。
 */
export const getOrCreateUserConfig = async (
    userId: number,
    seed?: UserConfigSeed,
): Promise<UserConfigDTO> => {
    const existing = await prisma.userConfig.findUnique({ where: { userId } });
    if (existing) {
        return toDto(existing);
    }
    // 行不存在才建行：先确认用户仍存在，避免「会话指向已删除用户」时 create 撞外键约束（500）。
    // 此种会话已失效，统一抛 UNAUTHORIZED，由客户端按未登录/会话失效处理（而非整屏卡死）。
    const userExists = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!userExists) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'SESSION_USER_NOT_FOUND' });
    }
    const created = await prisma.userConfig.create({ data: buildCreateData(userId, seed) });
    return toDto(created);
};

/**
 * 增量更新用户配置（upsert，last-write-wins）。仅写入 patch 中已提供的字段。
 * @param userId 用户 ID。
 * @param patch 增量字段。
 */
export const updateUserConfig = async (
    userId: number,
    patch: UserConfigPatch,
): Promise<UserConfigDTO> => {
    const updateData: Record<string, unknown> = {};
    if (patch.playDuration !== undefined) updateData.playDurationMinutes = patch.playDuration;
    if (patch.voiceId !== undefined) updateData.voiceId = patch.voiceId;
    if (patch.speed !== undefined) updateData.speed = patch.speed;
    if (patch.floatingPlayerEnabled !== undefined) {
        updateData.floatingPlayerEnabled = patch.floatingPlayerEnabled;
    }
    if (patch.themeMode !== undefined) updateData.themeMode = patch.themeMode;

    const row = await prisma.userConfig.upsert({
        where: { userId },
        create: buildCreateData(userId, patch),
        update: updateData,
    });
    return toDto(row);
};
