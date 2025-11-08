# AGENTS

## 目录职责
- 提供登录、登出与用户信息查询的 API Route，实现设置页登录模块的 BFF 能力。
- 复用 `ServiceError` 统一错误结构，并负责设置/清理 Cookie。

## 子目录结构
- `login/`：处理登录请求，校验账号密码并写入会话 Cookie。
- `logout/`：处理登出请求，清空会话 Cookie。
- `profile/`：查询当前登录态，返回用户昵称。

## 关键协作与依赖
- 依赖 `@/utils/authCookie` 构建 Cookie 字符串。
- 与 `@/types/auth`、`@/lib/http/server/ErrorHandler` 保持响应与错误格式一致。
