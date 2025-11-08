import { create } from 'zustand';

import {
  fetchProfile as fetchProfileRequest,
  login as loginRequest,
  logout as logoutRequest,
  AuthClientError,
} from '@/lib/client/auth';

/**
 * 登录态 store 的状态定义。
 */
type AuthState = {
  isLogin: boolean;
  nickname: string;
  loading: boolean;
  initialized: boolean;
  error?: string;
};

/**
 * 登录态 store 的操作方法集合。
 */
type AuthActions = {
  /**
   * 查询当前登录状态。
   */
  fetchProfile: () => Promise<void>;
  /**
   * 尝试执行登录流程。
   * @param username 账号。
   * @param password 密码。
   * @returns 是否登录成功。
   */
  login: (username: string, password: string) => Promise<boolean>;
  /**
   * 执行登出流程。
   */
  logout: () => Promise<boolean>;
  /**
   * 清理错误提示文本。
   */
  resetError: () => void;
};

/**
 * 登录态 store 的完整类型。
 */
export type AuthStore = AuthState & AuthActions;

/**
 * 创建登录态 store，负责管理登录、登出与错误状态。
 */
export const useAuthStore = create<AuthStore>()((set, get) => ({
  isLogin: false,
  nickname: '',
  loading: false,
  initialized: false,
  error: undefined,
  async fetchProfile() {
    const state = get();
    if (state.initialized) {
      return;
    }

    set({ loading: true, error: undefined });

    try {
      const profile = await fetchProfileRequest();
      set({
        isLogin: profile.isLogin,
        nickname: profile.user?.nickname ?? '',
        loading: false,
        initialized: true,
        error: undefined,
      });
    } catch (error) {
      const message =
        error instanceof AuthClientError
          ? error.message
          : error instanceof Error
          ? error.message
          : '获取登录状态失败';

      set({
        isLogin: false,
        nickname: '',
        loading: false,
        initialized: true,
        error: message,
      });
    }
  },
  async login(username: string, password: string) {
    set({ loading: true, error: undefined });

    try {
      const result = await loginRequest({ username, password });
      set({
        isLogin: true,
        nickname: result.user.nickname,
        loading: false,
        initialized: true,
        error: undefined,
      });
      return true;
    } catch (error) {
      const message =
        error instanceof AuthClientError
          ? error.message
          : error instanceof Error
          ? error.message
          : '登录失败，请稍后重试';

      set({
        loading: false,
        initialized: true,
        isLogin: false,
        nickname: '',
        error: message,
      });
      return false;
    }
  },
  async logout() {
    set({ loading: true, error: undefined });

    try {
      await logoutRequest();
      set({
        isLogin: false,
        nickname: '',
        loading: false,
        initialized: true,
        error: undefined,
      });
      return true;
    } catch (error) {
      const message =
        error instanceof AuthClientError
          ? error.message
          : error instanceof Error
          ? error.message
          : '登出失败，请稍后重试';

      set({
        loading: false,
        error: message,
      });
      return false;
    }
  },
  resetError() {
    set({ error: undefined });
  },
}));
