import React from 'react';
import LibraryUndoProvider from '@/components/Library/LibraryUndoProvider';
import CollectionUndoProvider from '@/components/Library/CollectionUndoProvider';

/**
 * 故事库全局布局组件（，  扩展集合级 Undo）
 *
 * 核心设计原则：
 * 1. /library、/library/[id] 与 /library/collections/[id] 共享同一 Library layout；
 * 2. 挂载 LibraryUndoProvider（Work 级）与 CollectionUndoProvider（集合级），
 *    确保详情页软删除后跳回列表页，Undo 提示不因页面卸载而丢失；
 * 3. 两 provider 会话相互独立（各自 token 隔离），toast 同一时刻至多其一可见；
 * 4. 严格使用 React Context / useState 管理瞬时 UI 状态与撤销命令，绝不引入外部持久 store.
 *
 * @param props 包含子路由页面节点
 * @returns 故事库布局节点
 */
export default function LibraryLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <LibraryUndoProvider>
      <CollectionUndoProvider>{children}</CollectionUndoProvider>
    </LibraryUndoProvider>
  );
}
