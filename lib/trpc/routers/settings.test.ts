/**
 * settings router 单元测试
 *
 * 覆盖 get / save 两个 procedure 在不同登录态下的行为。
 */

import { describe, it, expect } from 'vitest';
import { TRPCError } from '@trpc/server';
import { prismaMock } from '@/test/helpers/prisma';
import { createPublicCaller, createAuthedCaller } from '@/test/helpers/trpc';

/** settings.get 返回的 DB 行记录 fixture */
const settingsRow = {
  id: 1,
  userId: 1,
  playDuration: 20,
  voiceId: 'alloy',
  speed: 1.1,
  floatingPlayerEnabled: false,
  themeMode: 'dark',
  updatedAt: new Date(),
};

describe('settings.get', () => {
  it('未登录返回 null', async () => {
    const caller = createPublicCaller();
    const result = await caller.settings.get();
    expect(result).toBeNull();
  });

  it('已登录但无记录返回 null', async () => {
    prismaMock.userSettings.findUnique.mockResolvedValue(null);
    const caller = createAuthedCaller(1);
    const result = await caller.settings.get();
    expect(result).toBeNull();
  });

  it('已登录有记录返回正确结构', async () => {
    prismaMock.userSettings.findUnique.mockResolvedValue(settingsRow);
    const caller = createAuthedCaller(1);
    const result = await caller.settings.get();

    expect(result).toEqual({
      playDuration: 20,
      voiceId: 'alloy',
      speed: 1.1,
      floatingPlayerEnabled: false,
      themeMode: 'dark',
    });
  });

  it('查询使用正确的 userId', async () => {
    prismaMock.userSettings.findUnique.mockResolvedValue(null);
    const caller = createAuthedCaller(42);
    await caller.settings.get();

    expect(prismaMock.userSettings.findUnique).toHaveBeenCalledWith({
      where: { userId: 42 },
    });
  });
});

describe('settings.save', () => {
  it('未登录抛出 UNAUTHORIZED', async () => {
    const caller = createPublicCaller();
    try {
      await caller.settings.save({ playDuration: 30 });
      expect.unreachable('应当抛出异常');
    } catch (error) {
      expect(error).toBeInstanceOf(TRPCError);
      expect((error as TRPCError).code).toBe('UNAUTHORIZED');
    }
  });

  it('已登录保存成功', async () => {
    prismaMock.userSettings.upsert.mockResolvedValue(settingsRow);
    const caller = createAuthedCaller(1);
    const result = await caller.settings.save({ playDuration: 20 });

    expect(result).toEqual({
      playDuration: 20,
      voiceId: 'alloy',
      speed: 1.1,
      floatingPlayerEnabled: false,
      themeMode: 'dark',
    });
  });

  it('upsert 传入正确参数（增量更新）', async () => {
    prismaMock.userSettings.upsert.mockResolvedValue(settingsRow);
    const caller = createAuthedCaller(7);
    await caller.settings.save({ speed: 1.5 });

    expect(prismaMock.userSettings.upsert).toHaveBeenCalledWith({
      where: { userId: 7 },
      create: { userId: 7, speed: 1.5 },
      update: { speed: 1.5 },
    });
  });

  it('Zod 校验：playDuration 超范围拒绝', async () => {
    const caller = createAuthedCaller(1);
    await expect(caller.settings.save({ playDuration: 5 })).rejects.toThrow();
    await expect(caller.settings.save({ playDuration: 100 })).rejects.toThrow();
  });

  it('Zod 校验：空对象通过', async () => {
    prismaMock.userSettings.upsert.mockResolvedValue(settingsRow);
    const caller = createAuthedCaller(1);
    await expect(caller.settings.save({})).resolves.toBeDefined();
  });

  it('DB 异常时抛出错误', async () => {
    prismaMock.userSettings.upsert.mockRejectedValue(new Error('DB connection lost'));
    const caller = createAuthedCaller(1);
    await expect(caller.settings.save({ speed: 1.0 })).rejects.toThrow();
  });
});

describe('settings.get DB 异常', () => {
  it('DB 异常时抛出错误', async () => {
    prismaMock.userSettings.findUnique.mockRejectedValue(new Error('DB connection lost'));
    const caller = createAuthedCaller(1);
    await expect(caller.settings.get()).rejects.toThrow();
  });
});
