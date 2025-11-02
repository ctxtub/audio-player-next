/**
 * 浮动播放器拖拽工具集合，负责对外暴露位置与边界计算工具。
 */
export interface FloatingPosition {
  /** 浮窗当前横坐标，单位为像素 */
  x: number;
  /** 浮窗当前纵坐标，单位为像素 */
  y: number;
}

/** 浮窗面板尺寸描述，用于读取拖拽边界。 */
export interface PanelSize {
  /** 面板宽度像素 */
  width: number;
  /** 面板高度像素 */
  height: number;
}

/** 视口尺寸描述，便于在外部计算拖拽极值。 */
export interface ViewportSize {
  /** 视口宽度像素 */
  width: number;
  /** 视口高度像素 */
  height: number;
}

/**
 * 判断指针按下目标是否应当阻止拖拽行为。
 * @param target 指针事件目标节点
 * @returns 是否应该跳过拖拽
 */
export const shouldSkipPointerDown = (target: EventTarget | null): boolean => {
  if (!(target instanceof Element)) {
    return false;
  }
  return Boolean(target.closest('button'));
};

/**
 * 夹紧数值至指定区间。
 * @param value 目标值
 * @param min 最小值
 * @param max 最大值
 * @returns 夹紧结果
 */
export const clampValue = (value: number, min: number, max: number): number => {
  return Math.min(max, Math.max(min, value));
};
