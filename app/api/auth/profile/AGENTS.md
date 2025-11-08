# AGENTS

## 目录职责
- 处理 `GET /api/auth/profile` 请求，从 Cookie 中解析登录态并返回用户信息。

## 关键协作与依赖
- 依赖 `@/utils/authCookie` 获取 Cookie 名称。
- 输出结构需满足 `@/types/auth` 中定义的 `AuthProfileResponse`。
