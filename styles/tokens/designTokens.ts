import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";

/**
 * 设计令牌命名映射，保留 CSS 变量 ID 以便跨层复用。
 */
export const DESIGN_TOKEN_VARIABLES = {
  colors: {
    background: "--color-background",
    backgroundInitial: "--color-background-initial",
    pageBackground: "--color-page-background",
    foreground: "--color-foreground",
    foregroundSecondary: "--color-foreground-secondary",
    primary: "--color-primary",
    primaryHover: "--color-primary-hover",
    primaryActive: "--color-primary-active",
    process: "--color-process",
    success: "--color-success",
    error: "--color-error",
    surface: "--color-surface",
    surfaceOverlay: "--color-surface-overlay",
    surfaceAccent: "--color-surface-accent",
    surfaceInteractive: "--color-surface-interactive",
    surfacePrimarySoft: "--color-surface-primary-soft",
    surfacePrimaryMedium: "--color-surface-primary-medium",
    surfacePrimaryStrong: "--color-surface-primary-strong",
    surfacePrimaryIntense: "--color-surface-primary-intense",
    surfaceMixed: "--color-surface-mixed",
    surfaceProcessSoft: "--color-surface-process-soft",
    surfaceProcess: "--color-surface-process",
    surfaceProcessStrong: "--color-surface-process-strong",
    surfaceSuccess: "--color-surface-success",
    surfaceError: "--color-surface-error",
    border: "--color-border",
    borderCard: "--color-border-card",
    borderPrimary: "--color-border-primary",
    borderProcess: "--color-border-process",
    borderPrimaryBlend: "--color-border-primary-blend",
    inputBackground: "--color-input-background",
    shadowColor: "--color-shadow",
  },
  boxShadow: {
    floating: "--shadow-floating",
    panel: "--shadow-panel",
    surfaceSm: "--shadow-surface-sm",
    surfaceMd: "--shadow-surface-md",
    surfaceLg: "--shadow-surface-lg",
    surfaceTop: "--shadow-surface-top",
    surfaceInner: "--shadow-surface-inner",
    surfaceAmbient: "--shadow-surface-ambient",
    primaryPanel: "--shadow-primary-panel",
    primaryGlow: "--shadow-primary-glow",
    primaryGlowStrong: "--shadow-primary-glow-strong",
    primaryGlowMuted: "--shadow-primary-glow-muted",
    primarySoft: "--shadow-primary-soft",
    primaryActive: "--shadow-primary-active",
    processGlow: "--shadow-process-glow",
    errorGlow: "--shadow-error-glow",
  },
  transition: {
    duration: "--motion-duration-theme",
    easing: "--motion-ease-theme",
  },
  blur: {
    soft: "--blur-soft",
    panel: "--blur-panel",
  },
  spacing: {
    xs: "--space-xs",
    sm: "--space-sm",
    md: "--space-md",
    lg: "--space-lg",
    xl: "--space-xl",
  },
  radius: {
    lgx: "--radius-lgx",
    lgPlus: "--radius-lg-plus",
    xlPlus: "--radius-xl-plus",
    modal: "--radius-modal",
  },
  size: {
    minWidthLabel: "--size-min-width-label",
    minWidthButton: "--size-min-width-button",
    minWidthStatus: "--size-min-width-status",
    minWidthBadge: "--size-min-width-badge",
    maxWidthContent: "--size-max-width-content",
    maxWidthModal: "--size-max-width-modal",
    maxWidthPlayer: "--size-max-width-player",
    widthDisc: "--size-width-disc",
    widthIcon: "--size-width-icon",
    widthSpeedMenu: "--size-width-speed-menu",
    widthIconMd: "--size-width-icon-md",
    widthFloating: "--size-width-floating",
    widthFloatingActive: "--size-width-floating-active",
    heightDisc: "--size-height-disc",
    heightIcon: "--size-height-icon",
    heightBadge: "--size-height-badge",
    heightIconMd: "--size-height-icon-md",
    minHeightInput: "--size-min-height-input",
    maxHeightPromptPanel: "--size-max-height-prompt-panel",
  },
  fontSize: {
    xsPlus: {
      size: "--font-xs-plus",
      lineHeight: "--font-xs-plus-line",
    },
    smPlus: {
      size: "--font-sm-plus",
      lineHeight: "--font-sm-plus-line",
    },
    lgPlus: {
      size: "--font-lg-plus",
      lineHeight: "--font-lg-plus-line",
    },
  },
} as const;

/**
 * 基于设计令牌生成的 Tailwind 扩展配置，确保 className 引用保持一致。
 */
export const tailwindThemeExtension = {
  colors: {
    background: `var(${DESIGN_TOKEN_VARIABLES.colors.background})`,
    "background-initial": `var(${DESIGN_TOKEN_VARIABLES.colors.backgroundInitial})`,
    "page-background": `var(${DESIGN_TOKEN_VARIABLES.colors.pageBackground})`,
    foreground: `var(${DESIGN_TOKEN_VARIABLES.colors.foreground})`,
    "foreground-secondary": `var(${DESIGN_TOKEN_VARIABLES.colors.foregroundSecondary})`,
    primary: `var(${DESIGN_TOKEN_VARIABLES.colors.primary})`,
    "primary-hover": `var(${DESIGN_TOKEN_VARIABLES.colors.primaryHover})`,
    "primary-active": `var(${DESIGN_TOKEN_VARIABLES.colors.primaryActive})`,
    process: `var(${DESIGN_TOKEN_VARIABLES.colors.process})`,
    success: `var(${DESIGN_TOKEN_VARIABLES.colors.success})`,
    error: `var(${DESIGN_TOKEN_VARIABLES.colors.error})`,
    surface: `var(${DESIGN_TOKEN_VARIABLES.colors.surface})`,
    "surface-overlay": `var(${DESIGN_TOKEN_VARIABLES.colors.surfaceOverlay})`,
    "surface-accent": `var(${DESIGN_TOKEN_VARIABLES.colors.surfaceAccent})`,
    "surface-interactive": `var(${DESIGN_TOKEN_VARIABLES.colors.surfaceInteractive})`,
    "surface-primary-soft": `var(${DESIGN_TOKEN_VARIABLES.colors.surfacePrimarySoft})`,
    "surface-primary-medium": `var(${DESIGN_TOKEN_VARIABLES.colors.surfacePrimaryMedium})`,
    "surface-primary-strong": `var(${DESIGN_TOKEN_VARIABLES.colors.surfacePrimaryStrong})`,
    "surface-primary-intense": `var(${DESIGN_TOKEN_VARIABLES.colors.surfacePrimaryIntense})`,
    "surface-mixed": `var(${DESIGN_TOKEN_VARIABLES.colors.surfaceMixed})`,
    "surface-process-soft": `var(${DESIGN_TOKEN_VARIABLES.colors.surfaceProcessSoft})`,
    "surface-process": `var(${DESIGN_TOKEN_VARIABLES.colors.surfaceProcess})`,
    "surface-process-strong": `var(${DESIGN_TOKEN_VARIABLES.colors.surfaceProcessStrong})`,
    "surface-success": `var(${DESIGN_TOKEN_VARIABLES.colors.surfaceSuccess})`,
    "surface-error": `var(${DESIGN_TOKEN_VARIABLES.colors.surfaceError})`,
    border: `var(${DESIGN_TOKEN_VARIABLES.colors.border})`,
    "border-card": `var(${DESIGN_TOKEN_VARIABLES.colors.borderCard})`,
    "border-primary": `var(${DESIGN_TOKEN_VARIABLES.colors.borderPrimary})`,
    "border-process": `var(${DESIGN_TOKEN_VARIABLES.colors.borderProcess})`,
    "border-primary-blend": `var(${DESIGN_TOKEN_VARIABLES.colors.borderPrimaryBlend})`,
    "input-background": `var(${DESIGN_TOKEN_VARIABLES.colors.inputBackground})`,
    "shadow-color": `var(${DESIGN_TOKEN_VARIABLES.colors.shadowColor})`,
  },
  boxShadow: {
    floating: `var(${DESIGN_TOKEN_VARIABLES.boxShadow.floating})`,
    panel: `var(${DESIGN_TOKEN_VARIABLES.boxShadow.panel})`,
    "surface-sm": `var(${DESIGN_TOKEN_VARIABLES.boxShadow.surfaceSm})`,
    "surface-md": `var(${DESIGN_TOKEN_VARIABLES.boxShadow.surfaceMd})`,
    "surface-lg": `var(${DESIGN_TOKEN_VARIABLES.boxShadow.surfaceLg})`,
    "surface-top": `var(${DESIGN_TOKEN_VARIABLES.boxShadow.surfaceTop})`,
    "surface-inner": `var(${DESIGN_TOKEN_VARIABLES.boxShadow.surfaceInner})`,
    "surface-ambient": `var(${DESIGN_TOKEN_VARIABLES.boxShadow.surfaceAmbient})`,
    "primary-panel": `var(${DESIGN_TOKEN_VARIABLES.boxShadow.primaryPanel})`,
    "primary-glow": `var(${DESIGN_TOKEN_VARIABLES.boxShadow.primaryGlow})`,
    "primary-glow-strong": `var(${DESIGN_TOKEN_VARIABLES.boxShadow.primaryGlowStrong})`,
    "primary-glow-muted": `var(${DESIGN_TOKEN_VARIABLES.boxShadow.primaryGlowMuted})`,
    "primary-soft": `var(${DESIGN_TOKEN_VARIABLES.boxShadow.primarySoft})`,
    "primary-active": `var(${DESIGN_TOKEN_VARIABLES.boxShadow.primaryActive})`,
    "process-glow": `var(${DESIGN_TOKEN_VARIABLES.boxShadow.processGlow})`,
    "error-glow": `var(${DESIGN_TOKEN_VARIABLES.boxShadow.errorGlow})`,
  },
  transitionDuration: {
    theme: `var(${DESIGN_TOKEN_VARIABLES.transition.duration})`,
  },
  transitionTimingFunction: {
    theme: `var(${DESIGN_TOKEN_VARIABLES.transition.easing})`,
  },
  backdropBlur: {
    soft: `var(${DESIGN_TOKEN_VARIABLES.blur.soft})`,
    panel: `var(${DESIGN_TOKEN_VARIABLES.blur.panel})`,
  },
  spacing: {
    xs: `var(${DESIGN_TOKEN_VARIABLES.spacing.xs})`,
    sm: `var(${DESIGN_TOKEN_VARIABLES.spacing.sm})`,
    md: `var(${DESIGN_TOKEN_VARIABLES.spacing.md})`,
    lg: `var(${DESIGN_TOKEN_VARIABLES.spacing.lg})`,
    xl: `var(${DESIGN_TOKEN_VARIABLES.spacing.xl})`,
  },
  borderRadius: {
    lgx: `var(${DESIGN_TOKEN_VARIABLES.radius.lgx})`,
    "lg-plus": `var(${DESIGN_TOKEN_VARIABLES.radius.lgPlus})`,
    "xl-plus": `var(${DESIGN_TOKEN_VARIABLES.radius.xlPlus})`,
    modal: `var(${DESIGN_TOKEN_VARIABLES.radius.modal})`,
  },
  fontSize: {
    "xs-plus": [
      `var(${DESIGN_TOKEN_VARIABLES.fontSize.xsPlus.size})`,
      { lineHeight: `var(${DESIGN_TOKEN_VARIABLES.fontSize.xsPlus.lineHeight})` },
    ],
    "sm-plus": [
      `var(${DESIGN_TOKEN_VARIABLES.fontSize.smPlus.size})`,
      { lineHeight: `var(${DESIGN_TOKEN_VARIABLES.fontSize.smPlus.lineHeight})` },
    ],
    "lg-plus": [
      `var(${DESIGN_TOKEN_VARIABLES.fontSize.lgPlus.size})`,
      { lineHeight: `var(${DESIGN_TOKEN_VARIABLES.fontSize.lgPlus.lineHeight})` },
    ],
  },
} satisfies NonNullable<Config["theme"]>["extend"];

/**
 * Tailwind 插件钩子，占位以便后续集中维护。
 */
export const tailwindPlugins = [
  plugin(({ addUtilities }) => {
    /**
     * 组合主题动效工具类，确保 `@apply` 可以引用自定义时长与缓动。
     */
    addUtilities({
      ".duration-theme": {
        transitionDuration: "var(--motion-duration-theme)",
      },
      ".ease-theme": {
        transitionTimingFunction: "var(--motion-ease-theme)",
      },
    });
  }),
] as const;
