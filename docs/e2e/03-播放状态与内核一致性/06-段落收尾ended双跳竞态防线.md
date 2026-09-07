# E2E-03-06 · 段落收尾连发（ended 双跳）竞态

| 属性 | 设定值 |
| --- | --- |
| 规范 ID | `E2E-03-06` |
| 所属功能套件 | `03-播放状态与内核一致性` |
| 规范层级 | 单用例规范（Canonical Test Spec） |
| 优先级 | `P2` |
| 自动化类型 | `AUT-BROWSER` |
| 执行调度 | 阶段 4: 播放状态机深度一致性（全局队列第 26 项） |
| 待验证假设 | ⚠️ H-12 |

## 用例规格

- 前置条件/夹具：`{{GUEST_FRESH}}`；mock 短音频（≈0.8s）×4 段连续播放。
- 步骤：1) 播放；2) 在第 1→2 段切换瞬间点击另一故事卡播放；3) 观察是否出现双跳/回跳。
- UI 断言：段落徽标不回退、不跳两段；最终只有一个播放源。
- 音频/浏览器断言：`audio.src` 切换有序；无同刻两次 `play()` 报错残留（console 允许被打断的 play() 异常，但不得未捕获）。
- 网络/数据断言：`saveProgress` 的 `nextParagraphIndex` 单调。
- 清理：清进度行；恢复音频时长。
- 证据要求：`console.json`、`db.txt`。
- 溯源：`components/AudioControllerHost/index.tsx:60-61,335,337,352`（`isTransitioningRef` 置位后从未读取——守卫失效，**待验证假设 H-12**）。
