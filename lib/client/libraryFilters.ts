import type { LibraryView } from '@/lib/client/library';

/** 故事库允许的所有合法视图列表 */
export const VALID_LIBRARY_VIEWS: readonly LibraryView[] = [
  'active',
  'favorites',
  'trash',
] as const;

/** 故事库默认视图 */
export const DEFAULT_LIBRARY_VIEW: LibraryView = 'active';

/** 搜索输入防抖等待毫秒数 */
export const SEARCH_DEBOUNCE_MS = 300;

/** 故事库 URL 筛选解析结果 */
export interface LibraryUrlFilters {
  view: LibraryView;
  q?: string;
}

/** 路由导航操作器最小抽象（解耦 Next.js 与单元测试） */
export interface RouterLike {
  push: (href: string) => void;
  replace: (href: string) => void;
}

/**
 * 规整搜索词（与 M2 领域契约完全一致，确保 canonical q）
 *
 * 规则：
 * 1. null / undefined -> undefined；
 * 2. trim 后如果为空字符串 -> undefined（空串转 undefined，URL 移除 q）；
 * 3. trim 后非空 -> 返回 trim 后的干净字符串（如 "  hero  " -> "hero"）；
 * 4. 字符串内部空格保留（如 "  a  b  " -> "a  b"）。
 */
export function canonicalizeQuery(rawQuery?: string | null): string | undefined {
  if (rawQuery === null || rawQuery === undefined) {
    return undefined;
  }
  const trimmed = rawQuery.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * 校验并解析视图类型
 *
 * 规则：
 * 1. 'favorites' -> 'favorites'；
 * 2. 'trash' -> 'trash'；
 * 3. 其余一切（'active'、非法值如 'foo'、null、undefined、空串） -> 兜底归一化为 'active'。
 */
export function parseLibraryView(rawView?: string | null): LibraryView {
  if (rawView === 'favorites' || rawView === 'trash') {
    return rawView;
  }
  return DEFAULT_LIBRARY_VIEW;
}

/**
 * 序列化故事库 URL
 *
 * 核心契约：
 * 1. 仅允许参数：view、q；
 * 2. 绝对禁止序列化 cursor、page、offset 等任何游标或分页参数；
 * 3. /library 等价于 view=active&q=''，当 view 为 active 且无 q 时产出 /library；
 * 4. 当 q 为空字符串或规整后为空时，自动从 URL 移除 q 参数；
 * 5. 当 view 为 active 且有 q 时，产出 /library?q=...（保持 URL 简洁）；
 * 6. 当 view 为 favorites/trash 时，始终携带 view=...（如 /library?view=favorites&q=foo）。
 */
export function serializeLibraryUrl(
  filters: { view?: LibraryView | string | null; q?: string | null },
  basePath = '/library'
): string {
  const view = parseLibraryView(filters.view);
  const canonicalQ = canonicalizeQuery(filters.q);

  const searchParams = new URLSearchParams();
  if (view !== DEFAULT_LIBRARY_VIEW) {
    searchParams.set('view', view);
  }
  if (canonicalQ) {
    searchParams.set('q', canonicalQ);
  }

  const queryString = searchParams.toString();
  return queryString ? `${basePath}?${queryString}` : basePath;
}

/**
 * 解析故事库 URL 或参数对象
 *
 * 提取 view 与 canonical q，严格忽略任何非契约参数（如 cursor, page, offset 等）。
 */
export function parseLibraryUrl(
  urlOrParams: string | URLSearchParams | { get: (name: string) => string | null }
): LibraryUrlFilters {
  let params: { get: (name: string) => string | null };
  if (typeof urlOrParams === 'string') {
    const qIndex = urlOrParams.indexOf('?');
    const queryString =
      qIndex >= 0
        ? urlOrParams.slice(qIndex)
        : urlOrParams.startsWith('?')
        ? urlOrParams
        : '';
    params = new URLSearchParams(queryString);
  } else {
    params = urlOrParams;
  }

  return {
    view: parseLibraryView(params.get('view')),
    q: canonicalizeQuery(params.get('q')),
  };
}

/** 故事库搜索状态快照 */
export interface LibrarySearchState {
  view: LibraryView;
  q?: string;           // 当前 URL 中的 canonical q
  draftQ: string;       // 输入框当前草稿内容
  isComposing: boolean; // 是否处于 IME 拼音/输入法组合状态
}

export interface LibrarySearchControllerOptions {
  initialUrl?: string;
  router: RouterLike;
  basePath?: string;
  debounceMs?: number;
  onStateChange?: (state: LibrarySearchState) => void;
}

/**
 * 故事库搜索输入与视图控制器（纯状态机与防抖逻辑）
 *
 * 核心保障：
 * 1. input draft -> 300ms debounce -> URL q (canonical) -> router.replace；
 * 2. compositionstart 暂停 debounce / 组合期间零调用；
 * 3. compositionend 重新开始完整 300ms，只提交一次最终 canonical q；
 * 4. view 切换默认保留当前 q，使用 router.push；
 * 5. back/forward 外部 URL 变更时同步 draftQ，且不产生额外历史路由操作。
 */
export class LibrarySearchController {
  private view: LibraryView;
  private q?: string;
  private draftQ: string;
  private isComposing = false;
  private timer: NodeJS.Timeout | null = null;

  private readonly router: RouterLike;
  private readonly basePath: string;
  private readonly debounceMs: number;
  private readonly onStateChange?: (state: LibrarySearchState) => void;

  constructor(options: LibrarySearchControllerOptions) {
    const parsed = parseLibraryUrl(options.initialUrl ?? options.basePath ?? '/library');
    this.view = parsed.view;
    this.q = parsed.q;
    this.draftQ = parsed.q ?? '';

    this.router = options.router;
    this.basePath = options.basePath ?? '/library';
    this.debounceMs = options.debounceMs ?? SEARCH_DEBOUNCE_MS;
    this.onStateChange = options.onStateChange;
  }

  /** 获取当前状态快照 */
  public getState(): LibrarySearchState {
    return {
      view: this.view,
      q: this.q,
      draftQ: this.draftQ,
      isComposing: this.isComposing,
    };
  }

  private notify(): void {
    if (this.onStateChange) {
      this.onStateChange(this.getState());
    }
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * 提交当前草稿至 URL（使用 router.replace）
   */
  private commitDraft(textToCommit: string): void {
    const canonical = canonicalizeQuery(textToCommit);
    if (canonical !== this.q) {
      this.q = canonical;
      const targetUrl = serializeLibraryUrl(
        { view: this.view, q: canonical },
        this.basePath
      );
      this.router.replace(targetUrl);
    }
    this.notify();
  }

  /**
   * 用户输入草稿变化
   */
  public setDraftQ(nextText: string): void {
    this.draftQ = nextText;
    this.notify();

    // IME 组合期间绝不启动 debounce 定时器，保证零调用
    if (this.isComposing) {
      this.clearTimer();
      return;
    }

    this.clearTimer();
    this.timer = setTimeout(() => {
      this.commitDraft(this.draftQ);
    }, this.debounceMs);
  }

  /**
   * IME 拼音/输入法开始组合
   */
  public onCompositionStart(): void {
    this.isComposing = true;
    this.clearTimer();
    this.notify();
  }

  /**
   * IME 拼音/输入法结束组合
   *
   * @param finalVal 组合完成后的最终文本值（可选；未传则使用当前草稿）
   */
  public onCompositionEnd(finalVal?: string): void {
    this.isComposing = false;
    if (finalVal !== undefined) {
      this.draftQ = finalVal;
    }
    this.notify();

    // 组合结束后，以最终内容重新开始完整的 300ms 防抖计时
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.commitDraft(this.draftQ);
    }, this.debounceMs);
  }

  /**
   * 切换视图类型（使用 router.push）
   *
   * 契约：
   * - 切换 view 默认保留当前的有效搜索词；
   * - view 切换操作必须产生新的历史栈记录（router.push）。
   */
  public setView(nextView: LibraryView): void {
    this.clearTimer();
    const validView = parseLibraryView(nextView);
    this.view = validView;

    const targetUrl = serializeLibraryUrl(
      { view: this.view, q: this.q },
      this.basePath
    );
    this.router.push(targetUrl);
    this.notify();
  }

  /**
   * 浏览器后退/前进 (Back/Forward / popstate) 外部 URL 变更同步
   *
   * 契约：
   * - 重新同步 draftQ 与 URL 中的 q；
   * - 不产生额外的路由 push/replace（杜绝历史记录污染）；
   * - 若用户当前处于 IME 组合中，则不覆盖正在组合的输入。
   */
  public syncFromUrl(urlOrParams: string | URLSearchParams | { get: (name: string) => string | null }): void {
    this.clearTimer();
    const parsed = parseLibraryUrl(urlOrParams);
    this.view = parsed.view;
    this.q = parsed.q;

    if (!this.isComposing) {
      this.draftQ = parsed.q ?? '';
    }
    this.notify();
  }

  /** 立即清空搜索输入并同步提交 */
  public clearSearch(): void {
    this.clearTimer();
    this.draftQ = '';
    this.commitDraft('');
  }

  /** 销毁控制器，清理未完成的定时器 */
  public destroy(): void {
    this.clearTimer();
  }
}
