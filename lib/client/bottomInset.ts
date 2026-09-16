/**
 * 底部 Chrome 占位纯函数（）。
 *
 * 与 styles/app.module.scss 的 .app 变量赋值保持同构：
 * - 无 docked Mini：mini/gap 均为 0；
 * - 有 docked Mini：mini = Mini 高度 token，gap = 间距 token；
 * - TabBar 占用恒为 tab-bar token（含 safe-area，由 token 自带）。
 * 真实遮挡 oracle 由 L3 包围盒断言承担，本模块锁定 TS/CSS 契约一致。
 */

export interface BottomChromeOccupancy {
  tabBarVar: string;
  miniVar: string;
  gapVar: string;
}

export const TAB_BAR_OCCUPIED_VAR = 'var(--tab-bar-safe-bottom)';
export const MINI_PLAYER_HEIGHT_VAR = 'var(--size-mini-now-playing-height)';
export const BOTTOM_CHROME_GAP_VAR = 'var(--space-2)';

/** 由 MainChrome 状态解析三占位变量取值。 */
export function resolveBottomChromeOccupancy(
  hasDockedMini: boolean,
): BottomChromeOccupancy {
  return {
    tabBarVar: TAB_BAR_OCCUPIED_VAR,
    miniVar: hasDockedMini ? MINI_PLAYER_HEIGHT_VAR : '0px',
    gapVar: hasDockedMini ? BOTTOM_CHROME_GAP_VAR : '0px',
  };
}

/** 组合避让量表达式（与 --bottom-chrome-safe-bottom 定义同构）。 */
export function composeBottomChromeSafeBottom(o: BottomChromeOccupancy): string {
  return `calc(${o.tabBarVar} + ${o.miniVar} + ${o.gapVar})`;
}
