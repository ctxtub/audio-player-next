# Audio Player Next — Design Token Spec v2.0 (iOS 26 Liquid Glass)

> 本文档是 UI 重设计的唯一设计规范来源（Single Source of Truth）。
> 所有页面和组件的样式必须引用本文档中定义的 Design Token，禁止使用硬编码数值。

---

## 1. 设计原则

| 原则 | 说明 |
|------|------|
| **沉浸优先** | 音频播放场景需要最大化沉浸感，减少视觉干扰 |
| **Liquid Glass** | 借鉴 iOS 26 设计语言，通过高强度毛玻璃 + 光泽边框 + 柔和阴影构建通透的玻璃质感 |
| **层次分明** | 通过 Surface 层级 + 阴影 + 模糊 + saturate 构建清晰的 Z 轴空间 |
| **动静结合** | 静态时克制留白，动态时（生成/播放）有仪式感和节奏感 |
| **一致性** | 所有间距、圆角、字号、颜色只能从 Token 中取值，色板对齐 iOS HIG |

---

## 2. Design Token 定义

### 2.1 颜色系统 (Color)

采用语义化颜色命名，分 Primitive（原始色）和 Semantic（语义色）两层。

#### 2.1.1 Primitive Colors

| Token | Dark | Light | 说明 |
|-------|------|-------|------|
| `--color-black` | `#000000` | `#000000` | 纯黑 |
| `--color-white` | `#ffffff` | `#ffffff` | 纯白 |
| `--color-gray-50` | `#F9F9FB` | `#F9F9FB` | |
| `--color-gray-100` | `#F2F2F7` | `#F2F2F7` | iOS systemGroupedBackground |
| `--color-gray-200` | `#E5E5EA` | `#E5E5EA` | |
| `--color-gray-300` | `#D1D1D6` | `#D1D1D6` | |
| `--color-gray-400` | `#AEAEB2` | `#AEAEB2` | iOS systemGray2 |
| `--color-gray-500` | `#8E8E93` | `#8E8E93` | iOS systemGray |
| `--color-gray-600` | `#636366` | `#636366` | iOS systemGray2 (dark) |
| `--color-gray-700` | `#48484A` | `#48484A` | iOS systemGray3 (dark) |
| `--color-gray-800` | `#2C2C2E` | `#2C2C2E` | iOS secondarySystemBackground (dark) |
| `--color-gray-900` | `#1C1C1E` | `#1C1C1E` | iOS systemBackground (dark) |
| `--color-blue-400` | `#409CFF` | `#409CFF` | |
| `--color-blue-500` | `#0A84FF` | `#0A84FF` | iOS systemBlue (dark) |
| `--color-blue-600` | `#007AFF` | `#007AFF` | iOS systemBlue (light) |
| `--color-amber-400` | `#FFB340` | `#FFB340` | |
| `--color-amber-500` | `#FF9500` | `#FF9500` | iOS systemOrange |
| `--color-red-400` | `#FF6961` | `#FF6961` | |
| `--color-red-500` | `#FF3B30` | `#FF3B30` | iOS systemRed |
| `--color-green-400` | `#4CD964` | `#4CD964` | |
| `--color-green-500` | `#34C759` | `#34C759` | iOS systemGreen |
| `--color-violet-400` | `#BF8BFF` | `#BF8BFF` | 装饰/渐变 |
| `--color-violet-500` | `#AF52DE` | `#AF52DE` | iOS systemPurple |

#### 2.1.2 Semantic Colors

| Token | Dark 值 | Light 值 | 用途 |
|-------|---------|----------|------|
| **背景 (Background)** | | | |
| `--bg-primary` | `#000000` | `#F2F2F7` | 页面主背景（iOS systemGroupedBackground） |
| `--bg-secondary` | `#1C1C1E` | `#ffffff` | 卡片/面板背景 |
| `--bg-tertiary` | `#2C2C2E` | `#F9F9FB` | 输入框/嵌套区域背景 |
| `--bg-elevated` | `rgba(44,44,46,0.75)` | `rgba(255,255,255,0.80)` | 毛玻璃浮层背景 |
| `--bg-overlay` | `rgba(0,0,0,0.5)` | `rgba(0,0,0,0.3)` | 遮罩层 |
| **Liquid Glass 表面** | | | |
| `--glass-bg` | `rgba(38,38,40,0.50)` | `rgba(255,255,255,0.45)` | Liquid Glass 背景 |
| `--glass-border` | `rgba(255,255,255,0.12)` | `rgba(255,255,255,0.60)` | 光泽发光边框 |
| `--glass-highlight` | `inset 0 0.5px ... 0.15` | `inset 0 0.5px ... 0.70` | 顶部高光（模拟玻璃折射） |
| **前景 (Foreground / Text)** | | | |
| `--text-primary` | `#ffffff` | `#1C1C1E` | 主文本 |
| `--text-secondary` | `#AEAEB2` | `#636366` | 次要文本、描述 |
| `--text-tertiary` | `#8E8E93` | `#8E8E93` | 占位符、禁用文本 |
| `--text-inverse` | `#000000` | `#ffffff` | 反色文本（如 primary 按钮文字） |
| `--text-on-primary` | `#ffffff` | `#ffffff` | primary 色上的文字 |
| **品牌 / 交互 (Brand / Interactive)** | | | |
| `--accent-primary` | `#0A84FF` | `#007AFF` | iOS systemBlue（按钮、链接、进度条） |
| `--accent-primary-hover` | `#409CFF` | `#0A84FF` | 主操作色 hover |
| `--accent-primary-subtle` | `rgba(10,132,255,0.18)` | `rgba(0,122,255,0.12)` | 主色浅底（Tag、选中态背景） |
| `--accent-secondary` | `#AF52DE` | `#AF52DE` | iOS systemPurple（渐变、装饰） |
| **语义状态 (Status)** | | | |
| `--status-success` | `#30D158` | `#34C759` | iOS systemGreen |
| `--status-warning` | `#FFD60A` | `#FF9500` | iOS systemYellow / Orange |
| `--status-error` | `#FF453A` | `#FF3B30` | iOS systemRed |
| `--status-info` | `#64D2FF` | `#5AC8FA` | iOS systemCyan |
| **边框 (Border)** | | | |
| `--border-default` | `rgba(255,255,255,0.10)` | `rgba(0,0,0,0.08)` | 默认边框 |
| `--border-subtle` | `rgba(255,255,255,0.05)` | `rgba(0,0,0,0.04)` | 微弱分割线 |
| `--border-strong` | `rgba(255,255,255,0.18)` | `rgba(0,0,0,0.15)` | 强调边框/聚焦框 |
| `--border-accent` | `rgba(10,132,255,0.45)` | `rgba(0,122,255,0.40)` | 选中/聚焦态边框 |

#### 2.1.3 渐变 (Gradient)

| Token | 值 | 用途 |
|-------|----|------|
| `--gradient-brand` | `linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))` | 品牌渐变（按钮高亮、标题装饰） |
| `--gradient-surface` | `linear-gradient(180deg, var(--bg-secondary), var(--bg-primary))` | 页面底部渐变 |
| `--gradient-fade-down` | `linear-gradient(180deg, var(--bg-secondary), transparent)` | 内容区顶部渐隐 |
| `--gradient-fade-up` | `linear-gradient(0deg, var(--bg-primary) 0%, transparent 100%)` | 内容区底部渐隐（如输入框上方） |
| `--gradient-glow` | `radial-gradient(circle, var(--accent-primary-subtle) 0%, transparent 70%)` | 播放器光晕效果 |

---

### 2.2 排版系统 (Typography)

#### 2.2.1 字体族 (Font Family)

| Token | 值 |
|-------|----|
| `--font-sans` | `-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'Helvetica Neue', 'Noto Sans SC', sans-serif` |
| `--font-mono` | `'SF Mono', 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace` |

#### 2.2.2 字号 (Font Size)

固定 8 级字号，禁止使用其他数值。

| Token | 值 | 行高 | 用途 |
|-------|-----|------|------|
| `--text-xs` | `11px` | `16px` | 标签、角标、时间戳 |
| `--text-sm` | `13px` | `18px` | 辅助说明、描述文本 |
| `--text-base` | `15px` | `22px` | 正文、按钮、输入框 |
| `--text-md` | `17px` | `24px` | 列表标题、卡片标题 |
| `--text-lg` | `20px` | `28px` | 区域标题 |
| `--text-xl` | `24px` | `32px` | 页面标题 |
| `--text-2xl` | `32px` | `40px` | 大标题（Auth 页面） |
| `--text-3xl` | `40px` | `48px` | 超大装饰文字 |

#### 2.2.3 字重 (Font Weight)

| Token | 值 | 用途 |
|-------|----|------|
| `--weight-normal` | `400` | 正文 |
| `--weight-medium` | `500` | 次要强调 |
| `--weight-semibold` | `600` | 按钮、卡片标题 |
| `--weight-bold` | `700` | 页面标题、数字强调 |

#### 2.2.4 字间距 (Letter Spacing)

| Token | 值 | 用途 |
|-------|----|------|
| `--tracking-tight` | `-0.02em` | 大标题 |
| `--tracking-normal` | `0` | 正文 |
| `--tracking-wide` | `0.02em` | 大写标签、角标 |

---

### 2.3 间距系统 (Spacing)

基于 4px 网格，共 12 级。

| Token | 值 | 用途示例 |
|-------|----|----------|
| `--space-0` | `0px` | |
| `--space-1` | `4px` | 图标与文字间距、紧凑内边距 |
| `--space-2` | `8px` | 行内元素间距、小卡片内边距 |
| `--space-3` | `12px` | 卡片内边距、列表项间距 |
| `--space-4` | `16px` | 页面边距（`--page-padding`）、节间距 |
| `--space-5` | `20px` | 大卡片内边距 |
| `--space-6` | `24px` | 区域间距 |
| `--space-8` | `32px` | 页面节间距 |
| `--space-10` | `40px` | 大区域间距 |
| `--space-12` | `48px` | 页面顶部/底部留白 |
| `--space-16` | `64px` | 特殊布局间距 |
| `--space-20` | `80px` | 视觉焦点周围留白 |

**布局别名：**

| Token | 映射 | 用途 |
|-------|------|------|
| `--page-padding` | `var(--space-4)` = 16px | 页面左右内边距 |
| `--section-gap` | `var(--space-6)` = 24px | 页面内各 Section 之间 |
| `--card-padding` | `var(--space-5)` = 20px | 卡片内边距 |
| `--card-padding-sm` | `var(--space-3)` = 12px | 小卡片内边距 |
| `--tab-bar-height` | `56px` | 底部 TabBar 固定高度 |

---

### 2.4 圆角系统 (Border Radius)

固定 7 级，禁止自定义数值。

| Token | 值 | 用途 |
|-------|----|------|
| `--radius-xs` | `4px` | 进度条、小 badge |
| `--radius-sm` | `8px` | 小按钮、Tag、代码块 |
| `--radius-md` | `12px` | 卡片、按钮、输入框 |
| `--radius-lg` | `16px` | 大卡片、面板 |
| `--radius-xl` | `20px` | 消息气泡、弹窗 |
| `--radius-2xl` | `28px` | 顶部 Header 区域 |
| `--radius-full` | `9999px` | 圆形头像、Pill 按钮、圆形播放按钮 |

---

### 2.5 阴影系统 (Shadow / Elevation)

4 级阴影，构建视觉层级。

| Token | 值 | 用途 |
|-------|----|------|
| `--shadow-sm` | `0 1px 4px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.03)` | 卡片微浮起 |
| `--shadow-md` | `0 2px 12px rgba(0,0,0,0.08), 0 2px 4px rgba(0,0,0,0.04)` | 卡片默认阴影 |
| `--shadow-lg` | `0 4px 20px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06)` | 弹窗、浮层 |
| `--shadow-xl` | `0 8px 32px rgba(0,0,0,0.18), 0 4px 12px rgba(0,0,0,0.08)` | 模态框、播放器 |
| `--shadow-glass` | `0 2px 16px rgba(0,0,0,0.08)` | Liquid Glass 外部阴影（亮色） |
| `--shadow-glass-dark` | `0 2px 16px rgba(0,0,0,0.35)` | Liquid Glass 外部阴影（暗色） |

> Dark 模式下阴影不明显，改用 `border` + `bg-elevated` 构建层级感。

**特殊阴影：**

| Token | 值 | 用途 |
|-------|----|------|
| `--shadow-accent` | `0 4px 16px color-mix(in srgb, var(--accent-primary) 30%, transparent)` | 主操作按钮光晕 |
| `--shadow-inset` | `inset 0 1px 2px rgba(0,0,0,0.06)` | 输入框内阴影 |

---

### 2.6 模糊 / 毛玻璃 (Blur / Liquid Glass)

iOS 26 Liquid Glass 风格，使用更高强度的模糊 + 饱和度增强。

| Token | 值 | 用途 |
|-------|----|------|
| `--blur-sm` | `12px` | 小浮层 |
| `--blur-md` | `24px` | 标准毛玻璃面板 |
| `--blur-lg` | `40px` | 大面积毛玻璃（导航栏、底栏） |
| `--blur-xl` | `60px` | 播放器背景、遮罩 |
| `--glass-blur` | `blur(48px) saturate(180%)` | Liquid Glass 专用复合效果 |

**使用方式：**
- 普通模糊：`backdrop-filter: blur(var(--blur-md)); -webkit-backdrop-filter: blur(var(--blur-md));`
- Liquid Glass：`backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur);` 配合 `--glass-bg`、`--glass-border`、`--glass-highlight` 使用

---

### 2.7 动效系统 (Motion)

#### 2.7.1 时长 (Duration)

| Token | 值 | 用途 |
|-------|----|------|
| `--duration-fast` | `120ms` | 按钮 hover/active、Toggle 切换 |
| `--duration-normal` | `240ms` | 卡片展开/收起、Tab 切换 |
| `--duration-slow` | `400ms` | 页面过渡、弹窗进出 |
| `--duration-slower` | `600ms` | 复杂多步动画 |

#### 2.7.2 缓动函数 (Easing)

| Token | 值 | 用途 |
|-------|----|------|
| `--ease-default` | `cubic-bezier(0.4, 0, 0.2, 1)` | 通用过渡（Material Standard） |
| `--ease-in` | `cubic-bezier(0.4, 0, 1, 1)` | 元素退出 |
| `--ease-out` | `cubic-bezier(0, 0, 0.2, 1)` | 元素进入 |
| `--ease-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | 弹性效果（按钮点击反馈） |

#### 2.7.3 预设 Transition

| Token | 值 |
|-------|----|
| `--transition-colors` | `color var(--duration-fast) var(--ease-default), background-color var(--duration-fast) var(--ease-default), border-color var(--duration-fast) var(--ease-default)` |
| `--transition-transform` | `transform var(--duration-normal) var(--ease-default)` |
| `--transition-opacity` | `opacity var(--duration-normal) var(--ease-default)` |
| `--transition-all` | `all var(--duration-normal) var(--ease-default)` |

#### 2.7.4 关键帧动画规范

| 动画名称 | 用途 | 时长 | 缓动 |
|----------|------|------|------|
| `spin` | 加载旋转 | `1s` | `linear infinite` |
| `pulse` | 发送中脉搏 | `2s` | `ease-in-out infinite` |
| `wave` | 音频波形条 | `1s` | `ease-in-out infinite` |
| `fade-in` | 元素入场 | `var(--duration-normal)` | `var(--ease-out)` |
| `fade-up` | 元素上浮入场 | `var(--duration-slow)` | `var(--ease-out)` |
| `shimmer` | 骨架屏闪光 | `2s` | `linear infinite` |
| `disc-rotate` | 唱片旋转 | `20s` | `linear infinite` |
| `typewriter-blink` | 打字机光标 | `0.8s` | `step-end infinite` |

---

### 2.8 层级系统 (Z-Index)

| Token | 值 | 用途 |
|-------|----|------|
| `--z-base` | `0` | 默认层 |
| `--z-raised` | `10` | 卡片浮起 |
| `--z-sticky` | `20` | 吸顶/吸底元素（TabBar） |
| `--z-overlay` | `30` | 遮罩层 |
| `--z-modal` | `40` | 弹窗 |
| `--z-popover` | `50` | 下拉菜单、Toast |
| `--z-floating` | `60` | 悬浮播放器 |
| `--z-max` | `100` | 系统级最高层 |

---

### 2.9 尺寸 Token (Sizing)

| Token | 值 | 用途 |
|-------|----|------|
| `--size-icon-sm` | `16px` | 小图标 |
| `--size-icon-md` | `20px` | 默认图标 |
| `--size-icon-lg` | `24px` | 大图标（TabBar、操作栏） |
| `--size-icon-xl` | `32px` | 特大图标 |
| `--size-avatar-sm` | `32px` | 小头像 |
| `--size-avatar-md` | `40px` | 默认头像（消息气泡） |
| `--size-avatar-lg` | `48px` | 大头像（设置页） |
| `--size-touch-target` | `44px` | 最小可点击区域（无障碍） |
| `--size-button-height` | `48px` | 标准按钮高度 |
| `--size-input-height` | `48px` | 标准输入框高度 |
| `--size-disc` | `200px` | 播放器唱片尺寸 |
| `--size-play-button` | `56px` | 播放按钮尺寸 |

---

## 3. 组件 Token 映射（Component Token）

> 组件 Token 引用上层 Semantic Token，不直接使用 Primitive Token。

### 3.1 按钮 (Button)

| 变体 | 背景 | 文字 | 边框 | 圆角 | 高度 |
|------|------|------|------|------|------|
| **Primary** | `var(--accent-primary)` | `var(--text-on-primary)` | none | `var(--radius-md)` | `var(--size-button-height)` |
| **Secondary** | `var(--bg-tertiary)` | `var(--text-primary)` | `var(--border-default)` | `var(--radius-md)` | `var(--size-button-height)` |
| **Ghost** | `transparent` | `var(--accent-primary)` | none | `var(--radius-md)` | `var(--size-button-height)` |
| **Danger** | `var(--status-error)` | `var(--text-on-primary)` | none | `var(--radius-md)` | `var(--size-button-height)` |
| **Icon** | `var(--bg-tertiary)` | `var(--text-secondary)` | none | `var(--radius-full)` | `var(--size-touch-target)` |

**交互状态：**
- Hover: 背景 `opacity 0.88` 或使用 `--accent-primary-hover`
- Active: `transform: scale(0.97)` + `var(--duration-fast)`
- Disabled: `opacity: 0.4`, `pointer-events: none`
- Focus-visible: `outline: 2px solid var(--border-accent)`, `outline-offset: 2px`

### 3.2 输入框 (Input / TextArea)

| 属性 | Token |
|------|-------|
| 背景 | `var(--bg-tertiary)` |
| 文字 | `var(--text-primary)` |
| 占位符 | `var(--text-tertiary)` |
| 边框 | `1px solid var(--border-default)` |
| 聚焦边框 | `1px solid var(--border-accent)` |
| 圆角 | `var(--radius-md)` |
| 高度 | `var(--size-input-height)` |
| 内边距 | `var(--space-3) var(--space-4)` |
| 字号 | `var(--text-base)` |

### 3.3 卡片 (Card)

| 属性 | Token |
|------|-------|
| 背景 | `var(--bg-secondary)` |
| 边框 | `1px solid var(--border-default)` |
| 圆角 | `var(--radius-lg)` |
| 内边距 | `var(--card-padding)` |
| 阴影 | `var(--shadow-sm)` |

**Card 变体：**
- **Elevated Card**（毛玻璃）: `background: var(--bg-elevated)`, `backdrop-filter: blur(var(--blur-md))`, `shadow: var(--shadow-md)`
- **Interactive Card**: 增加 `hover: var(--shadow-md)`, `transition: var(--transition-all)`
- **Highlighted Card**: `border-color: var(--border-accent)`, `background: var(--accent-primary-subtle)`

### 3.4 消息气泡 (MessageBubble)

| 角色 | 背景 | 文字 | 圆角 | 内边距 |
|------|------|------|------|--------|
| **AI (assistant)** | `var(--bg-secondary)` | `var(--text-primary)` | `var(--radius-xl)` | `var(--space-3) var(--space-4)` |
| **User** | `var(--accent-primary)` | `var(--text-on-primary)` | `var(--radius-xl)` | `var(--space-3) var(--space-4)` |
| **System** | `var(--bg-tertiary)` | `var(--text-secondary)` | `var(--radius-md)` | `var(--space-3)` |

### 3.5 播放器 (AudioPlayer)

| 部件 | 规格 |
|------|------|
| **容器** | `bg: var(--bg-elevated)`, `blur: var(--blur-lg)`, `radius: var(--radius-lg)`, `padding: var(--card-padding)`, `shadow: var(--shadow-xl)` |
| **唱片** | `width/height: var(--size-disc)`, `radius: var(--radius-full)`, `border: 3px solid var(--border-default)`, `animation: disc-rotate 20s linear infinite` |
| **播放按钮** | `size: var(--size-play-button)`, `radius: var(--radius-full)`, `bg: var(--accent-primary)`, `shadow: var(--shadow-accent)` |
| **进度条轨道** | `height: 4px (hover: 6px)`, `radius: var(--radius-xs)`, `bg: var(--bg-tertiary)` |
| **进度条已播** | `bg: var(--accent-primary)` |
| **时间文字** | `size: var(--text-sm)`, `color: var(--text-secondary)`, `weight: var(--weight-medium)`, `font: var(--font-mono)` |
| **速度按钮** | `radius: var(--radius-md)`, `bg: var(--bg-tertiary)`, `size: var(--text-sm)` |

### 3.6 导航栏 (TabBar)

| 属性 | Token |
|------|-------|
| 高度 | `var(--tab-bar-height)` |
| 背景 | `var(--bg-elevated)` |
| 模糊 | `var(--blur-lg)` |
| 边框 | `border-top: 1px solid var(--border-subtle)` |
| 层级 | `var(--z-sticky)` |
| 未选中色 | `var(--text-tertiary)` |
| 选中色 | `var(--accent-primary)` |
| 图标尺寸 | `var(--size-icon-lg)` |
| 标签字号 | `var(--text-xs)` |
| Badge 背景 | `var(--status-error)` |

### 3.7 悬浮播放器 (FloatingPlayer)

| 属性 | Token |
|------|-------|
| 背景 | `var(--bg-elevated)` |
| 模糊 | `var(--blur-md)` |
| 圆角 | `var(--radius-lg)` |
| 阴影 | `var(--shadow-lg)` |
| 层级 | `var(--z-floating)` |
| 播放按钮 | `size: var(--size-touch-target)`, `radius: var(--radius-full)`, `bg: var(--accent-primary)` |

### 3.8 表单区域 (Auth Page)

| 元素 | 规格 |
|------|------|
| **页面标题** | `size: var(--text-2xl)`, `weight: var(--weight-bold)`, `tracking: var(--tracking-tight)` |
| **副标题** | `size: var(--text-lg)`, `color: var(--text-secondary)` |
| **Tab 切换** | `size: var(--text-base)`, `active: var(--accent-primary)`, `inactive: var(--text-tertiary)` |
| **输入框** | 引用 3.2 Input Token |
| **提交按钮** | 引用 3.1 Button Primary, `width: 100%` |
| **游客入口** | 引用 3.1 Button Ghost, `size: var(--text-sm)` |
| **错误提示** | `color: var(--status-error)`, `size: var(--text-sm)` |

### 3.9 设置页 (Setting)

| 元素 | 规格 |
|------|------|
| **Section 容器** | 引用 3.3 Card |
| **Section 标题** | `size: var(--text-md)`, `weight: var(--weight-semibold)`, `margin-bottom: var(--space-3)` |
| **设置项行** | `padding: var(--space-3) 0`, `border-bottom: 1px solid var(--border-subtle)` |
| **设置项标签** | `size: var(--text-base)`, `color: var(--text-primary)` |
| **设置项描述** | `size: var(--text-sm)`, `color: var(--text-secondary)` |
| **用户卡片** | `padding: var(--card-padding)`, `radius: var(--radius-lg)`, `bg: var(--bg-secondary)` |
| **头像** | `size: var(--size-avatar-lg)`, `radius: var(--radius-full)` |

### 3.10 故事生成预览 (GenerationPreview)

| 元素 | 规格 |
|------|------|
| **容器** | `radius: var(--radius-md)`, `padding: var(--space-4)`, `bg: var(--bg-secondary)`, `border: 1px solid var(--border-default)` |
| **文本区** | `height: 120px`, `overflow-y: auto`, `size: var(--text-base)`, `color: var(--text-primary)` |
| **光标** | `animation: typewriter-blink`, `color: var(--accent-primary)` |
| **音频遮罩** | `bg: var(--bg-overlay)`, `blur: var(--blur-sm)` |
| **波形条** | `width: 6px`, `radius: var(--radius-xs)`, `bg: var(--accent-primary)`, `animation: wave 1s ease-in-out infinite` |

### 3.11 Composer (聊天输入栏)

| 元素 | 规格 |
|------|------|
| **容器** | `padding: var(--space-3) var(--space-4)`, `bg: var(--bg-elevated)`, `blur: var(--blur-lg)`, `border-top: 1px solid var(--border-subtle)` |
| **输入框** | `radius: var(--radius-lg)`, `padding: var(--space-3) var(--space-5)`, `size: var(--text-base)`, `bg: var(--bg-tertiary)` |
| **发送按钮** | `radius: var(--radius-full)`, `size: var(--size-touch-target)`, `bg: var(--accent-primary)`, `icon: var(--size-icon-md)` |

### 3.12 预设模板卡片 (HeaderArea Quick Prompts)

| 元素 | 规格 |
|------|------|
| **容器** | 2 列 Grid, `gap: var(--space-3)` |
| **卡片** | `padding: var(--space-3)`, `radius: var(--radius-md)`, `bg: var(--bg-secondary)`, `border: 1px solid var(--border-default)` |
| **Hover** | `border-color: var(--border-accent)`, `bg: var(--accent-primary-subtle)`, `shadow: var(--shadow-sm)` |
| **文本** | `size: var(--text-sm)`, `color: var(--text-secondary)`, `weight: var(--weight-medium)` |

### 3.13 GuestBanner

| 元素 | 规格 |
|------|------|
| **容器** | `padding: var(--space-2) var(--space-4)`, `bg: var(--accent-primary-subtle)`, `border-bottom: 1px solid var(--border-accent)` |
| **文本** | `size: var(--text-sm)`, `color: var(--text-secondary)` |
| **操作链接** | `color: var(--accent-primary)`, `weight: var(--weight-semibold)` |

### 3.14 OnboardingModal

| 元素 | 规格 |
|------|------|
| **弹窗** | `radius: var(--radius-xl)`, `padding: var(--card-padding)`, `bg: var(--bg-secondary)`, `shadow: var(--shadow-xl)` |
| **标题** | `size: var(--text-lg)`, `weight: var(--weight-bold)`, `background: var(--gradient-brand)`, `-webkit-background-clip: text` |
| **Agent 项** | `padding: var(--space-3)`, `radius: var(--radius-md)` |
| **图标** | `size: var(--size-avatar-md)`, `radius: var(--radius-full)`, `bg: var(--bg-tertiary)` |

### 3.15 StoryViewer

| 元素 | 规格 |
|------|------|
| **容器** | `padding: var(--space-4)`, `radius: var(--radius-lg)`, `bg: var(--bg-secondary)`, `border: 1px solid var(--border-default)` |
| **故事文本** | `size: var(--text-base)`, `line-height: 1.7`, `color: var(--text-primary)` |
| **播放按钮** | 引用 3.5 播放器播放按钮（缩小版） |

### 3.16 PlaybackStatusBoard

| 元素 | 规格 |
|------|------|
| **容器** | `padding: var(--space-3) var(--space-4)`, `radius: var(--radius-md)`, `bg: var(--bg-secondary)` |
| **状态文本** | `size: var(--text-sm)`, `color: var(--text-secondary)` |
| **倒计时** | `size: var(--text-md)`, `weight: var(--weight-semibold)`, `font: var(--font-mono)`, `color: var(--accent-primary)` |
| **进度指示** | `color: var(--status-success)` (就绪) / `var(--accent-primary)` (生成中) |

### 3.17 HistoryRecords

| 元素 | 规格 |
|------|------|
| **列表容器** | `gap: var(--space-2)` |
| **记录项** | `padding: var(--space-3) var(--space-4)`, `radius: var(--radius-md)`, `bg: var(--bg-secondary)`, `border: 1px solid var(--border-subtle)` |
| **标题** | `size: var(--text-base)`, `weight: var(--weight-medium)`, `color: var(--text-primary)` |
| **时间** | `size: var(--text-xs)`, `color: var(--text-tertiary)`, `font: var(--font-mono)` |
| **Hover** | `border-color: var(--border-default)`, `shadow: var(--shadow-sm)` |

### 3.18 GuidancePart (终端风格消息)

| 元素 | 规格 |
|------|------|
| **容器** | `radius: var(--radius-sm)`, `bg: #1a1a2e` (固定深色，不随主题), `border: 1px solid #2a2a4a`, `font: var(--font-mono)` |
| **标题栏** | `padding: var(--space-1) var(--space-3)`, `bg: #16162a`, `size: var(--text-xs)`, `tracking: var(--tracking-wide)`, `text-transform: uppercase` |
| **内容** | `padding: var(--space-3)`, `size: var(--text-sm)`, `color: #e2b97f` |
| **状态** | `color: #6ecb63`, `size: var(--text-xs)` |

> 注：GuidancePart 保持固定深色终端风格，不跟随主题切换。

---

## 4. 页面布局规范

### 4.1 全局布局

```
┌─────────────────────────────┐
│        GuestBanner          │  ← 条件显示, 游客模式
├─────────────────────────────┤
│                             │
│                             │
│        Page Content         │  ← flex: 1, overflow-y: auto
│    padding: var(--page-     │
│             padding)        │
│                             │
│                             │
├─────────────────────────────┤
│         TabBar              │  ← sticky bottom, z-sticky
└─────────────────────────────┘
         FloatingPlayer        ← fixed, z-floating
```

### 4.2 Home 页布局

```
┌─────────────────────────────┐
│     PlaybackStatusBoard     │  ← 顶部状态条
├─────────────────────────────┤
│                             │
│     GenerationPreview       │  ← 条件显示 (生成中)
│                             │
├─────────────────────────────┤
│                             │
│       AudioPlayer           │  ← 视觉焦点，居中
│    (Disc + Controls)        │
│                             │
├─────────────────────────────┤
│     InputStatusSection      │  ← 输入框 + 快捷按钮
├─────────────────────────────┤
│      HistoryRecords         │  ← 可滚动列表
└─────────────────────────────┘
```

**状态切换：**
- **空闲态**：AudioPlayer 缩小/隐藏，InputStatusSection 为视觉焦点
- **生成中**：GenerationPreview 展开，显示文字流 + 波形动画
- **播放中**：AudioPlayer 为视觉焦点，唱片旋转，进度条活跃

### 4.3 Chat 页布局

```
┌─────────────────────────────┐
│        HeaderArea           │  ← 欢迎 + 预设模板 (无消息时)
├─────────────────────────────┤
│                             │
│       MessageArea           │  ← flex: 1, 消息列表
│   (ChatLog + Bubbles)       │
│                             │
├─────────────────────────────┤
│  ── gradient-fade-up ──     │  ← 底部渐隐遮罩
│        Composer             │  ← 输入栏，sticky bottom
└─────────────────────────────┘

        OnboardingModal        ← 首次访问弹出
```

### 4.4 Setting 页布局

```
┌─────────────────────────────┐
│        UserSection          │  ← 用户信息卡片
├── section-gap ──────────────┤
│     ThemeModeSection        │
├── section-gap ──────────────┤
│     BasicConfigSection      │
├── section-gap ──────────────┤
│     SpeedConfigSection      │
├── section-gap ──────────────┤
│   FloatingPlayerSection     │
├── section-gap ──────────────┤
│    VoiceServiceSection      │
└─────────────────────────────┘
```

### 4.5 Auth 页布局

```
┌─────────────────────────────┐
│                             │
│         Logo / Title        │  ← text-2xl, gradient-brand
│         Tagline             │  ← text-lg, text-secondary
│                             │
├─────────────────────────────┤
│      Tab (登录 | 注册)       │
├─────────────────────────────┤
│        Form Fields          │
│     [username input]        │
│     [password input]        │
│     [nickname input]*       │  ← 注册时显示
├─────────────────────────────┤
│      [Submit Button]        │  ← Button Primary, full-width
│                             │
│     游客模式入口              │  ← Button Ghost
└─────────────────────────────┘
```

---

## 5. 响应式策略

移动端优先（Mobile-first），基准宽度 375px。

| 断点 Token | 值 | 说明 |
|------------|-----|------|
| `--breakpoint-sm` | `375px` | 小屏手机 |
| `--breakpoint-md` | `428px` | 大屏手机 |
| `--breakpoint-lg` | `768px` | 平板（暂不适配） |

当前阶段只做 375–428px 适配。页面最大宽度 `480px`，居中展示。

---

## 6. 无障碍 (Accessibility)

| 规则 | 要求 |
|------|------|
| 最小触摸目标 | `var(--size-touch-target)` = 44px |
| 对比度 | 文本/背景对比度 ≥ 4.5:1 (WCAG AA) |
| Focus 可见 | 所有交互元素必须有 `focus-visible` 样式 |
| 动画偏好 | 支持 `prefers-reduced-motion: reduce` 时关闭非必要动画 |
| 字号最小值 | 不低于 `var(--text-xs)` = 11px |

---

## 7. 实施指南

### 7.1 Token 文件组织

```
styles/
├── tokens/
│   ├── _colors.scss        # 2.1 颜色 Token
│   ├── _typography.scss    # 2.2 排版 Token
│   ├── _spacing.scss       # 2.3 间距 Token
│   ├── _radius.scss        # 2.4 圆角 Token
│   ├── _shadows.scss       # 2.5 阴影 Token
│   ├── _blur.scss          # 2.6 模糊 Token
│   ├── _motion.scss        # 2.7 动效 Token
│   ├── _z-index.scss       # 2.8 层级 Token
│   ├── _sizing.scss        # 2.9 尺寸 Token
│   └── index.scss          # 汇总导出
├── components/
│   └── _*.scss             # 3.x 组件 Token（可选，按需拆分）
└── index.css               # 全局入口，@import tokens/index
```

### 7.2 命名规则

- CSS 变量统一使用 `--` 前缀 + kebab-case
- 组件级变量可加组件前缀：`--player-disc-size`
- 禁止在组件 `.module.scss` 中定义全局变量
- 禁止使用硬编码的颜色值、间距值、字号值

### 7.3 迁移策略

1. **Phase 1**：创建 Token 文件，定义所有 CSS 变量
2. **Phase 2**：替换全局样式 `styles/index.css` 中的硬编码值
3. **Phase 3**：逐页面迁移组件样式（Home → Chat → Setting → Auth）
4. **Phase 4**：移除旧变量，统一 antd-mobile Token 映射
5. **Phase 5**：视觉走查，微调 Token 数值

### 7.4 Quality Gate

每个 PR 的样式变更必须满足：
- [ ] 所有颜色值引用 Token，不存在硬编码 hex/rgba
- [ ] 所有间距值引用 Token，不存在硬编码 px（除 `1px` border 外）
- [ ] 所有字号值引用 Token
- [ ] Dark / Light 两种主题下视觉验证通过
- [ ] 动画支持 `prefers-reduced-motion`
