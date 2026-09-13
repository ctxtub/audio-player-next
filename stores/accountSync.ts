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
import { usePlaybackSessionStore } from '@/stores/playbackSessionStore';
import { usePlaybackProgressStore } from '@/stores/playbackProgressStore';
import { usePlaybackStore } from '@/stores/playbackStore';

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
    initForGuest: () => usePromptHistoryStore.getState().initForUser(),
    reset: () => usePromptHistoryStore.getState().reset(),
  },
  {
    name: 'generationHistory',
    initForUser: () => useGenerationHistoryStore.getState().initForUser(),
    initForGuest: () => useGenerationHistoryStore.getState().initForUser(),
    reset: () => useGenerationHistoryStore.getState().reset(),
  },
  {
    name: 'chat',
    initForUser: () => useChatStore.getState().initForUser(),
    initForGuest: () => useChatStore.getState().initForUser(),
    reset: () => useChatStore.getState().reset(),
  },
  {
    // M5-09 cutover 过渡：新 SSOT PlaybackSessionStore 为主，旧 playbackProgressStore
    // 保留 compatibility 双水合/双清（M9 删除旧项）。probe 名保持 playbackProgress
    // 以兼容 H-06 参与序列断言；新增 playbackSession 参与项承载新链。
    name: 'playbackProgress',
    initForUser: () => usePlaybackProgressStore.getState().initForUser(),
    initForGuest: () => usePlaybackProgressStore.getState().initForGuest(),
    reset: () => {
      usePlaybackProgressStore.getState().reset();
    },
  },
  {
    name: 'playbackSession',
    initForUser: () => usePlaybackSessionStore.getState().initForUser().then(() => {}),
    initForGuest: () => usePlaybackSessionStore.getState().initForGuest().then(() => {}),
    reset: () => {
      usePlaybackSessionStore.getState().reset();
      usePlaybackStore.getState().reset();
    },
  },
];

/**
 * H-06 登出停声时序探针的播放快照（卸载瞬间采样，纯观测）。
 */
export type LogoutProbePlaybackSnapshot = {
  /** 采样瞬间是否处于播放中。 */
  isPlaying: boolean;
  /** 采样瞬间当前音频地址。 */
  currentAudioUrl: string | null;
  /** 采样瞬间是否已注册音频控制器。 */
  hasController: boolean;
};

/**
 * H-06 登出停声时序探针的一次采样（reset 链前后各一次快照，纯观测）。
 */
export type LogoutProbeSample = {
  /** 采样时间戳（毫秒）。 */
  at: number;
  /** 本次清理的参与块序列。 */
  participants: string[];
  /** 清理前（卸载瞬间）播放快照。 */
  playbackBefore: LogoutProbePlaybackSnapshot;
  /** 清理后播放快照。 */
  playbackAfter: LogoutProbePlaybackSnapshot;
};

/** 探针采样环形保留（只记最近若干条，防内存增长）。 */
const LOGOUT_PROBE_KEEP = 20;

/** 探针采样暂存（仅内存，不持久化）。 */
const logoutProbeSamples: LogoutProbeSample[] = [];

/**
 * 采样当前播放快照（纯读，不触控制器行为）。
 * @returns 当前播放快照
 */
function samplePlaybackForProbe(): LogoutProbePlaybackSnapshot {
  const state = usePlaybackStore.getState();
  return {
    isPlaying: state.isPlaying,
    currentAudioUrl: state.currentAudioUrl,
    hasController: state.audioController !== null,
  };
}

/**
 * 深冻单条探针采样：participants 数组与播放快照均拷贝后冻结，顶层亦冻结。
 * 快照为一层扁平结构，展开拷贝即深拷贝；调用方任何改写均不触内部暂存。
 * @param sample 内部暂存的原始采样。
 * @returns 深拷贝且深冻的采样。
 */
function freezeLogoutProbeSample(sample: LogoutProbeSample): LogoutProbeSample {
  return Object.freeze({
    at: sample.at,
    participants: Object.freeze([...sample.participants]),
    playbackBefore: Object.freeze({ ...sample.playbackBefore }),
    playbackAfter: Object.freeze({ ...sample.playbackAfter }),
  }) as LogoutProbeSample;
}

/**
 * 读取登出探针采样（返回深拷贝 + 深冻，调用方不得改写内部暂存）。
 * @returns 采样拷贝（冻结数组内冻结对象）
 */
export function getLogoutProbeSamples(): LogoutProbeSample[] {
  const copies = logoutProbeSamples.map((sample) => freezeLogoutProbeSample(sample));
  return Object.freeze(copies) as LogoutProbeSample[];
}

/**
 * 清空登出探针采样（测试隔离用，不触登出行为）。
 * @returns void
 */
export function clearLogoutProbeSamples(): void {
  logoutProbeSamples.length = 0;
}

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
 * 访客/未登录初始化：拉取访客专属服务端云端数据。
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
 * 登出/会话失效/身份切换：同步清理所有块（清本地 + 关同步）。
 * H-06 探针仅在前后采样播放快照并记录参与序列，不改任何清理行为。
 * H-06 follow-up：try/finally 永不阻断登出——单块 reset 抛错仅告警并继续其余块，
 * 探针采样与记录包在 finally/内层 try/catch，任何探针异常不外抛阻断登出。
 */
export function resetAccountData(): void {
  const at = Date.now();
  let playbackBefore: LogoutProbePlaybackSnapshot;
  try {
    playbackBefore = samplePlaybackForProbe();
  } catch (error) {
    console.warn('[accountSync] probe before failed', error);
    playbackBefore = { isPlaying: false, currentAudioUrl: null, hasController: false };
  }
  try {
    for (const p of participants) {
      try {
        p.reset();
      } catch (error) {
        console.warn(`[accountSync] ${p.name} reset failed`, error);
      }
    }
  } finally {
    let playbackAfter: LogoutProbePlaybackSnapshot;
    try {
      playbackAfter = samplePlaybackForProbe();
    } catch (error) {
      console.warn('[accountSync] probe after failed', error);
      playbackAfter = { isPlaying: false, currentAudioUrl: null, hasController: false };
    }
    try {
      logoutProbeSamples.push({
        at,
        participants: participants.map((p) => p.name),
        playbackBefore,
        playbackAfter,
      });
      if (logoutProbeSamples.length > LOGOUT_PROBE_KEEP) {
        logoutProbeSamples.splice(0, logoutProbeSamples.length - LOGOUT_PROBE_KEEP);
      }
    } catch (error) {
      console.warn('[accountSync] probe record failed', error);
    }
  }
}

/** 登出订阅是否已挂载（保证全 app 生命周期只装一次）。 */
let subscribed = false;

/**
 * 一次性挂载 authStore 订阅：isLogin 发生状态跃迁时（登录或登出）
 * 自动清理所有账号数据，防止内存与防抖保存交叉污染，确保各主体云端数据独立可信。
 */
export function ensureAccountSyncSubscribed(): void {
  if (subscribed) {
    return;
  }
  subscribed = true;
  useAuthStore.subscribe((state, prevState) => {
    if (prevState.isLogin !== state.isLogin) {
      resetAccountData();
    }
  });
}
