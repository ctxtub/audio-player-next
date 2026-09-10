# 产品覆盖矩阵（9 旅程 × case 分布）

> 推导来源：`tests/test-catalog.yaml` 由 `scripts/check-test-catalog.mjs` 校验。
> 基线 run-id：`20260909T105219Z-fea26406`。本页不手维护总数，数字与 catalog 不一致时以 checker 为准。
> 主防线唯一（每个风险场景恰有一个 Primary defense）；辅助防线可为空或多个。
> 必守 oracle 引用方案 `docs/plans/TEST-ARCHITECTURE-REBUILD-BASELINE.md` 第 6 节“产品旅程与唯一主防线”表。
> 旧编号仅供回查，主身份为语义 `case_id` + 中文名。

图例：`P` = 优先级；`L` = 主防线；`LC` = 生命周期（ACTIVE 已实现 / PLANNED 语义已定代码未到 / MANUAL 人工 / LEGACY-NON-COVERAGE 不计覆盖）。

## 旅程总览（9）

| 旅程 `journey_id` | case 数 | 主防线分布 | 必守 oracle（方案第 6 节） |
| --- | ---: | --- | --- |
| `smoke-baseline`（冒烟基线） | 9 | L3×6、L2×1、L1×2 | 访客冷启动（L3）：路由正确、初始化门消失、audio paused、匿名 API 边界；首故事自动播放（L3）：播放的是 delivered story，三处镜像同源 |
| `interactive-race`（交互竞态） | 10 | L3×5、L2×4、L1×1 | 首次创作与流式反馈（L2 主）：单次提交、delta 顺序、状态终态、历史副作用；浏览器专属断言以 L3 为主 |
| `playback-kernel`（播放内核） | 12 | L2×9、L1×2、L3×1 | 多段连续聆听（L2）：TTS 文本与段落一致、前瞻=1、进度单调、完播清理；暂停恢复与跨路由（L3）：用户暂停不被慢 TTS/ended 覆盖，同一 audio 连续；预算耗尽（L3）：ended 错峰，0 预算所有入口拒绝且真实停声 |
| `cloud-storage`（云端存储） | 5 | L2×4、L1×1 | 跨会话保存恢复（L2）：DB source 一致、真 pagehide/close 送达、无悬空进度（浏览器送达另交 L3） |
| `persistence-recovery`（持久化恢复） | 6 | L2×3、L1×2、L3×1 | 跨会话保存恢复（L2）同上；设置与个性化（L2）：防抖合并、乱序回滚、刷新一致、试音状态 |
| `auth-session`（认证会话） | 10 | L3×6、L2×4 | 注册登录登出迁移（L2）：注册迁移、登录零迁移、cookie/reset、pause 先于卸载 |
| `error-rate-limit`（异常限流） | 8 | L3×6、L2×1、L1×1 | 异常恢复与安全（L2）：触达次数、failed 过滤、无僵尸态、重试无重复副作用 |
| `history-reuse-create`（历史再利用创作） | 1 | L3×1 | 从提示词历史开始新创作（L3 主 + L2 辅）：新 Agent 上下文不含旧会话、新建干净当前会话、旧创作保留在历史可返回、新故事自动起播 |
| `history-reuse-playback`（历史再利用回放） | 1 | L3×1 | 生成历史本页单次回放（L3 主 + L2 辅）：回放匹配来源、单次不续写新历史、真实起播 |

## 1. `smoke-baseline`（9）

| 语义 case_id | 中文名 | P / 主防线 / LC | 场景 spec |
| --- | --- | --- | --- |
| `guest-cold-start-first-screen`（旧 E2E-01-01） | 访客冷启动首屏渲染 | P0 / L3 / PLANNED | [场景](../e2e/01-基础冒烟与页面基线/01-访客冷启动首屏渲染.md) |
| `guest-identity-cookie-upgrade`（旧 E2E-01-02） | 访客身份创建与凭证升级续签 | P1 / L2 / ACTIVE | [场景](../e2e/01-基础冒烟与页面基线/02-访客身份创建与cookie升级续签.md) |
| `first-story-stream-autoplay`（旧 E2E-01-03） | 首个故事生成流式渲染与自动播放 | P1 / L3 / PLANNED | [场景](../e2e/01-基础冒烟与页面基线/03-首个故事生成流式渲染与自动播放.md) |
| `triple-playback-mirror-consistent`（旧 E2E-01-04） | 三处播放镜像状态一致 | P1 / L3 / PLANNED | [场景](../e2e/01-基础冒烟与页面基线/04-三处播放镜像状态一致性.md) |
| `config-init-gate-retry`（旧 E2E-01-05） | 配置初始化门控与错误屏重试 | P1 / L3 / PLANNED | [场景](../e2e/01-基础冒烟与页面基线/05-配置初始化门控与错误屏重试.md) |
| `anon-guest-route-guard-open-redirect`（旧 E2E-01-06-01） | 匿名与访客路由守卫及开放重定向安全 | P1 / L1 / ACTIVE | [场景](../e2e/01-基础冒烟与页面基线/06-路由守卫与重定向安全.md#e2e-01-06-01) |
| `authed-reverse-guard-from-backjump`（旧 E2E-01-06-02） | 已登录反向守卫与来源回跳 | P1 / L1 / ACTIVE | [场景](../e2e/01-基础冒烟与页面基线/06-路由守卫与重定向安全.md#e2e-01-06-02) |
| `hard-refresh-loses-playback`（旧 E2E-01-07） | 硬刷新丢失播放 | P2 / L3 / PLANNED | [场景](../e2e/01-基础冒烟与页面基线/07-硬刷新丢失播放.md) |
| `mobile-viewport-float-overlap`（旧 E2E-01-08） | 移动端视口浮窗遮挡与开关 | P2 / L3 / PLANNED | [场景](../e2e/01-基础冒烟与页面基线/08-移动端视口浮窗遮挡.md) |

## 2. `interactive-race`（10）

| 语义 case_id | 中文名 | P / 主防线 / LC | 场景 spec |
| --- | --- | --- | --- |
| `rapid-double-submit-guard`（旧 E2E-02-01、H-04） | 连续快速双发防重 | P0 / L2 / ACTIVE | [场景](../e2e/02-交互并发与竞态防御/01-快速双发防重.md) |
| `streaming-resubmit-mutex`（旧 E2E-02-02、H-02） | 流式生成中再次提交互斥 | P0 / L2 / ACTIVE | [场景](../e2e/02-交互并发与竞态防御/02-流式生成中再次提交互斥.md) |
| `preload-continue-no-chat-pollution`（旧 E2E-02-03、H-03） | 预载续写不污染聊天流 | P0 / L1 / ACTIVE | [场景](../e2e/02-交互并发与竞态防御/03-预载续写不污染聊天流.md) |
| `clear-during-generate-no-orphan-audio`（旧 E2E-02-04、H-05） | 生成中清空防止孤儿播放 | P0 / L2 / BLOCKED | [场景](../e2e/02-交互并发与竞态防御/04-生成中清空防止孤儿播放.md) |
| `story-card-double-tap-suppress`（旧 E2E-02-05、H-20） | 故事卡连击双发抑制 | P1 / L3 / PLANNED | [场景](../e2e/02-交互并发与竞态防御/05-故事卡连击双发抑制.md) |
| `suggest-click-blocked-while-sending`（旧 E2E-02-06） | 发送中建议项点击拦截 | P1 / L3 / PLANNED | [场景](../e2e/02-交互并发与竞态防御/06-发送中建议项点击拦截.md) |
| `draft-preserved-during-auto-continue`（旧 E2E-02-07、H-03） | 自动续写期间输入框草稿保留 | P2 / L3 / PLANNED | [场景](../e2e/02-交互并发与竞态防御/07-自动续写期间输入框草稿保留.md) |
| `tab-switch-unread-badge-consistent`（旧 E2E-02-08） | 生成中切标签页未读徽标一致 | P1 / L3 / PLANNED | [场景](../e2e/02-交互并发与竞态防御/08-生成中切标签页未读徽标一致性.md) |
| `pause-resume-burst-final-consistent`（旧 E2E-02-09、H-01） | 暂停恢复快速连击终态一致 | P1 / L3 / PLANNED | [场景](../e2e/02-交互并发与竞态防御/09-暂停恢复快速连击状态终态一致.md) |
| `failed-message-retry-context`（旧 E2E-02-10） | 失败消息重试上下文正确 | P2 / L2 / PLANNED | [场景](../e2e/02-交互并发与竞态防御/10-失败消息重试上下文正确性.md) |

## 3. `playback-kernel`（12）

| 语义 case_id | 中文名 | P / 主防线 / LC | 场景 spec |
| --- | --- | --- | --- |
| `countdown-exhaust-ui-audio-consistent`（旧 E2E-03-01、H-01） | 倒计时耗尽界面与音频一致 | P0 / L2 / ACTIVE | [场景](../e2e/03-播放状态与内核一致性/01-倒计时耗尽UI与音频一致性.md) |
| `budget-exhausted-tap-play-audio-state`（旧 E2E-03-02、H-08） | 预算耗尽后点击播放音频状态 | P0 / L1 / ACTIVE | [场景](../e2e/03-播放状态与内核一致性/02-预算耗尽后点击播放音频状态.md) |
| `logout-during-play-instant-silence`（旧 E2E-03-03、H-06） | 播放中登出立即停声与重置 | P0 / L2 / ACTIVE | [场景](../e2e/03-播放状态与内核一致性/03-播放中登出立即停声与状态重置.md) |
| `pause-in-paragraph-switch-no-resume`（旧 E2E-03-04、H-07） | 段落切换窗口内暂停不续播 | P0 / L2 / ACTIVE | [场景](../e2e/03-播放状态与内核一致性/04-段落切换窗口内暂停不续播.md) |
| `breakpoint-resume-null-budget-state`（旧 E2E-03-05、H-10） | 断点恢复空预算播放状态 | P0 / L2 / ACTIVE | [场景](../e2e/03-播放状态与内核一致性/05-断点恢复null预算播放状态.md) |
| `segment-end-double-jump-guard`（旧 E2E-03-06、H-12） | 段落收尾结束双跳竞态防线 | P2 / L1 / ACTIVE | [场景](../e2e/03-播放状态与内核一致性/06-段落收尾ended双跳竞态防线.md) |
| `multi-paragraph-prefetch-progress-persist`（旧 E2E-03-07） | 多段落前瞻预取推进与进度落库 | P1 / L2 / PLANNED | [场景](../e2e/03-播放状态与内核一致性/07-多段落前瞻预取推进与进度落库.md) |
| `story-complete-clear-progress`（旧 E2E-03-08） | 故事播完清理进度收尾 | P1 / L2 / ACTIVE | [场景](../e2e/03-播放状态与内核一致性/08-故事播完clearProgress收尾.md) |
| `client-route-nav-play-continuity`（旧 E2E-03-09） | 客户端路由导航播放连续 | P1 / L2 / PLANNED | [场景](../e2e/03-播放状态与内核一致性/09-客户端路由导航播放连续性.md) |
| `history-restore-card-resynth`（旧 E2E-03-10、H-11） | 历史恢复卡回放重合成 | P1 / L2 / ACTIVE | [场景](../e2e/03-播放状态与内核一致性/10-历史恢复卡回放重合成.md) |
| `old-card-replay-no-consume-preload`（旧 E2E-03-11、H-09） | 旧卡回放不消费新预载 | P2 / L2 / ACTIVE | [场景](../e2e/03-播放状态与内核一致性/11-旧卡回放不消费新预载.md) |
| `setting-preview-dual-audio-source`（旧 E2E-03-12、H-13） | 设置页试音与主播放双声源 | P2 / L3 / PLANNED | [场景](../e2e/03-播放状态与内核一致性/12-设置页试音与主播放并发双声源.md) |

## 4. `cloud-storage`（5）

| 语义 case_id | 中文名 | P / 主防线 / LC | 场景 spec |
| --- | --- | --- | --- |
| `dual-tab-same-account-write-cover`（旧 E2E-04-01、H-15） | 双标签同账号并发写入覆盖 | P1 / L2 / ACTIVE | [场景](../e2e/04-云端存储与多端数据调和/01-双标签同账号并发写入覆盖.md) |
| `quick-exit-loses-tail-hanging-progress`（旧 E2E-04-02、H-16） | 快速退出丢失尾部与悬空进度 | P0 / L2 / ACTIVE | [场景](../e2e/04-云端存储与多端数据调和/02-快速退出丢失尾部与悬空进度.md) |
| `config-optimistic-save-rollback`（旧 E2E-04-03、H-14） | 配置乐观保存失败回滚 | P1 / L1 / ACTIVE | [场景](../e2e/04-云端存储与多端数据调和/03-配置乐观保存失败回滚.md) |
| `guest-user-table-isolation-zero-leak`（旧 E2E-04-05） | 访客与用户表级隔离零串读 | P1 / L2 / ACTIVE | [场景](../e2e/04-云端存储与多端数据调和/05-访客与用户表级隔离与零串读.md) |
| `summary-summarize-concurrent-public`（旧 E2E-04-10） | 摘要并发与公开端点 | P1 / L2 / ACTIVE | [场景](../e2e/04-云端存储与多端数据调和/10-摘要summarize并发与公开端点.md) |

## 5. `persistence-recovery`（6）

| 语义 case_id | 中文名 | P / 主防线 / LC | 场景 spec |
| --- | --- | --- | --- |
| `tts-voice-fallback-browser-behavior`（旧 E2E-02-12） | 语音回退浏览器行为占位 | P2 / L3 / PLANNED | [场景](../e2e/06-异常处理与接口限流/02-TTS限流分层与语音白名单回退.md) |
| `progress-monotonic-guard-force-reset`（旧 E2E-04-04） | 进度单调递增守卫与强制重置 | P1 / L1 / ACTIVE | [场景](../e2e/04-云端存储与多端数据调和/04-进度单调递增守卫与forceReset.md) |
| `history-epoch-guard-30day-prune`（旧 E2E-04-06） | 历史纪元守卫与30天裁剪 | P2 / L2 / PLANNED | [场景](../e2e/04-云端存储与多端数据调和/06-历史记录epoch守卫与30天裁剪.md) |
| `onboarding-first-visit-unread-cross-session`（旧 E2E-04-07） | 首访标记与未读跨会话一致 | P2 / L1 / ACTIVE | [场景](../e2e/04-云端存储与多端数据调和/07-onboarding首访标记与未读跨会话.md) |
| `theme-config-once-hydrate-dual-write`（旧 E2E-04-08） | 主题配置一次性水合并双写保留 | P2 / L2 / ACTIVE | [场景](../e2e/04-云端存储与多端数据调和/08-主题配置一次性水合与双写保留.md) |
| `guest-chat-100-limit-truncate`（旧 E2E-04-09） | 访客聊天100条上限截断 | P2 / L2 / ACTIVE | [场景](../e2e/04-云端存储与多端数据调和/09-访客聊天100条上限截断.md) |

> 说明：`tts-voice-fallback-browser-behavior` 的 `spec_path` 已修正为 `06-异常处理与接口限流/02-TTS限流分层与语音白名单回退.md`（与 `tts-limit-tier-voice-fallback` 同文件不同裁面：本例裁浏览器行为，彼例裁 API 契约，两 case 并存非重复）。

## 6. `auth-session`（10）

| 语义 case_id | 中文名 | P / 主防线 / LC | 场景 spec |
| --- | --- | --- | --- |
| `guest-register-3step-migrate-fidelity`（旧 E2E-05-01） | 访客注册三步迁移与数据保真 | P0 / L3 / PLANNED | [场景](../e2e/05-认证授权与会话生命周期/01-访客注册三步迁移与数据保真.md) |
| `register-interrupt-orphan-rollback`（旧 E2E-05-02） | 注册中断孤儿用户事务回滚 | P2 / L2 / ACTIVE | [场景](../e2e/05-认证授权与会话生命周期/02-注册中断孤儿用户事务回滚.md) |
| `login-existing-no-leak`（旧 E2E-05-03） | 登录既有账号无数据渗漏 | P0 / L3 / PLANNED | [场景](../e2e/05-认证授权与会话生命周期/03-登录既有账号无数据渗漏.md) |
| `logout-dual-cookie-clean-reset`（旧 E2E-05-04） | 登出双凭证清理与状态重置 | P0 / L2 / BLOCKED | [场景](../e2e/05-认证授权与会话生命周期/04-登出双cookie清理与状态重置.md) |
| `relogin-new-guest-isolation`（旧 E2E-05-05、H-19） | 登出后再入访客新身份隔离 | P2 / L3 / PLANNED | [场景](../e2e/05-认证授权与会话生命周期/05-登出后再入访客新身份隔离.md) |
| `session-invalidated-closed-loop`（旧 E2E-05-06） | 会话失效闭环 | P1 / L3 / PLANNED | [场景](../e2e/05-认证授权与会话生命周期/06-会话失效sessionInvalidated闭环.md) |
| `expired-session-guest-cookie-revive`（旧 E2E-05-07、H-18） | 过期会话加残留访客凭证静默复活 | P1 / L3 / PLANNED | [场景](../e2e/05-认证授权与会话生命周期/07-过期会话加残留访客cookie静默复活.md) |
| `auth-reverse-guard-from-safety`（旧 E2E-05-08） | 登录页反向守卫与来源回跳安全 | P2 / L3 / PLANNED | [场景](../e2e/05-认证授权与会话生命周期/08-auth反向守卫与from回跳安全.md) |
| `fast-account-switch-epoch-no-crossread`（旧 E2E-05-09） | 快速账号切换纪元失效不串读 | P1 / L2 / PLANNED | [场景](../e2e/05-认证授权与会话生命周期/09-快速账号切换epoch失效不串读.md) |
| `register-login-validate-sessionguard-exempt`（旧 E2E-05-10） | 注册登录校验失败与守卫豁免 | P1 / L2 / ACTIVE | [场景](../e2e/05-认证授权与会话生命周期/10-校验失败与sessionGuard豁免.md) |

## 7. `error-rate-limit`（8）

| 语义 case_id | 中文名 | P / 主防线 / LC | 场景 spec |
| --- | --- | --- | --- |
| `guest-429-limit-retry-burn-quota`（旧 E2E-06-01、H-17） | 访客限流与重试烧配额 | P0 / L1 / ACTIVE | [场景](../e2e/06-异常处理与接口限流/01-访客429限流与重试烧配额.md) |
| `tts-limit-tier-voice-fallback`（旧 E2E-06-02） | 语音合成限流分层与白名单回退 | P2 / L3 / PLANNED | [场景](../e2e/06-异常处理与接口限流/02-TTS限流分层与语音白名单回退.md) |
| `tts-synthesize-fail-no-zombie`（旧 E2E-06-03） | 语音合成失败停声不僵尸 | P1 / L3 / PLANNED | [场景](../e2e/06-异常处理与接口限流/03-TTS合成失败停声不僵尸.md) |
| `stream-interrupt-failed-retry`（旧 E2E-06-04） | 流式中断失败标记与重试 | P1 / L3 / PLANNED | [场景](../e2e/06-异常处理与接口限流/04-流式生成中断failed标记与重试.md) |
| `breakpoint-switch-tts-fail-retry-bound`（旧 E2E-06-05） | 断点与切换语音失败重试边界 | P2 / L3 / PLANNED | [场景](../e2e/06-异常处理与接口限流/05-断点与切换TTS失败重试边界.md) |
| `protected-api-401-guard-matrix`（旧 E2E-06-06） | 直连受保护接口401守卫矩阵 | P1 / L2 / ACTIVE | [场景](../e2e/06-异常处理与接口限流/06-直连受保护API之401守卫矩阵.md) |
| `guest-data-30day-gc-clean`（旧 E2E-06-07） | 访客数据30天清理 | P2 / L3 / PLANNED | [场景](../e2e/06-异常处理与接口限流/07-访客数据30天GC清理.md) |
| `bfcache-pageshow-recover-probe`（旧 E2E-06-08） | 往返缓存恢复探针 | P3 / L3 / MANUAL | [场景](../e2e/06-异常处理与接口限流/08-bfcache与pageshow恢复探针.md) |

## 8. `history-reuse-create`（1）

| 语义 case_id | 中文名 | P / 主防线 / LC | 场景 spec |
| --- | --- | --- | --- |
| `history-prompt-start-new-creation`（旧 E2E-02-11-01、H-21） | 从提示词历史开始新创作 | P0 / L3 / ACTIVE | [场景](../e2e/02-交互并发与竞态防御/11-播放器选历史切换当前创作.md#e2e-02-11-01) |

## 9. `history-reuse-playback`（1）

| 语义 case_id | 中文名 | P / 主防线 / LC | 场景 spec |
| --- | --- | --- | --- |
| `generation-history-play-once`（旧 E2E-02-11-02、H-21） | 生成历史本页单次回放 | P0 / L3 / ACTIVE | [场景](../e2e/02-交互并发与竞态防御/11-播放器选历史切换当前创作.md#e2e-02-11-02) |

## 覆盖阅读说明

- 本矩阵只证明“绑定存在”，不证明“行为通过”；行为通过以 runner 结构化断言 + 原始证据为准。
- `LEGACY-NON-COVERAGE` 已清零（checker 清零门强制，残留即 exit 1）。
- `MANUAL` 共 1 项（`bfcache-pageshow-recover-probe`）不进自动化调度，需人工探索并留证据。
- `PLANNED` 共 29 项：其中 27 项无 executable 为预期缺口（产品语义已确定、代码尚不存在，
  不得为通过而降级）；2 项（`config-init-gate-retry`、`stream-interrupt-failed-retry`）仅有部分
  静态/单元证据，仍计缺口。
- `BLOCKED` 共 2 项，均为 P0 高声缺口（`clear-during-generate-no-orphan-audio`、
  `logout-dual-cookie-clean-reset`），候选门阻断，解法见 catalog `blocked_reason`。
- 每条 assertion 显式绑定负责的 executable；L2 不得替 L3 证明关闭页面送达、实际音频或 DOM。
