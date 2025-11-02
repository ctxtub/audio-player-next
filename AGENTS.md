# AGENTS

- 包管理器解析：检测到仓库根目录存在 `yarn.lock` ，因此约定 `<pm>` = `yarn`
- 规范来源：`package.json#scripts`、`tsconfig.json`、`eslint.config.mjs`、`next.config.ts`、`app/` 与 `components/` 目录结构

## 项目概览（Project Overview）

- Next.js 15.2.1 + React 19 + TypeScript 5 音频播放应用，主要采用 `app/` 路由（未检测到 `pages/`）
- 关键目录：页面路由位于 `app/`（含 `app/home`、`app/setting` 等子路由），共享 UI 位于根部 `components/`，辅助模块在 `lib/`、`utils/`、`types/`、`stores/`，静态资源在 `public/`，样式在 `styles/`
- 配置文件：全局 ESLint 规则见 `eslint.config.mjs`，编译设定见 `tsconfig.json`，Next.js 定制逻辑见 `next.config.ts`

## 编码规范（Coding Conventions）

- TypeScript：遵循 `tsconfig.json` 中 `strict: true` 的强类型约束；新增类型优先声明在 `types/` 或贴近领域的 `app/**/types/`；禁止绕过类型系统（避免 `any`/非必要断言）
- React 19：默认编写 Server Component；仅在需要浏览器能力时添加 `use client` 并限制在最小组件；客户端组件的副作用集中在 `useEffect`，避免全局单例修改
- 路由与拆分：
  - 页面私有实现放在页面同级子目录：例如 `app/(group)/feature/page.tsx` 的专用组件放入 `app/(group)/feature/components/`，私有工具放入 `.../utils/`，私有 Hook 放入 `.../hooks/`
  - 跨页面复用的 UI/逻辑分别归档至根部 `components/`、`utils/`、`hooks/`，并按领域细分（如 `utils/http/`、`hooks/useAuth/`）；禁止从页面私有目录跨页引用
  - 建议项：为公共模块维护 Barrel 文件（如 `components/index.ts`、`utils/index.ts`）与最小使用示例/Story（若团队引入 Storybook）
- 样式：共享样式放在 `styles/`，组件私有样式命名为 `*.module.scss` 并与组件共存；避免全局样式污染
- 数据与状态：
  - 数据请求置于 Next.js Server Actions、`app/api/*` Route 或 `lib/` 服务层，再在客户端通过 props/Hook 使用
  - 全局/跨页状态使用 `stores/` 内的 Zustand store；页面内部优先 `useState`/`useReducer`
  - `axios` 统一在 `utils/http/` 封装实例供模块复用，组件内不得直接创建新实例
- 代码质量：遵循 `eslint.config.mjs` 与 Next 官方 `eslint-config-next`；新增规则请集中配置，避免局部禁用；SVG 资产统一通过 `@svgr/webpack` 处理
- 导入路径：遵循 `tsconfig.json` 中声明的 `@/*` 别名；若别名不足则使用最短相对路径，禁止破坏目录边界的“倒灌式”依赖
- 依赖引用统一使用 `@/*` 别名且按“远到近”排序：最先列第三方 npm 包，其次为 `@/` 起始的仓库别名，最后才是当前目录内的相对依赖
- 代码注释：所有文件中的首层函数与变量必须编写中文注释；函数需说明职责及入参/返回，变量需说明用途与取值来源
- 目录文档：每个目录需维护本地 `AGENTS.md` 描述该目录的职责、内部结构与上下游依赖，保持与根目录规范一致
- 编码交付前需确认新增或调整的注释与对应目录的 `AGENTS.md` 已同步更新；非经用户指示，禁止主动修改根目录 `AGENTS.md`

## 测试与验证（Testing & Validation）

- Lint：`<pm> lint`（来自 `package.json#scripts`，内部调用 `next lint`）
- Typecheck：当前未定义脚本，执行 `<pm> tsc --noEmit`；建议在 `package.json#scripts` 补充 `typecheck`
- Build：`<pm> build`（`package.json#scripts`）
- Test：当前未配置自动化测试脚本（见 `package.json#scripts`）；待测试方案确定后再更新本文件
- 任意代码或文档改动在提交前需至少完成 lint、类型检查

## 提交与 PR 规范（PR / Commit Guidelines）

- Commit：推荐遵循 Conventional Commits，示例：`feat: add playlist queue`、`fix: guard audio player store`
- PR：当前仓库未检测到模板文件；创建 PR 时需在描述中说明动机、核心变更、潜在影响与已执行的验证命令，引用本文件与 `package.json#scripts` 以保持一致
- 文档更新同样需要在 PR 描述中附带所运行的程序化检查结果（即便仅修改 Markdown）

## 智能体工作指引（Agent Directives）

- 智能体默认不直接修改代码，也不会自动提交；所有提交由用户审计决定，但在交付前需完成 `<pm> lint` 与 `<pm> tsc --noEmit` 并反馈结果
- 接到用户指令后，须先与用户讨论并确认技术方案/执行步骤；得到明确授权后方可开始编码或文档编辑
- 若需要推动重构或大规模调整，应与用户协商拆分任务、约定验证方式与交付顺序
- 在执行任何自动化操作前确认命令来源于受支持的 `package.json#scripts` 或本文件

## 安全检查（Safety Checks）

- 提交或交付前必须确保：`<pm> lint`、`<pm> tsc --noEmit` 通过；涉及上线风险的改动建议额外执行 `<pm> build`
- 禁止提交密钥、凭证或 `.env*` 等敏感文件；遵守 `.gitignore` 约束
- Patch 控制在易于审阅的粒度；对大规模改动需拆分 PR，并在描述中注明验证步骤
