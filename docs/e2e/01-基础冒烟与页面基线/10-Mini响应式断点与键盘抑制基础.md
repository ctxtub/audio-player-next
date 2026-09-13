# Mini 响应式断点与键盘抑制基础（M6-01 Responsive Foundation）

功能域：01-基础冒烟与页面基线

## 用户目标

Mini 在不同视口下形态可预测：窄屏固定、宽屏按偏好悬浮/固定；软键盘展开时 detector 可独立判定 open/closed（本项不做 Mini 显隐，只验证基础能力）。

## 前置条件

- 冻结断点：mobile/docked <768px；desktop >=768px。
- SCSS `$breakpoint-lg` 与 TS `NOW_PLAYING_BREAKPOINT_PX` 同一契约（同为 768，无 1024 第二边界）。

## 操作步骤

1. viewport 767 → 判定 compact（`compact-docked`）。
2. viewport 768 + 偏好 true → `wide-floating`；偏好 false → `wide-docked`。
3. SCSS token 文件含 `$breakpoint-lg: 768px` 且被聚合入口引用。
4. TS 纯函数与 hook 同一常量来源（无硬编码第二边界）。
5. 软键盘 detector：可编辑聚焦 + visualViewport 收缩 >150px → open；无聚焦 → closed；无 visualViewport 时聚焦即 open（fallback）。

## 验收标准

- 767→mobile/compact；768→desktop/wide（含边界）。
- 三态派生：compact 恒 docked；wide 按偏好 floating/docked。
- SCSS 与 TS 同值 768（guard 锁定）。
- keyboard detector open/closed 可独立测试（纯函数 + hook）。
- 本项不断言 Mini 显隐/MainChrome/FloatingPlayer 替换。

## 边界与异常

- SSR（无 window）默认 compact（mobile-first）。
- 不支持 visualViewport 的浏览器走聚焦 fallback。
- 禁止在组件内另起 768/1024 裸断点。

## 实现参考

- `styles/tokens/_breakpoints.scss` + `styles/tokens/index.scss`
- `components/NowPlaying/types.ts`
- `components/NowPlaying/useNowPlayingLayoutMode.ts`
- `components/NowPlaying/useSoftKeyboardState.ts`
