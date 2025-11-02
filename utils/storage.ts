/**
 * 在非浏览器环境下使用的兜底 Storage 实现。
 */
const fallbackStorage: Storage = {
  get length() {
    return 0;
  },
  clear() {
    return undefined;
  },
  getItem() {
    return null;
  },
  key() {
    return null;
  },
  removeItem() {
    return undefined;
  },
  setItem() {
    return undefined;
  },
};

/**
 * 获取安全的 localStorage，若不可用则返回兜底实现。
 * @returns 可用的 Storage 实例
 */
export const getSafeLocalStorage = (): Storage => {
  if (typeof window === 'undefined') {
    return fallbackStorage;
  }
  return window.localStorage;
};

/**
 * 判断当前是否在浏览器环境运行。
 * @returns 是否为浏览器环境
 */
export const isBrowserEnvironment = () => typeof window !== 'undefined';
