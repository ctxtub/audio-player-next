/**
 * 测试主体（访客/用户）合成身份构造器。
 *
 * 约定：一切 ID 均为 `g_<场景>_<时间戳>` / `user_<场景>_<时间戳>` 形合成值，
 * 与 `docs/e2e/execution-isolation.md` §4 的假 ID 口径一致，不含真实凭据。
 */

/**
 * 生成唯一合成访客 ID（后缀时间戳防串扰）。
 * @param scenario 场景短名（如 `resume_tc01`）
 * @returns 合成访客 ID
 */
export function makeGuestId(scenario: string): string {
    // 中文注释：时间戳后缀保证串行调度下跨用例不碰撞。
    return `g_${scenario}_${Date.now()}`;
}

/**
 * 生成唯一合成用户名。
 * @param scenario 场景短名
 * @returns 合成用户名
 */
export function makeUsername(scenario: string): string {
    // 中文注释：合成注册用户名，仅供隔离库使用。
    return `user_${scenario}_${Date.now()}`;
}

/**
 * 生成唯一合成消息 ID。
 * @param scenario 场景短名
 * @returns 合成消息 ID
 */
export function makeMessageId(scenario: string): string {
    // 中文注释：合成聊天消息 ID，仅供隔离库使用。
    return `msg_${scenario}_${Date.now()}`;
}

/**
 * 访客 tRPC caller 上下文（直连 `createCaller` 用）。
 */
export interface GuestCallerContext {
    session: null;
    guestId: string;
    isGuest: boolean;
    clientIp: string;
}

/**
 * 构造访客 caller 上下文。
 * @param guestId 合成访客 ID
 * @returns 访客上下文对象
 */
export function makeGuestContext(guestId: string): GuestCallerContext {
    // 中文注释：固定本机 IP，发往隔离库的调用上下文。
    return { session: null, guestId, isGuest: true, clientIp: '127.0.0.1' };
}

/**
 * 登录用户 tRPC caller 上下文（直连 `createCaller` 用）。
 */
export interface UserCallerContext {
    session: { userId: number; nickname: string };
    guestId: null;
    isGuest: boolean;
    clientIp: string;
}

/**
 * 构造登录用户 caller 上下文。
 * @param userId 隔离库内用户主键
 * @param nickname 合成昵称
 * @returns 用户上下文对象
 */
export function makeUserContext(userId: number, nickname: string): UserCallerContext {
    // 中文注释：固定本机 IP，发往隔离库的调用上下文。
    return { session: { userId, nickname }, guestId: null, isGuest: false, clientIp: '127.0.0.1' };
}

/**
 * 构造匿名（无身份）caller 上下文（401 拦截断言用）。
 * @returns 匿名上下文对象
 */
export function makeAnonymousContext(): {
    session: null;
    guestId: null;
    isGuest: boolean;
    clientIp: string;
} {
    // 中文注释：无 session、无 guestId，期望服务端拒绝。
    return { session: null, guestId: null, isGuest: false, clientIp: '127.0.0.1' };
}
