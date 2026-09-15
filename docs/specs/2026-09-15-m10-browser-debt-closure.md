# M10 历史 browser 债务清零与目录冻结（M10-05，M10 收官）

- 日期：2026-09-15（dated spec，冻结快照；后续不得改写为当前事实）
- 前置：M10-01（main-navigation / mobile-docked 退役旧 `/player` oracle）→ M10-02（Generation History 转正式 Work Session）
  → M10-03（History Prompt 转正式 Draft Session）→ M10-04（cold-start TabBar 对齐冻结 IA 创作/故事库/设置）
- 本项性质：收官冻结，不做新功能，不改产品行为，不改 M5/M6/M7/M8/M9 冻结契约。

## 1. 目标（锁死两件事）

1. historical ACTIVE browser debt = 0：`ACTIVE` + `executable` 的 browser case 必须真实 PASS；
2. 收口规则：以后不允许用 `KNOWN BASELINE` 永久豁免 ACTIVE browser case（常设规则见
   `docs/testing/execution/maintenance.md` §6；本 spec 为事件快照）。

## 2. 范围（不做新功能）

- 本 dated spec（事件快照）+ E2E 收口文档
 （`docs/e2e/09-旧播放器退役与兼容收口/05-M10历史browser债务清零与目录冻结.md`）；
- test catalog 状态审计（§4）；
- closure static oracle（L1，`tests/unit/navigation/m10-browser-debt-closure.unit.test.ts`，§3）；
- browser runner / report contract 收口口径（§5）。

## 3. Closure oracle（M10 closure L1，静态锁）

| # | 冻结内容 | 锁位（spec） | 旧语义归零 | 冻结标记存在性 |
|---|---|---|---|---|
| M10-01 | `main-navigation-route-journey` 不再期待 Legacy `/player` UI | `main-navigation-route-journey.spec.ts` | 无正向 `toContain(/player)` / `toHaveURL(/player)` / `pathname=/player` 落地期待 | 落到 `/library` + 故事库 Tab 选中 + 旧 Player 地标（播放进度/播放速度/从头重播）零计数 + 单宿主 |
| M10-02 | `main-chrome-mobile-docked` 不再期待 Mini 导航 `/player` | `main-chrome-mobile-docked.spec.ts` | 无 `goto /player` / `waitForURL player` | `mini-metadata-button` → Expanded + URL 不变 + `not.toContain(/player)` |
| M10-03 | cold-start 不再断言旧主导航名「播放器」 | `guest-cold-start-first-screen.spec.ts` | 全文件无「播放器」 | 断言冻结 IA：创作 / 故事库 / 设置 |
| M10-04 | Generation History 不再把 replay 定义成 Transport-only oneShot | `generation-history-play-once.spec.ts` | 可执行面无 `oneShot` / `isOneShot` | `source.kind=work` + `finite` + 真 Anchor work 身份 + 否定 `replay-text-*` + Mini/Expanded 可达 |
| M10-05 | History Prompt autoplay 要求正式 Session / Mini | `history-prompt-start-new-creation.spec.ts` | 全文件无 `oneShot`，可执行面无 `isOneShot` | `autoplayDraftStory` + `source.kind=draft` + `finite` + 非 idle + Mini（只派生自 Session） |
| M10-06 | `/player` compatibility 仅允许既有白名单形态 | 产品三件套 + 4 个 compat spec | 非白名单 spec 不得导航进入 `/player` | `page.tsx=redirect('/library')` server 形态 + `mainNavigation` alias→library + `middleware` 守卫；browser 白名单=`main-navigation-route-journey` / `player-compat-redirect` / `m9-player-retirement-closure` / `expanded-now-playing-surface` |
| M10-07 | 目录冻结 | `tests/test-catalog.yaml` + `playwright.config.ts` + 自身绑定 | catalog 无 `KNOWN BASELINE` 豁免标记 | deferred（`story-card-double-tap-suppress` + 4 个 TTS 相关）保持 `PLANNED` + `executable_ids=[]`；runner `retries=0` 且无 skip/fixme；本 closure 自身 ACTIVE + L1 落盘 |

## 4. Catalog 审计结论（M10 CLOSED 时）

- `ACTIVE` + `executable` 的 browser case：31 个 L3 executable × chromium + webkit = 62，全量真实 PASS（`retries=0`）。
- 不存在 `ACTIVE` + 已知长期失败 + 文档写 `KNOWN BASELINE` 状态；catalog 全文无 `KNOWN BASELINE` 豁免标记。
- 真正未实现的场景保持 `PLANNED` + `executable_ids=[]`（24 个预期缺口，checker 逐项列出）。
- 未为分母好看改状态：`P3B` 继续 deferred（执行面 markers 归零由 M9-04-10 锁存）；`story-card-double-tap-suppress` /
  TTS 相关（`tts-voice-fallback-browser-behavior` / `tts-limit-tier-voice-fallback` / `tts-synthesize-fail-no-zombie` /
  `breakpoint-switch-tts-fail-retry-bound`）继续 `PLANNED`（由 M10-07 锁存）。
- 本项新增 1 个 catalog case（`m10-browser-debt-closure`，ACTIVE + L1 executable）：catalog 原子 case 数 107→108，
  已实现数 81→82；browser 分母不变（仍为 62/62，L1 不进 browser 分母）。

## 5. Browser runner / report contract 收口口径

- 调度唯一以 `tests/test-catalog.yaml` 的 `lifecycle_status` + `executable_ids` 为准；`MANUAL` 不进自动队列
 （`maintenance.md` §4；`verdicts.md` 五态终态机）。
- runner（`scripts/run-tests.mjs` + `tests/system/browser/playwright.config.ts`）与 report（`results.jsonl` 证据链）
  不设任何 `KNOWN BASELINE` / `NEW REGRESSION` 豁免通道：全仓唯一两处历史豁免字样均为 M9-time 快照
  （E2E `09-.../04-死代码与终局守卫收口.md` §操作步骤6/验收/边界、dated spec `2026-09-15-m9-f01-*.md`），
  记录的是 M9 收官时“M10 债务不在 M9 修”的分工边界；M10-01~04 已逐条清零其所指债务，本 spec 宣告该豁免通道关闭，
  历史快照本身按“已发布历史文档不改写”原则保留原文。
- verdict 口径（`verdicts.md` + `flaky-policy.md`）早已禁止洗绿：产品失败禁自动重试；失败后显式 repeat 通过仍为
  `FLAKY` 不得记 `PASS`；quarantine 须 owner + issue + 截止日且不计覆盖；禁止降为 `PLANNED` 洗绿。
  M10-05 未修改任何可靠性阈值：不加 retry、不拉长 timeout、不新增 skip/fixme、不放宽断言、不新增吞错 catch、
  不删/解绑 executable 缩分母（新增的 L1 为冻结锁，只增不减）。

## 6. 最终验收（评审方冻结口径，逐条照办）

1. 最终候选树固定后再取证：本提交先于两轮 full-browser；两轮跑在完全相同的最终 SHA 上；之间/之后再改任何
   tracked file 即作废重计。
2. 最终静态门禁全绿且工作树干净：`yarn test:catalog` · `npx tsc --noEmit --incremental false` · `yarn lint` ·
   `yarn test:unit` · `yarn test:integration` · `yarn build` · `git diff --check`。
3. ACTIVE + executable browser 分母全跑 `retries=0`：62/62；分母变化逐条解释（本项：无变化）。
4. 连续两次完整 full-browser 全绿：Run A = 62 passed / 0 failed；Run B = 62 passed / 0 failed；均为完整 suite 从头到尾。
5. 任何一次 full-browser failure 打断两连绿：失败轮不算绿证据；可 targeted rerun 分类取证但不得改写；处理后从 Run A 重计。
6. 不修改可靠性阈值（见 §5）。
7. 送审证据：最终 commit URL / full SHA、parent、tree clean、完整门禁结果、Run A/B 各自完整摘要与执行顺序；
   若两轮之前有失败，披露「失败 → 分类/修复 → 重新开始两轮」链条。

## 7. 交付契约

- 一个原子提交，仅显式路径 `git add`（禁 `-A` / `.`）；提交先于两轮 full-browser。
- 不 push：SHA、文件清单、门禁结果、Run A/B 摘要写入 DONE 报告，由监督方独立复验后 push。
- 基线：M10-04 提交 `e0b0f1f08d6372506480faf9df562ec7584d9acf`，工作树干净。
