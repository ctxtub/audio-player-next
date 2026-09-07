# E2E-06-08 · bfcache/pageshow 恢复探针

| 属性 | 设定值 |
| --- | --- |
| 规范 ID | `E2E-06-08` |
| 所属功能套件 | `06-异常处理与接口限流` |
| 规范层级 | 单用例规范（Canonical Test Spec） |
| 优先级 | `P3` |
| 自动化类型 | `MANUAL` |
| 执行调度 | 人工排除项（manual_excluded） |
| 待验证假设 | — |

## 用例规格

- 前置条件/夹具：真实桌面 Chrome/Safari（bfcache 行为浏览器相关，agent-browser 受控环境可能不触发）；播放中或播放刚停止的 `/player`。
- 步骤：1) 播放中导航至站外页（或 `history.pushState` 后关闭再快速回退）；2) 触发 bfcache 恢复（后退）；3) 在 DevTools Console 验证 `pageshow` 事件 `persisted` 值；4) 采样音频与 UI。
- UI 断言：bfcache 恢复后 UI 状态与离开时一致或正确复位；不出现「显示播放中但无声」或「无声但计时走」的幽灵态。
- 音频/浏览器断言：恢复后 `<audio>` 元素存在性与 `paused` 值；若宿主已卸载（离开 `(main)` 组），恢复时是否正确重挂（登记实际行为）。
- 网络/数据断言：恢复时是否重复发起 `config.get`/profile（一次性水合语义联动 E2E-04-08）。
- 清理：清 cookie；关真实浏览器。
- 证据要求：`ui-bfcache.png`、console 记录（`persisted` 值）、人工观察笔记。
- 溯源：`app/(main)/layout.tsx:17-27`（`(auth)` 组离开即卸载音频宿主）；`components/AudioControllerHost/index.tsx:232-253`（卸载 `registerAudioController(null)`）；scan 留档：全仓无 `pageshow` 处理器（静态 grep 证据）。
- 备注：MANUAL 原因——bfcache 不可由受控浏览器可靠触发，且属探索性低频路径；若 MANUAL 环境不可得，登记为「未执行」并保留步骤供后续执行。
