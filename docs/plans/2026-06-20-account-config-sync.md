# 账号体系对接（一）：应用配置同步 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实施。步骤用 `- [ ]` 复选框跟踪。

**Goal:** 让登录用户的应用配置（时长/音色/语速/浮窗/主题）以服务端 `UserConfig` 为权威源云端同步，访客/未登录走纯本地，并确立可复用的"登录态编排/登出清理/首次 seed 迁移"基建。

**Architecture:** 新增 `authedProcedure` 保护的 `config.getMine/updateMine`，服务端首次访问懒建行（可用本地 seed 初始化）；`config.get` 重定位为只返回系统级音色数据；`configStore` 增加 `initForUser/reset` 与防抖回写；`ConfigInitializer` 升级为认证感知编排器；新增 `ThemeConfigBridge` 双向绑定主题与配置。

**Tech Stack:** Next.js 15 / tRPC 11 / Zod / Prisma 7(libsql) / Zustand。

> **测试约定（重要）：** 本仓库**无测试框架**（无 vitest/jest，无测试脚本），CLAUDE.md 规定的验证门槛是 `yarn lint` + `yarn tsc --noEmit` + `yarn build`。遵循 writing-plans"在既有代码库沿用既有模式"原则，本计划**不引入测试栈**，每个任务以"类型检查/构建 + 浏览器验证"作为验证手段，替代单元测试步骤。
>
> **提交约定（用户指示覆盖）：** 用户要求**整体任务完成后再统一提交 git**。因此各任务末尾是"验证检查点"而非 `git commit`；仅最后 Task 8 在用户确认后做一次性提交。执行者在此之前**不要**运行 `git commit`。

---

## 文件结构与职责

| 文件 | 角色 | 职责 |
|------|------|------|
| `lib/trpc/schemas/config.ts` | 新建 | seed/patch/DTO 的 Zod schema、类型、`DEFAULT_USER_CONFIG` 常量 |
| `lib/server/userConfig.ts` | 新建 | DB↔DTO 映射、`getOrCreateUserConfig`(seed)、`updateUserConfig`(patch) |
| `lib/trpc/routers/config.ts` | 改 | 加 `getMine`/`updateMine`，重定位 `get` 为系统级 |
| `lib/client/userConfig.ts` | 新建 | `fetchMyConfig`/`saveMyConfig` 客户端封装 |
| `lib/client/appConfig.ts` | 改 | 适配 `get` 的新返回形状 |
| `types/appConfig.ts` | 改 | `APIConfig` 增加 `themeMode`；`AppConfigResponse` 收敛为系统级 |
| `stores/configStore.ts` | 改 | 加 `initForUser`/`reset` + 防抖回写 + themeMode + 适配新 `get` |
| `components/ConfigInitializer/index.tsx` | 改 | 升级为"先认证后按登录态编排 init"的编排器 |
| `components/ThemeConfigBridge/index.tsx` | 新建 | 登录态下 ThemeProvider ↔ configStore.themeMode 双向绑定 |
| `app/(main)/setting/components/UserSection/index.tsx` | 改 | 登出成功后调用 `configStore.reset()` |

---

## Task 1: 配置 Zod Schema 与默认常量

**Files:**
- Create: `lib/trpc/schemas/config.ts`

- [ ] **Step 1: 新建 schema 文件**

```ts
/**
 * 用户配置相关 Zod Schemas 与默认值。
 *
 * seed：首次建行时的初始值；patch：更新时的增量；DTO：返回前端的形状。
 */

import { z } from 'zod';
import type { ThemeMode } from '@/types/theme';

/** 主题模式枚举校验。 */
export const themeModeSchema = z.enum(['dark', 'light', 'system']);

/**
 * 用户配置增量更新 Schema：全字段可选，约束与 UserConfig 表对齐。
 */
export const userConfigPatchSchema = z.object({
    /** 播放时长（分钟），范围 10-120。 */
    playDuration: z.number().int().min(10).max(120).optional(),
    /** TTS 音色 ID，空串=系统默认。 */
    voiceId: z.string().max(64).optional(),
    /** 播放速率，范围 0.25-4.0。 */
    speed: z.number().min(0.25).max(4.0).optional(),
    /** 是否启用浮动播放器。 */
    floatingPlayerEnabled: z.boolean().optional(),
    /** 主题模式。 */
    themeMode: themeModeSchema.optional(),
});

/** 增量更新类型。 */
export type UserConfigPatch = z.infer<typeof userConfigPatchSchema>;

/** 首次建行迁移用 Seed，与 patch 同形，但语义为初始值。 */
export const userConfigSeedSchema = userConfigPatchSchema;
/** Seed 类型。 */
export type UserConfigSeed = z.infer<typeof userConfigSeedSchema>;

/**
 * 返回前端的用户配置 DTO（前端语义命名）。
 */
export const userConfigDtoSchema = z.object({
    playDuration: z.number().int(),
    voiceId: z.string(),
    speed: z.number(),
    floatingPlayerEnabled: z.boolean(),
    themeMode: themeModeSchema,
});

/** 用户配置 DTO 类型。 */
export type UserConfigDTO = z.infer<typeof userConfigDtoSchema>;

/**
 * 系统级默认配置，与 Prisma schema 的 @default 对齐。
 * 同时用作：新建 UserConfig 行的兜底、访客/未登录客户端默认。
 */
export const DEFAULT_USER_CONFIG: UserConfigDTO = {
    playDuration: 30,
    voiceId: '',
    speed: 1.0,
    floatingPlayerEnabled: true,
    themeMode: 'system',
};
```

- [ ] **Step 2: 验证检查点**

Run: `yarn tsc --noEmit`
Expected: 无类型错误（`ThemeMode` 与 `themeModeSchema` 枚举一致）。

---

## Task 2: 服务端配置服务（DB↔DTO + 懒建行 + 更新）

**Files:**
- Create: `lib/server/userConfig.ts`

- [ ] **Step 1: 新建服务文件**

```ts
/**
 * 用户配置服务层
 *
 * 封装 UserConfig 表的 DB↔DTO 映射、懒建行（支持本地 seed 迁移）与增量更新。
 * 将 prisma 细节从 tRPC router 剥离，便于复用与维护。
 */

import type { ThemeMode } from '@/types/theme';
import { prisma } from '@/lib/db';
import {
    DEFAULT_USER_CONFIG,
    type UserConfigDTO,
    type UserConfigPatch,
    type UserConfigSeed,
} from '@/lib/trpc/schemas/config';

/** UserConfig 行中本服务关心的字段子集。 */
type UserConfigRow = {
    playDurationMinutes: number;
    voiceId: string;
    speed: number;
    floatingPlayerEnabled: boolean;
    themeMode: string;
};

/**
 * 将 DB 存储的 themeMode 字符串收敛为合法枚举，非法值回落默认。
 */
const normalizeThemeMode = (value: string): ThemeMode =>
    value === 'dark' || value === 'light' || value === 'system'
        ? value
        : DEFAULT_USER_CONFIG.themeMode;

/**
 * DB 行 → 前端 DTO。
 */
const toDto = (row: UserConfigRow): UserConfigDTO => ({
    playDuration: row.playDurationMinutes,
    voiceId: row.voiceId,
    speed: row.speed,
    floatingPlayerEnabled: row.floatingPlayerEnabled,
    themeMode: normalizeThemeMode(row.themeMode),
});

/**
 * 构造建行所需的 data，seed 缺省字段回落系统默认。
 * @param userId 关联用户 ID。
 * @param source seed 或 patch（取其中已提供的字段）。
 */
const buildCreateData = (userId: number, source?: UserConfigSeed) => ({
    userId,
    playDurationMinutes: source?.playDuration ?? DEFAULT_USER_CONFIG.playDuration,
    voiceId: source?.voiceId ?? DEFAULT_USER_CONFIG.voiceId,
    speed: source?.speed ?? DEFAULT_USER_CONFIG.speed,
    floatingPlayerEnabled:
        source?.floatingPlayerEnabled ?? DEFAULT_USER_CONFIG.floatingPlayerEnabled,
    themeMode: source?.themeMode ?? DEFAULT_USER_CONFIG.themeMode,
});

/**
 * 获取当前用户配置；行不存在时用 seed 建行（首次绑定迁移），之后服务端为准。
 * @param userId 用户 ID。
 * @param seed 仅在行不存在时消费的本地初始配置。
 */
export const getOrCreateUserConfig = async (
    userId: number,
    seed?: UserConfigSeed,
): Promise<UserConfigDTO> => {
    const existing = await prisma.userConfig.findUnique({ where: { userId } });
    if (existing) {
        return toDto(existing);
    }
    const created = await prisma.userConfig.create({ data: buildCreateData(userId, seed) });
    return toDto(created);
};

/**
 * 增量更新用户配置（upsert，last-write-wins）。仅写入 patch 中已提供的字段。
 * @param userId 用户 ID。
 * @param patch 增量字段。
 */
export const updateUserConfig = async (
    userId: number,
    patch: UserConfigPatch,
): Promise<UserConfigDTO> => {
    const updateData: Record<string, unknown> = {};
    if (patch.playDuration !== undefined) updateData.playDurationMinutes = patch.playDuration;
    if (patch.voiceId !== undefined) updateData.voiceId = patch.voiceId;
    if (patch.speed !== undefined) updateData.speed = patch.speed;
    if (patch.floatingPlayerEnabled !== undefined) {
        updateData.floatingPlayerEnabled = patch.floatingPlayerEnabled;
    }
    if (patch.themeMode !== undefined) updateData.themeMode = patch.themeMode;

    const row = await prisma.userConfig.upsert({
        where: { userId },
        create: buildCreateData(userId, patch),
        update: updateData,
    });
    return toDto(row);
};
```

- [ ] **Step 2: 验证检查点**

Run: `yarn tsc --noEmit`
Expected: 无类型错误（prisma `userConfig` 委托存在、`toDto` 入参匹配返回行）。

---

## Task 3: tRPC Router — getMine/updateMine + get 重定位

**Files:**
- Modify: `lib/trpc/routers/config.ts`（整文件替换）

- [ ] **Step 1: 重写 config router**

```ts
/**
 * 配置 Router
 *
 * - get：系统级配置（音色白名单 + 系统默认音色），public。
 * - getMine/updateMine：当前登录用户的个性化配置，authed。
 */

import { z } from 'zod';

import { router, publicProcedure, authedProcedure } from '../init';
import { getTtsConfig } from '@/lib/server/openai';
import { userConfigPatchSchema, userConfigSeedSchema } from '../schemas/config';
import { getOrCreateUserConfig, updateUserConfig } from '@/lib/server/userConfig';

export const configRouter = router({
    /**
     * 获取系统级配置：音色白名单与系统默认音色（与用户无关，来自 env）。
     */
    get: publicProcedure.mutation(() => {
        const { voicesList, voiceId } = getTtsConfig();
        return { voicesList, voiceId };
    }),

    /**
     * 获取当前登录用户的配置；行不存在时用 seed 建行（首次绑定迁移）。
     */
    getMine: authedProcedure
        .input(z.object({ seed: userConfigSeedSchema.optional() }).optional())
        .query(async ({ ctx, input }) => {
            return getOrCreateUserConfig(ctx.session.userId, input?.seed);
        }),

    /**
     * 增量更新当前登录用户的配置。
     */
    updateMine: authedProcedure
        .input(userConfigPatchSchema)
        .mutation(async ({ ctx, input }) => {
            return updateUserConfig(ctx.session.userId, input);
        }),
});
```

> 说明：`get` 不再返回 `playDuration/floatingPlayerEnabled`（这些用户偏好默认改由 `DEFAULT_USER_CONFIG` / Prisma `@default` 提供）。`authedProcedure` 已把 `ctx.session` 收窄为非空，故 `ctx.session.userId` 类型安全。

- [ ] **Step 2: 验证检查点**

Run: `yarn tsc --noEmit && yarn build`
Expected: 构建通过。（此步会暴露下游对 `config.get` 旧返回字段的依赖——`appConfig.ts`/`configStore` 将在 Task 4/5 修复；若 build 因这些下游报错，先记录，按顺序做完 Task 4/5 再整体 build。）

---

## Task 4: 客户端封装 — userConfig 调用 + appConfig 适配

**Files:**
- Create: `lib/client/userConfig.ts`
- Modify: `lib/client/appConfig.ts`
- Modify: `types/appConfig.ts`

- [ ] **Step 1: 新建用户配置客户端**

```ts
/**
 * 用户配置客户端
 *
 * 使用 tRPC 读写当前登录用户的个性化配置。
 */

import { trpc } from '@/lib/trpc/client';
import type { UserConfigPatch, UserConfigSeed } from '@/lib/trpc/schemas/config';

/** 用户配置 DTO 响应类型（由服务端推导）。 */
export type MyConfigResponse = Awaited<ReturnType<typeof fetchMyConfig>>;

/**
 * 获取当前用户配置；可携带本地 seed 供首次建行迁移使用。
 */
export const fetchMyConfig = async (seed?: UserConfigSeed) => {
    return trpc.config.getMine.query(seed ? { seed } : undefined);
};

/**
 * 保存当前用户配置（增量）。
 */
export const saveMyConfig = async (patch: UserConfigPatch) => {
    return trpc.config.updateMine.mutate(patch);
};
```

- [ ] **Step 2: 适配 appConfig 客户端类型**

`lib/client/appConfig.ts` 的 `fetchAppConfig` 实现不变（仍 `trpc.config.get.mutate()`），但其返回类型现在只含 `voicesList/voiceId`。无需改代码，类型自动收窄。确认文件无显式引用被删字段即可。

- [ ] **Step 3: 更新 appConfig 类型定义**

修改 `types/appConfig.ts`：给 `APIConfig` 增加 `themeMode`，并把 `AppConfigResponse` 收敛为系统级形状。

```ts
import type { VoiceOption, VoiceId } from '@/types/ttsGenerate';
import type { ThemeMode } from '@/types/theme';

/**
 * 应用配置默认值定义（客户端持有的完整偏好）。
 */
export type AppConfigDefaults = {
  playDuration: number;
  voiceId: VoiceId;
  speed: number;
  floatingPlayerEnabled: boolean;
  themeMode: ThemeMode;
};

/**
 * 系统级配置接口（config.get）响应结构：仅音色白名单与系统默认音色。
 */
export type AppConfigResponse = {
  voicesList: VoiceOption[];
  voiceId: VoiceId;
};

/**
 * 客户端使用的应用配置结构。
 */
export type APIConfig = AppConfigDefaults;
```

- [ ] **Step 4: 验证检查点**

Run: `yarn tsc --noEmit`
Expected: `configStore.ts` 可能因 `APIConfig` 新增 `themeMode` 与 `loadRemoteConfig` 读取被删字段报错——这是预期的，Task 5 修复。

---

## Task 5: configStore 改造（核心）

**Files:**
- Modify: `stores/configStore.ts`

> 改造点：① `APIConfig` 现含 `themeMode`，更新 `createEmptyConfig/isValidConfig/mergeConfig`；② `loadRemoteConfig` 改为只取 `voicesList`，其余默认取 `DEFAULT_USER_CONFIG`；③ 新增登录态字段 `syncEnabled` 与防抖回写；④ 新增 `initForUser()` 与 `reset()`。

- [ ] **Step 1: 顶部新增 import 与默认引用**

在文件顶部 import 区追加：

```ts
import type { ThemeMode } from '@/types/theme';
import { DEFAULT_USER_CONFIG } from '@/lib/trpc/schemas/config';
import { fetchMyConfig, saveMyConfig } from '@/lib/client/userConfig';
import type { UserConfigPatch } from '@/lib/trpc/schemas/config';
```

- [ ] **Step 2: `APIConfig` 默认值与校验纳入 themeMode**

将 `createEmptyConfig` 改为含 themeMode：

```ts
const createEmptyConfig = (): APIConfig => ({
  playDuration: 0,
  voiceId: '',
  speed: 1,
  floatingPlayerEnabled: true,
  themeMode: DEFAULT_USER_CONFIG.themeMode,
});
```

在 `isValidConfig` 末尾（`return true` 之前）追加 themeMode 校验：

```ts
  if (
    config.themeMode !== 'dark' &&
    config.themeMode !== 'light' &&
    config.themeMode !== 'system'
  ) {
    return false;
  }
```

在 `mergeConfig` 的返回对象中纳入 themeMode：

```ts
  const themeMode: ThemeMode =
    partial.themeMode === 'dark' ||
    partial.themeMode === 'light' ||
    partial.themeMode === 'system'
      ? partial.themeMode
      : base.themeMode;

  return {
    playDuration: nextPlayDuration,
    voiceId,
    speed,
    floatingPlayerEnabled,
    themeMode,
  };
```

> **旧本地配置兼容（关键）：** 升级前 localStorage 的 `config-store` 不含 `themeMode`，若直接用收紧后的 `isValidConfig` 会判为非法 → 老用户首次登录 seed 为空 → 配置丢失（违反验收 #4）。需在校验前**回填默认 themeMode**。

修改 `persist` 的 `migrate`（bump `version` 至 1）回填 themeMode：

```ts
const persistedConfigStore = persist(configStoreCreator, {
  name: CONFIG_STORAGE_KEY,
  version: 1,
  storage: createJSONStorage(getSafeLocalStorage),
  partialize: (state) => ({
    apiConfig: state.apiConfig,
  }),
  migrate: (persistedState: unknown) => {
    const raw = (persistedState as Partial<ConfigStore> | undefined)?.apiConfig;
    // 回填缺失的 themeMode（旧版本无此字段时用默认；已有则保留）
    const config = raw
      ? { themeMode: DEFAULT_USER_CONFIG.themeMode, ...raw }
      : undefined;
    if (isValidConfig(config)) {
      return { apiConfig: config };
    }
    return { apiConfig: createEmptyConfig() };
  },
  skipHydration: true,
});
```

- [ ] **Step 3: `loadRemoteConfig` 改为只依赖 voicesList**

将 `loadRemoteConfig` 中 `remote.playDuration`、`remote.floatingPlayerEnabled` 的读取替换为 `DEFAULT_USER_CONFIG` 兜底（`remote` 现在只有 `voicesList/voiceId`）：

```ts
  const loadRemoteConfig = async (
    localConfig: APIConfig | undefined
  ): Promise<{ config: APIConfig; voiceOptions: VoiceOption[] }> => {
    try {
      const remote = await fetchAppConfig();
      const voiceOptions = Array.isArray(remote.voicesList) ? remote.voicesList : [];
      const hasVoice = (voice?: string) =>
        !!voice && voiceOptions.some(option => option.value === voice);

      const playDuration =
        localConfig && localConfig.playDuration > 0
          ? localConfig.playDuration
          : DEFAULT_USER_CONFIG.playDuration;

      let resolvedVoice: string | undefined;
      if (localConfig && hasVoice(localConfig.voiceId)) {
        resolvedVoice = localConfig.voiceId;
      } else if (hasVoice(remote.voiceId)) {
        resolvedVoice = remote.voiceId;
      }
      if (!resolvedVoice) {
        throw new Error('INVALID_VOICE');
      }

      const mergedConfig: APIConfig = {
        playDuration,
        voiceId: resolvedVoice,
        speed: localConfig?.speed ?? DEFAULT_USER_CONFIG.speed,
        floatingPlayerEnabled:
          localConfig?.floatingPlayerEnabled ?? DEFAULT_USER_CONFIG.floatingPlayerEnabled,
        themeMode: localConfig?.themeMode ?? DEFAULT_USER_CONFIG.themeMode,
      };

      return { config: mergedConfig, voiceOptions };
    } catch (error) {
      throw new Error(
        error instanceof Error ? error.message : 'FAILED_TO_FETCH_REMOTE_CONFIG'
      );
    }
  };
```

- [ ] **Step 4: 新增 syncEnabled 状态、防抖回写、initForUser、reset**

在 `ConfigStoreBaseState` 增加字段：

```ts
type ConfigStoreBaseState = {
  apiConfig: APIConfig;
  isLoaded: boolean;
  voiceOptions: VoiceOption[];
  /** 是否处于登录态（开启服务端回写）。 */
  syncEnabled: boolean;
};
```

在 `ConfigStoreActions` 增加：

```ts
  /** 登录后：拉取服务端配置（本地作 seed），开启回写。 */
  initForUser: () => Promise<void>;
  /** 登出：重置为默认并清本地缓存，关闭回写。 */
  reset: () => void;
```

在 `configStoreCreator` 内、`return` 之前，加入防抖回写与 seed 构造工具：

```ts
  /** 防抖回写定时器与待写 patch 累积。 */
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingPatch: UserConfigPatch = {};

  /** 将完整配置映射为可作为 seed/patch 的形状。 */
  const toPatch = (config: APIConfig): UserConfigPatch => ({
    playDuration: config.playDuration,
    voiceId: config.voiceId,
    speed: config.speed,
    floatingPlayerEnabled: config.floatingPlayerEnabled,
    themeMode: config.themeMode,
  });

  /** 防抖 500ms 将累积 patch 回写服务端，失败保留乐观值并提示。 */
  const scheduleSave = (patch: UserConfigPatch) => {
    pendingPatch = { ...pendingPatch, ...patch };
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const toSend = pendingPatch;
      pendingPatch = {};
      saveTimer = null;
      saveMyConfig(toSend).catch((error) => {
        console.warn('[configStore] saveMyConfig failed', error);
        GlassToast.show({ icon: 'fail', content: '配置同步失败，稍后重试' });
      });
    }, 500);
  };
```

> import `GlassToast`：文件顶部追加 `import GlassToast from '@/components/ui/GlassToast';`（与 UserSection 同款 toast）。

将 `update` 改为在登录态下触发回写：

```ts
    update: (partial) => {
      const current = get().apiConfig;
      const nextConfig = mergeConfig(current, partial);
      set({ apiConfig: nextConfig });
      if (get().syncEnabled) {
        scheduleSave(toPatch(nextConfig));
      }
    },
```

在 `return` 的对象里，`apiConfig/isLoaded/voiceOptions` 后增加 `syncEnabled: false`，并新增两个 action：

```ts
    initForUser: async () => {
      // 1) 取本地配置作为 seed（仅服务端无行时被消费）
      const localConfig = await hydrateLocalConfig();
      const seed = localConfig ? toPatch(localConfig) : undefined;
      // 2) 并行拉取系统级音色与个人配置
      const [remote, mine] = await Promise.all([
        fetchAppConfig(),
        fetchMyConfig(seed),
      ]);
      const voiceOptions = Array.isArray(remote.voicesList) ? remote.voicesList : [];
      const hasVoice = (voice?: string) =>
        !!voice && voiceOptions.some(option => option.value === voice);
      // 3) 解析音色：服务端值优先，回落系统默认 / 列表首项
      const resolvedVoice = hasVoice(mine.voiceId)
        ? mine.voiceId
        : hasVoice(remote.voiceId)
          ? remote.voiceId
          : voiceOptions[0]?.value ?? '';

      set({
        apiConfig: {
          playDuration: mine.playDuration,
          voiceId: resolvedVoice,
          speed: mine.speed,
          floatingPlayerEnabled: mine.floatingPlayerEnabled,
          themeMode: mine.themeMode,
        },
        voiceOptions,
        isLoaded: true,
        syncEnabled: true,
      });
    },
    reset: () => {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      pendingPatch = {};
      try {
        getSafeLocalStorage().removeItem(CONFIG_STORAGE_KEY);
      } catch {
        // ignore
      }
      set({
        apiConfig: createEmptyConfig(),
        voiceOptions: [],
        isLoaded: false,
        syncEnabled: false,
      });
    },
```

> `initForUser` 的失败处理：调用方（ConfigInitializer）已对 init 链 `.catch` 兜底；失败时 `isLoaded` 保持 false，会退回 loading 态。`reset()` 中 `getSafeLocalStorage().removeItem` 复用 `utils/storage`（已 import）。

- [ ] **Step 5: 验证检查点**

Run: `yarn lint && yarn tsc --noEmit`
Expected: 通过。`partialize` 仅持久化 `apiConfig`，themeMode 随之进入本地缓存（无需改 persist 配置）。

---

## Task 6: ConfigInitializer 升级为认证感知编排器

**Files:**
- Modify: `components/ConfigInitializer/index.tsx`（整文件替换）

> 编排逻辑：先确保 `authStore.fetchProfile` 完成 → 已登录走 `initForUser()`，否则走本地 `initialize()`。**只编排，不在 store 内耦合 authStore。**

- [ ] **Step 1: 重写 ConfigInitializer**

```tsx
'use client';

import React, { PropsWithChildren, useEffect } from 'react';
import { useConfigStore } from '@/stores/configStore';
import { useAuthStore } from '@/stores/authStore';
import { PageLoading } from '@/components/PageLoading';

/**
 * 配置编排组件：先解析登录态，再按登录态选择配置初始化路径。
 * - 已登录：initForUser（服务端为准 + 本地 seed 迁移 + 开启回写）
 * - 未登录/访客：initialize（纯本地 + 系统级音色）
 */
export const ConfigInitializer: React.FC<PropsWithChildren> = ({ children }) => {
  const initializeLocal = useConfigStore(state => state.initialize);
  const initForUser = useConfigStore(state => state.initForUser);
  const isConfigLoaded = useConfigStore(state => state.isLoaded);

  const authInitialized = useAuthStore(state => state.initialized);
  const isLogin = useAuthStore(state => state.isLogin);
  const fetchProfile = useAuthStore(state => state.fetchProfile);

  // 1) 确保登录态已解析
  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  // 2) 登录态确定后，按身份选择初始化路径（仅当配置未加载时）
  useEffect(() => {
    if (!authInitialized || isConfigLoaded) {
      return;
    }
    const run = isLogin ? initForUser : initializeLocal;
    run().catch(() => {});
  }, [authInitialized, isConfigLoaded, isLogin, initForUser, initializeLocal]);

  if (!authInitialized || !isConfigLoaded) {
    return <PageLoading message="配置加载中..." />;
  }

  return <>{children}</>;
};

export default ConfigInitializer;
```

- [ ] **Step 2: 验证检查点（构建 + 浏览器）**

Run: `yarn tsc --noEmit && yarn build`，然后用 preview 工具启动 dev：
- 未登录/访客访问 `/setting`：配置加载、可改设置（纯本地）。
- 登录用户访问 `/setting`：配置来自服务端；改设置后用 preview_network 确认触发 `config.updateMine` 请求（防抖后单次）。
Expected: 无 console 报错；网络面板可见 getMine/updateMine 调用。

---

## Task 7: 主题与配置双向绑定（ThemeConfigBridge）

**Files:**
- Create: `components/ThemeConfigBridge/index.tsx`
- Modify: `app/(main)/layout.tsx`（挂载 bridge）

> 仅登录态生效：server themeMode → ThemeProvider；用户改主题 → configStore（触发防抖回写）。等值守卫避免回环。访客/未登录时 bridge 惰性，ThemeProvider 维持自有 localStorage 行为。

- [ ] **Step 1: 新建 bridge 组件**

```tsx
'use client';

import { useEffect, useRef } from 'react';
import { useTheme } from '@/components/ThemeProvider';
import { useConfigStore } from '@/stores/configStore';

/**
 * 主题 ↔ 配置 双向绑定（仅登录态）。
 * - Effect A：配置中的 themeMode 变化 → 同步给 ThemeProvider。
 * - Effect B：ThemeProvider 的 themeMode 变化 → 写回配置（防抖回写至服务端）。
 * 两个 Effect 均以"值不同"为触发条件，达成一致后停止，避免回环。
 */
const ThemeConfigBridge: React.FC = () => {
  const { themeMode, setThemeMode } = useTheme();
  const syncEnabled = useConfigStore(state => state.syncEnabled);
  const configThemeMode = useConfigStore(state => state.apiConfig.themeMode);
  const updateConfig = useConfigStore(state => state.update);

  // Effect A：配置 → 主题
  useEffect(() => {
    if (!syncEnabled) return;
    if (configThemeMode !== themeMode) {
      setThemeMode(configThemeMode);
    }
  }, [syncEnabled, configThemeMode, themeMode, setThemeMode]);

  // Effect B：主题 → 配置（跳过 Effect A 刚同步过来的首帧）
  const lastConfigThemeRef = useRef(configThemeMode);
  useEffect(() => {
    lastConfigThemeRef.current = configThemeMode;
  }, [configThemeMode]);

  useEffect(() => {
    if (!syncEnabled) return;
    if (themeMode !== lastConfigThemeRef.current) {
      updateConfig({ themeMode });
    }
  }, [syncEnabled, themeMode, updateConfig]);

  return null;
};

export default ThemeConfigBridge;
```

- [ ] **Step 2: 在 (main) 布局挂载 bridge**

修改 `app/(main)/layout.tsx`，在 `ConfigInitializer` 内部挂载 `ThemeConfigBridge`：

```tsx
import ConfigInitializer from '@/components/ConfigInitializer';
import ThemeConfigBridge from '@/components/ThemeConfigBridge';
// ...
  return (
    <ConfigInitializer>
      <ThemeConfigBridge />
      <div className={styles.app}>
        <main className={styles.content}>
          {children}
        </main>
        <MainTabBar />
      </div>
      <AudioControllerHost />
      <FloatingPlayer />
    </ConfigInitializer>
  );
```

- [ ] **Step 3: 验证检查点（浏览器）**

用 preview 工具：登录用户在 `/setting` 切换主题 → 页面主题即时变化；preview_network 确认 `updateMine` 携带 `themeMode`；reload 后主题保持。访客切换主题不报错、不触发 updateMine。
Expected: 主题随账号、回写正常、无回环（无连续重复 updateMine）。

---

## Task 8: 登出清理 + 全量回归 + 统一提交

**Files:**
- Modify: `app/(main)/setting/components/UserSection/index.tsx`

- [ ] **Step 1: 登出成功后重置配置**

在 `UserSection` 的 `handleLogout` 中，`doLogout()` 成功后、跳转前调用 `configStore.reset()`。顶部 import：

```tsx
import { useConfigStore } from '@/stores/configStore';
```

组件内取 reset：

```tsx
  const resetConfig = useConfigStore(state => state.reset);
```

修改 `handleLogout`：

```tsx
  const handleLogout = useCallback(async () => {
    const success = await doLogout();
    if (success) {
      resetConfig();
      GlassToast.show({ icon: 'success', content: '已登出' });
      router.push('/auth');
    } else {
      GlassToast.show({ icon: 'fail', content: useAuthStore.getState().error || '登出失败' });
    }
  }, [doLogout, resetConfig, router]);
```

- [ ] **Step 2: 全量验证**

Run: `yarn lint && yarn tsc --noEmit && yarn build`
Expected: 三项全过。

- [ ] **Step 3: 验收场景走查（浏览器）**

对照 spec 验收标准逐条走查：
1. 登录用户改配置 → 刷新/换设备模拟（清 localStorage 后重登）配置仍在（来自服务端）。
2. 用户 A 登录改配置 → 登出 → 用户 B 登录 → 看不到 A 的配置（无串号）。
3. 访客调设置后注册 → 新账号保留该设置（seed 生效）。
4. 防抖：连续拖动滑块只发少量 updateMine。
5. 访客/未登录全程不触发 protected 接口。

- [ ] **Step 4: 统一提交（仅在用户确认后执行）**

> 用户要求整体完成后再提交。确认后：

```bash
git add -A
git commit -m "feat: 应用配置随账号云端同步（UserConfig + 登录态编排）"
```

提交信息体内说明：动机（账号体系接管用户配置）、核心变更（getMine/updateMine + configStore 编排 + 主题同步）、影响（config.get 收敛为系统级）、验证（lint/tsc/build + 浏览器走查）。结尾加：
`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

## 自检：Spec 覆盖核对

| Spec 要求 | 对应任务 |
|-----------|---------|
| 服务端为准 + 乐观本地缓存 | Task 5（update 乐观 + 防抖回写）、Task 6（initForUser） |
| 首次行不存在时本地 seed 初始化 | Task 2（getOrCreateUserConfig）、Task 5（seed 构造） |
| 登出/切换重置为默认 + 清本地 | Task 5（reset）、Task 8（登出钩入） |
| 主题纳入同步 | Task 1/2/5（themeMode 贯穿）、Task 7（bridge） |
| 防抖 ~500ms 回写 | Task 5（scheduleSave） |
| upsert last-write-wins | Task 2（updateUserConfig.upsert） |
| 首次激活 authedProcedure | Task 3（getMine/updateMine） |
| config.get 重定位为系统级 | Task 3、Task 4（类型收敛） |
| 跨域基建（编排/清理/seed） | Task 6（编排）、Task 8（清理）、Task 2（seed） |
| 验收标准 1-6 | Task 8 Step 3 走查 |

---

## 实施记录（as-built 偏差）

执行中相对原计划的两处调整，均已落地并通过浏览器验证：

1. **新增 Task 5b：补 `UserConfig` 数据库迁移。** 计划假设"schema 已有 `UserConfig` 故不动 DB"，但实际本地 `dev.db` 与生产从未为该模型建表（无对应迁移）。已新增迁移 `prisma/migrations/20260620025724_add_user_config`（纯新增建表 + `userId` 唯一索引 + FK 级联），应用到本地 dev.db，并随仓库供 prod `migrate deploy`。

2. **Task 7 主题集成方案调整为「单向水合 + 设置页显式回写」。** 原计划的双 `useEffect` 双向 diff 方案在浏览器验证中暴露竞态：`ConfigInitializer` 把子树（含 bridge）挡在加载门之后，bridge 挂载时 `syncEnabled` 已为 true，错过 false→true 跳变；且 React StrictMode 对 effect 的双调用会在 `setThemeMode` 尚未传播时把 ThemeProvider 的旧值误判为用户改动回写到服务端，违反服务端权威。改为：
   - `ThemeConfigBridge` 只做**单向**「服务端 themeMode → ThemeProvider」一次性水合（`hydratedRef` 守卫，登出复位）。
   - 用户改主题由**设置页** `handleThemeModeChange` 显式 `setThemeMode + updateConfig({themeMode})`（全项目唯一的主题改动入口，已确认）。
   - 该方案无 effect 内双向 diff，天然规避上述竞态与 StrictMode 双调用问题。

验收走查结论（登录 verifyA / verifyB 双账号实测）：服务端登录下发为准（server=light → 覆盖本地 dark，无回写）；用户改主题→`updateMine` 回写；登出 `reset` 回默认；新账号 verifyB 仅见默认（themeMode=system），**不残留** verifyA 的 dark——账号隔离成立。
```
