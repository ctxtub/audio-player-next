/**
 * 支持的主题模式枚举。
 */
export type ThemeMode = 'dark' | 'light' | 'system';

/**
 * 4 套预制调性色板：
 * - amber: 暖琥珀 / 晨曦暖金 (默认)
 * - midnight: 静谧星夜 / 极光流金
 * - forest: 森林雨雾 / 鼠尾草松针绿
 * - mocha: 复古摩卡 / 羊皮纸书卷
 */
export const THEME_PALETTES = ['amber', 'midnight', 'forest', 'mocha'] as const;
export type ThemePalette = (typeof THEME_PALETTES)[number];
