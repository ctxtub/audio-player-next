/**
 * 账号数据同步机制：四块上云数据（应用配置 / 提示词历史 / 生成历史 / 单会话聊天）
 * 「登录初始化 + 登出清理」编排的唯一事实源。
 *
 * - 登录/访客初始化由 AccountSyncProvider 调度（带渲染门）。
 * - 登出/会话失效清理键于 authStore 的 isLogin 下降沿自动触发（401/会话过期复用，零额外接线）。
 */

import { useAuthStore } from '@/stores/authStore';
import { useConfigStore } from '@/stores/configStore';
import { usePromptHistoryStore } from '@/stores/promptHistoryStore';
import { useGenerationHistoryStore } from '@/stores/generationHistoryStore';
import { useChatStore } from '@/stores/chatStore';

/**
 * 参与账号数据同步的一块数据的生命周期契约。
 */
interface AccountSyncParticipant {
  /** 调试标识。 */
  name: string;
  /** 登录态：拉取服务端数据并开启同步（须幂等，可安全重复调用）。 */
  initForUser: () => Promise<void>;
  /** 访客/未登录：本地初始化（登录专属块无此项）。 */
  initForGuest?: () => Promise<void> | void;
  /** 登出/会话失效：清本地并关闭同步。 */
  reset: () => void;
}

/**
 * 账号同步注册表：集中列出参与的块。新增一块账号同步数据，只需在此加一行。
 */
const participants: AccountSyncParticipant[] = [
  {
    name: 'config',
    initForUser: () => useConfigStore.getState().initForUser(),
    initForGuest: () => useConfigStore.getState().initialize(),
    reset: () => useConfigStore.getState().reset(),
  },
  {
    name: 'promptHistory',
    initForUser: () => usePromptHistoryStore.getState().initForUser(),
    initForGuest: () => usePromptHistoryStore.getState().hydrate(),
    reset: () => usePromptHistoryStore.getState().reset(),
  },
  {
    name: 'generationHistory',
    initForUser: () => useGenerationHistoryStore.getState().initForUser(),
    reset: () => useGenerationHistoryStore.getState().reset(),
  },
  {
    name: 'chat',
    initForUser: () => useChatStore.getState().initForUser(),
    reset: () => useChatStore.getState().reset(),
  },
];

/**
 * 登录态初始化：触发所有块拉取服务端数据（各自幂等，失败互不影响）。
 */
export function initAccountForUser(): void {
  for (const p of participants) {
    Promise.resolve(p.initForUser()).catch((error) => {
      console.warn(`[accountSync] ${p.name} initForUser failed`, error);
    });
  }
}

/**
 * 访客/未登录初始化：仅触发具备本地初始化的块（登录专属块跳过）。
 */
export function initAccountForGuest(): void {
  for (const p of participants) {
    if (!p.initForGuest) {
      continue;
    }
    Promise.resolve(p.initForGuest()).catch((error) => {
      console.warn(`[accountSync] ${p.name} initForGuest failed`, error);
    });
  }
}

/**
 * 登出/会话失效：同步清理所有块（清本地 + 关同步）。
 */
export function resetAccountData(): void {
  for (const p of participants) {
    p.reset();
  }
}

/** 登出订阅是否已挂载（保证全 app 生命周期只装一次）。 */
let subscribed = false;

/**
 * 一次性挂载 authStore 订阅：isLogin 由真转假（手动登出 / 未来 401 / 会话过期）
 * 时自动清理所有账号数据。须在客户端挂载时调用（避免 SSR 顶层副作用）。
 */
export function ensureAccountSyncSubscribed(): void {
  if (subscribed) {
    return;
  }
  subscribed = true;
  useAuthStore.subscribe((state, prevState) => {
    if (prevState.isLogin && !state.isLogin) {
      resetAccountData();
    }
  });
}
