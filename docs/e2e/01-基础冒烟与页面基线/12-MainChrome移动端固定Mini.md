# MainChrome 与移动端固定 Mini（M6-03 Mobile Docked）

功能域：01-基础冒烟与页面基线

## 用户目标

移动端有可展示播放会话时 Mini 固定在 TabBar 上方、不可拖，TabBar 与输入区不被遮挡；无会话时不保留幽灵空间；软键盘展开时 Mini 纯隐藏且播放/会话不变，键盘收起后自动恢复；点击 Mini 进入 `/player`；跨 `/chat` `/library` `/setting` 同一会话派生且音频宿主唯一。

## 前置条件

- M5 PlaybackSessionStore + Transport 为唯一播放事实源（M5 冻结）；布局层不 mutation `sessionId/status/source/continuationMode`。
- M6-01 冻结断点（767→compact，768→wide）与三态形态；M6-02 语义核心（标题/动作/进度）与 entry 契约（`router.push('/player')`）。
- 本项 desktop 允许 compatibility floating 路径继续存在，不实现桌面 drag。

## 操作步骤

1. 无 current session（source null / idle）→ 打开 `/chat`：Mini 不渲染，BottomChrome 不预留幽灵空间。
2. 建立 Work 播放会话并暂停驻留（真实 `beginSession` + 首段合成 + pause），视口 767：Mini 出现在 TabBar 上方、不可拖，TabBar 与 Composer 均可达，内容区底部预留抬高。
3. 聚焦 Chat 输入框（移动端软键盘 fallback 抑制）：Mini 隐藏；`sessionId`/播放态/音频轨道不变。
4. 失焦/键盘收起：同一 `sessionId` 的 Mini 自动恢复。
5. 点击 Mini 元数据：进入 `/player`；返回后回到原路由，播放不断。
6. 跨 `/chat`→`/library`→`/setting`→返回：同一 `sessionId`、同一 `source`、唯一 audio owner、无重复 `beginSession`、无新增合成。
7. 视口 768：不进入 mobile docked 分支（`wide-floating`/`wide-docked`），Mini 仍由同一 Session 派生。

## 验收标准

- 767 + active session → `compact-docked`、Mini 在 TabBar 上方、不可拖、TabBar 与 Composer 不被遮挡。
- 无 session → `data-has-docked-mini=false` 且无 Mini DOM。
- keyboard open → Mini 隐藏但 Session 与音频不变；close → 同一 `sessionId` 恢复。
- 点击 Mini → 精确 `/player`；`/player` 上 no-op 由 M6-02 facade 保证。
- 跨路由同一 Session、唯一 Host、零重建（`beginSession=0`、`tts.synthesize=0`、同轨道 URL、同一 audio 元素标记存活）。
- 768 为 wide（含边界），不走 `compact-docked` 抑制分支。

## 边界与异常

- 纯 layout visibility：抑制不 clear Session、不 pause、不改 Anchor、不写 `isMiniVisible`。
- `desktopFloatingPlayerEnabled` 只决定 wide 下 floating/docked，不决定存在性；compact 不受偏好影响。
- wide-floating 为兼容浮层，不占位；桌面 drag/snap/resize 归 M6-04。
- Playwright 桌面无法真实弹出手机软键盘：L3 走聚焦 fallback 断言抑制，真实键盘视觉留待设备 QA。

## 实现参考

- `components/MainChrome/index.tsx`
- `components/MainChrome/BottomChrome.tsx`
- `components/MainChrome/useMainChromeState.ts`
- `components/MainChrome/index.module.scss`
- `styles/app.module.scss`（`--bottom-chrome-safe-bottom`）
- `styles/tokens/_sizing.scss`（Mini 高度/宽度 token）
- `app/(main)/layout.tsx`（MainChrome + 唯一 Host）
- `app/(main)/chat/components/Composer/Composer.module.scss`
- `app/(main)/chat/index.module.scss`
- `app/(main)/library/index.module.scss`
