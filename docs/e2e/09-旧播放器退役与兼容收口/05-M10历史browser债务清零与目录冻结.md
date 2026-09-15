# M10 历史 browser 债务清零与目录冻结（M10-05 收官）

功能域：09-旧播放器退役与兼容收口

> 本文件为 M10 收官冻结快照（2026-09-15）。M10-01~04 已逐条清零 M9-time `KNOWN BASELINE` 所指债务；
> 本文件宣告该豁免通道关闭。M9-04 文件（`04-死代码与终局守卫收口.md`）中的 `KNOWN BASELINE` /
> `NEW REGRESSION` 字样为 M9 收官时分工边界的历史快照，按“已发布历史文档不改写”原则保留原文，
> 其效力止于 M9；M10 CLOSED 起以本文件 + `maintenance.md` §6 为准。

## 用户目标

M10 收官：historical ACTIVE browser debt = 0，且以后不允许用 `KNOWN BASELINE` 永久豁免 ACTIVE browser case。
不做新功能，不改产品行为。

## 前置条件

- M10-01 CLOSED：`main-navigation-route-journey` / `main-chrome-mobile-docked` 已退役旧 `/player` oracle。
- M10-02 CLOSED：`generation-history-play-once` 已转正式 Work Session 语义。
- M10-03 CLOSED：`history-prompt-start-new-creation` 已转正式 Draft Session 语义。
- M10-04 CLOSED：`guest-cold-start-first-screen` TabBar 已对齐冻结 IA（创作 / 故事库 / 设置）。

## 操作步骤

1. Catalog 状态审计：确认 `ACTIVE` + `executable` 的 browser case 为完整 Chromium + WebKit 集合（31 L3 × 2 = 62），
   确认 catalog 全文无 `KNOWN BASELINE` 豁免标记，确认 deferred 项保持 `PLANNED` + `executable_ids=[]`。
2. 新增 M10 closure oracle（L1，`tests/unit/navigation/m10-browser-debt-closure.unit.test.ts`，7 组静态锁，
   登记 runner `m10-browser-debt-closure` + catalog `exec-m10-browser-debt-closure` + case `m10-browser-debt-closure`）。
3. 常设收口规则写入 `docs/testing/execution/maintenance.md` §6。
4. 原子提交（显式路径，先于两轮 full-browser），再取连续两轮 62/62 绿证据，不 push。

## 验收标准

- M10-01：`main-navigation-route-journey` 以 compat redirect 形态覆盖 `/player`（落到 `/library`，
  故事库 Tab 选中，旧 Player 地标零计数，单宿主），无 Legacy `/player` UI 落地期待。
- M10-02：`main-chrome-mobile-docked` 经 Mini 元数据区 `openExpanded()`（URL 不变、会话连续、Host 不重建），
  从未进入 `/player`，且不导航进入 `/player`。
- M10-03：cold-start 断言冻结 IA 三 Tab（创作 / 故事库 / 设置），全文件无「播放器」。
- M10-04：Generation History 回放为正式 Work Session（`source.kind='work'` + `workId`=点击项 + `finite` +
  真 Anchor work 身份 + Mini/Expanded 可达），可执行面无 `oneShot` / `isOneShot`。
- M10-05：History Prompt 重创为正式 Draft Session（`autoplayDraftStory` + `source.kind='draft'` + `finite` +
  非 idle + Mini 只派生自 Session），无 `oneShot` 语义。
- M10-06：`/player` 兼容仅白名单形态——产品侧：`app/(main)/player/page.tsx` 精确 `redirect('/library')` server 形态、
  `lib/navigation/mainNavigation.ts` alias→library、`middleware.ts` 兼容守卫；browser 侧仅
  `main-navigation-route-journey` / `player-compat-redirect` / `m9-player-retirement-closure` /
  `expanded-now-playing-surface` 四个 compat spec 可导航进入 `/player`。
- M10-07 目录冻结：catalog 无豁免标记；`story-card-double-tap-suppress` + TTS 相关四项保持 `PLANNED` + `[]`；
  runner `retries=0`；本 closure 自身 ACTIVE + L1 落盘。
- Full-browser：连续两轮完整 suite 62 passed / 0 failed（`retries=0`），静态门禁全绿，工作树干净。

## 边界与异常

- 不是历史大扫除：M9-time 快照（E2E `04-...md`、dated spec `2026-09-15-m9-f01-*.md`）中的豁免字样保留原文，
  仅宣告其效力终止，不改写。
- `PLANNED` 缺口（24 个，含 `triple-playback-mirror-consistent` 等旧 `/player` 全屏描述文档）为真正未实现场景，
  保持 `PLANNED` + `executable_ids=[]`，不在本项实现或改写（禁止为分母好看改状态）。
- `stream-interrupt-failed-retry`（PLANNED，绑定遗留 `exec-toast-terminal-priority-legacy`）为历史遗留绑定，
  checker 通过，本项不顺手重构，仅如实记录。
- `bfcache-pageshow-recover-probe` 为 `MANUAL` 环境探针，不进自动队列，不属产品 coverage。
- 任何一次 full-browser failure（含 PRODUCT_DEFECT / STALE_ORACLE / oracle flake / HARNESS_ENV）都打断两连绿，
  从完整 Run A 重新计数；targeted rerun 只用于分类取证，不得改写失败轮。

## 实现参考

- `tests/unit/navigation/m10-browser-debt-closure.unit.test.ts`（本项 L1 oracle，case `m10-browser-debt-closure`）
- `docs/specs/2026-09-15-m10-browser-debt-closure.md`（dated 冻结快照）
- `tests/test-catalog.yaml`（`exec-m10-browser-debt-closure` + case `m10-browser-debt-closure`）
- `scripts/run-tests.mjs`（`m10-browser-debt-closure` suite 登记）
- `docs/testing/execution/maintenance.md` §6（常设目录冻结规则）
