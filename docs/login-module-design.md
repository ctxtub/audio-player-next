# 设置页用户模块与登录流程详细设计

## 1. 背景与目标
- 在设置页顶部加入用户信息模块，满足“左侧展示昵称、右侧提供登录/登出按钮”的要求。
- 通过用户模块唤起独立的登录界面，完成账号密码登录（模拟逻辑，仅支持 `test/test`）。
- 登录态通过 Cookie 持久化，刷新页面后仍可正确识别身份。
- 交互与视觉需兼容应用的明暗主题，并统一使用 antd-mobile 组件库。

## 2. 设计总体概览
```
客户端（设置页） ──▶ BFF 登录接口 ──▶ 服务端校验逻辑
        │                    │
        │                    └── 设置/清理 Cookie
        ▼
登录 Modal（antd-mobile）
```
- 客户端：设置页用户模块 + 登录 Modal 组合完成身份管理视图。
- BFF：复用现有 API Route 模式（参考 `/app/api/storyGenerate/route.ts` 的数据流分层），新增 `/app/api/auth/*` 路由处理登录态。
- Cookie：登录成功后通过 `Set-Cookie` 写入，登出时设置过期时间清理；前端无需显式存储，仅维护内存态同步展示。

## 3. BFF 交互设计
### 3.1 新增 API Route 结构
- 目录：`app/api/auth/`
  - `route.ts`：可选汇总导出（若仅 POST/DELETE）。
  - 或拆分子目录：`login/route.ts`、`logout/route.ts`、`profile/route.ts`，便于语义隔离。
- 参考 `storyGenerate` 的实现方式：
  1. 解析 JSON，并使用 `ServiceError` 抛出业务异常。
  2. 将原始入参归一化（`normalizeRequest`）。
  3. 调用内部校验逻辑，构造响应。
  4. `NextResponse` 中设置 `headers: { "Set-Cookie": ... }`，保持无缓存（`Cache-Control: no-store`）。

### 3.2 接口约定
| 功能 | 方法 & 路径 | 请求体 | 响应体 | Cookie 策略 |
| --- | --- | --- | --- | --- |
| 登录 | `POST /api/auth/login` | `{ username: string, password: string }` | `{ success: true, user: { nickname } }`<br>`{ success: false, error: { code, message } }` | 成功：`Set-Cookie: auth_session=test; HttpOnly; Secure(生产); SameSite=Lax; Path=/; Max-Age=86400` |
| 登出 | `POST /api/auth/logout` | `-` | `{ success: true }` | `Set-Cookie: auth_session=; Path=/; Max-Age=0` |
| 获取状态 | `GET /api/auth/profile` | `-` | `{ isLogin: boolean, user?: { nickname } }` | 读取现有 Cookie，勿修改 |

> `auth_session` 的值可简单存储用户名或签名过的 token；在模拟阶段直接写入 `test` 即可。

### 3.3 服务端处理流程
1. **登录**：
   - 使用 `await req.json()` 解析请求体。
   - 调用 `validateLoginPayload(payload)` 校验字段（判空、类型判断）。
   - 核对账号密码是否均为 `test`：
     - 成功：构造 `NextResponse.json`，并在 headers 中写入 Cookie。
     - 失败：返回 `401`，结构 `error: { code: "INVALID_CREDENTIAL", message: "账号或密码错误" }`。
2. **登出**：直接返回 `success: true`，并将 Cookie 过期。
3. **状态查询**：
   - 通过 `cookies()` 读取 `auth_session`。
   - 返回 `isLogin: Boolean(value)`，若存在则附带 `user.nickname`（直接取 Cookie 值或在服务层查表）。

### 3.4 复用 Story 接口的数据流思路
- 同样采用“解析 → 归一化 → 调用服务 → 构造响应”的分层结构，便于未来扩展真实后端。
- 错误处理沿用 `ServiceError`，统一返回体格式，便于前端判定。
- 在 `utils/` 中拆分 `buildAuthCookie`、`clearAuthCookie` 等纯函数，类似 `buildStoryMessages` 的职责划分。

## 4. 客户端设计
### 4.1 状态管理
- 在 `stores/` 新增 `authStore.ts`：
  - 状态：`isLogin`, `nickname`, `loading`。
  - 动作：`fetchProfile()`, `login(username, password)`, `logout()`。
  - 调用统一的 `@/utils/http` 封装（若存在）发起请求。
  - 登录/登出成功后更新状态，并交由设置页刷新视图。
- 应用启动时，可在 `app/setting/page.tsx` 的 `useEffect` 或 `useAsyncEffect` 中调用 `fetchProfile()`；若想全局复用，可在 `components/ConfigInitializer` 中初始化。

### 4.2 设置页用户模块
- 位置：`app/setting/components/UserSection`（新建目录，含组件与样式）。
- 结构：
  - 左侧：
    - 已登录：显示 `authStore.nickname`。
    - 未登录：显示占位文本（例如“未登录”）。
  - 右侧：
    - 使用 `antd-mobile` 的 `Button`（`size="small"`，`color="primary"`）。
    - 文案根据状态切换为“登录”或“登出”。
- 交互：
  - 登录按钮：打开 Modal。
  - 登出按钮：调用 `authStore.logout()`，成功后展示 `Toast.show({ content: "已登出" })`。
- 样式：
  - 参考 `index.module.scss` 的排版，增加 `userSection`、`userInfo`、`actions` 样式类。
  - 使用 CSS 变量衔接主题色（例如 `var(--adm-color-text)`、`var(--adm-color-primary)`），确保明暗模式一致。

### 4.3 登录 Modal 设计
- 组件：建议在 `components/Modal` 或 `antd-mobile` 的 `Dialog`/`Popup` 基础上实现。
- 内容布局：
  1. 标题：`<h3>` 或 `antd-mobile` 的 `Dialog` 标题 slot，文案“账号登录”。
  2. 表单：使用 `Form` + `Input`（`type="text"`/`type="password"`），添加必填校验。
  3. 操作区：`Button`（主按钮）提交；必要时增加“取消”按钮关闭弹窗。
  4. 错误提示：登录失败后在表单上方显示 `ErrorBlock` 或 `NoticeBar`。
- 动画与交互：
  - Modal 打开时禁止背景滚动，关闭时还原。
  - 提交中展示 `Button loading` 状态，避免重复提交。
  - 登录成功后，关闭 Modal 并调用 `Toast.show({ content: "登录成功" })`。

### 4.4 明暗主题适配
- 遵循 `ThemeProvider` 中定义的变量：
  - 背景：使用 `var(--page-background)`（若已有）或延续设置页容器色。
  - 字体颜色：使用 antd-mobile 默认 CSS 变量（`--adm-color-text`、`--adm-color-weak`）。
  - 按钮：沿用 antd-mobile 自动适配主题的 `color="primary"`。
- 确认 Modal 背景、输入框描边在暗色模式下对比度足够，可自定义 `Input` 的 `--adm-color-border`。

## 5. 前后端时序图（文字描述）
1. 用户打开设置页，触发 `authStore.fetchProfile()`：
   - 客户端请求 `GET /api/auth/profile`。
   - BFF 读取 Cookie，返回登录态。
   - Store 更新状态，用户模块展示昵称或“未登录”。
2. 用户点击“登录”按钮：
   - 打开 Modal，输入凭据，提交调用 `POST /api/auth/login`。
   - BFF 校验账号密码，并在响应头写入 `Set-Cookie`。
   - 前端收到成功响应，关闭 Modal、更新 store，并提示成功。
3. 用户点击“登出”按钮：
   - 调用 `POST /api/auth/logout`。
   - BFF 清空 Cookie，返回成功。
   - Store 重置状态，用户模块显示“未登录”。

## 6. 验证与待办
- **开发前置**：
  - 明确是否需要真实后端联调；若未来接入真实后端，可将账号校验逻辑抽象为服务层函数。
- **调试步骤**：
  1. 进入设置页，确认用户模块默认展示“未登录”。
  2. 点击登录，输入 `test/test`，确认成功提示并刷新昵称。
  3. 刷新页面，昵称仍然展示为 `test`（验证 Cookie 持久化）。
  4. 点击登出，确认 Cookie 清除，状态恢复。
- **自动化检查**：提交前运行 `yarn lint`、`yarn tsc --noEmit`，与现有流程保持一致。

## 7. 后续扩展建议
- 接入真实后端时：
  - 将 Cookie 值替换为 JWT 或 sessionId，BFF 负责校验签名/向后端换取用户信息。
  - 扩展 `/profile` 接口返回头像、角色等信息，便于前端展示更多内容。
- 考虑在 `ConfigInitializer` 中预拉取登录态，保证所有页面初始渲染一致。
- 补充 UI 自动化测试或 Playwright 脚本验证登录流程。
