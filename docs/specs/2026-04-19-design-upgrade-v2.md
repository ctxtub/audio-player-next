# Design Upgrade v2 — 实施设计文档

> 来源：claude.ai/design 导出包（Design Upgrade v2.html）  
> 原则：只动 Token 与样式层 + 组件结构，不动业务逻辑 / 状态机 / 路由

---

## 背景与目标

将现有 iOS 26 Liquid Glass 风格升级为 v2 设计语言：

- **颜色系统**：从固定 iOS 系统色迁移至 oklch 动态品牌色（可调色相）
- **字体系统**：新增 Instrument Serif 展示字体 + JetBrains Mono 等宽字体
- **视觉升级**：唱片黑胶纹理、aurora 光晕、display 斜体标题、终端风格 Guidance 卡片
- **结构重构**：AudioPlayer、Chat 卡片形态枚举、Settings 页重组

---

## 实施策略：三阶段分层推进

| 阶段 | 内容 | 可独立验证 |
|------|------|-----------|
| **阶段 1** | Token 层替换 | ✅ 构建通过即可 |
| **阶段 2** | 样式迁移（三页 module.scss） | ✅ 逐页视觉对比 |
| **阶段 3** | 组件结构重构 | ✅ 功能回归测试 |

---

## 阶段 1：Token 层替换

### 1.1 颜色系统重构

**文件**：`styles/tokens/_colors.scss`、`_colors-dark.scss`、`_colors-light.scss`

新增 oklch 动态 accent 色相变量，保留所有语义 Token 名称（组件代码零改动）：

```scss
// _colors.scss 新增
:root {
  --accent-h: 245;                                          // 色相控制变量（可主题化）
  --accent-500: oklch(66% 0.18 var(--accent-h));
  --accent-400: oklch(74% 0.16 var(--accent-h));
  --accent-300: oklch(82% 0.12 var(--accent-h));
  --accent-tint: oklch(66% 0.18 var(--accent-h) / 0.18);
  --accent-ghost: oklch(66% 0.18 var(--accent-h) / 0.08);
  --accent-glow: oklch(66% 0.22 var(--accent-h) / 0.35);
}
```

Dark 主题背景色更新（`_colors-dark.scss`）：

| 变量 | 旧值 | 新值 |
|------|------|------|
| `--bg-primary` | `#000000` | `#09090B` |
| `--bg-secondary` | `#1C1C1E` | `#141417`（新命名 bg-rise）|
| `--bg-tertiary` | `#2C2C2E` | `#1C1C20` （新命名 bg-high）|
| `--accent-primary` | `#0A84FF` | `var(--accent-500)` |
| `--accent-primary-hover` | `#409CFF` | `var(--accent-400)` |
| `--accent-primary-subtle` | `rgba(10,132,255,0.18)` | `var(--accent-tint)` |
| `--glass-bg` | `rgba(38,38,40,0.50)` | `rgba(30,30,34,0.45)` |
| `--glass-border` | `rgba(255,255,255,0.12)` | `rgba(255,255,255,0.09)` |
| `--glass-border-bright`（新增）| — | `rgba(255,255,255,0.16)` |

新增 aurora 渐变变量（dark only）：
```scss
--aurora-primary: radial-gradient(circle, var(--accent-500) 0%, transparent 70%);
--aurora-secondary: radial-gradient(circle, oklch(68% 0.18 calc(var(--accent-h) + 60)) 0%, transparent 70%);
```

### 1.2 字体系统扩展

**文件**：`styles/tokens/_typography.scss`

```scss
:root {
  --font-display: 'Instrument Serif', 'Noto Serif SC', Georgia, serif;  // 新增
  --font-sans: 'Inter', 'SF Pro Text', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Noto Sans SC', sans-serif;  // Inter 提到首位
  --font-mono: 'JetBrains Mono', 'SF Mono', ui-monospace, monospace;   // JetBrains Mono 提到首位
}
```

字号规模与行高保持 8 级不变。

### 1.3 字体加载（`app/layout.tsx`）

通过 `next/font/google` 自托管，消除运行时外部依赖：

```tsx
import { Inter, Instrument_Serif, JetBrains_Mono } from 'next/font/google';

const inter = Inter({ subsets: ['latin'], variable: '--font-sans-loaded' });
const instrumentSerif = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  style: ['normal', 'italic'],
  variable: '--font-display-loaded',
});
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono-loaded',
});
```

将 `className` 注入到 `<html>` 元素，让 CSS 变量生效。

### 1.4 DESIGN_SPEC.md 同步

整体替换为 v2 规范，涵盖：新颜色 Token 表、三字体族、aurora 变量说明。

---

## 阶段 2：样式迁移

### 2.1 全局基础（`styles/index.scss`）

- `body` 背景色引用新 `--bg-primary`（`#09090B`）
- 新增 `.aurora` 伪元素 keyframes：`glowPulse`（光晕缩放）、`spin`（唱片旋转）
- `@keyframes pulse`（状态点脉冲）移入全局，供 PlaybackStatusBoard 使用

### 2.2 Player 页样式

**`AudioPlayer/index.module.scss`**（唱片视觉完全重写）：

```scss
.discStage { position: relative; display: flex; align-items: center; justify-content: center; }

.discGlow {
  position: absolute; inset: -40px; border-radius: 50%;
  background: radial-gradient(circle, var(--accent-glow) 0%, transparent 65%);
  filter: blur(30px);
  animation: glowPulse 4s ease-in-out infinite;
}

.disc {
  width: 220px; height: 220px; border-radius: 50%;
  background:
    repeating-radial-gradient(circle at center, rgba(255,255,255,0.02) 0 1px, transparent 1px 3px),
    conic-gradient(from 0deg, #1a1a1e, #2a2a30, #1a1a1e, #28282e, #1a1a1e);
  box-shadow: inset 0 0 0 1px rgba(255,255,255,0.06), 0 30px 60px rgba(0,0,0,0.5);
  animation: spin 20s linear infinite;

  &.paused { animation-play-state: paused; }

  // 中心宝石标签
  &::after {
    content: ''; position: absolute; inset: 35%; border-radius: 50%;
    background: radial-gradient(circle at 30% 30%, var(--accent-300), var(--accent-500) 60%);
    box-shadow: inset 0 0 0 2px rgba(255,255,255,0.1), 0 0 20px var(--accent-glow);
  }
  // 中心孔
  &::before {
    content: ''; position: absolute; inset: 47%; border-radius: 50%;
    background: #0a0a0c;
    box-shadow: inset 0 0 0 1px rgba(255,255,255,0.2);
    z-index: 1;
  }
}
```

进度条：`height: 4px`，hover 时 `6px`，填充色改用 `var(--accent-500)`，带 `box-shadow: 0 0 8px var(--accent-glow)`。

**`PlaybackStatusBoard`**：状态点 `background: var(--status-ok)` + `animation: pulse`，倒计时用 `font-family: var(--font-mono)` + `color: var(--accent-400)`。

**`HistoryRecords/index.module.scss`**：
- 标题改为 `font-family: var(--font-sans)`、`font-weight: var(--weight-semibold)`
- 元信息用 `font-family: var(--font-mono)`、`font-size: var(--text-xs)`、`letter-spacing: 0.06em`
- 序号圆点背景：`var(--accent-tint)`，文字：`var(--accent-400)`

### 2.3 Chat 页样式

**`ChatLayout/HeaderArea.module.scss`**：
- 容器：`background: var(--glass-bg); backdrop-filter: var(--glass-blur); border-radius: 0 0 var(--radius-xl) var(--radius-xl)`
- 头像字母圆：`background: var(--gradient-brand); border-radius: var(--radius-md); width: 40px; height: 40px`
- 标题：`font-family: var(--font-display); font-style: italic; background: var(--gradient-brand); -webkit-background-clip: text; color: transparent`
- 副标题：`font-family: var(--font-mono); font-size: var(--text-xs)`

**`MessageParts/index.module.scss`**（storyCard 头部、summary 文件卡样式已存在，微调即可）：
- `.storyHeader` 用 `font-family: var(--font-mono)` 渲染状态元信息
- `.summaryContainer` 更新背景为 `color-mix(in srgb, var(--accent-primary) 5%, transparent)`，图标改为 SVG（而非 emoji）

新增 `.systemChip`（system 消息 pill 样式）：
```scss
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

**`GuidancePart.module.scss`**：将 `font-family` 内联值改为引用 `var(--font-mono)`（已符合终端风格，无结构改动）。

**`Composer`**：输入框容器 `border-radius: var(--radius-lg)`，发送按钮 `background: var(--gradient-brand); box-shadow: var(--shadow-accent)`。

### 2.4 Setting 页样式

**`setting/index.module.scss`** 新增：
```scss
.settingsHero {
  padding: var(--space-6) var(--page-padding) var(--space-4);
  .heroLabel { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--text-tertiary); letter-spacing: 0.08em; text-transform: uppercase; }
  .heroTitle  { font-family: var(--font-display); font-style: italic; font-size: var(--text-xl); font-weight: 400; letter-spacing: -0.01em; margin-top: var(--space-1); }
}
```

**`UserSection/index.module.scss`** 扩展：
```scss
.userEmail { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--text-tertiary); margin-top: 2px; }
.planBadge { font-size: var(--text-xs); color: var(--status-success); margin-top: var(--space-1); }
```

各 Section 组件行图标：`.rowIcon { width: 14px; height: 14px; color: var(--text-tertiary); flex-shrink: 0; }`

---

## 阶段 3：组件结构重构

### 3.1 AudioPlayer（`app/(main)/player/components/AudioPlayer/index.tsx`）

**结构变化**：播放按钮从唱片内部移出，唱片成为纯旋转装饰，transport 独立成行。

新 JSX 骨架：
```tsx
<div className={styles.audioPlayer}>
  {/* 唱片区 */}
  <div className={styles.discStage}>
    <div className={styles.discGlow} />
    <div className={cn(styles.disc, !isPlaying && styles.paused)} />
  </div>

  {/* 曲目信息 */}
  <div className={styles.trackInfo}>
    <div className={styles.trackTitle}>{title}</div>          {/* font-display italic */}
    <div className={styles.trackSub}>{duration} · {voice}</div> {/* font-mono */}
  </div>

  {/* 进度条 */}
  <div className={styles.progress}>
    <div className={styles.progressBar}>
      <div className={styles.progressFill} style={{ width: `${percent}%` }} />
      <div className={styles.progressScrub} style={{ left: `${percent}%` }} />
    </div>
    <div className={styles.progressTimes}>
      <span>{currentTimeStr}</span>
      <span>-{remainingStr}</span>
    </div>
  </div>

  {/* 传输控制 */}
  <div className={styles.transport}>
    <button className={styles.speedPill}>{playbackRate}×</button>
    <button className={styles.tbtn}>{/* prev */}</button>
    <button className={styles.playBtn} onClick={handlePlayPause}>{/* play/pause icon */}</button>
    <button className={styles.tbtn}>{/* next */}</button>
    <button className={styles.tbtn}>{/* list */}</button>
  </div>
</div>
```

`title` 降级取自 `chatStore` 最后一条用户消息内容（截断至 20 字）；`voice` 从 `configStore.apiConfig.voiceId` 取名称；`duration` / `currentTime` 来自 `playbackStore`。若均无值则隐藏 `trackInfo` 区块。

### 3.2 HeaderArea（`app/(main)/chat/components/ChatLayout/HeaderArea.tsx`）

将 `<Image>` 替换为字母圆圈 `<div>`：
```tsx
// 旧
<Image src={avatarAssistant} ... />

// 新
<div className={styles.avatar}>A</div>
```

标题和副标题 className 引用更新后的 `font-display` 样式。

### 3.3 MessageBubble — system role 分支

**文件**：`app/(main)/chat/components/ChatLog/MessageBubble/index.tsx`

在渲染逻辑中增加 system role 分支：
```tsx
if (message.role === 'system') {
  return (
    <div className={styles.rowSystem}>
      <span className={styles.systemChip}>{message.content}</span>
    </div>
  );
}
```

`.systemChip` 对应 2.3 节中定义的样式。

### 3.4 Settings — Hero 区块

**文件**：`app/(main)/setting/index.tsx`

在 `<div className={styles.configPage}>` 内顶部插入：
```tsx
<div className={styles.settingsHero}>
  <div className={styles.heroLabel}>Settings</div>
  <h1 className={styles.heroTitle}>个人空间</h1>
</div>
```

### 3.5 UserSection — username + plan badge

**`stores/authStore.ts`**：
- `AuthState` 新增 `username: string`
- `fetchProfile` 中赋值：`username: profile.user?.username ?? ''`

**`UserSection/index.tsx`** 新增展示：
```tsx
<div className={styles.userEmail}>{username || '—'}</div>
{isLogin && <div className={styles.planBadge}>● 故事工坊用户</div>}
```

### 3.6 Settings Section 行图标

各 Section 组件（`BasicConfigSection`、`SpeedConfigSection`、`FloatingPlayerSection`、`ThemeModeSection`、`VoiceServiceSection`）每行左侧新增 `<span className={styles.rowIcon}><SomeIcon size={14} /></span>`，使用 lucide-react 图标，与 v2 设计对应。

---

## 文件变动汇总

### 阶段 1
```
styles/tokens/_colors.scss           + oklch accent 变量 + aurora 变量
styles/tokens/_colors-dark.scss      ~ bg / glass / accent 全量替换
styles/tokens/_colors-light.scss     ~ 同步更新 light 值
styles/tokens/_typography.scss       + --font-display; ~ font-mono 栈顺序
app/layout.tsx                       + next/font/google 三字体
DESIGN_SPEC.md                       ~ 整体替换为 v2 规范
```

### 阶段 2
```
styles/index.scss                    + aurora keyframes + pulse keyframe
app/(main)/player/components/
  AudioPlayer/index.module.scss      ~ 唱片 discStage/discGlow/disc + progress + transport
  PlaybackStatusBoard/*.module.scss  ~ pulse + mono 时间色
  HistoryRecords/index.module.scss   ~ 标题 semibold + 元信息 mono
  InputStatusSection/*.module.scss   ~ glass 卡片边框
app/(main)/chat/components/
  ChatLayout/HeaderArea.module.scss  ~ glass 头部 + display 标题 + mono 副标题
  MessageParts/index.module.scss     ~ storyHeader mono + .systemChip 新增
  MessageParts/GuidancePart.module.scss  ~ font-mono 变量引用
  Composer/*.module.scss             ~ radius-lg + gradient-brand 发送按钮
app/(main)/setting/
  index.module.scss                  + .settingsHero / .heroLabel / .heroTitle
  components/UserSection/index.module.scss  + .userEmail / .planBadge
  components/*.tsx                   + .rowIcon（各 Section）
```

### 阶段 3
```
stores/authStore.ts                                    + username 字段
app/(main)/player/components/AudioPlayer/index.tsx     ~ 结构重构（唱片+trackInfo+transport）
app/(main)/chat/components/ChatLayout/HeaderArea.tsx   ~ img → div 字母头像
app/(main)/chat/components/ChatLog/MessageBubble/index.tsx  + system role 分支
app/(main)/setting/index.tsx                           + settingsHero JSX
app/(main)/setting/components/UserSection/index.tsx    + username + planBadge JSX
app/(main)/setting/components/*.tsx                    + rowIcon（各 Section）
```

---

## 约束与边界

- **不改动**：业务逻辑、tRPC router、Zustand store 核心状态机、路由结构
- **不新增功能**：设计稿中出现的"推测性新功能"（Aurora 开关、密度切换等）均不实现
- **GuidancePart 终端风格**：固定深色 `#1a1a2e`，不跟随主题切换——此为有意设计
- **字体回退**：若 Google Fonts 加载失败，`--font-display` 回退到 `Noto Serif SC, Georgia`

## QA 检查清单

- [ ] `yarn lint` 无报错
- [ ] `yarn tsc --noEmit` 无类型错误
- [ ] `yarn build` 成功
- [ ] Dark / Light 两主题视觉对比通过
- [ ] ChatLog：text / storyCard（4 个阶段）/ guidance / summary / system / sending / failed 全部形态验证
- [ ] Player：idle / generating / playing 三状态验证
- [ ] Settings：已登录 / 访客 / 未登录三态验证
- [ ] `prefers-reduced-motion` 下动画关闭
