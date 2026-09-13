'use client';

/**
 * M7-01 NowPlayingHeader（spec §3/§10/§11 基础 presentation）。
 *
 * 纯展示组件：只收 props，不读任何 store / Session / Transport。
 * - Drag Handle：移动端 Bottom Sheet 唯一拖拽发起点（spec §10.2），
 *   桌面 Side Panel 下经 CSS 隐藏（仍保留 DOM 供一致性打点，aria-hidden）。
 * - 标题区：title + voice · 段落二级文案（P3A 明确“本段/第 X/Y 段”，不伪装整篇）。
 * - 关闭按钮：Expanded 打开时首个焦点目标（spec §42），Escape/backdrop/swipe
 *   之外的显式关闭入口；点击只关闭 UI，不暂停播放（spec §9）。
 */

import React from 'react';
import { X } from 'lucide-react';

import styles from './ExpandedNowPlaying.module.scss';

/** Header props（全部由 ExpandedNowPlaying 经 ViewModel 派生传入）。 */
export type NowPlayingHeaderProps = {
    /** 一级标题（Session.title，已回退）。 */
    title: string;
    /** 二级文案（如“小雅 · 第 4 / 12 段”，调用方组装）。 */
    subtitle: string | null;
    /** 关闭回调（只关闭 UI，不触播放）。 */
    onClose: () => void;
    /** Drag Handle 绑定（仅 spread 到 handle，内容区/controls 不得 spread）。 */
    dragHandleProps?: Record<string, unknown>;
    /** 是否正在拖拽（供 cursor/transition 打点）。 */
    isDragging?: boolean;
};

export const NOW_PLAYING_HEADER_CLOSE_LABEL = '关闭正在播放';
export const NOW_PLAYING_DRAG_HANDLE_LABEL = '向下拖动关闭';

/**
 * Expanded 头部：Handle + 标题 + 关闭。
 * Handle 为唯一可拖元素（内容区滚动/Speed/Timer 与其不冲突）。
 */
export const NowPlayingHeader: React.FC<NowPlayingHeaderProps> = ({
    title,
    subtitle,
    onClose,
    dragHandleProps,
    isDragging = false,
}) => {
    return (
        <div className={styles.header} data-testid="expanded-header">
            <div
                className={styles.dragHandleZone}
                data-testid="expanded-drag-handle"
                data-dragging={isDragging ? 'true' : 'false'}
                role="button"
                tabIndex={0}
                aria-label={NOW_PLAYING_DRAG_HANDLE_LABEL}
                aria-hidden={false}
                {...dragHandleProps}
            >
                <span aria-hidden="true" className={styles.dragHandleBar} />
            </div>
            <div className={styles.titleRow}>
                <div className={styles.titleBlock}>
                    <div className={styles.title} data-testid="expanded-title">
                        {title}
                    </div>
                    {subtitle !== null ? (
                        <div className={styles.subtitle} data-testid="expanded-subtitle">
                            {subtitle}
                        </div>
                    ) : null}
                </div>
                <button
                    type="button"
                    className={styles.closeButton}
                    aria-label={NOW_PLAYING_HEADER_CLOSE_LABEL}
                    onClick={onClose}
                    data-testid="expanded-close-button"
                    // spec §42：打开后焦点首个落点为关闭按钮（RAC 自动聚焦首个可聚焦元素，
                    // 此处显式 autoFocus 保证跨浏览器一致）。
                    autoFocus
                >
                    <X size={16} strokeWidth={2} aria-hidden="true" />
                </button>
            </div>
        </div>
    );
};

export default NowPlayingHeader;
