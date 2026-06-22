/**
 * 会话失效统一闭环
 *
 * 运行中会话失效（用户被删 / cookie 过期）时，由 tRPC session-guard link 在捕获
 * 非 auth.* 路径的 UNAUTHORIZED 后触发：清服务端会话 → 翻转登录态（经 accountSync
 * 订阅自动清四块账号数据）→ 重定向登录页。加载时已失效的场景（profile 修真）走
 * authStore.fetchProfile 的独立分支，不经此模块。
 */

import { useAuthStore } from '@/stores/authStore';
import { logout as logoutRequest } from '@/lib/client/auth';

/** 再入守卫：闭环触发后置真，避免并发 UNAUTHORIZED 重复登出/跳转。 */
let handling = false;

/**
 * 会话失效闭环：仅在「客户端自认已登录」时触发。
 * 访客 / 未登录态的 UNAUTHORIZED（如登录密码错）不在此处理。
 */
export function maybeHandleSessionInvalidation(): void {
  if (handling) {
    return;
  }
  // 客户端不认为自己已登录（访客/匿名）→ 该 UNAUTHORIZED 非「会话失效」，交由本地逻辑处理。
  if (!useAuthStore.getState().isLogin) {
    return;
  }
  handling = true;

  void (async () => {
    try {
      // best-effort 清服务端会话 cookie；失败不阻断后续翻转与跳转。
      await logoutRequest().catch(() => undefined);
    } finally {
      // 翻转登录态：accountSync 的 isLogin 下降沿订阅会自动清四块账号数据。
      useAuthStore.setState({ isLogin: false, isGuest: false, nickname: '', username: '' });
      if (typeof window !== 'undefined') {
        window.location.assign('/auth?session=expired');
      }
    }
  })();
}
