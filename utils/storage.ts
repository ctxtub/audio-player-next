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

export const getSafeLocalStorage = (): Storage => {
  if (typeof window === 'undefined') {
    return fallbackStorage;
  }
  return window.localStorage;
};

export const isBrowserEnvironment = () => typeof window !== 'undefined';
