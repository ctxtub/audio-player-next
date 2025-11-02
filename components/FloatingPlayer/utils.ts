/**
 * 浮动播放器拖拽工具集合，提供状态生成与位置计算方法。
 */
export interface FloatingPosition {
  /** 浮窗当前横坐标，单位为像素 */
  x: number;
  /** 浮窗当前纵坐标，单位为像素 */
  y: number;
}

export interface DragState {
  /** 指针标识，用于过滤多指同时拖拽 */
  pointerId: number;
  /** 指针按下时的横坐标 */
  startX: number;
  /** 指针按下时的纵坐标 */
  startY: number;
  /** 浮窗原始横坐标 */
  originX: number;
  /** 浮窗原始纵坐标 */
  originY: number;
}

export interface DragDelta {
  /** 指针移动相对起点的横向位移 */
  deltaX: number;
  /** 指针移动相对起点的纵向位移 */
  deltaY: number;
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

export interface DragStateRef {
  /** React ref 容器，承载当前拖拽状态 */
  current: DragState | null;
}

export interface DragListenerOptions {
  /** 拖拽状态引用 */
  dragStateRef: DragStateRef;
  /** 拖拽结束回调 */
  onDragEnd: () => void;
  /** 拖拽过程位置更新回调 */
  onDrag: (position: FloatingPosition) => void;
  /** 运行时动态生成的拖拽边界 */
  createBoundary: () => DragBoundary;
  /** 自定义拖拽阈值 */
  threshold?: number;
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
}

/**
 * 拖拽阈值常量，避免误触导致面板抖动。
 */
export const DRAG_THRESHOLD_PX = 4;

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
 * 根据指针事件生成拖拽状态快照。
 * @param event 指针事件
 * @param position 当前浮窗位置
 * @returns 拖拽状态对象
 */
export const createDragState = (
  event: Pick<PointerEvent, 'pointerId' | 'clientX' | 'clientY'>,
  position: FloatingPosition
): DragState => {
  return {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    originX: position.x,
    originY: position.y,
  };
};

/**
 * 计算指针相对拖拽起点的位移。
 * @param dragState 当前拖拽状态
 * @param event 指针事件
 * @returns 横纵向位移
 */
export const calculatePointerDelta = (
  dragState: DragState,
  event: Pick<PointerEvent, 'clientX' | 'clientY'>
): DragDelta => {
  return {
    deltaX: event.clientX - dragState.startX,
    deltaY: event.clientY - dragState.startY,
  };
};

/**
 * 判断位移是否超过拖拽阈值。
 * @param delta 位移对象
 * @param threshold 阈值像素
 * @returns 是否满足拖拽条件
 */
export const isBeyondDragThreshold = (
  delta: DragDelta,
  threshold: number = DRAG_THRESHOLD_PX
): boolean => {
  return Math.abs(delta.deltaX) >= threshold || Math.abs(delta.deltaY) >= threshold;
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
    marginX = 12,
    marginY = 12,
    panelWidth = 320,
    panelHeight = 320,
  } = options;

  const maxX = Math.max(marginX, viewportWidth - panelWidth - marginX);
  const maxY = Math.max(marginY, viewportHeight - panelHeight - marginY);

  return {
    minX: marginX,
    minY: marginY,
    maxX,
    maxY,
  };
};

/**
 * 计算拖拽后夹紧到边界内的位置。
 * @param dragState 拖拽状态
 * @param delta 指针位移
 * @param boundary 拖拽边界
 * @returns 夹紧后的浮窗位置
 */
export const computeDragPosition = (
  dragState: DragState,
  delta: DragDelta,
  boundary: DragBoundary
): FloatingPosition => {
  const nextX = clampValue(dragState.originX + delta.deltaX, boundary.minX, boundary.maxX);
  const nextY = clampValue(dragState.originY + delta.deltaY, boundary.minY, boundary.maxY);
  return { x: nextX, y: nextY };
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
 * 注册指针对应的拖拽监听，返回卸载函数。
 * @param options 拖拽监听参数
 * @returns 卸载监听回调
 */
export const attachDragListeners = (options: DragListenerOptions): (() => void) => {
  if (typeof window === 'undefined') {
    return () => undefined;
  }

  const { dragStateRef, onDragEnd, onDrag, createBoundary, threshold = DRAG_THRESHOLD_PX } = options;

  const handlePointerMove = (event: PointerEvent) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }
    const delta = calculatePointerDelta(dragState, event);
    if (!isBeyondDragThreshold(delta, threshold)) {
      return;
    }
    const boundary = createBoundary();
    const nextPosition = computeDragPosition(dragState, delta, boundary);
    onDrag(nextPosition);
  };

  const handlePointerUp = (event: PointerEvent) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }
    dragStateRef.current = null;
    onDragEnd();
  };

  window.addEventListener('pointermove', handlePointerMove);
  window.addEventListener('pointerup', handlePointerUp);
  window.addEventListener('pointercancel', handlePointerUp);

  return () => {
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
    window.removeEventListener('pointercancel', handlePointerUp);
  };
};
