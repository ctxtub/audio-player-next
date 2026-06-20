# Design Upgrade v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将应用视觉体系从固定 iOS 系统色升级为 v2 oklch 动态品牌色 + Instrument Serif 编辑字体 + 黑胶唱片播放器 + 完整 Chat 卡片形态。

**Architecture:** 三阶段分层推进——Phase 1 替换全局 CSS Token（`styles/tokens/`），Phase 2 迁移各页面组件 `.module.scss`，Phase 3 重构组件 JSX 结构（authStore、AudioPlayer、HeaderArea、MessageBubble、Settings）。每阶段结束后运行 `yarn build` 验收。

**Tech Stack:** Next.js 15 App Router、React 19、SCSS Modules、Zustand、next/font/google（Instrument Serif + Inter + JetBrains Mono）、lucide-react

---

## Phase 1 — Token 层替换

### Task 1: 更新 `_colors.scss`，添加 oklch 动态 accent 变量

**Files:**
- Modify: `styles/tokens/_colors.scss`

- [ ] **Step 1: 在文件末尾追加 oklch accent 变量块**

打开 `styles/tokens/_colors.scss`，在文件末尾（现有 primitive 色板之后）追加：

```scss
/* ── v2 oklch 动态品牌色 ── */
:root {
  --accent-h: 245;                                               /* 色相控制旋钮，245 ≈ 靛蓝 */
  --accent-500: oklch(66% 0.18 var(--accent-h));
  --accent-400: oklch(74% 0.16 var(--accent-h));
  --accent-300: oklch(82% 0.12 var(--accent-h));
  --accent-tint: oklch(66% 0.18 var(--accent-h) / 0.18);
  --accent-ghost: oklch(66% 0.18 var(--accent-h) / 0.08);
  --accent-glow: oklch(66% 0.22 var(--accent-h) / 0.35);
  --accent2-500: oklch(68% 0.18 calc(var(--accent-h) + 60));     /* 互补色，用于 aurora */
}
```

- [ ] **Step 2: 类型检查**

```bash
yarn tsc --noEmit
```

期望：0 错误（纯 CSS 文件改动，TS 不涉及）。

- [ ] **Step 3: Commit**

```bash
git add styles/tokens/_colors.scss
git commit -m "feat(tokens): 新增 oklch 动态 accent 色相变量"
```

---

### Task 2: 更新 `_colors-dark.scss`，全量替换暗色语义 Token

**Files:**
- Modify: `styles/tokens/_colors-dark.scss`

- [ ] **Step 1: 替换暗色主题语义 Token**

用以下内容完整替换 `styles/tokens/_colors-dark.scss`：

```scss
/* Dark 语义色 — v2 Design Upgrade */
:root[data-theme="dark"] {
  /* 背景层级 */
  --bg-primary:   #09090B;
  --bg-secondary: #141417;
  --bg-tertiary:  #1C1C20;
  --bg-elevated:  rgba(28, 28, 32, 0.72);
  --bg-overlay:   rgba(0, 0, 0, 0.55);

  /* Liquid Glass 表面 */
  --glass-bg:           rgba(30, 30, 34, 0.45);
  --glass-border:       rgba(255, 255, 255, 0.09);
  --glass-border-bright:rgba(255, 255, 255, 0.16);
  --glass-highlight:    inset 0 0.5px 0 rgba(255, 255, 255, 0.14), inset 0 -0.5px 0 rgba(0, 0, 0, 0.3);

  /* 前景 / 文字 */
  --text-primary:    #F5F5F7;
  --text-secondary:  #A8A8B3;
  --text-tertiary:   #76767F;
  --text-inverse:    #09090B;
  --text-on-primary: #ffffff;

  /* 品牌 / 交互 — 引用 oklch 动态变量 */
  --accent-primary:        var(--accent-500);
  --accent-primary-hover:  var(--accent-400);
  --accent-primary-subtle: var(--accent-tint);
  --accent-secondary: oklch(68% 0.18 calc(var(--accent-h) + 60));

  /* 语义状态 */
  --status-success: oklch(72% 0.16 152);
  --status-warning: oklch(78% 0.14 72);
  --status-error:   oklch(68% 0.20 25);
  --status-info:    oklch(74% 0.14 220);

  /* 边框 */
  --border-default: rgba(255, 255, 255, 0.08);
  --border-subtle:  rgba(255, 255, 255, 0.05);
  --border-strong:  rgba(255, 255, 255, 0.14);
  --border-accent:  oklch(66% 0.18 var(--accent-h) / 0.45);

  /* 渐变 */
  --gradient-brand:    linear-gradient(135deg, var(--accent-primary), var(--accent-secondary));
  --gradient-surface:  linear-gradient(180deg, var(--bg-secondary), var(--bg-primary));
  --gradient-fade-down:linear-gradient(180deg, var(--bg-secondary), transparent);
  --gradient-fade-up:  linear-gradient(0deg, var(--bg-primary) 0%, transparent 100%);
  --gradient-glow:     radial-gradient(circle, var(--accent-tint) 0%, transparent 70%);

  /* Aurora 光晕（仅暗色，供 Player/Chat 背景使用） */
  --aurora-primary:   radial-gradient(circle, var(--accent-500) 0%, transparent 70%);
  --aurora-secondary: radial-gradient(circle, var(--accent2-500) 0%, transparent 70%);
}
```

- [ ] **Step 2: 检查构建**

```bash
yarn tsc --noEmit && yarn lint
```

期望：0 错误，0 警告（新增）。

- [ ] **Step 3: Commit**

```bash
git add styles/tokens/_colors-dark.scss
git commit -m "feat(tokens): 替换暗色语义 Token 为 v2 oklch 动态色体系"
```

---

### Task 3: 更新 `_colors-light.scss`，同步亮色语义 Token

**Files:**
- Modify: `styles/tokens/_colors-light.scss`

- [ ] **Step 1: 替换亮色主题语义 Token**

用以下内容完整替换 `styles/tokens/_colors-light.scss`：

```scss
/* Light 语义色 — v2 Design Upgrade */
:root[data-theme="light"] {
  /* 背景层级 */
  --bg-primary:   #F2F2F4;
  --bg-secondary: #FFFFFF;
  --bg-tertiary:  #F7F7F9;
  --bg-elevated:  rgba(255, 255, 255, 0.78);
  --bg-overlay:   rgba(0, 0, 0, 0.35);

  /* Liquid Glass 表面 */
  --glass-bg:           rgba(255, 255, 255, 0.55);
  --glass-border:       rgba(0, 0, 0, 0.06);
  --glass-border-bright:rgba(255, 255, 255, 0.90);
  --glass-highlight:    inset 0 0.5px 0 rgba(255, 255, 255, 0.80), inset 0 -0.5px 0 rgba(0, 0, 0, 0.04);

  /* 前景 / 文字 */
  --text-primary:    #0B0B0E;
  --text-secondary:  #4E4E56;
  --text-tertiary:   #76767F;
  --text-inverse:    #FFFFFF;
  --text-on-primary: #FFFFFF;

  /* 品牌 / 交互 */
  --accent-primary:        var(--accent-500);
  --accent-primary-hover:  var(--accent-400);
  --accent-primary-subtle: var(--accent-tint);
  --accent-secondary: oklch(68% 0.18 calc(var(--accent-h) + 60));

  /* 语义状态 */
  --status-success: oklch(62% 0.18 152);
  --status-warning: oklch(65% 0.16 72);
  --status-error:   oklch(55% 0.22 25);
  --status-info:    oklch(60% 0.16 220);

  /* 边框 */
  --border-default: rgba(0, 0, 0, 0.08);
  --border-subtle:  rgba(0, 0, 0, 0.04);
  --border-strong:  rgba(0, 0, 0, 0.14);
  --border-accent:  oklch(66% 0.18 var(--accent-h) / 0.40);

  /* 渐变 */
  --gradient-brand:    linear-gradient(135deg, var(--accent-primary), var(--accent-secondary));
  --gradient-surface:  linear-gradient(180deg, var(--bg-secondary), var(--bg-primary));
  --gradient-fade-down:linear-gradient(180deg, var(--bg-secondary), transparent);
  --gradient-fade-up:  linear-gradient(0deg, var(--bg-primary) 0%, transparent 100%);
  --gradient-glow:     radial-gradient(circle, var(--accent-tint) 0%, transparent 70%);

  /* Aurora 关闭（亮色模式无 aurora） */
  --aurora-primary:   none;
  --aurora-secondary: none;
}
```

- [ ] **Step 2: Commit**

```bash
git add styles/tokens/_colors-light.scss
git commit -m "feat(tokens): 同步亮色语义 Token 至 v2 体系"
```

---

### Task 4: 扩展 `_typography.scss` + 接入 `next/font/google`

**Files:**
- Modify: `styles/tokens/_typography.scss`
- Modify: `app/layout.tsx`

- [ ] **Step 1: 在 `_typography.scss` 中新增 `--font-display`，调整字体栈顺序**

在 `styles/tokens/_typography.scss` 的 `:root` 块中，将字体族部分替换为：

```scss
  /* 字体族 */
  --font-display: 'Instrument Serif', 'Noto Serif SC', Georgia, serif;
  --font-sans:    'Inter', 'SF Pro Text', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Noto Sans SC', sans-serif;
  --font-mono:    'JetBrains Mono', 'SF Mono', ui-monospace, monospace;
```

（其余字号、字重、行高、字间距保持不变。）

- [ ] **Step 2: 更新 `app/layout.tsx` 接入 next/font**

用以下内容完整替换 `app/layout.tsx`：

```tsx
import React from 'react';
import { Inter, Instrument_Serif, JetBrains_Mono } from 'next/font/google';
import '@/styles/index.scss';
import { ThemeProvider } from '@/components/ThemeProvider';
import {
  FALLBACK_THEME,
  THEME_COLORS,
  INITIAL_THEME_SCRIPT,
} from '@/components/ThemeProvider/themeConfig';

/** Inter：主 sans 字体，覆盖拉丁字符集。 */
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

/** Instrument Serif：展示级衬线字体，加载正常体与斜体。 */
const instrumentSerif = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  style: ['normal', 'italic'],
  variable: '--font-instrument-serif',
  display: 'swap',
});

/** JetBrains Mono：等宽字体，加载 400 与 500 字重。 */
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

/**
 * 应用根布局，注入 next/font 三字体变量与全局 Provider。
 * TabBar / AudioController 等主应用专属布局在 (main)/layout.tsx 中。
 */
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const fontClassName = [
    inter.variable,
    instrumentSerif.variable,
    jetbrainsMono.variable,
  ].join(' ');

  return (
    <html
      lang="zh"
      data-theme={FALLBACK_THEME}
      className={fontClassName}
      suppressHydrationWarning
    >
      <head>
        <title>故事工坊</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
        <meta name="theme-color" content={THEME_COLORS[FALLBACK_THEME]} />
        <script dangerouslySetInnerHTML={{ __html: INITIAL_THEME_SCRIPT }} />
      </head>
      <body>
        <ThemeProvider>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
```

- [ ] **Step 3: 更新 `_typography.scss` 使用 font 变量绑定**

在 `styles/tokens/_typography.scss` 的 `--font-display / --font-sans / --font-mono` 定义之后追加：

```scss
  /* next/font CSS 变量绑定（layout.tsx 注入后生效） */
  --font-display: var(--font-instrument-serif), 'Noto Serif SC', Georgia, serif;
  --font-sans:    var(--font-inter), 'SF Pro Text', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Noto Sans SC', sans-serif;
  --font-mono:    var(--font-jetbrains-mono), 'SF Mono', ui-monospace, monospace;
```

（此处覆盖上一步写的静态定义，next/font 变量优先生效，静态名称作回退。）

- [ ] **Step 4: 类型检查 + 构建验证（Phase 1 完整验收）**

```bash
yarn tsc --noEmit
yarn build
```

期望：build 成功，无 TS 错误。若字体包未安装，先运行 `yarn` 安装依赖。

- [ ] **Step 5: Commit**

```bash
git add styles/tokens/_typography.scss app/layout.tsx
git commit -m "feat(tokens): 新增 --font-display，接入 next/font/google 三字体"
```

---

## Phase 2 — 样式迁移

### Task 5: 全局基础 keyframes（`styles/index.scss`）

**Files:**
- Modify: `styles/index.scss`

- [ ] **Step 1: 在 `styles/index.scss` 末尾追加全局动画 keyframes**

```scss
/* ── v2 全局动画 ── */
@keyframes glowPulse {
  50% { transform: scale(1.08); opacity: 0.8; }
}

@keyframes discSpin {
  to { transform: rotate(360deg); }
}

@keyframes statusPulse {
  50% { opacity: 0.5; }
}
```

- [ ] **Step 2: Lint 检查**

```bash
yarn lint
```

- [ ] **Step 3: Commit**

```bash
git add styles/index.scss
git commit -m "style: 新增全局 v2 动画 keyframes（glowPulse / discSpin / statusPulse）"
```

---

### Task 6: AudioPlayer 唱片 + 进度条 + Transport 样式

**Files:**
- Modify: `app/(main)/player/components/AudioPlayer/index.module.scss`

- [ ] **Step 1: 完整替换 `AudioPlayer/index.module.scss`**

```scss
/* 音频播放器 — v2 Design Upgrade */

.audioPlayer {
  display: flex;
  flex-direction: column;
  width: 100%;
}

/* ── 唱片舞台 ── */
.discStage {
  margin: 48px 0 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
}

.discGlow {
  position: absolute;
  inset: -40px;
  border-radius: 50%;
  background: radial-gradient(circle, var(--accent-glow) 0%, transparent 65%);
  filter: blur(30px);
  animation: glowPulse 4s ease-in-out infinite;

  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
}

.disc {
  width: 220px;
  height: 220px;
  border-radius: 50%;
  position: relative;
  background:
    repeating-radial-gradient(circle at center, rgba(255,255,255,0.02) 0 1px, transparent 1px 3px),
    conic-gradient(from 0deg, #1a1a1e, #2a2a30, #1a1a1e, #28282e, #1a1a1e);
  box-shadow:
    inset 0 0 0 1px rgba(255,255,255,0.06),
    inset 0 0 0 30px rgba(0,0,0,0.15),
    0 30px 60px rgba(0,0,0,0.5);
  animation: discSpin 20s linear infinite;

  &.paused {
    animation-play-state: paused;
  }

  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }

  /* 中心标签宝石 */
  &::after {
    content: '';
    position: absolute;
    inset: 35%;
    border-radius: 50%;
    background: radial-gradient(circle at 30% 30%, var(--accent-300), var(--accent-500) 60%, oklch(40% 0.15 var(--accent-h)) 100%);
    box-shadow: inset 0 0 0 2px rgba(255,255,255,0.1), 0 0 20px var(--accent-glow);
  }

  /* 中心孔 */
  &::before {
    content: '';
    position: absolute;
    inset: 47%;
    border-radius: 50%;
    background: #0a0a0c;
    box-shadow: inset 0 0 0 1px rgba(255,255,255,0.2);
    z-index: 1;
  }
}

/* ── 曲目信息 ── */
.trackInfo {
  text-align: center;
  margin: 20px 16px 0;
}

.trackTitle {
  font-family: var(--font-display);
  font-style: italic;
  font-size: var(--text-xl);
  line-height: 1.2;
  color: var(--text-primary);
  letter-spacing: -0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.trackSub {
  margin-top: 6px;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--text-secondary);
  letter-spacing: 0.04em;
}

/* ── 进度条 ── */
.progress {
  margin: 24px 20px 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.progressTrack {
  height: 4px;
  background: var(--border-default);
  border-radius: var(--radius-full);
  position: relative;
  overflow: visible;
  cursor: pointer;
  transition: height var(--duration-normal) var(--ease-default);

  &:hover {
    height: 6px;
  }
}

.progressFill {
  position: absolute;
  inset: 0 auto 0 0;
  background: linear-gradient(90deg, var(--accent-500), var(--accent-400));
  border-radius: var(--radius-full);
  box-shadow: 0 0 8px var(--accent-glow);
}

.progressTimes {
  display: flex;
  justify-content: space-between;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

/* ── Transport 控制行 ── */
.transport {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 24px 24px 0;
}

.tbtn {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color var(--duration-fast) var(--ease-default);
  border-radius: var(--radius-full);

  &:hover { color: var(--text-primary); }
  &:active { transform: scale(0.90); }
}

.speedPill {
  background: var(--glass-bg);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 0.5px solid var(--glass-border);
  padding: 6px 14px;
  border-radius: var(--radius-full);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--accent-400);
  cursor: pointer;
  transition: all var(--duration-fast) var(--ease-default);

  &:active { transform: scale(0.94); }
}

.playBtn {
  width: 64px;
  height: 64px;
  border-radius: var(--radius-full);
  background: linear-gradient(135deg, var(--accent-400), var(--accent-500));
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  box-shadow: 0 8px 32px var(--accent-glow), 0 8px 24px rgba(0,0,0,0.3);
  transition: all var(--duration-fast) cubic-bezier(0.34, 1.56, 0.64, 1);

  &:hover { transform: scale(1.04); }
  &:active { transform: scale(0.94); }
}

/* ── Speed Menu（保留功能，调整样式） ── */
.speedControl {
  position: relative;
}

.speedMenu {
  backdrop-filter: blur(var(--blur-lg));
  -webkit-backdrop-filter: blur(var(--blur-lg));
  box-shadow: var(--shadow-lg);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background-color: var(--bg-elevated);
  position: absolute;
  left: 0;
  bottom: calc(100% + var(--space-2));
  width: 100px;
  padding: var(--space-2);
  z-index: var(--z-raised);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.speedOption {
  border-radius: var(--radius-sm);
  background-color: transparent;
  transition: var(--transition-colors);
  border: none;
  padding: 6px var(--space-2);
  text-align: center;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--text-primary);
  cursor: pointer;

  &:hover { background-color: var(--accent-primary-subtle); }

  &.active {
    background-color: color-mix(in srgb, var(--accent-primary) 20%, transparent);
    color: var(--accent-primary);
    font-weight: var(--weight-medium);
  }
}

/* CSSTransition 动画类名 */
.speedMenuEnter { opacity: 0; transform: translateY(10px) scale(0.95); }
.speedMenuEnterActive {
  opacity: 1; transform: translateY(0) scale(1);
  transition: opacity var(--duration-normal) var(--ease-out), transform var(--duration-normal) var(--ease-out);
}
.speedMenuExit { opacity: 1; transform: translateY(0) scale(1); }
.speedMenuExitActive {
  opacity: 0; transform: translateY(10px) scale(0.95);
  transition: opacity var(--duration-fast) var(--ease-in), transform var(--duration-fast) var(--ease-in);
}
```

- [ ] **Step 2: Lint**

```bash
yarn lint
```

- [ ] **Step 3: Commit**

```bash
git add "app/(main)/player/components/AudioPlayer/index.module.scss"
git commit -m "style(player): 重写 AudioPlayer 样式，实现 v2 黑胶唱片 + transport"
```

---

### Task 7: HistoryRecords + PlaybackStatusBoard 样式微调

**Files:**
- Modify: `app/(main)/player/components/HistoryRecords/index.module.scss`
- Modify: `app/(main)/player/components/PlaybackStatusBoard/index.module.scss`

- [ ] **Step 1: 更新 `HistoryRecords/index.module.scss` 的字体引用**

找到 `.historyPrompt` 和 `.historyMeta` 规则，将字体更新：

```scss
/* 在 .historyContent 中 */
.historyPrompt {
  /* ... 保留所有现有属性 ... */
  font-family: var(--font-sans);
  font-weight: var(--weight-semibold);  /* 改为 semibold */
}

.historyMeta {
  /* ... 保留所有现有属性 ... */
  font-family: var(--font-mono);          /* 新增 */
  letter-spacing: 0.06em;                 /* 新增 */
}
```

找到 `.historyIndex` 规则，确认使用 `var(--accent-tint)` 背景和 `var(--accent-400)` 前景：

```scss
.historyIndex {
  /* ... 保留所有现有属性 ... */
  background-color: var(--accent-tint);   /* 从 accent-primary-subtle 改为 accent-tint */
  color: var(--accent-400);               /* 从 accent-primary 改为 accent-400 */
}
```

- [ ] **Step 2: 更新 `PlaybackStatusBoard/index.module.scss` 的倒计时样式**

找到 `.countdown` 规则，追加等宽字体：

```scss
&.countdown {
  background: var(--accent-tint);      /* 从 accent-primary-subtle 改为 accent-tint */
  color: var(--accent-400);            /* 从 accent-primary 改为 accent-400 */
  font-family: var(--font-mono);       /* 新增 */
  font-variant-numeric: tabular-nums;  /* 新增 */
}
```

并为状态点（若有 `.dot` 类）追加：
```scss
.statusDot {
  animation: statusPulse 2s ease-in-out infinite;
}
```

- [ ] **Step 3: Commit**

```bash
git add "app/(main)/player/components/HistoryRecords/index.module.scss" \
        "app/(main)/player/components/PlaybackStatusBoard/index.module.scss"
git commit -m "style(player): 历史记录 semibold 标题 + mono 元信息，倒计时 mono 字体"
```

---

### Task 8: Chat HeaderArea 样式 + Composer 样式

**Files:**
- Modify: `app/(main)/chat/components/ChatLayout/HeaderArea.module.scss`
- Modify: `app/(main)/chat/components/Composer/Composer.module.scss`

- [ ] **Step 1: 更新 `HeaderArea.module.scss` 的标题字体**

找到 `.title` 规则，新增 font-display 斜体：

```scss
.title {
  margin: 0;
  font-family: var(--font-display);        /* 新增 */
  font-style: italic;                       /* 新增 */
  font-size: var(--text-lg);
  font-weight: 400;                         /* 改为 400（display 字体不需要 bold） */
  letter-spacing: -0.01em;                  /* 改为 -0.01em */
  background: var(--gradient-brand);
  background-clip: text;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}
```

找到 `.subtitle` 规则，新增 mono 字体：

```scss
.subtitle {
  margin: 0;
  font-family: var(--font-mono);  /* 新增 */
  font-size: var(--text-xs);
  line-height: var(--leading-sm);
  color: var(--text-secondary);
}
```

将 `.avatar` 规则改为支持字母圆（去掉 `object-fit: cover`，改为 flex 居中）：

```scss
.avatar {
  --size: 40px;
  width: var(--size);
  height: var(--size);
  border-radius: var(--radius-md);
  background: var(--gradient-brand);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: var(--weight-semibold);
  font-size: var(--text-base);
  color: var(--text-on-primary);
  flex-shrink: 0;
  box-shadow: 0 4px 12px var(--accent-glow);
}
```

- [ ] **Step 2: 更新 `Composer.module.scss` 发送按钮样式**

找到发送按钮相关样式（通常为 `.sendButton` 或 `.submitButton`），替换背景为品牌渐变：

```scss
.sendButton {  /* 根据实际类名调整 */
  background: var(--gradient-brand);
  box-shadow: 0 4px 16px var(--accent-glow);
  /* 保留其他现有属性 */
}
```

- [ ] **Step 3: Commit**

```bash
git add "app/(main)/chat/components/ChatLayout/HeaderArea.module.scss" \
        "app/(main)/chat/components/Composer/Composer.module.scss"
git commit -m "style(chat): 标题改 display 斜体，头像改 gradient div，发送按钮 gradient-brand"
```

---

### Task 9: MessageParts 样式（storyCard mono 头部 + systemChip）

**Files:**
- Modify: `app/(main)/chat/components/MessageParts/index.module.scss`
- Modify: `app/(main)/chat/components/MessageParts/GuidancePart.module.scss`

- [ ] **Step 1: 在 `MessageParts/index.module.scss` 更新 storyHeader 字体**

找到 `.storyHeader` 规则，追加：

```scss
.storyHeader {
  /* ... 保留所有现有属性 ... */
  font-family: var(--font-mono);      /* 新增 */
  letter-spacing: 0.06em;             /* 新增 */
}
```

- [ ] **Step 2: 在 `index.module.scss` 末尾追加 `.systemChip` 样式**

```scss
/* System 消息 pill 样式 */
.systemChip {
  display: inline-block;
  padding: var(--space-1) var(--space-3);
  background: var(--bg-tertiary);
  border: 0.5px solid var(--border-subtle);
  border-radius: var(--radius-full);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-tertiary);
  letter-spacing: 0.04em;
}
```

- [ ] **Step 3: 更新 `GuidancePart.module.scss`，将内联字体改为变量引用**

找到 `.container` 和 `.content` 规则，确认 `font-family` 引用 `var(--font-mono)`（已有则跳过，否则添加）。

- [ ] **Step 4: Commit**

```bash
git add "app/(main)/chat/components/MessageParts/index.module.scss" \
        "app/(main)/chat/components/MessageParts/GuidancePart.module.scss"
git commit -m "style(chat): storyCard 头部 mono 字体，新增 systemChip pill 样式"
```

---

### Task 10: Settings 页 Hero + UserSection + 行图标样式

**Files:**
- Modify: `app/(main)/setting/index.module.scss`
- Modify: `app/(main)/setting/components/UserSection/index.module.scss`

- [ ] **Step 1: 在 `setting/index.module.scss` 追加 hero 区块样式**

在文件末尾追加：

```scss
/* ── Settings Hero 区块 ── */
.settingsHero {
  padding: var(--space-6) var(--page-padding) var(--space-4);

  .heroLabel {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .heroTitle {
    font-family: var(--font-display);
    font-style: italic;
    font-size: var(--text-xl);
    font-weight: 400;
    letter-spacing: -0.01em;
    color: var(--text-primary);
    margin: var(--space-1) 0 0;
  }
}

/* ── 设置行图标 ── */
.rowIcon {
  width: 14px;
  height: 14px;
  color: var(--text-tertiary);
  flex-shrink: 0;
}
```

- [ ] **Step 2: 在 `UserSection/index.module.scss` 追加 email + plan badge 样式**

在 `UserSection` 模块文件末尾追加：

```scss
/* v2 UserSection 扩展 */
.userEmail {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-tertiary);
  margin-top: 2px;
  letter-spacing: 0.02em;
}

.planBadge {
  font-size: var(--text-xs);
  color: var(--status-success);
  margin-top: var(--space-1);
  letter-spacing: 0.02em;
}
```

- [ ] **Step 3: Phase 2 完整构建验收**

```bash
yarn tsc --noEmit
yarn build
```

期望：build 成功。

- [ ] **Step 4: Commit**

```bash
git add "app/(main)/setting/index.module.scss" \
        "app/(main)/setting/components/UserSection/index.module.scss"
git commit -m "style(setting): 新增 hero 区块 + userEmail + planBadge 样式"
```

---

## Phase 3 — 组件结构重构

### Task 11: `authStore` 新增 `username` 字段

**Files:**
- Modify: `stores/authStore.ts`

- [ ] **Step 1: 在 `AuthState` 中新增 `username` 字段**

找到 `type AuthState`，新增一行：

```ts
type AuthState = {
  isLogin: boolean;
  isGuest: boolean;
  nickname: string;
  username: string;  // 新增
  loading: boolean;
  initialized: boolean;
  error?: string;
};
```

- [ ] **Step 2: 在初始状态中设置 `username` 默认值**

找到 `create<AuthStore>()((set, get) => ({` 初始化块，在 `nickname: ''` 之后新增：

```ts
  nickname: '',
  username: '',  // 新增
```

- [ ] **Step 3: 在 `fetchProfile` 中赋值 `username`**

找到 `fetchProfile` 的 `set(...)` 调用，将 `nickname` 赋值行之后新增：

```ts
  set({
    isLogin: profile.isLogin,
    isGuest: profile.isGuest ?? false,
    nickname: profile.isLogin ? (profile.user?.nickname ?? '') : '',
    username: profile.isLogin ? (profile.user?.username ?? '') : '',  // 新增
    loading: false,
    initialized: true,
    error: undefined,
  });
```

- [ ] **Step 4: 类型检查**

```bash
yarn tsc --noEmit
```

期望：0 错误。

- [ ] **Step 5: Commit**

```bash
git add stores/authStore.ts
git commit -m "feat(auth): authStore 新增 username 字段，从 profile.user.username 读取"
```

---

### Task 12: AudioPlayer JSX 重构（唱片 + trackInfo + transport）

**Files:**
- Modify: `app/(main)/player/components/AudioPlayer/index.tsx`

- [ ] **Step 1: 完整替换 `AudioPlayer/index.tsx`**

```tsx
'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CSSTransition } from 'react-transition-group';
import { Play, Pause, SkipBack, SkipForward, List } from 'lucide-react';
import GlassToast from '@/components/ui/GlassToast';
import { usePlaybackStore, useFloatingPlayer } from '@/stores/playbackStore';
import { useConfigStore } from '@/stores/configStore';
import { useChatStore } from '@/stores/chatStore';
import styles from './index.module.scss';

/**
 * 可选的播放速度列表。
 */
const PLAYBACK_RATES = [
  { value: 0.8, label: '0.8x' },
  { value: 0.9, label: '0.9x' },
  { value: 0.95, label: '0.95x' },
  { value: 1, label: '1x' },
  { value: 1.05, label: '1.05x' },
  { value: 1.1, label: '1.1x' },
  { value: 1.5, label: '1.5x' },
] as const;

/** 将秒数格式化为 mm:ss 字符串。 */
const formatTime = (seconds: number): string => {
  if (!isFinite(seconds) || seconds < 0) return '00:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

/**
 * 播放器主组件：展示黑胶唱片、曲目信息、进度条与 transport 控制行。
 */
const AudioPlayer: React.FC = () => {
  const speedMenuRef = useRef<HTMLDivElement>(null);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);

  const playbackRate = usePlaybackStore((state) => state.playbackRate);
  const currentTime  = usePlaybackStore((state) => state.currentTime);
  const duration     = usePlaybackStore((state) => state.duration);
  const isPlaying    = usePlaybackStore((state) => state.isPlaying);
  const seekAudio    = usePlaybackStore((state) => state.seekAudio);
  const setGlobalPlaybackRate = usePlaybackStore((state) => state.setPlaybackRate);
  const { resume, pause } = useFloatingPlayer();

  /** 最近一次用户输入内容，截断为 20 字作为曲目标题。 */
  const trackTitle = useChatStore((state) => {
    const lastUserMsg = state.messages.findLast((m) => m.role === 'user');
    const text = lastUserMsg?.content ?? '';
    return text.length > 20 ? `${text.slice(0, 20)}…` : text;
  });

  /** 当前选中语音的显示名称。 */
  const voiceLabel = useConfigStore((state) => {
    const { apiConfig, voiceOptions } = state;
    const option = voiceOptions.find((v) => v.value === apiConfig.voiceId);
    return option?.label ?? '—';
  });

  const hasAudio = duration > 0;
  const percent  = hasAudio ? (currentTime / duration) * 100 : 0;

  const togglePlay = useCallback(() => {
    if (isPlaying) {
      pause();
    } else {
      resume();
    }
  }, [isPlaying, pause, resume]);

  const handleProgressClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!hasAudio) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      seekAudio(Math.max(0, Math.min(ratio * duration, duration)));
    },
    [hasAudio, duration, seekAudio],
  );

  const handleSelectPlaybackRate = useCallback(
    (rate: number) => {
      setGlobalPlaybackRate(rate);
      setShowSpeedMenu(false);
    },
    [setGlobalPlaybackRate],
  );

  /** 点击外部关闭速度菜单。 */
  useEffect(() => {
    if (!showSpeedMenu) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(`.${styles.speedControl}`)) {
        setShowSpeedMenu(false);
      }
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [showSpeedMenu]);

  return (
    <div className={styles.audioPlayer}>
      {/* 黑胶唱片 */}
      <div className={styles.discStage}>
        <div className={styles.discGlow} />
        <div className={`${styles.disc} ${!isPlaying ? styles.paused : ''}`} />
      </div>

      {/* 曲目信息 */}
      {(trackTitle || voiceLabel) && (
        <div className={styles.trackInfo}>
          {trackTitle && <div className={styles.trackTitle}>{trackTitle}</div>}
          <div className={styles.trackSub}>
            {hasAudio ? formatTime(duration) : '——'} · {voiceLabel}
          </div>
        </div>
      )}

      {/* 进度条 */}
      <div className={styles.progress}>
        <div
          className={styles.progressTrack}
          onClick={handleProgressClick}
          role="slider"
          aria-valuemin={0}
          aria-valuemax={duration}
          aria-valuenow={currentTime}
          aria-label="播放进度"
        >
          <div className={styles.progressFill} style={{ width: `${percent}%` }} />
        </div>
        <div className={styles.progressTimes}>
          <span>{formatTime(currentTime)}</span>
          <span>-{formatTime(Math.max(0, duration - currentTime))}</span>
        </div>
      </div>

      {/* Transport 控制行 */}
      <div className={styles.transport}>
        {/* 速度 pill */}
        <div className={styles.speedControl}>
          <button
            className={styles.speedPill}
            onClick={(e) => { e.stopPropagation(); setShowSpeedMenu((v) => !v); }}
            aria-label="播放速度"
          >
            {playbackRate}×
          </button>
          <CSSTransition
            in={showSpeedMenu}
            timeout={200}
            classNames={{
              enter: styles.speedMenuEnter,
              enterActive: styles.speedMenuEnterActive,
              exit: styles.speedMenuExit,
              exitActive: styles.speedMenuExitActive,
            }}
            unmountOnExit
            nodeRef={speedMenuRef}
          >
            <div ref={speedMenuRef} className={styles.speedMenu}>
              {PLAYBACK_RATES.map((rate) => (
                <button
                  key={rate.value}
                  className={`${styles.speedOption} ${playbackRate === rate.value ? styles.active : ''}`}
                  onClick={() => handleSelectPlaybackRate(rate.value)}
                >
                  {rate.label}
                </button>
              ))}
            </div>
          </CSSTransition>
        </div>

        {/* 上一曲 */}
        <button className={styles.tbtn} aria-label="上一曲" disabled={!hasAudio}>
          <SkipBack size={22} strokeWidth={1.5} />
        </button>

        {/* 播放/暂停 */}
        <button
          className={styles.playBtn}
          onClick={togglePlay}
          aria-label={isPlaying ? '暂停' : '播放'}
          disabled={!hasAudio}
        >
          {isPlaying
            ? <Pause size={26} strokeWidth={2} />
            : <Play  size={26} strokeWidth={2} />}
        </button>

        {/* 下一曲 */}
        <button className={styles.tbtn} aria-label="下一曲" disabled={!hasAudio}>
          <SkipForward size={22} strokeWidth={1.5} />
        </button>

        {/* 历史列表（占位，暂不触发弹层） */}
        <button className={styles.tbtn} aria-label="历史记录">
          <List size={22} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  );
};

export default AudioPlayer;
```

- [ ] **Step 2: 类型检查**

```bash
yarn tsc --noEmit
```

期望：0 错误。若报 `useFloatingPlayer` 相关类型错误，确认 `playbackStore.ts` 中导出 `useFloatingPlayer`（现有代码已有此导出）。

- [ ] **Step 3: Commit**

```bash
git add "app/(main)/player/components/AudioPlayer/index.tsx"
git commit -m "feat(player): AudioPlayer 重构为黑胶唱片 + trackInfo + transport 布局"
```

---

### Task 13: Chat HeaderArea JSX — img 替换为字母圆圈 div

**Files:**
- Modify: `app/(main)/chat/components/ChatLayout/HeaderArea.tsx`

- [ ] **Step 1: 移除 next/image 导入，替换头像为 div**

找到文件顶部：

```tsx
import Image from 'next/image';
import { avatarAssistant } from '@/lib/assets/avatars';
```

删除这两行。

找到 JSX 中的 `<Image>` 元素：

```tsx
<Image
  className={styles.avatar}
  src={avatarAssistant}
  alt="Agent助手头像"
  unoptimized
/>
```

替换为：

```tsx
<div className={styles.avatar} aria-hidden="true">A</div>
```

- [ ] **Step 2: 类型检查**

```bash
yarn tsc --noEmit
```

期望：0 错误。

- [ ] **Step 3: Commit**

```bash
git add "app/(main)/chat/components/ChatLayout/HeaderArea.tsx"
git commit -m "feat(chat): HeaderArea 头像从 next/image 改为 display 字母圆圈 div"
```

---

### Task 14: MessageBubble — system role pill 渲染分支

**Files:**
- Modify: `app/(main)/chat/components/ChatLog/MessageBubble/index.tsx`

- [ ] **Step 1: 在 `MessageBubble` 组件中添加 system 消息的早期返回**

找到 `const MessageBubble: FC<MessageBubbleProps> = ...` 函数体的开头（在 `const status = ...` 之后），在 `return (` 之前插入以下早期返回：

```tsx
  // system / developer / function / tool 消息渲染为居中 pill，不展示头像与气泡框
  if (roleKey === 'system' || roleKey === 'developer' || roleKey === 'function' || roleKey === 'tool') {
    const textContent = messageParts
      .filter((p): p is { type: 'text'; content: string } => p.type === 'text')
      .map((p) => p.content)
      .join('');
    if (!textContent) return null;
    return (
      <div className={styles.rowSystem}>
        <span className={styles.systemChip}>{textContent}</span>
      </div>
    );
  }
```

同时在 `MessageBubble.module.scss` 中确认 `styles.systemChip` 已定义（Task 9 已添加到 `index.module.scss`）。

由于 `systemChip` 定义在 `MessageParts/index.module.scss` 而非 `MessageBubble.module.scss`，需在 `MessageBubble.module.scss` 末尾也追加该样式：

```scss
/* System 消息 pill */
.systemChip {
  display: inline-block;
  padding: var(--space-1) var(--space-3);
  background: var(--bg-tertiary);
  border: 0.5px solid var(--border-subtle);
  border-radius: var(--radius-full);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-tertiary);
  letter-spacing: 0.04em;
}
```

- [ ] **Step 2: 类型检查**

```bash
yarn tsc --noEmit
```

期望：0 错误。

- [ ] **Step 3: Commit**

```bash
git add "app/(main)/chat/components/ChatLog/MessageBubble/index.tsx" \
        "app/(main)/chat/components/ChatLog/MessageBubble/MessageBubble.module.scss"
git commit -m "feat(chat): MessageBubble 新增 system role pill 渲染分支"
```

---

### Task 15: Setting 页 Hero 区块 JSX

**Files:**
- Modify: `app/(main)/setting/index.tsx`

- [ ] **Step 1: 在 `ConfigPage` return 中插入 hero 区块**

找到 `return (` 内的 `<div className={styles.configPage}>` 开标签，在其紧接内部、第一个子元素之前插入：

```tsx
<div className={styles.settingsHero}>
  <div className={styles.heroLabel}>Settings</div>
  <h1 className={styles.heroTitle}>个人空间</h1>
</div>
```

- [ ] **Step 2: 类型检查**

```bash
yarn tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add "app/(main)/setting/index.tsx"
git commit -m "feat(setting): 新增 Settings hero 区块（Settings label + 个人空间 h1）"
```

---

### Task 16: UserSection — username + plan badge

**Files:**
- Modify: `app/(main)/setting/components/UserSection/index.tsx`

- [ ] **Step 1: 从 `authStore` 读取 `username`**

找到现有 `const nickname = useAuthStore(state => state.nickname);` 一行，在其下方追加：

```tsx
const username = useAuthStore(state => state.username);
```

- [ ] **Step 2: 在 JSX 的用户信息区域添加 username 和 plan badge**

找到渲染 `displayNickname` 的 `<span>` 之后，插入：

```tsx
<span className={styles.nickname}>{displayNickname}</span>
{username && (
  <span className={styles.userEmail}>{username}</span>
)}
{isLogin && (
  <span className={styles.planBadge}>● 故事工坊用户</span>
)}
```

- [ ] **Step 3: 类型检查**

```bash
yarn tsc --noEmit
```

期望：0 错误（`username` 已在 Task 11 中添加到 `AuthState`）。

- [ ] **Step 4: Commit**

```bash
git add "app/(main)/setting/components/UserSection/index.tsx"
git commit -m "feat(setting): UserSection 展示 username 和 plan badge"
```

---

### Task 17: Settings 各 Section 添加行图标

**Files:**
- Modify: `app/(main)/setting/components/BasicConfigSection.tsx`
- Modify: `app/(main)/setting/components/SpeedConfigSection.tsx`
- Modify: `app/(main)/setting/components/FloatingPlayerSection.tsx`
- Modify: `app/(main)/setting/components/ThemeModeSection.tsx`
- Modify: `app/(main)/setting/components/VoiceServiceSection.tsx`

- [ ] **Step 1: 更新 `BasicConfigSection.tsx` 行图标**

在文件顶部 import 区域追加：

```tsx
import { Clock } from 'lucide-react';
import styles from '../index.module.scss';
```

（若已有 `styles` 导入则跳过。）

在渲染播放时长的行最前方，包裹图标：

```tsx
<Clock size={14} className={styles.rowIcon} />
```

- [ ] **Step 2: 更新 `SpeedConfigSection.tsx`**

```tsx
import { Gauge } from 'lucide-react';
// 在倍速行最前方添加：
<Gauge size={14} className={styles.rowIcon} />
```

- [ ] **Step 3: 更新 `FloatingPlayerSection.tsx`**

```tsx
import { Layers } from 'lucide-react';
// 在悬浮播放器开关行最前方添加：
<Layers size={14} className={styles.rowIcon} />
```

- [ ] **Step 4: 更新 `ThemeModeSection.tsx`**

```tsx
import { Sun } from 'lucide-react';
// 在主题模式行最前方添加：
<Sun size={14} className={styles.rowIcon} />
```

- [ ] **Step 5: 更新 `VoiceServiceSection.tsx`**

```tsx
import { Volume2 } from 'lucide-react';
// 在语音行最前方添加：
<Volume2 size={14} className={styles.rowIcon} />
```

- [ ] **Step 6: 类型检查**

```bash
yarn tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add "app/(main)/setting/components/BasicConfigSection.tsx" \
        "app/(main)/setting/components/SpeedConfigSection.tsx" \
        "app/(main)/setting/components/FloatingPlayerSection.tsx" \
        "app/(main)/setting/components/ThemeModeSection.tsx" \
        "app/(main)/setting/components/VoiceServiceSection.tsx"
git commit -m "feat(setting): 各 Section 行头新增 lucide-react 图标"
```

---

### Task 18: Phase 3 最终验收

- [ ] **Step 1: 完整类型检查 + Lint**

```bash
yarn tsc --noEmit
yarn lint
```

期望：0 错误，0 新增警告。

- [ ] **Step 2: 完整构建**

```bash
yarn build
```

期望：build 成功，无 TS / SCSS 编译错误。

- [ ] **Step 3: 功能回归 QA 清单（手动检查）**

启动开发服务器：

```bash
yarn dev
```

逐项验证：

**Chat 页：**
- [ ] 消息气泡：text 类型气泡正常显示
- [ ] storyCard 生成中（`generating_text`）：星星图标 + mono 头部文案 + 打字机光标
- [ ] storyCard 生成音频（`generating_audio`）：波形蒙层
- [ ] storyCard 就绪（`ready`）：「查看全文」+「播放故事」按钮
- [ ] storyCard 播放中（`playing`）：「暂停播放」按钮 + 高亮边框
- [ ] guidance：终端深色固定，不随主题切换
- [ ] summary：文件图标 + 「上下文总结」标签 + 摘要文字
- [ ] system 消息：居中 pill，无头像，font-mono 灰色
- [ ] HeaderArea：字母圆圈头像，display 斜体标题，mono 副标题，glass 背景
- [ ] Composer：发送按钮 gradient-brand

**Player 页：**
- [ ] 黑胶唱片：播放时旋转，暂停时静止
- [ ] 光晕（discGlow）：pulse 动画
- [ ] trackInfo 区块：若有曲目内容则显示标题 + 时长 · 语音名
- [ ] 进度条：点击跳转，数字 tabular-nums
- [ ] transport：速度 pill 在左侧，64px 圆形播放按钮居中
- [ ] 速度菜单：弹出 / 关闭正常

**Settings 页：**
- [ ] Hero 区块：「Settings」mono 小标签 + 「个人空间」display 斜体
- [ ] 已登录：UserSection 显示 nickname、username、「● 故事工坊用户」
- [ ] 访客：仅显示「访客」，无 username 和 plan badge
- [ ] 各 Section 行头有图标

**主题切换：**
- [ ] Dark → Light 切换：背景、accent 色、文字正确响应
- [ ] aurora 变量：Dark 下有光晕效果定义，Light 下关闭

- [ ] **Step 4: 最终 Commit**

```bash
git add -A
git commit -m "feat: Design Upgrade v2 完整交付（Token + 样式 + 组件结构）"
```

---

## 自查说明

**Spec 覆盖：**
- Token 层（Phase 1）→ Tasks 1-4 ✅
- 样式迁移（Phase 2）→ Tasks 5-10 ✅
- authStore username → Task 11 ✅
- AudioPlayer 结构重构 → Task 12 ✅
- HeaderArea 头像 → Task 13 ✅
- system 消息 pill → Task 14 ✅
- Settings hero → Task 15 ✅
- UserSection 扩展 → Task 16 ✅
- Section 行图标 → Task 17 ✅

**边界确认：**
- GuidancePart 终端深色（`#1a1a2e`）不随主题变化 — Task 9 中仅更新字体变量引用，背景色保留
- `SkipBack` / `SkipForward` 按钮当前为 disabled 占位，不触发业务逻辑（上下曲功能不在本计划范围内）
- `List` 按钮（历史记录）同上，占位不触发弹层
