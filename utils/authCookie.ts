/**
 * 登录态 Cookie 的统一名称。
 */
const AUTH_COOKIE_NAME = 'auth_session';

/**
 * 登录态 Cookie 的有效期（秒）。
 */
const AUTH_COOKIE_MAX_AGE = 60 * 60 * 24; // 86400 秒

/**
 * 构造登录态 Cookie 字符串。
 * @param value 需要写入 Cookie 的会话标识。
 * @returns 可直接用于 Set-Cookie 的字符串。
 */
export const buildAuthCookie = (value: string): string => {
  const sanitizedValue = encodeURIComponent(value);
  const secureFlag = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${AUTH_COOKIE_NAME}=${sanitizedValue}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${AUTH_COOKIE_MAX_AGE}${secureFlag}`;
};

/**
 * 构造清除登录态的 Cookie 字符串。
 * @returns 立即失效的 Cookie 字符串。
 */
export const clearAuthCookie = (): string => {
  return `${AUTH_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
};

/**
 * 获取当前使用的登录态 Cookie 名称。
 * @returns Cookie 名称。
 */
export const getAuthCookieName = (): string => AUTH_COOKIE_NAME;
