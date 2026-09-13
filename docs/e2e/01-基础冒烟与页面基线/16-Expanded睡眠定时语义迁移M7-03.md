# Expanded 睡眠定时语义迁移 P3C（M7-03）

功能域：01-基础冒烟与页面基线

## 用户目标

睡眠定时从“分钟数预算”迁移为三态语义（关闭 / N 分钟 / 本故事结束后）：新播放默认按个人偏好定时（默认 30 分钟，可关），在 Expanded 内可随时改本次定时（关闭 / 10 / 20 / 30 / 60 / 自定义 10–120 / 本故事结束后），暂停时不扣时间，到期自动暂停并可继续播放；旧版本留下的定时数据自动迁移为新语义，行为保持。

## 前置条件

- M5 Session/Transport/Flow ownership 冻结；M7-01 Surface、M7-02 P3A（timeline/倍速）冻结。
- 睡眠定时规则 SSOT：`lib/playback/sleepTimer.ts`（三态、10–120 范围、legacy 派生、到期归一）。
- 默认配置：`defaultSleepTimerEnabled=true + defaultSleepTimerMinutes=30`（旧 `playDurationMinutes=30` 行为保持）。

## 操作步骤

1. 建立 Work 播放会话并暂停驻留：断言新 Session 默认 Timer 为 minutes、剩余 30 分钟（默认配置启用）。
2. 点 Mini 元数据区打开 Expanded：断言定时 pill 显示“30:00 后暂停”，URL/session 不变。
3. 点 pill 打开菜单：断言选项齐全（关闭 / 10 / 20 / 30 / 60 分钟 / 自定义输入 / 本故事结束后）。
4. 按 Escape：断言只关闭菜单，Expanded 不关闭（内联菜单消费 Escape，不冒泡至 Dialog）。
5. 选“10 分钟”：断言 Session/Transport 同步为 minutes、剩余 600000，sessionId 不变，无新增 `beginSession` 与 `tts.synthesize`，pill 显示“10:00 后暂停”。
6. 自定义输入 45 并确定：断言剩余变为 45 分钟，session 不变。
7. 选“本故事结束后”：断言 mode 为 story_end、剩余为 null，session 不变，pill 显示“本故事结束后”。
8. 选“关闭”：断言 mode 为 off、剩余为 null；刷新页面后仍为 off（持久化）。
9. 从头播放（restart）：断言新 sessionId，且 Timer 回到默认 minutes/30 分钟（不继承旧 Session 的 off/story_end）。
10. 设置页“默认睡眠定时”：开关 + 10–120 分钟滑杆（step 10）；只改新播放默认值，不触当前 Session。

## 验收标准

- 三态 off/minutes/story_end；story_end 仅 Work 可用（Draft 不显示该选项、不接受该设置）。
- minutes 倒计时只在音频真实播放时扣减；暂停/合成中/网络等待/就绪均不扣；暂停 60 秒剩余不变。
- 到期：暂停音频元素 → mode=off、剩余/总额=null → UI 回暂停态 → 可继续播放（不得被旧 `remainingMs<=0` 守卫锁死）；并落检查点 + Toast。
- Work 完播（任何 Timer 模式）→ Timer 重置 off；Draft 完播同样重置。
- Session 切换不继承旧 Timer，一律按默认配置重算；story_end 永不作为默认值。
- 旧数据迁移：有剩余预算 → minutes；无 → off；旧 `playDurationMinutes=30` → 启用 + 30 分钟。
- 跨 Session 设置旧 sessionId → STALE_SESSION，不污染新 Session。
- 检查点携带 mode 则更新 Timer，缺省则保持现值（旧包不覆盖）；检查点去重键覆盖 Timer。
- UI 只经 flow/Transport 命令改 Timer，不直接写 Session/Config；Expanded 快捷只改当前 Session，不改 Settings 默认。
- 旧 `playDuration` 字段作为兼容别名保留一个周期；新旧同时出现且值冲突 → BAD_REQUEST。

## 边界与异常

- 自定义分钟数非法（<10/>120/非整数）时确定按钮禁用，不发请求。
- minutes 缺 minutes 参数 → BAD_REQUEST；非法 mode → fail-closed。
- 非法 Anchor 行（非法 mode/剩余为 0/off 配预算）→ 读取时修复并写回。
- 到期后重新 Play 正常继续；到期不建新 Session、不触发 TTS。
- 慢沙箱一律确定性轮询（`expect.poll`），无长 sleep；Chromium/WebKit 双跑，`retries=0`。

## 实现参考

- `lib/playback/sleepTimer.ts`
- `lib/server/playbackSession.ts`（`setSleepTimerForSubject`/begin/checkpoint/complete/repair）
- `lib/trpc/routers/playback.ts`（`setSleepTimer`）
- `stores/playbackStore.ts`（Transport countdown/到期，`setSleepTimerState`）
- `stores/playbackSessionStore.ts`（`setSleepTimer`/`handleSleepTimerExpired`）
- `app/services/playbackSessionFlow.ts`
- `components/NowPlaying/SleepTimerControl.tsx`
- `components/NowPlaying/useExpandedNowPlayingViewModel.ts`（`sleepTimer`）
- `components/NowPlaying/useExpandedPlaybackControls.ts`（`setSleepTimer`）
- `components/NowPlaying/ExpandedNowPlaying.tsx`
- `app/(main)/setting/components/DefaultSleepTimerSection.tsx`
- `prisma/migrations/20260914090000_m7_03_sleep_timer/migration.sql`
