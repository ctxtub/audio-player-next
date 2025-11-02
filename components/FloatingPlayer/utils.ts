/**
 * 浮动播放器拖拽工具集合，负责对外暴露位置与边界计算工具。
 */
export interface FloatingPosition {
  /** 浮窗当前横坐标，单位为像素 */
  x: number;
  /** 浮窗当前纵坐标，单位为像素 */
  y: number;
}

export interface DragBoundary {
  /** 横向可拖拽最小值 */
  minX: number;
  /** 横向可拖拽最大值 */
  maxX: number;
  /** 纵向可拖拽最小值 */
  minY: number;
  /** 纵向可拖拽最大值 */
  maxY: number;
}

export interface DragBoundaryOptions {
  /** 视口宽度 */
  viewportWidth: number;
  /** 视口高度 */
  viewportHeight: number;
  /** 浮窗保留的最小横向外边距 */
  marginX?: number;
  /** 浮窗保留的最小纵向外边距 */
  marginY?: number;
  /** 浮窗组件宽度估值 */
  panelWidth?: number;
  /** 浮窗组件高度估值 */
  panelHeight?: number;
  /** 可视区域内需要保留的提手宽度 */
  handleSize?: number;
}

/** 浮窗吸附方向定义，仅支持左右贴边 */
export type DockedSide = 'left' | 'right';

/** 浮窗提手宽度常量，单位像素 */
export const FLOATING_HANDLE_SIZE = 28;

/** 默认吸附判定阈值，避免轻微越界即触发吸附 */
export const DEFAULT_DOCK_THRESHOLD = 0;

/** 默认解除吸附所需的最小拖动距离 */
export const DEFAULT_UNDOCK_THRESHOLD = 20;

/**
 * 面板尺寸描述，用于计算吸附与边界。
 */
export interface PanelSize {
  /** 面板宽度像素 */
  width: number;
  /** 面板高度像素 */
  height: number;
}

/**
 * 视口尺寸描述，用于计算吸附与边界。
 */
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
 * 计算浮窗拖拽的边界范围。
 * @param options 边界计算参数
 * @returns 可用拖拽范围
 */
export const createDragBoundary = (options: DragBoundaryOptions): DragBoundary => {
  const {
    viewportWidth,
    viewportHeight,
    marginX = 0,
    marginY = 0,
    panelWidth = 320,
    panelHeight = 320,
    handleSize = FLOATING_HANDLE_SIZE,
  } = options;

  const availableWidth = Math.max(0, viewportWidth - marginX * 2);
  const availableHeight = Math.max(0, viewportHeight - marginY * 2);
  const maxX = marginX + Math.max(0, availableWidth - handleSize);
  const maxY = marginY + Math.max(0, availableHeight - panelHeight);
  const minX = marginX - Math.max(0, panelWidth - handleSize);
  const minY = marginY;

  return {
    minX,
    minY,
    maxX,
    maxY,
  };
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

/**
 * 根据最终位置判断是否应当吸附到屏幕某侧。
 * @param position 当前浮窗位置
 * @param panelSize 面板尺寸
 * @param viewport 视口尺寸
 * @param dockThreshold 吸附判定阈值
 * @param handleSize 提手宽度
 * @returns 吸附方向，未达阈值返回 null
 */
export const determineDockedSide = (
  position: FloatingPosition,
  panelSize: PanelSize,
  viewport: ViewportSize,
  dockThreshold: number = DEFAULT_DOCK_THRESHOLD
): DockedSide | null => {
  const distanceToLeft = position.x;
  if (distanceToLeft <= dockThreshold) {
    return 'left';
  }

  const distanceToRight = viewport.width - (position.x + panelSize.width);
  if (distanceToRight <= dockThreshold) {
    return 'right';
  }

  return null;
};

/**
 * 判断拖拽过程中是否满足解除吸附的阈值。
 * @param side 当前吸附方向
 * @param movementX 横向移动距离
 * @param undockThreshold 灵敏度阈值
 * @returns 是否应当解除吸附
 */
export const shouldUndock = (
  side: DockedSide,
  movementX: number,
  undockThreshold: number = DEFAULT_UNDOCK_THRESHOLD
): boolean => {
  if (side === 'left') {
    return movementX >= undockThreshold;
  }
  return movementX <= -undockThreshold;
};

export interface DockedPositionOptions {
  /** 吸附方向 */
  side: DockedSide;
  /** 当前浮窗位置，用于保留垂直或水平位移 */
  position: FloatingPosition;
  /** 面板尺寸，用于计算越界距离 */
  panelSize: PanelSize;
  /** 视口尺寸，用于限制另一方向 */
  viewport: ViewportSize;
  /** 提手宽度 */
  handleSize?: number;
}

/**
 * 计算吸附状态下的面板坐标，仅保留提手在屏幕内。
 * @param options 吸附参数
 * @returns 调整后的浮窗坐标
 */
export const getDockedPosition = (options: DockedPositionOptions): FloatingPosition => {
  const { side, position, panelSize, viewport, handleSize = FLOATING_HANDLE_SIZE } = options;

  const boundary = createDragBoundary({
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    panelWidth: panelSize.width,
    panelHeight: panelSize.height,
    handleSize,
  });

  switch (side) {
    case 'left':
      return {
        x: boundary.minX,
        y: clampValue(position.y, boundary.minY, boundary.maxY),
      };
    case 'right':
      return {
        x: boundary.maxX,
        y: clampValue(position.y, boundary.minY, boundary.maxY),
      };
    default:
      return position;
  }
};
