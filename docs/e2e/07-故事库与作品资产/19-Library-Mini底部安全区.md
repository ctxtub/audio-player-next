# Library Mini 底部安全区

功能域：07-故事库与作品资产

## 用户目标

无论 Mini 播放器出现与否，故事库滚动容器末尾内容都不被底部 Chrome（TabBar/Mini）遮挡，且无 Mini 时不留幽灵空白。

## 前置条件

- 服务可用；真实注册用户；经真实 tRPC 预置含 3 个作品的集合（复用 18 号场景种子方式）。
- MainChrome 输出占位变量 `--main-tabbar-occupied-height`、`--mini-player-occupied-height`、`--bottom-chrome-gap`；Library 滚动容器动态消费，禁止末卡固定 margin。
- 预留语义（产品真相）：仅 docked 路径预留——Mini 可见 **且** layout 非 `wide-floating` 时（窄视口），MainChrome 给 `.app` 叠加 docked 类并输出三变量；桌面宽视口 Mini 为浮层（`wide-floating`），不参与列表预留，三变量中 Mini/gap 为 `0px`。

## 操作步骤

1. **无 Mini 基线**：新用户无播放会话时访问 `/library`，读取滚动容器 `padding-bottom` 计算值，确认等于 TabBar 占用（含 safe-area），且末卡底部与视口底部保留合理间距、无超大空白。
2. **有 Mini 抬升（docked 路径，窄视口 767px）**：播放任意作品使 Mini 出现（`mini-slot[data-visible="true"]` 且 `main-chrome[data-has-docked-mini="true"]`），确认 `--mini-player-occupied-height` 非零；行为断言取已求值几何：`.content` 的 `padding-bottom` ≈ TabBar 矩形高 + Mini 矩形高 + gap（8px，容差 4px：WebKit 亚像素舍入可达 ±3，仍能捕获任何缺项）。
3. **末卡可达**：将集合列表滚动到底，断言末张卡片包围盒底边严格位于 Mini 包围盒顶边之上（`cardBottom <= miniTop`），“加载更多”哨兵同样不被遮挡。
4. **Mini 消失回落**：关闭会话（新建创作强重置或暂停卸载以隐藏 Mini），确认占位变量回落、padding 收缩，无残留空白。

## 验收标准

- 占位变量由 MainChrome 单源输出，Library 只消费不自算 Mini 高度。
- docked 路径下末卡完整可达、无遮挡；无 Mini 时无幽灵空白；桌面浮层路径不断言列表预留（产品即如此设计）。
- 窄视口（docked）数值组合断言通过。

## 关联实现与测试

- 场景测试：`tests/system/browser/scenarios/library-collection.spec.ts`（安全区断言与集合旅程同文件）
- 可执行 ID：`exec-l3-collection-library`
- 契约规范：`docs/specs/2026-09-15-story-collection-continuous-creation-technical-design.md` §6
