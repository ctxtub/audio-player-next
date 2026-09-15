# M10-05-H1-F1-F2 · beginSession barrier 身份绑定（work + newestWorkId）

- 日期：2026-09-15（dated spec，冻结快照；后续不得改写为当前事实）
- change-id：M10-05-H1-F1-F2
- 角色：实现（test-only；不修产品、不改 oracle、不放宽阈值、不新增 retry/skip/wait/timeout）
- 基线 SHA：`377e90e1c3e6ab0b338220799ea5dde73a6c0e34`（分支 `feat/story-library-upgrade-20260912`，工作树干净）
- 前置裁决：F1（`377e90e`）方向与边界获认可；本轮唯一 Blocking＝
  「同步 barrier 只按 URL 匹配 procedure 名，未绑定本次点击对应的那一次 Work 回放」

## 1. 改了什么（唯一同步点，单文件）

文件：`tests/system/browser/scenarios/story-playback-global-controls-reachable.spec.ts`
用例：「M9-F01 生成历史回放走正式 Work Session 且全局控制同帧可达」。

在 click **之前** arm 的 `beginSessionSettled = page.waitForResponse(predicate)` 中，把
predicate 从「URL 含 `playback.beginSession`」收紧为**同时**满足三条：

1. procedure 名 ＝ `playback.beginSession`（URL pathname 末段精确匹配，非 substring）；
2. 该请求 input 的 `source.kind === "work"`；
3. 该请求 input 的 `source.workId` 与本用例既有的 `newestWorkId` 相等
   （字符串归一比较，`newestWorkId` 即用例内 `workIds[workIds.length - 1]`，不新造 id 来源）。

保持不变：

- click 之前先 arm；
- 只等 response **settle**，不新增 `response.status() === 200` 之类 oracle；
- settle 之后原封不动执行 `safeAnchorKind(dbFile, prompt)).toBe("work")` 及既有
  `anchor.sourceId === newestWorkId` 断言（产品若仍 500，Anchor 仍 draft，原断言照常失败）。

新增 test-only helper `parseTrpcInput(response, procedure)` 供 predicate 解析请求身份；
`parseTrpcInput` 任何一步解析失败均返回 `null`，predicate fail-closed 返回 `false`，
绝不退化为「只看 URL」的弱匹配。

## 2. 为什么必须绑定身份

F1 的 barrier 只按 URL 判定 procedure 名。若时序变为：

```
click → arm 完成
       → 一次无关的 draft playback.beginSession 晚到并 resolve
       → barrier 提前放行（此时用户 work click 的 beginSession 仍在写 Anchor）
       → safeAnchorKind 开始直读 DB
```

则 test 侧直读再次落进产品写窗口，`SQLITE_BUSY → 500 → Anchor 停在 draft` 的
observer-effect 窗口重现。只有把放行条件绑定到「本次点击所对应的那一次 Work 回放」
（procedure 名 + `source.kind=work` + `source.workId=newestWorkId` 三者同时成立），
才能保证 barrier 放行时该次 work beginSession 确已 settle。

## 3. payload 解析依据（真实 wire shape 与字段路径）

依据客户端 `lib/trpc/client.ts`（tRPC v11 + superjson 的 `httpBatchLink`）与服务端
`node_modules/@trpc/server/dist/unstable-core-do-not-import/http/contentType.js`
（`isBatchCall = searchParams.get('batch') === '1'`；batch 时 `path.split(',')`，
对 `inputs[index]` 调 `transformer.input.deserialize`）：

- URL：`<base>/api/trpc/<procedure[,procedure...]>?batch=1`；procedure 名以逗号分隔，
  **下标与 body 的 key 顺序一致**。取 pathname 末段 `split(",")`，`indexOf("playback.beginSession")`。
- POST body（batch）：`{"<index>":{"json":<input>,"meta":{...}},...}`；
  单发（非 batch）：`{"json":<input>,"meta":{...}}`。
  先取 `body[String(index)]`，再解其 `json` 字段。
- 目标字段路径（`lib/trpc/schemas/playback.ts` 的 `beginPlaybackSessionInputSchema` /
  `playbackSourceSchema`）：
  - `input.source.kind`（字面量 `"work"` | `"draft"`）
  - `input.source.workId`（`work` 分支，`z.number().int().positive()`）
  - 与用例既有 `newestWorkId`（`String(workIds[workIds.length - 1])`）做 `String(...)` 归一比较。

上述解析由本轮 2 次 targeted 运行的通过反向证实：predicate 未命中时
`await beginSessionSettled` 会在 30s 超时抛错使用例失败；实际两次均 4 passed。

## 4. targeted 验证

命令（chromium + webkit，retries=0，连续执行 2 次；运行提交含本 spec 变更，
提交 `158614bc0f495a074a7835a5e4ad71c147b7d186`，parent `377e90e`）：

```
npx playwright test --config tests/system/browser/playwright.config.ts \
  tests/system/browser/scenarios/story-playback-global-controls-reachable.spec.ts \
  --project=chromium --project=webkit
```

两次用例编排一致（1 worker，4 tests）：

```
[1/4] [chromium] › story-playback-global-controls-reachable.spec.ts:195:5 › M9-F01 故事卡播放（Legacy audioUrl 两种形态）全局控制同帧可达
[2/4] [chromium] › story-playback-global-controls-reachable.spec.ts:248:5 › M9-F01 生成历史回放走正式 Work Session 且全局控制同帧可达
[3/4] [webkit]   › story-playback-global-controls-reachable.spec.ts:195:5 › M9-F01 故事卡播放（Legacy audioUrl 两种形态）全局控制同帧可达
[4/4] [webkit]   › story-playback-global-controls-reachable.spec.ts:248:5 › M9-F01 生成历史回放走正式 Work Session 且全局控制同帧可达
```

真实结果行：

- 第 1 次：`  4 passed (59.6s)`，进程 `EXIT=0`
- 第 2 次：`  4 passed (1.0m)`，进程 `EXIT=0`

两次均 `4 passed / 0 failed`（chromium 与 webkit 各 2 用例全通过；无 flaky、无重试）。

## 5. 明确不做（边界）

- 不改任何其它测试文件；不改任何产品代码（`lib/` / `app/` / `components/` / `stores/` 一律不动）；
- 不引入 WAL，不改 harness DB 并发语义；
- 不新增 sleep / retry / skip / fixme / timeout 膨胀；
- 不放宽或改写 Anchor oracle，不改分母与 catalog lifecycle；
- 不碰已登记为 `BACKGROUND_OBSERVATION` 的其它 webkit 漂移失败；
- 不跑 5 轮全量矩阵（由监督方统一执行）。

## 6. 推送状态

按交付契约**只提交、不 push**；最终 SHA / parent / 变更文件清单见交付报告，
由监督方独立复验后再决定推送。
