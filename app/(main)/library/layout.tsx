import React from 'react';
import LibraryUndoProvider from '@/components/Library/LibraryUndoProvider';

/**
 * 故事库全局布局组件（M3-05）
 *
 * 核心设计原则：
 * 1. /library 与 /library/[id] 共享同一 Library layout；
 * 2. 挂载 LibraryUndoProvider，确保用户在详情页软删除后跳回列表页，Undo 提示不因页面卸载而丢失；
 * 3. 严格使用 React Context / useState 管理瞬时 UI 状态与撤销命令，绝不引入外部持久 store。
 *
 * @param props 包含子路由页面节点
 * @returns 故事库布局节点
 */
export default function LibraryLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <LibraryUndoProvider>{children}</LibraryUndoProvider>;
}
