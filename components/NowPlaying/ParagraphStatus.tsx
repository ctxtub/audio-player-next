'use client';

/**
 * M7-02 ParagraphStatus（spec §39）。
 *
 * P3A 最重要的作品级定位：「第 4 / 12 段」。
 * - 数据仅取 Session.nextParagraphIndex/totalParagraphs（段落 identity），
 *   绝不取 Transport currentTime/duration（段内位置）；
 * - 纯 badge，不新增「上一段/下一段」按钮（spec §40 明确拒绝）；
 * - P3B 即使有全篇时间轴仍保留本 indicator（本组件形态不变）。
 *
 * 纯展示：只收 current/total，不读 store。
 */

import React from 'react';

/** ParagraphStatus props（父级经 ViewModel.paragraph 传入，已钳制 1..total）。 */
export type ParagraphStatusProps = {
    /** 1-based 当前段序号。 */
    current: number;
    /** 总段数（>=1）。 */
    total: number;
};

/**
 * 纯函数：段落文案（与 Mini secondaryLabel 多段分支同公式）。
 */
export const formatParagraphStatus = (current: number, total: number): string =>
    `第 ${current} / ${total} 段`;

export const ParagraphStatus: React.FC<ParagraphStatusProps> = ({ current, total }) => {
    return (
        <div data-testid="expanded-paragraph-status" aria-label={formatParagraphStatus(current, total)}>
            {formatParagraphStatus(current, total)}
        </div>
    );
};

export default ParagraphStatus;
