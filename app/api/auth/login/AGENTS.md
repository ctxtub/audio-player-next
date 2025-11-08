# AGENTS

## 目录职责
- 处理 `POST /api/auth/login` 请求，完成账号密码校验并写入 Cookie。

## 关键协作与依赖
- 依赖 `@/utils/authCookie` 构建登录态 Cookie。
- 使用 `ServiceError` 统一错误抛出，并遵循 `{ success: boolean }` 响应结构。
