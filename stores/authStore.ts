import { create } from 'zustand';

import {
  fetchProfile as fetchProfileRequest,
  login as loginRequest,
  logout as logoutRequest,
  register as registerRequest,
  enterGuestMode as enterGuestModeRequest,
} from '@/lib/client/auth';
import { useConfigStore } from '@/stores/configStore';

type AuthState = {
  isLogin: boolean;
  isGuest: boolean;
  nickname: string;
  loading: boolean;
  initialized: boolean;
  error?: string;
};

type AuthActions = {
  fetchProfile: () => Promise<void>;
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => Promise<boolean>;
  register: (username: string, password: string, nickname?: string) => Promise<boolean>;
  enterGuestMode: () => Promise<boolean>;
  resetError: () => void;
};

export type AuthStore = AuthState & AuthActions;

export const useAuthStore = create<AuthStore>()((set, get) => ({
  isLogin: false,
  isGuest: false,
  nickname: '',
  loading: false,
  initialized: false,
  error: undefined,

  async fetchProfile() {
    if (get().initialized || get().loading) return;

    set({ loading: true, error: undefined });

    try {
      const profile = await fetchProfileRequest();
      set({
        isLogin: profile.isLogin,
        isGuest: profile.isGuest ?? false,
        nickname: profile.isLogin ? (profile.user?.nickname ?? '') : '',
        loading: false,
        initialized: true,
        error: undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '获取登录状态失败';
      set({ isLogin: false, isGuest: false, nickname: '', loading: false, initialized: true, error: message });
    }
  },

  async login(username: string, password: string) {
    set({ loading: true, error: undefined });

    try {
      const result = await loginRequest({ username, password });
      set({ isLogin: true, isGuest: false, nickname: result.user.nickname, loading: false, initialized: true, error: undefined });
      /** 同步 configStore 登录态，拉取用户设置 */
      useConfigStore.getState().onLogin().catch((err) => {
        console.error('登录后同步用户设置失败:', err);
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : '登录失败，请稍后重试';
      set({ loading: false, initialized: true, isLogin: false, isGuest: false, nickname: '', error: message });
      return false;
    }
  },

  async register(username: string, password: string, nickname?: string) {
    set({ loading: true, error: undefined });

    try {
      const result = await registerRequest({ username, password, nickname });
      set({ isLogin: true, isGuest: false, nickname: result.user.nickname, loading: false, initialized: true, error: undefined });
      /** 同步 configStore 登录态，拉取用户设置 */
      useConfigStore.getState().onLogin().catch((err) => {
        console.error('注册后同步用户设置失败:', err);
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : '注册失败，请稍后重试';
      set({ loading: false, initialized: true, isLogin: false, isGuest: false, nickname: '', error: message });
      return false;
    }
  },

  async logout() {
    set({ loading: true, error: undefined });

    try {
      await logoutRequest();
      set({ isLogin: false, isGuest: false, nickname: '', loading: false, initialized: true, error: undefined });
      /** 同步 configStore 登出态，停止 DB 写入 */
      useConfigStore.getState().onLogout();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : '登出失败，请稍后重试';
      set({ loading: false, error: message });
      return false;
    }
  },

  async enterGuestMode() {
    set({ loading: true, error: undefined });

    try {
      await enterGuestModeRequest();
      set({ isLogin: false, isGuest: true, nickname: '', loading: false, initialized: true, error: undefined });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : '进入访客模式失败';
      set({ loading: false, error: message });
      return false;
    }
  },

  resetError() {
    set({ error: undefined });
  },
}));
