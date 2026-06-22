# CLAUDE.md

## 项目概览

Next.js 15 + React 19 + TypeScript 5 音频播放应用，使用 App Router、antd-mobile 5、tRPC 11、Zustand、Prisma 7（libsql）、LangGraph 多 Agent 系统。包管理器为 yarn。

## 核心架构

### LangGraph 多 Agent（Supervisor 模式）
`lib/agent/` 下五个节点：
- supervisor：路由节点，分析用户意图并分发任务
- story：故事创作 Agent
- chat：闲聊服务 Agent
- guidance：系统指令/剧情引导 Agent，处理干预指令或描述性设定
- audio：音频生成节点（非 LLM），负责 TTS 合成

通过 `lib/trpc/routers/agent.ts` 的 `graph.invoke/streamEvents` 调用。Agent 输出 `user_intent` 供前端切换 UI 状态（Chat/Story/Guidance 模式）。

### tRPC API 层
`lib/trpc/` 提供类型安全 API：
- routers：chat、story、tts、auth、agent
- 认证：`context.ts` 用 `@/lib/session` 解码 auth cookie；`routers/auth.ts` 依赖 Prisma + bcryptjs
- `schemas/` 下 Zod Schema 前后端复用（表单校验 + 接口参数校验）

### 业务流程编排
`app/services/` 连接前端与后端：
- storyFlow：故事生成与音频播放（首页）
- chatFlow：对话交互，支持根据 Agent 意图动态切换展示卡片
- agentFlow：统一 Agent 交互服务

### 状态管理
`stores/` 下 Zustand stores：
- configStore：应用配置（播放时长、首选语音、浮动播放器开关）
- playbackStore：播放进度、音频地址、音频控制器、倒计时
- generationStore：生成过程（流式文本、生成阶段 phase）
- chatStore：聊天会话与流式消息，支持根据 Intent 动态切换助手卡片类型
- authStore：登录态管理
- preloadStore：音频预加载状态

### 关键环境变量
`OPENAI_MODEL_STORY`（故事模型）、`OPENAI_MODEL_AGENT`（Agent 模型）必填。TTS 通过 `OPENAI_TTS_*` 系列变量控制。LangSmith Tracing 可选。数据库本地 SQLite，Docker 生产路径 `/app/data/app.db`。详见 `.env.sample`。

## 常用命令

- `yarn dev` — 启动开发服务器（Turbopack）
- `yarn build` — 生产构建
- `yarn lint` — ESLint 检查
- `yarn tsc --noEmit` — 类型检查（无独立脚本，直接调用）
- `yarn docker:build` / `yarn docker:up` — Docker 构建与启动

## 编码规范

### TypeScript
- 遵循 `tsconfig.json` 的 `strict: true`；禁止 `any` 和非必要类型断言
- 新增类型优先放 `types/` 或贴近领域的 `app/**/types/`

### React
- 默认编写 Server Component；仅在需要浏览器能力时添加 `use client` 并限制在最小组件
- 客户端副作用集中在 `useEffect`，避免全局单例修改

### 目录约定
- 页面私有实现放页面同级子目录（如 `app/(main)/feature/components/`）
- 跨页面复用的 UI/逻辑归档至根部 `components/`、`utils/`、`hooks/`，按领域细分
- 禁止从页面私有目录跨页引用

### 样式
- 共享样式放 `styles/`，组件私有样式用 `*.module.scss` 与组件共存
- 类名使用小驼峰，选择器按父子层级嵌套

### 数据与状态
- 数据请求置于 Server Actions、`app/api/*` Route 或 `lib/` 服务层
- 全局状态使用 `stores/` 内的 Zustand store；页面内部优先 `useState`/`useReducer`
- `axios` 统一在 `utils/http/` 封装，组件内不得直接创建新实例

### 导入路径
- 使用 `@/*` 别名，按"远到近"排序：第三方 npm → `@/` 别名 → 当前目录相对路径
- 禁止破坏目录边界的"倒灌式"依赖

### 注释
- 首层函数与变量必须编写中文注释；函数说明职责及入参/返回，变量说明用途与取值来源

### 代码质量
- 遵循 `eslint.config.mjs` 与 `eslint-config-next`
- SVG 资产通过 `@svgr/webpack` 处理

## 设计规范

UI 设计的唯一规范来源为 [DESIGN_SPEC.md](DESIGN_SPEC.md)。所有样式必须引用其中定义的 Design Token，禁止硬编码数值。

## 规范驱动开发（Spec-Driven Development）

非平凡任务采用 SDD：**先写规范与计划，再编码**，过程文档沉淀到仓库内，使决策可追溯、变更可复盘。

### 适用范围

- **必须留档**：新功能、跨模块重构、架构调整、数据模型/接口变更、影响多页面的设计改动。
- **可豁免**：纯 bugfix、文案修改、依赖升级、局部样式微调、重命名等低风险小改动。
- 判断原则：若改动需要做方案取舍，或会影响他人理解/后续维护，按非平凡处理。

### 文档结构

```
docs/
  specs/    # 设计规范：需求 + 设计 + 方案权衡 + 验收标准
  plans/    # 实施计划：可独立验证的任务拆解，与对应 spec 配套
```

- 命名统一为 `YYYY-MM-DD-<topic>.md`；同一任务的 spec 与 plan 同名以便配对。

### 工作流

1. **Spec** — 写 `docs/specs/`：目标、约束、方案对比、验收标准。
2. **Plan** — 写 `docs/plans/`：拆成可独立验证的步骤。
3. **Implement** — 按 plan 编码。
4. **Verify** — 跑 `yarn lint`、`yarn tsc --noEmit`、`yarn build`，并按「端到端验证」走一遍浏览器活体；结果落档。

### 与其他文档的关系

- [DESIGN_SPEC.md](DESIGN_SPEC.md) 是**跨任务**的 UI 设计 Token 规范（横切 SSOT）；`docs/specs/` 是**单任务**的设计文档，两者层级不同、互不替代。
- superpowers 的 brainstorming / writing-plans 技能默认写入 `docs/superpowers/`，本仓库统一覆盖为 `docs/specs/`、`docs/plans/`。

## 提交规范

- 遵循 Conventional Commits：`feat:`, `fix:`, `refactor:` 等
- PR 描述中说明动机、核心变更、潜在影响与已执行的验证命令

## 安全检查

提交前必须通过三道门：`yarn lint`、`yarn tsc --noEmit`、`yarn build`。禁止提交密钥、凭证或 `.env.local` 等敏感文件。

## 端到端验证（必做，与三道门并列）

本仓库**不引入** UI 自动化测试框架（Playwright/Cypress/jest 等）；改由助手在**每次完成任务时亲自跑一遍端到端浏览器验证**，作为「完成」的硬性前提——不可省略、不可用「应该没问题」替代。

- **适用范围**：凡浏览器可观察的改动（页面渲染、交互、布局、样式、控制台行为）。纯类型/工具链/不可运行的改动豁免，不必为「证明不了什么」而启动服务。
- **流程**：启动 dev/preview → 打开受影响页面 → **实际走一遍交互路径**（点击、切换、填写等真实操作，而非只看静态渲染）→ 查控制台无报错 → 截图/快照留证。
- **要求**：发现问题先改源码再复验；只有亲眼验证通过才可声称完成或提交；验证内容写入提交说明或任务小结。
- 三道门 + 端到端验证**二者都过**才算 done。
