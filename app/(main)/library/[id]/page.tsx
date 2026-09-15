import React from 'react';
import { notFound } from 'next/navigation';
import StoryDetailPage from './index';

interface StoryDetailPageProps {
  params: Promise<{
    id: string;
  }>;
}

/**
 * 校验 ID 是否为正整数（positive integer: 1, 2, 3...）。
 * 0, -1, foo, 1.2 等非法输入均返回 false。
 *
 * @param id 待校验的 ID 字符串
 * @returns 是否为合法的正整数字符串
 */
function isValidStoryId(id: string | undefined | null): boolean {
  if (!id || typeof id !== 'string') {
    return false;
  }
  return /^[1-9]\d*$/.test(id);
}

/**
 * 故事详情页路由入口（M1-02 骨架）。
 * 执行 [id] 结构校验：仅接受正整数（positive integer: 1, 2, 3...）。
 * 非法输入（0, -1, foo, 1.2 等）直接触发 notFound()。
 * @param props App Router 动态段参数
 * @returns 故事详情页路由节点
 */
export default async function Page({ params }: StoryDetailPageProps) {
  const resolvedParams = await params;
  const id = resolvedParams?.id;

  if (!isValidStoryId(id)) {
    notFound();
  }

  return <StoryDetailPage id={id!} />;
}
