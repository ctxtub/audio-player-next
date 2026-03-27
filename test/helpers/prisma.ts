/**
 * Prisma 深度 mock 工厂。
 *
 * 通过 vitest-mock-extended 创建 PrismaClient 的深度代理对象，
 * 所有 model 方法（findUnique / create / upsert 等）均为 vi.fn()，
 * 可在测试用例中通过 mockResolvedValue 设置返回值。
 */

import { mockDeep, mockReset, type DeepMockProxy } from 'vitest-mock-extended';
import { beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@/lib/generated/prisma/client';

/** Prisma 深度 mock 实例，测试用例可直接引用设置返回值。 */
export const prismaMock = mockDeep<PrismaClient>();

/** 每个测试前重置所有 mock 状态，避免用例间污染。 */
beforeEach(() => {
  mockReset(prismaMock);
});

/**
 * 拦截 `@/lib/db` 模块，将 prisma 替换为 mock 实例。
 * 需要在测试文件顶层调用 vi.mock，此处通过 re-export 让 setup 文件统一处理。
 */
vi.mock('@/lib/db', () => ({
  prisma: prismaMock,
}));
