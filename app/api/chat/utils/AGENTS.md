# AGENTS

## 目录职责
- 存放 `/api/chat` 路由专用的工具函数（SSE 编码、流式读取等）。

## 子目录结构
- 当前仅包含 TypeScript 工具函数文件，按功能拆分命名。

## 关键协作与依赖
- 工具函数仅供 `app/api/chat/route.ts` 使用，禁止被其他目录直接引用。
