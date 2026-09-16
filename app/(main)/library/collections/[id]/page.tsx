import React from 'react';
import { notFound } from 'next/navigation';
import CollectionDetailPage from './index';

interface CollectionDetailPageProps {
  params: Promise<{
    id: string;
  }>;
}

/**
 * 集合详情路由入口（）。
 * 集合 id 为 UUID 文本（非数字 Work id 命名空间，/library/[id] 不冲突）。
 * 空/超长输入直接 notFound；软删除集合由服务端 fail closed → 统一不可用视图。
 */
export default async function Page({ params }: CollectionDetailPageProps) {
  const resolvedParams = await params;
  const id = resolvedParams?.id;

  if (!id || typeof id !== 'string' || id.length === 0 || id.length > 64) {
    notFound();
  }

  return <CollectionDetailPage id={id!} />;
}
