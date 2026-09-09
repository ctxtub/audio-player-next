# 风险语义 slug 索引

> 第一身份为语义 slug（英文 kebab-case），旧 `H-XX` 只作历史别名放在括号中。
> 别名可一对多（如 `H-01` 关联 2 个 case、`H-03` 关联 2 个 case、`H-21` 随拆分保留组别名语义）。
> 本索引由 `tests/test-catalog.yaml` 的 `legacy_aliases` + 场景假设登记推导，别名冲突时以 catalog 为准。
> 示例：`H-08 → playback-budget-exhausted-still-audible`（预算耗尽后仍可闻）。

## 使用规则

- 新风险必须起语义 slug，禁止新分配 `H-XX` 流水号。
- 旧报告回查用别名检索，本索引保证每个 `H-XX` 至少有一行可定位到语义 case。
- 风险别名不受 `case_id` 唯一约束：一个别名可映射多个 case（如 H-01、H-03）。
- 展示格式固定为 `中文名（旧编号 H-XX）`，汇报首列必须为语义名。

## 索引表（H-01..H-21）

| 语义 slug | 旧别名 | 中文风险描述 | 关联语义 case |
| --- | --- | --- | --- |
| `countdown-exhaust-ui-paused-audio-leaks` | H-01 | 倒计时耗尽 UI 置暂停而音频元素未暂停 | `countdown-exhaust-ui-audio-consistent`、`pause-resume-burst-final-consistent` |
| `overlapping-stream-clears-new-submit` | H-02 | 全局单 Abort 重叠流互斥，新提交消息被清 | `streaming-resubmit-mutex` |
| `preload-continuation-pollutes-chat-stream` | H-03 | 预载续写以用户消息身份污染聊天流并清空输入框 | `preload-continue-no-chat-pollution`、`draft-preserved-during-auto-continue` |
| `composer-async-lock-double-submit` | H-04 | 编辑器本地锁为异步状态，同帧连击双发 | `rapid-double-submit-guard` |
| `clear-during-generate-orphan-playback` | H-05 | 生成中清空后完成回调仍起播，产生孤儿播放 | `clear-during-generate-no-orphan-audio` |
| `logout-stop-sequence-still-audible` | H-06 | 登出停声时序错位，重置后仍有声 | `logout-during-play-instant-silence` |
| `paragraph-switch-pause-overridden` | H-07 | 段落切换窗口内暂停意图被续播覆盖 | `pause-in-paragraph-switch-no-resume` |
| `playback-budget-exhausted-still-audible` | H-08 | 预算耗尽后点击播放仍出声（0 与 null 未同等拒绝） | `budget-exhausted-tap-play-audio-state` |
| `stale-card-consumes-fresh-preload` | H-09 | 旧卡回放门控边界不清，消费新卡预载 | `old-card-replay-no-consume-preload` |
| `null-budget-rehydrate-audible-without-play-state` | H-10 | 空预算水合恢复，有声而 UI 未进入播放态 | `breakpoint-resume-null-budget-state` |
| `restored-card-replay-path-divergence` | H-11 | 恢复卡回放结束后，续写/复位路径分歧 | `history-restore-card-resynth` |
| `ended-double-jump-guard-dead` | H-12 | 结束双跳守卫置位后从未读取，守卫失效 | `segment-end-double-jump-guard` |
| `preview-independent-audio-dual-source` | H-13 | 试音独立音频与主播放双声源并存可感知 | `setting-preview-dual-audio-source` |
| `config-optimistic-save-no-rollback` | H-14 | 配置乐观保存失败不回滚，UI 与服务端长期分歧 | `config-optimistic-save-rollback` |
| `dual-tab-last-writer-wins-no-merge` | H-15 | 双标签同账号并发写，快照整体覆盖无合并 | `dual-tab-same-account-write-cover` |
| `quick-exit-tail-lost-hanging-progress` | H-16 | 防抖加发送跳过、无关闭前刷盘，快速退出丢尾并悬空进度 | `quick-exit-loses-tail-hanging-progress` |
| `guest-ratelimit-shared-failure-proliferation` | H-17 | 访客限流窗口内预载重试链与人工操作共同失败，失败标记增殖 | `guest-429-limit-retry-burn-quota` |
| `expired-session-guest-cookie-silent-revive` | H-18 | 过期会话加残留访客凭证并存，中间件静默放行为访客态 | `expired-session-guest-cookie-revive` |
| `logout-relogin-orphan-guest-isolation` | H-19 | 登出后再入每次新访客身份，旧访客行成孤儿且新身份完全隔离 | `relogin-new-guest-isolation` |
| `concurrent-start-story-reset-hang` | H-20 | 两次并发起播互相复位，首次会话状态悬挂 | `story-card-double-tap-suppress` |
| `history-prompt-context-isolation` | H-21 | 从提示词历史开始新创作时旧上下文串台（组别名，覆盖双行为） | `player-history-select-switch-creation` |

## 别名回查示例

- 查 `H-08`：定位 `playback-budget-exhausted-still-audible`，再到 case `budget-exhausted-tap-play-audio-state`（旧 E2E-03-02），场景见 `../e2e/03-播放状态与内核一致性/02-预算耗尽后点击播放音频状态.md`。
- 查 `H-01`：同一别名映射 2 个 case，需同时阅读 `countdown-exhaust-ui-audio-consistent` 与 `pause-resume-burst-final-consistent`，不得只看其一即下结论。
- 查 `H-03`：同一别名映射预载污染与草稿保留 2 个 case，分别验证聊天流纯净性与输入框草稿保留。

## 与 catalog 的对应关系

- 每个上表 `关联语义 case` 的 `legacy_aliases` 必含对应 `H-XX`；新增语义风险不再分配 `H-XX`。
- 风险 slug 本身不进 catalog 字段，catalog 用 `risk_tags`（如 `[playback, budget]`）做机器分组；本索引是人工回查视图。
- 若 catalog 别名与本表不一致，以 catalog 为准并同步修正本表（不得手改 catalog 数字）。
