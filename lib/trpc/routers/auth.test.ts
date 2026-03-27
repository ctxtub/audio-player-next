/**
 * auth router 单元测试
 *
 * 覆盖 register / login / logout / profile 核心流程。
 */

import { describe, it, expect } from 'vitest';
import bcrypt from 'bcryptjs';
import { prismaMock } from '@/test/helpers/prisma';
import '@/test/helpers/cookies';
import { mockCookieStore } from '@/test/helpers/cookies';
import { createPublicCaller, createAuthedCaller } from '@/test/helpers/trpc';

/** 模拟 DB 用户行记录 */
const hashedPassword = bcrypt.hashSync('123456', 10);
const userRow = {
  id: 1,
  username: 'alice',
  password: hashedPassword,
  nickname: '爱丽丝',
  createdAt: new Date(),
};

describe('auth.register', () => {
  it('正常注册成功', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.user.create.mockResolvedValue(userRow);

    const caller = createPublicCaller();
    const result = await caller.auth.register({
      username: 'alice',
      password: '123456',
      nickname: '爱丽丝',
    });

    expect(result.success).toBe(true);
    expect(result.user.nickname).toBe('爱丽丝');
    /** 验证密码已 hash（不是明文存储） */
    const createCall = prismaMock.user.create.mock.calls[0]?.[0];
    expect(createCall?.data?.password).not.toBe('123456');
    /** 验证 cookie 已写入 */
    expect(mockCookieStore.set).toHaveBeenCalled();
  });

  it('不传 nickname 默认使用 username', async () => {
    const userWithoutNickname = { ...userRow, nickname: 'alice' };
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.user.create.mockResolvedValue(userWithoutNickname);

    const caller = createPublicCaller();
    const result = await caller.auth.register({
      username: 'alice',
      password: '123456',
    });

    expect(result.success).toBe(true);
    /** 验证 Prisma create 调用中 nickname 回退为 username */
    const createCall = prismaMock.user.create.mock.calls[0]?.[0];
    expect(createCall?.data?.nickname).toBe('alice');
  });

  it('用户名已存在抛出 CONFLICT', async () => {
    prismaMock.user.findUnique.mockResolvedValue(userRow);

    const caller = createPublicCaller();
    await expect(
      caller.auth.register({ username: 'alice', password: '123456' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('Zod 校验：用户名过短拒绝', async () => {
    const caller = createPublicCaller();
    await expect(
      caller.auth.register({ username: 'a', password: '123456' })
    ).rejects.toThrow();
  });
});

describe('auth.login', () => {
  it('正常登录成功', async () => {
    prismaMock.user.findUnique.mockResolvedValue(userRow);

    const caller = createPublicCaller();
    const result = await caller.auth.login({
      username: 'alice',
      password: '123456',
    });

    expect(result.success).toBe(true);
    expect(result.user.nickname).toBe('爱丽丝');
    expect(mockCookieStore.set).toHaveBeenCalled();
  });

  it('用户不存在抛出 UNAUTHORIZED', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    const caller = createPublicCaller();
    await expect(
      caller.auth.login({ username: 'ghost', password: '123456' })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('密码错误抛出 UNAUTHORIZED', async () => {
    prismaMock.user.findUnique.mockResolvedValue(userRow);

    const caller = createPublicCaller();
    await expect(
      caller.auth.login({ username: 'alice', password: 'wrong' })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('auth.logout', () => {
  it('清除 session 和 guest cookie', async () => {
    const caller = createPublicCaller();
    const result = await caller.auth.logout();

    expect(result.success).toBe(true);
    expect(mockCookieStore.delete).toHaveBeenCalledWith('auth');
    expect(mockCookieStore.delete).toHaveBeenCalledWith('guest');
  });
});

describe('auth.profile', () => {
  it('已登录返回用户信息', async () => {
    const caller = createAuthedCaller(1, '爱丽丝');
    const result = await caller.auth.profile();

    expect(result).toEqual({
      isLogin: true,
      isGuest: false,
      user: { nickname: '爱丽丝' },
    });
  });

  it('未登录且非访客', async () => {
    const caller = createPublicCaller();
    const result = await caller.auth.profile();

    expect(result.isLogin).toBe(false);
    expect(result.isGuest).toBe(false);
  });

  it('访客模式', async () => {
    /** 模拟 guest cookie 已设置 */
    mockCookieStore.get.mockImplementation((name: string) => {
      if (name === 'guest') return { name: 'guest', value: '1' };
      return undefined;
    });

    const caller = createPublicCaller();
    const result = await caller.auth.profile();

    expect(result.isLogin).toBe(false);
    expect(result.isGuest).toBe(true);
  });
});
