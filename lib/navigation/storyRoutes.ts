/** 故事资源路由集中构造；标题与显示序号不能作为身份。 */
export const collectionPath = (collectionId: string): string => `/library/collections/${encodeURIComponent(collectionId)}`;
/** 单篇正式地址，无归属时使用独立解析入口。 */
export const workPath = (workId: number, collectionId?: string | null): string => collectionId
  ? `${collectionPath(collectionId)}/works/${workId}`
  : `/library/works/${workId}`;
/** 来源创作地址，只表达读取目标，不自动激活或生成。 */
export const conversationPath = (conversationId: string): string => `/chat/conversations/${encodeURIComponent(conversationId)}`;
/** 故事库管理视图路径与受控查询参数。 */
export function libraryPath(view = 'active', query?: string, type = 'collections'): string {
  const path = view === 'favorites' ? '/library/favorites' : view === 'trash' ? '/library/trash' : '/library';
  const params = new URLSearchParams();
  if (query?.trim()) params.set('q', query.trim().slice(0, 100));
  if (type === 'works' && view !== 'active') params.set('type', type);
  return params.size ? `${path}?${params}` : path;
}
