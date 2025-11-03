/**
 * Tailwind 样式类名合并工具。
 * @param classes 待拼接的类名列表
 * @returns 过滤空值后的类名字符串
 */
export const cx = (...classes: Array<string | false | null | undefined>) =>
  classes.filter(Boolean).join(' ');
