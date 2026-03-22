# 故事工坊 (Audio Player Next)

## 项目简介

基于 Next.js 15 + React 19 构建的 AI 驱动音频故事创作与播放应用。用户可通过对话式交互触发故事生成、语音合成与实时播放，支持 LangGraph 多 Agent 协作、流式文本输出与移动端沉浸体验。

## 技术栈

| 分类 | 技术 |
|------|------|
| 框架 | Next.js 15（App Router + Turbopack）|
| UI | React 19 + TypeScript 5（`strict: true`）|
| 样式 | SCSS Modules + Design Token（见 `DESIGN_SPEC.md`）|
| 状态管理 | Zustand |
| API 层 | tRPC 11 + Zod + TanStack Query |
| AI / Agent | LangGraph + LangChain + OpenAI |
| TTS | OpenAI TTS API |
| 数据库 | Prisma 7（libsql / SQLite）|
| 认证 | 自建 session（bcryptjs + cookie）|
| 容器 | Docker Compose |

## 核心功能

- **故事创作页**（首页）：对话输入 → Supervisor Agent 路由 → 故事生成 → TTS 合成 → 实时播放
- **播放器页**：音频控制、倒计时、浮动播放器、波形动画
- **聊天页**：多轮对话，支持根据 Agent 意图（Chat / Story / Guidance）动态切换助手卡片
- **设置页**：配置首选语音、播放时长、浮动播放器开关
- **认证**：注册 / 登录 / Guest 模式

## LangGraph Agent 架构

`lib/agent/` 下基于 Supervisor 模式的五节点图：

```
用户输入
   ↓
supervisor（路由，分析 user_intent）
   ├─ story     故事创作 Agent
   ├─ chat      闲聊服务 Agent
   ├─ guidance  系统指令 / 剧情引导 Agent
   └─ audio     TTS 合成节点（非 LLM）
```

通过 `lib/trpc/routers/agent.ts` 以 `streamEvents` 流式调用，输出 `user_intent` 供前端切换 UI 状态。

## 快速开始

```bash
# 1. 安装依赖
yarn install

# 2. 配置环境变量（必填：OPENAI_MODEL_STORY、OPENAI_MODEL_AGENT）
cp .env.sample .env.local

# 3. 初始化数据库
yarn prisma migrate dev

# 4. 启动开发服务器
yarn dev
```

打开 <http://localhost:3000> 体验应用。

> Docker 本地运行：`yarn docker:up`

## 常用脚本

| 命令 | 说明 |
|------|------|
| `yarn dev` | 启动开发模式（Turbopack）|
| `yarn build` | 生产构建 |
| `yarn start` | 启动生产服务器 |
| `yarn lint` | ESLint 检查 |
| `yarn tsc --noEmit` | 类型检查 |
| `yarn docker:build` | 构建容器镜像 |
| `yarn docker:up` | 启动容器服务 |
| `yarn docker:push` | 推送容器镜像至 GHCR |

## 目录结构

```
.
├── app/
│   ├── (auth)/          # 登录 / 注册页面
│   ├── (main)/          # 主功能页面
│   │   ├── chat/        # 聊天页
│   │   ├── player/      # 播放器页
│   │   └── setting/     # 设置页
│   ├── api/             # Route Handler
│   ├── services/        # 业务流编排（storyFlow / chatFlow / agentFlow）
│   └── types/           # 页面级类型定义
├── components/          # 跨页面复用 UI 组件
├── lib/
│   ├── agent/           # LangGraph 多 Agent 节点
│   ├── trpc/            # tRPC routers / context / schemas
│   ├── client/          # 客户端工具
│   ├── server/          # 服务端工具
│   └── session.ts       # 认证 session 管理
├── stores/              # Zustand 状态仓库
├── styles/              # 全局样式 & Design Token
├── types/               # 跨模块共享类型
├── utils/               # 通用工具函数
├── prisma/              # 数据库 Schema & 迁移
└── public/              # 静态资源 & SVG 图标
```

## 环境变量

关键变量（完整列表见 `.env.sample`）：

| 变量 | 说明 | 是否必填 |
|------|------|---------|
| `OPENAI_MODEL_STORY` | 故事生成模型 ID | 必填 |
| `OPENAI_MODEL_AGENT` | Agent 路由模型 ID | 必填 |
| `OPENAI_TTS_*` | TTS 相关配置 | 可选 |
| `DATABASE_URL` | libsql 数据库路径 | 必填 |
| `SESSION_SECRET` | Cookie 签名密钥 | 必填 |
| `LANGSMITH_*` | LangSmith Tracing（调试用）| 可选 |

## 开发规范

- **样式**：所有样式必须引用 `DESIGN_SPEC.md` 中的 Design Token，禁止硬编码数值
- **导入路径**：`npm 包 → @/ 别名 → 相对路径`，禁止跨目录边界反向引用
- **注释**：顶层函数与变量必须编写中文注释
- **组件**：默认 Server Component，仅在需要浏览器能力时添加 `use client`
- **状态**：全局状态使用 `stores/`，页面内部优先 `useState`/`useReducer`

## 提交前检查

```bash
yarn lint
yarn tsc --noEmit
yarn build
```

## 贡献指南

- 提交遵循 Conventional Commits：`feat:` / `fix:` / `refactor:` 等
- PR 描述需说明：变更动机、核心修改、潜在影响与验证命令
- 详细规范见 [CLAUDE.md](CLAUDE.md)
