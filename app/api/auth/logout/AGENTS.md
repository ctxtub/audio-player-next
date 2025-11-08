# AGENTS

## 目录职责
- 处理 `POST /api/auth/logout` 请求，清除登录态 Cookie 并返回成功标记。

## 关键协作与依赖
- 依赖 `@/utils/authCookie` 提供的清除函数，保持响应头一致。
