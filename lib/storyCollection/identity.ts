/**
 * Conversation / StoryCollection 身份生成（change-id 2026-09-15-story-collection-continuous-creation）。
 *
 * - 实时创建使用随机 UUID v4；
 * - backfill 与注册迁移使用确定性 UUID v5 形态，保证可重复执行不产生重复行（幂等）。
 */

import { createHash, randomUUID } from 'node:crypto';

/** 生成随机 UUID（实时创作会话 / 作品集 id）。 */
export function createConversationId(): string {
  return randomUUID();
}

/** 生成随机 UUID（作品集 id）。 */
export function createCollectionId(): string {
  return randomUUID();
}

/**
 * 由命名空间与稳定值派生确定性 UUID v5 形态 id。
 * 用于 backfill / 注册迁移的幂等 upsert 主键（同一输入恒得同一 id）。
 * @param namespace 逻辑命名空间（区分实体类型，避免跨类型碰撞）
 * @param value 稳定业务键（如 `user:1:work:9`）
 */
export function deriveDeterministicId(namespace: string, value: string): string {
  const hex = createHash('sha256')
    .update(`${namespace}\u0000${value}`)
    .digest('hex')
    .slice(0, 32)
    .split('');
  hex[12] = '5';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
