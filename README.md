# Audio Player Next

## 项目简介
- 基于 Next.js 15 + React 19 构建的音频故事生成与播放应用。
- 支持故事生成、语音合成、播放进度管理与历史记录等核心能力。
- 通过 App Router 与 Server Actions 协同，面向移动端体验优化。

## 技术栈
- Next.js 15.2.1（App Router）
- React 19 + TypeScript 5（`strict: true`）
- Zustand 管理跨页面状态
- antd-mobile 组件库与 SVG 资源（经 `@svgr/webpack` 处理）

## 快速开始
1. 安装依赖：`yarn install`
2. 启动开发服务：`yarn dev`
3. 打开 <http://localhost:3000> 体验应用

> 若需 Docker 本地运行，可使用 `yarn docker:up`。

## 常用脚本
- `yarn dev`：启动开发模式（Turbopack）
- `yarn build`：构建生产产物
- `yarn start`：启动生产服务器
- `yarn lint`：运行 ESLint（已集成 `next lint`）
- `yarn tsc --noEmit`：手动触发类型检查（建议在 PR 前执行）
- `yarn docker:build` / `yarn docker:push`：构建并推送容器镜像

## 目录指引
- `app/`：页面、API Route 与服务端逻辑（详见 `app/AGENTS.md`）
- `components/`：跨页面复用的 UI 组件
- `lib/`：前后端共享的业务服务层，含 HTTP 客户端与上游适配
- `stores/`：Zustand 状态仓库
- `types/`：跨模块共享的类型定义
- `utils/`：通用工具函数
- `public/`：静态资源与 SVG 图标
- `scripts/`：运维脚本

> 每个目录均维护独立 `AGENTS.md` 描述职责、子结构及依赖，修改代码时需同步更新对应说明。

## 开发规范
- 导入路径遵循 “npm → `@/` → 相对路径” 顺序，跨目录依赖统一使用 `@/*` 别名。
- 所有文件的顶层函数、变量需编写中文注释，说明职责、入参与返回值或数据来源。
- 新增或更新代码时，需同步维护所在目录的 `AGENTS.md`；除非用户指示，否则不修改根部 `AGENTS.md`。
- 统一通过 `@/lib/http/common` 使用 axios，避免直接实例化。
- SVG 资源通过 `@svgr/webpack` 转换为 React 组件。
- 详细规范见根目录 `AGENTS.md`。

## 验证与部署
1. `yarn lint`
2. `yarn tsc --noEmit`
3. `yarn build`（如将要部署或变更范围较大）
4. 可选：使用 `yarn docker:build` / `yarn docker:push` 构建与发布镜像

## 贡献指南
- 提交遵循 Conventional Commits，例如 `feat: add playlist queue`。
- PR 需在描述中列出变更动机、核心修改与验证命令，并引用相关 `AGENTS.md` 条款。
