/**
 * 一级主导航 Tab 键名类型。
 * 目标 IA：'chat' (创作) | 'library' (故事库) | 'setting' (设置)。
 * 注意：'/player' 为过渡期 compatibility alias，映射为 'library'，不作为独立一级 TabKey。
 */
export type MainTabKey = 'chat' | 'library' | 'setting';

/**
 * 默认主导航 TabKey，未知路径防御性回退目标。
 */
export const DEFAULT_MAIN_TAB_KEY: MainTabKey = 'chat';

/**
 * 主导航项元数据定义。
 */
export interface MainTabDefinition {
  /** Tab 唯一标识键。 */
  readonly key: MainTabKey;
  /** Tab 显示标题。 */
  readonly title: string;
  /** Tab 导航基础路由路径。 */
  readonly path: string;
}

/**
 * 一级主导航 Tab 配置列表（按渲染顺序排列）。
 */
export const MAIN_TABS: readonly MainTabDefinition[] = [
  {
    key: 'chat',
    title: '创作',
    path: '/chat',
  },
  {
    key: 'library',
    title: '故事库',
    path: '/library',
  },
  {
    key: 'setting',
    title: '设置',
    path: '/setting',
  },
] as const;

/**
 * 判断指定 pathname 是否归属于目标 basePath 的路由家族。
 *
 * 关键规则：必须严格采用 exact + '/' boundary：
 * - pathname 完全等于 basePath
 * - 或 pathname 以 basePath + '/' 开头
 *
 * 杜绝类似 /library-old 误判为 /library 的前缀碰撞漏洞。
 *
 * @param pathname 当前路径（允许包含查询参或哈希，将自动清理）
 * @param basePath 家族基准路径（如 '/chat'、'/library'、'/setting'）
 * @returns 是否归属该路由家族
 */
export function isRouteFamily(pathname: string, basePath: string): boolean {
  if (!pathname || !basePath) {
    return false;
  }

  const cleanPath = pathname.split('?')[0].split('#')[0];
  const cleanBase = basePath.split('?')[0].split('#')[0];

  const normalizedBase = cleanBase.length > 1 && cleanBase.endsWith('/')
    ? cleanBase.slice(0, -1)
    : cleanBase;
  const normalizedPath = cleanPath.length > 1 && cleanPath.endsWith('/')
    ? cleanPath.slice(0, -1)
    : cleanPath;

  if (normalizedPath === normalizedBase) {
    return true;
  }

  return normalizedPath.startsWith(`${normalizedBase}/`);
}

/**
 * 根据传入的路由路径解析当前激活的一级导航 TabKey。
 *
 * 目标路由映射契约：
 * - /chat 或 /chat/** -> 'chat'
 * - /library 或 /library/** -> 'library'
 * - /setting 或 /setting/** -> 'setting'
 * - /player -> 'library'（过渡期 compatibility alias）
 * - unknown / 根路径 -> 防御性回退到 'chat'
 *
 * @param pathname 当前路由 pathname
 * @returns 对应的 MainTabKey
 */
export function resolveMainTabKey(pathname?: string | null): MainTabKey {
  if (!pathname || typeof pathname !== 'string') {
    return DEFAULT_MAIN_TAB_KEY;
  }

  const cleanPath = pathname.split('?')[0].split('#')[0];
  const normalizedPath = cleanPath.length > 1 && cleanPath.endsWith('/')
    ? cleanPath.slice(0, -1)
    : cleanPath;

  if (isRouteFamily(cleanPath, '/chat')) {
    return 'chat';
  }

  if (isRouteFamily(cleanPath, '/library') || normalizedPath === '/player') {
    return 'library';
  }

  if (isRouteFamily(cleanPath, '/setting')) {
    return 'setting';
  }

  return DEFAULT_MAIN_TAB_KEY;
}
