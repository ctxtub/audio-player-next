# AGENTS

## 目录职责
- 提供登录态校验与 Cookie 解析等可被多个 BFF 复用的工具函数。

## 关键协作与依赖
- 仅供 `app/api/auth/**` 路由调用，避免泄漏到业务层之外。
- 依赖 `@/utils/authCookie` 读取 Cookie 名称，依赖 `@/types/auth` 获取会话类型。
