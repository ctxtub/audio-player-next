# 账号同步 init/reset 竞态守卫 实施计划

> **For agentic workers:** 配套 spec：[docs/specs/2026-06-21-account-sync-epoch-guard.md](../specs/2026-06-21-account-sync-epoch-guard.md)。步骤用 `- [ ]` 勾选跟踪。

**Goal:** 给四块账号同步 store 加每-store 账号代次（epoch）守卫，修复在途 `initForUser` 被 `reset` 打断后回写旧账号数据（项 4）与 chat 首登窗口内发消息被冲掉（项 3）两个竞态。

**Architecture:** 每个 store creator 内加闭包计数器 `accountEpoch`，`reset()` 自增并清 `userInitPromise`；`initForUser` 进入时捕获代次，终态 `set` 与 finally 清理均按代次校验。chat 额外把窗口内本地新增消息经纯函数 `mergeConversation` 并回服务端历史之后。

**Tech Stack:** TypeScript + Zustand（`StateCreator` 闭包），无 test runner（验证靠 lint/tsc/build + 一次性纯函数算法核对 + 手动窗口复现）。

**测试现实说明：** 仓库无单元测试框架，且本任务明确不引入（YAGNI）。因此每个 store 任务以「`yarn tsc --noEmit` 通过 + 读码核对守卫位置」为验证；`mergeConversation` 用一次性 `node` 脚本核对算法后删除；末尾跑三道门 + 手测，再单次原子提交（四块改动相互依赖，部分提交会留下守卫覆盖不一致的中间态，故不逐块提交）。

---

### Task 1: generationHistoryStore —— epoch 守卫 + reset 卫生（最简、无合并，作样板）

**Files:**
- Modify: `stores/generationHistoryStore.ts:45`（加 `accountEpoch` 闭包）、`:51-69`（`initForUser` 守卫）、`:102-104`（`reset`）

- [ ] **Step 1: 在闭包区加代次计数器**

把第 45 行：
```ts
  let userInitPromise: Promise<void> | null = null;
```
改为：
```ts
  let userInitPromise: Promise<void> | null = null;
  /** 账号代次：reset 自增，作废在途 initForUser 的回写（防跨账号数据回流）。 */
  let accountEpoch = 0;
```

- [ ] **Step 2: `initForUser` 捕获并校验代次**

把现有 `initForUser` 实现：
```ts
    initForUser: () => {
      if (get().syncEnabled) {
        return Promise.resolve();
      }
      if (userInitPromise) {
        return userInitPromise;
      }
      userInitPromise = (async () => {
        const records = await fetchMyGenerations();
        set({ records, syncEnabled: true });
      })()
        .catch((error) => {
          console.warn('[generationHistoryStore] initForUser failed', error);
        })
        .finally(() => {
          userInitPromise = null;
        });
      return userInitPromise;
    },
```
改为：
```ts
    initForUser: () => {
      if (get().syncEnabled) {
        return Promise.resolve();
      }
      if (userInitPromise) {
        return userInitPromise;
      }
      const epoch = accountEpoch; // 捕获进入代次
      userInitPromise = (async () => {
        const records = await fetchMyGenerations();
        if (epoch !== accountEpoch) {
          return; // 期间 reset 过 → 放弃回写，勿落旧账号数据 / 勿重开同步
        }
        set({ records, syncEnabled: true });
      })()
        .catch((error) => {
          console.warn('[generationHistoryStore] initForUser failed', error);
        })
        .finally(() => {
          if (epoch === accountEpoch) {
            userInitPromise = null; // 仅本代次才清句柄，勿清掉新登录起的请求
          }
        });
      return userInitPromise;
    },
```

- [ ] **Step 3: `reset` 自增代次并清在途句柄**

把：
```ts
    reset: () => {
      set({ records: [], syncEnabled: false });
    },
```
改为：
```ts
    reset: () => {
      accountEpoch++; // 作废在途 initForUser 的回写
      userInitPromise = null; // 让重新登录能起新请求（与 configStore 一致）
      set({ records: [], syncEnabled: false });
    },
```

- [ ] **Step 4: 类型门校验**

Run: `yarn tsc --noEmit`
Expected: PASS（无新增类型错误）

---

### Task 2: promptHistoryStore —— 同样板套用

**Files:**
- Modify: `stores/promptHistoryStore.ts:124`、`:235-266`、`:267-276`

- [ ] **Step 1: 加代次计数器**

把第 124 行：
```ts
  let userInitPromise: Promise<void> | null = null;
```
改为：
```ts
  let userInitPromise: Promise<void> | null = null;
  /** 账号代次：reset 自增，作废在途 initForUser 的回写。 */
  let accountEpoch = 0;
```

- [ ] **Step 2: `initForUser` 守卫**

在 `initForUser` 内，去重判断之后插入 `const epoch = accountEpoch;`，并把终态 set 与 finally 改为代次校验。结果为：
```ts
    initForUser: () => {
      // 已按服务端加载则跳过；并发调用复用同一拉取
      if (get().syncEnabled) {
        return Promise.resolve();
      }
      if (userInitPromise) {
        return userInitPromise;
      }
      const epoch = accountEpoch; // 捕获进入代次
      userInitPromise = (async () => {
        const list = await fetchMyPromptHistory();
        const recordsMap: Record<string, HistoryRecord> = {};
        list.forEach((item) => {
          const prompt = normalizePrompt(item.prompt);
          if (!prompt) {
            return;
          }
          recordsMap[prompt] = {
            prompt,
            lastUsed: item.lastUsed,
            useCount: item.useCount,
          };
        });
        if (epoch !== accountEpoch) {
          return; // 期间 reset 过 → 放弃回写
        }
        set({ recordsMap, syncEnabled: true, initialized: true });
      })()
        .catch((error) => {
          console.warn('[promptHistoryStore] initForUser failed', error);
        })
        .finally(() => {
          if (epoch === accountEpoch) {
            userInitPromise = null;
          }
        });
      return userInitPromise;
    },
```

- [ ] **Step 3: `reset` 校正**

把：
```ts
    reset: () => {
      if (isBrowserEnvironment()) {
        try {
          getSafeLocalStorage().removeItem(PROMPT_HISTORY_STORAGE_KEY);
        } catch {
          // ignore storage 清理失败
        }
      }
      set({ recordsMap: {}, syncEnabled: false, initialized: false });
    },
```
改为：
```ts
    reset: () => {
      accountEpoch++; // 作废在途 initForUser 的回写
      userInitPromise = null; // 让重新登录能起新请求
      if (isBrowserEnvironment()) {
        try {
          getSafeLocalStorage().removeItem(PROMPT_HISTORY_STORAGE_KEY);
        } catch {
          // ignore storage 清理失败
        }
      }
      set({ recordsMap: {}, syncEnabled: false, initialized: false });
    },
```

- [ ] **Step 4: 类型门校验**

Run: `yarn tsc --noEmit`
Expected: PASS

---

### Task 3: configStore —— 仅加代次守卫（reset 已清 userInitPromise）

**Files:**
- Modify: `stores/configStore.ts:173`、`:313-356`、`:357-378`

**注意：** configStore 的 `initForUser` finally **无 `.catch`**（拒绝会透传给调用方，属既有行为，勿改）；`reset()` 已含 `userInitPromise = null` 与 `initializationPromise = null`（5f77ba9），本任务**只**新增 `accountEpoch`。

- [ ] **Step 1: 加代次计数器**

把第 173 行：
```ts
  let userInitPromise: Promise<void> | null = null;
```
改为：
```ts
  let userInitPromise: Promise<void> | null = null;
  /** 账号代次：reset 自增，作废在途 initForUser 的回写。 */
  let accountEpoch = 0;
```

- [ ] **Step 2: `initForUser` 守卫**

在去重判断之后加 `const epoch = accountEpoch;`，终态 set 前加代次校验，finally 改代次守卫。结果为：
```ts
    initForUser: () => {
      // 已按服务端加载则跳过；并发调用复用同一拉取（与其余三块契约一致）
      if (get().syncEnabled) {
        return Promise.resolve();
      }
      if (userInitPromise) {
        return userInitPromise;
      }
      const epoch = accountEpoch; // 捕获进入代次
      userInitPromise = (async () => {
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

        if (epoch !== accountEpoch) {
          return; // 期间 reset 过 → 放弃回写
        }
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
      })().finally(() => {
        if (epoch === accountEpoch) {
          userInitPromise = null;
        }
      });
      return userInitPromise;
    },
```

- [ ] **Step 3: `reset` 仅加自增（保留既有清理）**

把 `reset()` 开头：
```ts
    reset: () => {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      pendingPatch = {};
```
改为：
```ts
    reset: () => {
      accountEpoch++; // 作废在途 initForUser 的回写
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      pendingPatch = {};
```
（其后既有的 `initializationPromise = null; userInitPromise = null;` 保持不变。）

- [ ] **Step 4: 类型门校验**

Run: `yarn tsc --noEmit`
Expected: PASS

---

### Task 4: chatStore —— epoch 守卫 + reset 卫生 + mergeConversation 合并（项 3）

**Files:**
- Modify: `stores/chatStore.ts:138`（代次闭包）、模块作用域新增 `mergeConversation` 纯函数、`:499-527`（`initForUser`）、`:528-539`（`reset`）

- [ ] **Step 1: 加代次计数器**

把第 138 行：
```ts
  let userInitPromise: Promise<void> | null = null;
```
改为：
```ts
  let userInitPromise: Promise<void> | null = null;
  /** 账号代次：reset 自增，作废在途 initForUser 的回写。 */
  let accountEpoch = 0;
```

- [ ] **Step 2: 新增 `mergeConversation` 纯函数**

在 `chatStoreCreator` 定义之前（模块作用域，约第 133 行 `const chatStoreCreator` 上方）插入：
```ts
/**
 * 合并会话：服务端历史在前，本地窗口内新增按 id 去重续后。
 * 用于 initForUser 终态——既恢复账号历史，又不冲掉 await 窗口内刚发的消息（项 3）。
 * @param server 服务端恢复的消息（基准顺序）。
 * @param local await 窗口内本地新增、需保留的消息。
 * @returns 合并后的有序消息列表。
 */
const mergeConversation = (
  server: ChatMessage[],
  local: ChatMessage[],
): ChatMessage[] => {
  const serverIds = new Set(server.map((message) => message.id));
  const appended = local.filter((message) => !serverIds.has(message.id));
  return [...server, ...appended];
};
```

- [ ] **Step 3: `initForUser` 守卫 + 合并**

把现有 `initForUser`：
```ts
  initForUser: () => {
    if (get().syncEnabled) {
      return Promise.resolve();
    }
    if (userInitPromise) {
      return userInitPromise;
    }
    userInitPromise = (async () => {
      const dtos = await fetchMyConversation();
      const messages: ChatMessage[] = dtos.map((dto) => ({
        id: dto.messageId,
        role: dto.role as ChatMessageRole,
        content: dto.content,
        parts: dto.parts as MessagePart[] | undefined,
        status: 'delivered',
        createdAt: dto.createdAt,
        metadata: dto.agentType ? { agentType: dto.agentType as AgentType } : undefined,
      }));
      // 直接 set，不触发 scheduleSave，避免把恢复结果回写
      set({ messages, syncEnabled: true });
    })()
      .catch((error) => {
        console.warn('[chatStore] initForUser failed', error);
      })
      .finally(() => {
        userInitPromise = null;
      });
    return userInitPromise;
  },
```
改为：
```ts
  initForUser: () => {
    if (get().syncEnabled) {
      return Promise.resolve();
    }
    if (userInitPromise) {
      return userInitPromise;
    }
    const epoch = accountEpoch; // 捕获进入代次
    const baselineIds = new Set(get().messages.map((message) => message.id)); // 进入时已有（访客/旧态）
    userInitPromise = (async () => {
      const dtos = await fetchMyConversation();
      if (epoch !== accountEpoch) {
        return; // 账号已切（登出/401）→ 放弃回写（项 4）
      }
      const serverMessages: ChatMessage[] = dtos.map((dto) => ({
        id: dto.messageId,
        role: dto.role as ChatMessageRole,
        content: dto.content,
        parts: dto.parts as MessagePart[] | undefined,
        status: 'delivered',
        createdAt: dto.createdAt,
        metadata: dto.agentType ? { agentType: dto.agentType as AgentType } : undefined,
      }));
      // await 窗口内本地新增（非 baseline）的消息，需在恢复后保留（项 3）
      const appendedLocally = get().messages.filter(
        (message) => !baselineIds.has(message.id),
      );
      // 直接 set，不触发 scheduleSave，避免把恢复结果回写
      set({ messages: mergeConversation(serverMessages, appendedLocally), syncEnabled: true });
    })()
      .catch((error) => {
        console.warn('[chatStore] initForUser failed', error);
      })
      .finally(() => {
        if (epoch === accountEpoch) {
          userInitPromise = null;
        }
      });
    return userInitPromise;
  },
```

- [ ] **Step 4: `reset` 校正**

把现有 `reset`：
```ts
  reset: () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    set({
      messages: [],
      inputValue: '',
      hasUnviewedResponse: false,
      syncEnabled: false,
    });
  },
```
改为：
```ts
  reset: () => {
    accountEpoch++; // 作废在途 initForUser 的回写
    userInitPromise = null; // 让重新登录能起新请求
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    set({
      messages: [],
      inputValue: '',
      hasUnviewedResponse: false,
      syncEnabled: false,
    });
  },
```

- [ ] **Step 5: 类型门校验**

Run: `yarn tsc --noEmit`
Expected: PASS

---

### Task 5: 核对 `mergeConversation` 算法（一次性脚本，验后删除）

**Files:**
- Create（临时）: `scripts/_verify-merge.mjs`

- [ ] **Step 1: 写一次性算法核对脚本**

```js
// 复刻 mergeConversation 算法（纯 JS），核对 spec 的 4 个示例后删除本文件
const mergeConversation = (server, local) => {
  const serverIds = new Set(server.map((m) => m.id));
  const appended = local.filter((m) => !serverIds.has(m.id));
  return [...server, ...appended];
};
const ids = (xs) => xs.map((x) => x.id).join(',');
const M = (...names) => names.map((id) => ({ id }));
const cases = [
  [M('a', 'b'), M(),        'a,b'],
  [M('a', 'b'), M('c'),     'a,b,c'],
  [M('a', 'b'), M('b', 'c'),'a,b,c'],
  [M(),         M('c'),     'c'],
];
let ok = true;
for (const [s, l, want] of cases) {
  const got = ids(mergeConversation(s, l));
  const pass = got === want;
  ok = ok && pass;
  console.log(`${pass ? 'PASS' : 'FAIL'}  server[${ids(s)}] local[${ids(l)}] => ${got} (want ${want})`);
}
process.exit(ok ? 0 : 1);
```

- [ ] **Step 2: 运行核对**

Run: `node scripts/_verify-merge.mjs`
Expected: 4 行全 `PASS`，退出码 0

- [ ] **Step 3: 删除临时脚本**

Run: `rm scripts/_verify-merge.mjs`

---

### Task 6: 三道门 + 手测窗口复现 + 单次原子提交

- [ ] **Step 1: 三道门**

Run: `yarn lint && yarn tsc --noEmit && yarn build`
Expected: 全部 PASS

- [ ] **Step 2: 手测项 4（在途被打断不回写）**

在某块（如 generationHistory）`initForUser` 的 `await fetchMyGenerations()` 后临时加 `await new Promise((r) => setTimeout(r, 2000));`，`yarn dev` 登录触发拉取，2 秒窗口内登出。
Expected: 控制台无旧账号数据回写；该 store `syncEnabled` 未被重新置 `true`（可 `useGenerationHistoryStore.getState()` 观察）。验后移除临时延迟。

- [ ] **Step 3: 手测项 3（首登窗口内发消息保留）**

在 chat `initForUser` 的 `await fetchMyConversation()` 后临时加 2 秒延迟，登录后立即在聊天框发一条消息。
Expected：2 秒后服务端历史恢复，且刚发的消息仍在列表末尾（未被冲掉）。验后移除临时延迟。

- [ ] **Step 4: 单次原子提交**

```bash
git add stores/configStore.ts stores/promptHistoryStore.ts stores/generationHistoryStore.ts stores/chatStore.ts docs/specs/2026-06-21-account-sync-epoch-guard.md docs/plans/2026-06-21-account-sync-epoch-guard.md
git commit -m "$(cat <<'EOF'
fix: epoch 守卫修复账号同步 init/reset 竞态（项 3/项 4）

四块账号同步 store 的 initForUser 在 await 窗口内若发生 reset，
旧 promise 仍会回写上一账号数据并重开 syncEnabled（项 4，401 易触发）。
加每-store 账号代次 accountEpoch：reset 自增并清 userInitPromise，
initForUser 捕获代次、终态 set 与 finally 清理按代次校验。
chat 额外用纯函数 mergeConversation 把 await 窗口内本地新增消息
并回服务端历史之后，避免首登整体 replace 冲掉刚发的消息（项 3）。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## 自审

**Spec 覆盖：** 项 4（Task 1-4 的 epoch 守卫）✓；项 3（Task 4 的 mergeConversation + baseline）✓；reset 卫生（Task 1/2/4 的 `userInitPromise=null`，config Task 3 已有）✓；仅 chat 合并的边界（Task 3 注明 config 不合并）✓；验收 1-5（Task 5/6）✓。

**占位符扫描：** 无 TBD/TODO；每个代码步给出完整前后文。

**类型一致：** `accountEpoch`/`userInitPromise`/`mergeConversation(server, local)` 命名四处一致；`mergeConversation` 入参与 chat 调用处（`serverMessages, appendedLocally`）类型均为 `ChatMessage[]`。

---

## 验证结果（as-built · 2026-06-21）

**三道门全绿：**
- `yarn tsc --noEmit` — 通过，无类型错误。
- `yarn lint` — 通过；唯一告警在 `lib/agent/nodes/summary.ts`（`AIMessage` 未使用），与本次改动无关、属既有。
- `yarn build` — 通过，8 个路由全部产出。

**`mergeConversation` 算法核对：** 4/4 示例全 PASS（`node` 一次性核对，已删除临时脚本）。

**正常路径等价性（代码推理）：** 无打断时 `epoch === accountEpoch` 恒真，终态 `set` 与改前一致；chat 首登无窗口发消息时 `appendedLocally` 为空、`mergeConversation` 退化为旧的整体恢复。

**手测窗口复现（项 3/项 4）—— 未执行，原因如下：** dev 预览启动后发现首屏被 `AccountSyncProvider` 加载门卡在「配置加载中…」。排查（含将本次改动 `git stash` 后复现，确认与本改动无关）定位为**既有环境问题**：浏览器仍持有旧会话 cookie（用户 `ClaudeA`），而 dev.db 已被重置为干净态（仅 `test/test1`）；`config.getMine` 对不存在的用户执行 `prisma.userConfig.create()` 触发**外键约束冲突**，`config.initForUser`（无 `.catch`）拒绝 → `isLoaded` 永不为真 → 加载门锁死整屏。该问题纯属服务端 + 数据态，与本次纯客户端 store 改动无关；登录需输入密码（受安全约束不由助手代为执行），故未在 UI 内做活体竞态复现。

**遗留观察（超本任务范围）：** `config.getMine` 在「会话指向已删除用户」时抛 FK 错误，且 `config.initForUser` 无 `.catch`，会把整屏永久卡在加载门——这与账号同步正在收口的 401/会话失效健壮性同源，建议另起任务处理（服务端 `getOrCreate` 容错 + 客户端加载门兜底/重定向登录）。
