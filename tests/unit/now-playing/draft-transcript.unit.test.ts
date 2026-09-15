import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// 中文注释：M7-04-02 Draft Transcript 单测（L1，纯函数 + 架构守卫，不触库/网络）。
// 锁定验收 1/2/3/4/5/6 的确定性切面：Draft 查看正文入口（§35，同文案独立 testid，
// 绝不生成 /library/[fake-id]）、Transcript 只读（唯一来源 Session.storyText，
// 无编辑面）、局部 view 切换（controls ↔ transcript 不进 global UI Store，
// 返回控制不改 Session）、promotion 保持打开 + 打开作品详情复用同一路由出口
// （§35.1）、fail-closed（无正文/非法状态不展示或空态）、Work 面回归冻结。

const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);

const readRepoText = (rel: string): string =>
    fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');

const loadViaJiti = (rel: string): Record<string, unknown> => {
    const factory = nodeRequire('jiti') as unknown as (
        base: string,
        opts: Record<string, unknown>
    ) => (id: string) => Record<string, unknown>;
    const inner = factory(path.join(process.cwd(), 'index.js'), {
        alias: { '@': process.cwd() },
        jsx: true,
    });
    return inner(rel.startsWith('./') || rel.startsWith('../') ? rel : `./${rel}`);
};

const installUnitStubs = (): void => {
    const extTable = (
        nodeRequire as unknown as {
            extensions: Record<string, (m: NodeModule, f: string) => void>;
        }
    ).extensions;
    if (extTable && !extTable['.scss']) {
        const scssStub = (m: NodeModule): void => {
            const proxy = new Proxy(
                {},
                {
                    get: (_t: object, p: string | symbol): unknown => {
                        if (p === '__esModule') {
                            return true;
                        }
                        return String(p);
                    },
                }
            );
            (m as unknown as { exports: unknown }).exports = proxy;
        };
        extTable['.scss'] = scssStub as (m: NodeModule, f: string) => void;
        extTable['.css'] = scssStub as (m: NodeModule, f: string) => void;
    }
};

const stripComments = (src: string): string =>
    src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|\s)\/\/.*$/gm, '$1');

const DRAFT = { kind: 'draft', messageId: 'msg_draft_02_01' } as const;
const WORK = { kind: 'work', workId: 481 } as const;
const STORY = '第一段：森林里的小猫勇敢出发。\n第二段：大家结伴同行互相帮助。';

async function runDraftTranscriptUnit(): Promise<void> {
    installUnitStubs();

    console.log('=== M7-04-02-U1: Draft helper 纯派生（验收 1/4，§35 fail-closed） ===');
    {
        const helper = loadViaJiti('./components/NowPlaying/draftTranscript.ts') as unknown as {
            normalizeDraftTranscriptText: (t: unknown) => string | null;
            resolveDraftTranscriptText: (s: unknown, t: unknown, st: unknown) => string | null;
            resolveTranscriptDisplayText: (s: unknown, t: unknown, st: unknown) => string | null;
            shouldShowDraftTranscript: (s: unknown, t: unknown, st: unknown) => boolean;
            decideDraftTranscript: (i: { source: unknown; storyText: unknown; status: unknown }) => { visible: boolean; text: string | null };
        };
        // Draft + 可用正文 → 原文透传（不截断不拼接）。
        assert.strictEqual(helper.resolveDraftTranscriptText(DRAFT, STORY, 'paused'), STORY, 'Draft 原文透传');
        assert.strictEqual(helper.resolveDraftTranscriptText(DRAFT, STORY, 'playing'), STORY);
        assert.strictEqual(helper.shouldShowDraftTranscript(DRAFT, STORY, 'paused'), true, 'Draft 即展示查看正文');
        assert.deepStrictEqual(
            helper.decideDraftTranscript({ source: DRAFT, storyText: STORY, status: 'paused' }),
            { visible: true, text: STORY }
        );
        // Work / 空 / idle / 无正文 → fail-closed（绝不拼凑）。
        assert.strictEqual(helper.resolveDraftTranscriptText(WORK, STORY, 'paused'), null, 'Work 不走 transcript');
        assert.strictEqual(helper.resolveDraftTranscriptText(null, STORY, 'paused'), null);
        assert.strictEqual(helper.resolveDraftTranscriptText(undefined, STORY, 'paused'), null);
        assert.strictEqual(helper.resolveDraftTranscriptText(DRAFT, STORY, 'idle'), null, 'idle 无会话不展示');
        assert.strictEqual(helper.resolveDraftTranscriptText(DRAFT, '', 'paused'), null, '空正文隐藏');
        assert.strictEqual(helper.resolveDraftTranscriptText(DRAFT, '   \n  ', 'paused'), null, '空白正文隐藏');
        assert.strictEqual(helper.resolveDraftTranscriptText(DRAFT, null, 'paused'), null);
        assert.strictEqual(helper.resolveDraftTranscriptText(DRAFT, 123, 'paused'), null);
        assert.strictEqual(helper.shouldShowDraftTranscript(WORK, STORY, 'paused'), false);
        assert.strictEqual(helper.shouldShowDraftTranscript(DRAFT, '', 'paused'), false);
        assert.deepStrictEqual(
            helper.decideDraftTranscript({ source: DRAFT, storyText: '', status: 'paused' }),
            { visible: false, text: null }
        );
        // 展示文本 promotion 容忍：有会话 + 正文即返回（不分 kind）。
        assert.strictEqual(helper.resolveTranscriptDisplayText(DRAFT, STORY, 'paused'), STORY);
        assert.strictEqual(helper.resolveTranscriptDisplayText(WORK, STORY, 'paused'), STORY, 'promotion 后仍展示同一 storyText');
        assert.strictEqual(helper.resolveTranscriptDisplayText(null, STORY, 'paused'), null);
        assert.strictEqual(helper.resolveTranscriptDisplayText(WORK, '', 'paused'), null);
        // 源码级：绝不拼凑 Library 目标（无第二目标源）。
        const helperSrc = stripComments(readRepoText('components/NowPlaying/draftTranscript.ts'));
        assert.ok(!helperSrc.includes('/library'), 'Draft helper 不得拼凑 Library 目标');
        assert.ok(!helperSrc.includes('workId'), 'Draft helper 不得消费 workId');
        assert.ok(!helperSrc.includes('fake'), '不得出现 fake 形态');
        assert.ok(!helperSrc.includes('usePlaybackSessionStore') && !helperSrc.includes('usePlaybackStore'), 'helper 不得读 store（纯函数）');
        assert.ok(!helperSrc.includes('useRouter') && !helperSrc.includes('router.push'), 'helper 不得碰路由');
        assert.ok(!helperSrc.includes('nowPlayingUiStore'), 'helper 不得碰 global UI Store');
        console.log('PASS: M7-04-02-U1 draft helper fail-closed');
    }

    console.log('=== M7-04-02-U2: 常量冻结（testid/文案） ===');
    {
        const helper = loadViaJiti('./components/NowPlaying/draftTranscript.ts') as unknown as {
            EXPANDED_TRANSCRIPT_TESTID: string;
            EXPANDED_TRANSCRIPT_TEXT_TESTID: string;
            EXPANDED_TRANSCRIPT_EMPTY_TESTID: string;
            EXPANDED_VIEW_TRANSCRIPT_BUTTON_TESTID: string;
            EXPANDED_TRANSCRIPT_BACK_BUTTON_TESTID: string;
            EXPANDED_OPEN_WORK_DETAIL_BUTTON_TESTID: string;
            TRANSCRIPT_BACK_LABEL: string;
            OPEN_WORK_DETAIL_LABEL: string;
            TRANSCRIPT_EMPTY_LABEL: string;
        };
        assert.strictEqual(helper.EXPANDED_TRANSCRIPT_TESTID, 'expanded-transcript');
        assert.strictEqual(helper.EXPANDED_TRANSCRIPT_TEXT_TESTID, 'expanded-transcript-text');
        assert.strictEqual(helper.EXPANDED_TRANSCRIPT_EMPTY_TESTID, 'expanded-transcript-empty');
        assert.strictEqual(helper.EXPANDED_VIEW_TRANSCRIPT_BUTTON_TESTID, 'expanded-view-transcript-button');
        assert.strictEqual(helper.EXPANDED_TRANSCRIPT_BACK_BUTTON_TESTID, 'expanded-transcript-back-button');
        assert.strictEqual(helper.EXPANDED_OPEN_WORK_DETAIL_BUTTON_TESTID, 'expanded-open-work-detail-button');
        assert.strictEqual(helper.TRANSCRIPT_BACK_LABEL, '返回控制');
        assert.strictEqual(helper.OPEN_WORK_DETAIL_LABEL, '打开作品详情');
        assert.strictEqual(helper.TRANSCRIPT_EMPTY_LABEL, '暂无正文');
        // Draft 口与 Work 口同文案（查看正文），行为由独立 testid 区分。
        const workHelper = loadViaJiti('./components/NowPlaying/workViewStoryNavigation.ts') as unknown as {
            VIEW_STORY_LABEL: string;
        };
        assert.strictEqual(workHelper.VIEW_STORY_LABEL, '查看正文');
        console.log('PASS: M7-04-02-U2 constants');
    }

    console.log('=== M7-04-02-U3: ViewModel 增补向后兼容（§14 additive） ===');
    {
        const vm = loadViaJiti('./components/NowPlaying/useExpandedNowPlayingViewModel.ts') as unknown as {
            deriveDraftTranscriptText: (s: unknown, t: unknown, st: string) => string | null;
            deriveTranscriptDisplayText: (s: unknown, t: unknown, st: string) => string | null;
            deriveExpandedCanViewTranscript: (s: unknown, t: unknown, st: string) => boolean;
            deriveExpandedNowPlayingViewModel: (
                s: Record<string, unknown>,
                t: Record<string, unknown>,
                o: Array<{ value: string; label: string }>
            ) => Record<string, unknown>;
        };
        assert.strictEqual(vm.deriveDraftTranscriptText(DRAFT, STORY, 'paused'), STORY);
        assert.strictEqual(vm.deriveDraftTranscriptText(WORK, STORY, 'paused'), null, 'Work 入口仍隐藏（01 冻结）');
        assert.strictEqual(vm.deriveExpandedCanViewTranscript(DRAFT, STORY, 'paused'), true);
        assert.strictEqual(vm.deriveExpandedCanViewTranscript(DRAFT, STORY, 'idle'), false);
        assert.strictEqual(vm.deriveExpandedCanViewTranscript(WORK, STORY, 'paused'), false);
        assert.strictEqual(vm.deriveTranscriptDisplayText(WORK, STORY, 'paused'), STORY, 'promotion 后展示文本保留');
        // 旧调用兼容（无 storyText/sessionId）：Draft 口隐藏，Work 面不受损。
        const legacy = vm.deriveExpandedNowPlayingViewModel(
            { source: WORK, status: 'paused', title: '故事', voiceId: 'v1', nextParagraphIndex: 0, totalParagraphs: 2, speed: 1.0 },
            { isPlaying: false, currentTime: 0, duration: 1, playbackRate: 1.0 },
            [{ value: 'v1', label: '小雅' }]
        ) as unknown as {
            canViewStory: boolean; viewStoryTarget: string | null;
            canViewTranscript: boolean; transcriptText: string | null;
            sessionId: string | null; title: string;
        };
        assert.strictEqual(legacy.canViewStory, true, 'Work 导航口回归不变');
        assert.strictEqual(legacy.viewStoryTarget, '/library/481');
        assert.strictEqual(legacy.canViewTranscript, false, '旧调用（无 storyText）Draft 口隐藏');
        assert.strictEqual(legacy.transcriptText, null);
        assert.strictEqual(legacy.sessionId, null, '缺省 sessionId null（兼容）');
        assert.strictEqual(legacy.title, '故事');
        // Draft 全量：入口 + 原文 + sessionId 透传。
        const draftFull = vm.deriveExpandedNowPlayingViewModel(
            { source: DRAFT, status: 'paused', title: '草稿', voiceId: '', nextParagraphIndex: 0, totalParagraphs: 2, storyText: STORY, sessionId: 'sid-02' },
            { isPlaying: false, currentTime: 0, duration: 0 },
            []
        ) as unknown as { canViewTranscript: boolean; transcriptText: string | null; sessionId: string | null; canViewStory: boolean; viewStoryTarget: string | null };
        assert.strictEqual(draftFull.canViewTranscript, true);
        assert.strictEqual(draftFull.transcriptText, STORY, '内容 = Session.storyText 原文');
        assert.strictEqual(draftFull.sessionId, 'sid-02');
        assert.strictEqual(draftFull.canViewStory, false, 'Draft 不走 Work 导航口');
        assert.strictEqual(draftFull.viewStoryTarget, null, 'Draft 无 Library 目标');
        // promotion 态：source 切 work 但 storyText 同值 → 展示文本保留，入口切导航口。
        const promoted = vm.deriveExpandedNowPlayingViewModel(
            { source: WORK, status: 'paused', title: '作品', voiceId: '', nextParagraphIndex: 0, totalParagraphs: 2, storyText: STORY, sessionId: 'sid-02' },
            { isPlaying: false, currentTime: 0, duration: 0 },
            []
        ) as unknown as { canViewTranscript: boolean; transcriptText: string | null; canViewStory: boolean; viewStoryTarget: string | null };
        assert.strictEqual(promoted.transcriptText, STORY, 'promotion 后 transcript 文本保留（sessionId 不变）');
        assert.strictEqual(promoted.canViewTranscript, false, 'promotion 后入口切导航口');
        assert.strictEqual(promoted.canViewStory, true);
        assert.strictEqual(promoted.viewStoryTarget, '/library/481');
        const vmSrc = stripComments(readRepoText('components/NowPlaying/useExpandedNowPlayingViewModel.ts'));
        assert.ok(vmSrc.includes('resolveDraftTranscriptText'), 'VM 经 helper 单一派生（无第二正文源）');
        assert.ok(!vmSrc.includes('pausePlayback') && !vmSrc.includes('router'), 'ViewModel 不得调 Flow/路由（只派生）');
        console.log('PASS: M7-04-02-U3 viewmodel additive');
    }

    console.log('=== M7-04-02-U4: Actions Draft 分支（Work 冻结 + Draft 同文案独立口） ===');
    {
        const src = stripComments(readRepoText('components/NowPlaying/NowPlayingActions.tsx'));
        // Work 口冻结（01 契约原文保留）。
        assert.ok(src.includes('shouldShowWorkViewStory'), 'Work 口展示依据冻结');
        assert.ok(src.includes('EXPANDED_VIEW_STORY_BUTTON_TESTID'), 'Work 按钮 testid 冻结');
        assert.ok(src.includes('onViewStory'), 'Work 回调冻结');
        // Draft 口 additive（同文案、独立 testid、独立回调）。
        assert.ok(src.includes('shouldShowDraftTranscript'), 'Draft 口经 helper 判定');
        assert.ok(src.includes('EXPANDED_VIEW_TRANSCRIPT_BUTTON_TESTID'), 'Draft 按钮独立 testid');
        assert.ok(src.includes('onViewTranscript'), 'Draft 回调独立');
        assert.ok(src.includes('VIEW_STORY_LABEL'), 'Draft 口同文案查看正文（单文案源）');
        assert.ok(src.includes('return null'), '两者皆无返回 null（不占位）');
        // Work 优先（promotion 后 source 切 work 即走导航口）。
        assert.ok(
            src.indexOf('shouldShowWorkViewStory') < src.indexOf('shouldShowDraftTranscript'),
            '顺序固定：Work 口优先，promotion 后自动切导航口'
        );
        for (const forbidden of ['usePlaybackSessionStore', 'usePlaybackStore', 'useRouter', 'router.push', '/library', 'AudioController', 'pausePlayback', 'contentEditable', 'continueFromStoryWork']) {
            assert.ok(!src.includes(forbidden), `Actions 不得含 ${forbidden}`);
        }
        console.log('PASS: M7-04-02-U4 actions draft branch');
    }

    console.log('=== M7-04-02-U5: TranscriptView 只读纯度（验收 2，§35） ===');
    {
        const src = stripComments(readRepoText('components/NowPlaying/TranscriptView.tsx'));
        assert.ok(src.includes('expanded-transcript') || src.includes('EXPANDED_TRANSCRIPT_TESTID'), '容器 testid');
        assert.ok(src.includes('expanded-transcript-text') || src.includes('EXPANDED_TRANSCRIPT_TEXT_TESTID'), '正文 testid');
        assert.ok(src.includes('expanded-transcript-empty') || src.includes('EXPANDED_TRANSCRIPT_EMPTY_TESTID'), '空态 testid');
        assert.ok(src.includes('expanded-transcript-back-button') || src.includes('EXPANDED_TRANSCRIPT_BACK_BUTTON_TESTID'), '返回控制 testid');
        assert.ok(src.includes('返回控制') || src.includes('TRANSCRIPT_BACK_LABEL'), '返回文案');
        assert.ok(src.includes('暂无正文') || src.includes('TRANSCRIPT_EMPTY_LABEL'), '空态文案（不伪造正文）');
        assert.ok(src.includes('onBack'), '返回回调透传父级（只切局部 view）');
        assert.ok(src.includes('onOpenWorkDetail'), 'promotion 入口由父级按需传入（§35.1，不过界）');
        assert.ok(src.includes('打开作品详情') || src.includes('OPEN_WORK_DETAIL_LABEL'), 'promotion 入口文案');
        for (const forbidden of ['contentEditable', 'textarea', '<textarea', '<input', 'usePlaybackSessionStore', 'usePlaybackStore', 'useRouter', 'router.push', '/library', 'AudioController', 'pausePlayback', 'setActiveStory', 'continueFromStoryWork']) {
            assert.ok(!src.includes(forbidden), `TranscriptView 不得含 ${forbidden}`);
        }
        console.log('PASS: M7-04-02-U5 transcript readonly');
    }

    console.log('=== M7-04-02-U6: Expanded 局部 view（验收 3/5，§35/§72） ===');
    {
        const src = stripComments(readRepoText('components/NowPlaying/ExpandedNowPlaying.tsx'));
        assert.ok(src.includes('TranscriptView'), 'Expanded 挂载 TranscriptView（02 职责）');
        assert.ok(src.includes('NowPlayingActions'), 'Actions 保留（Work 冻结 + Draft 口）');
        assert.ok(src.includes('expandedView') || src.includes('ExpandedLocalView'), '局部 view state 存在');
        assert.ok(src.includes('useState') && (src.includes("'transcript'") || src.includes('"transcript"')), 'view 含 transcript 态');
        assert.ok(src.includes('handleViewTranscript'), 'Draft 查看正文统一回调');
        assert.ok(src.includes('handleBackToControls'), '返回控制统一回调');
        // §35/§72 互斥分支：transcript 与 controls 二选一（非追加）——
        // TranscriptView 位于 transcript 三元分支内，Actions/PlaybackControls/
        // Timeline 位于 controls 分支内（源码顺序：transcript 分支先，controls 后）。
        assert.ok(src.includes("expandedView === 'transcript'"), '分支条件为 expandedView === transcript');
        assert.ok(src.indexOf('<TranscriptView') > src.indexOf("expandedView === 'transcript'"), 'TranscriptView 位于 transcript 分支内');
        assert.ok(src.indexOf('<NowPlayingActions') > src.indexOf('<TranscriptView'), 'Actions 位于 controls 分支（transcript 后，互斥）');
        assert.ok(src.indexOf('<PlaybackControls') > src.indexOf('<TranscriptView'), 'PlaybackControls 位于 controls 分支（互斥）');
        assert.ok(src.indexOf('<PlaybackTimeline') > src.indexOf('<TranscriptView'), 'Timeline 位于 controls 分支（互斥）');
        // 开合只动局部 view：两回调段内无 Session/Transport/路由/播放写面。
        //（M7-04-03 收窄：handler 段精确截至闭包结束，避免 800 字符窗口误吞
        // 后续 handleBackToCreation 的合法 push。）
        for (const handler of ['handleViewTranscript', 'handleBackToControls']) {
            const at = src.indexOf(`const ${handler}`);
            assert.ok(at >= 0, `${handler} 存在`);
            const end = src.indexOf('}, []', at);
            assert.ok(end > at, `${handler} 闭包结束存在`);
            const seg = src.slice(at, end + 5);
            assert.ok(!seg.includes('router.push'), `${handler} 不得导航`);
            assert.ok(!seg.includes('pause'), `${handler} 不得 pause`);
            assert.ok(!seg.includes('closeExpanded'), `${handler} 不得关闭 Expanded（局部切换，面板保持打开）`);
            assert.ok(!seg.includes('setActiveStory') && !seg.includes('storyText'), `${handler} 不得改 Session 字段`);
        }
        // Actions 接线：Draft 口 storyText/status/onViewTranscript 全传入。
        assert.ok(src.includes('viewModel.transcriptText'), '正文经 ViewModel（Session.storyText 链）');
        assert.ok(src.includes('onViewTranscript'), 'Draft 口回调接线');
        // promotion：局部 view 只按 sessionId 与开关重置（source 变化不重置 → 保持打开）。
        assert.ok(src.includes('viewModel.sessionId'), '重置键为 sessionId（promotion 同 id 保持）');
        assert.ok(src.includes('transcriptOpenDetail') || src.includes('onOpenWorkDetail'), 'promotion 入口接线');
        // M7-04-03 supersede（定向最强，非放宽）：路由出口由一处增至两处——
        // 查看正文（handleViewStory → Library）+ 返回创作（handleBackToCreation → /chat）；
        // promotion 入口仍复用查看正文同一 handler（不过界），返回创作零自动发送。
        assert.strictEqual(src.split('router.push').length - 1, 2, '两处路由出口：查看正文 + 返回创作（各司其职）');
        assert.ok(src.indexOf('router.push', src.indexOf('handleViewStory')) >= 0, 'push 位于查看正文动作内');
        assert.ok(src.includes('handleBackToCreation'), 'M7-04-03 Draft 返回创作回调存在');
        assert.ok(src.includes('onBackToCreation'), '返回创作经 Actions 接线（与查看正文并存）');
        assert.ok(src.indexOf('router.push', src.indexOf('handleBackToCreation')) >= 0, 'push 位于返回创作动作内');
        {
            const backAt = src.indexOf('handleBackToCreation');
            const backSeg = src.slice(backAt, backAt + 800);
            assert.ok(backSeg.includes('handleClose'), '返回创作先 closeExpanded（§44）');
            assert.ok(backSeg.indexOf('handleClose') < backSeg.indexOf('router.push'), '返回创作顺序：close 先于 push');
            assert.ok(!backSeg.toLowerCase().includes('send'), '返回创作零 send（不自动发送）');
            assert.ok(!backSeg.includes('dispatch') && !backSeg.includes('pendingAutoSend'), '返回创作无预填即发/消息追加');
            assert.ok(!backSeg.includes('storyText') && !backSeg.includes('prompt'), '返回创作不拼 continuation Prompt');
            assert.ok(!backSeg.includes('pause'), '返回创作不得 pause（播放继续）');
        }
        assert.ok(!src.includes('continueFromStoryWork('), '无真实 continuation 调用（行为归 M4）');
        assert.ok(!src.includes('onContinueCreation'), 'Work 继续创作未缝合（隐藏，不伪造）');
        assert.ok(!src.includes('请继续'), 'M7 内禁拼 continuation Prompt');
        // 全局 Store 零新增：Expanded 不写 UI Store 新字段，store 文件无 transcript 字段。
        const storeSrc = stripComments(readRepoText('stores/nowPlayingUiStore.ts'));
        assert.ok(!storeSrc.includes('transcript') && !storeSrc.includes('Transcript'), 'global UI Store 不新增 transcript 字段');
        assert.ok(!storeSrc.includes('expandedView') && !storeSrc.includes('localView'), 'global UI Store 不存局部 view');
        assert.ok(!src.includes("push('/player')") && !src.includes('push("/player")'), '不得碰 /player（04 职责）');
        assert.ok(!src.includes('/library/fake') && !src.includes('fake-id'), '任何路径无 fake-id 形态');
        console.log('PASS: M7-04-02-U6 local view no-global-store');
    }

    console.log('=== M7-04-02-U7: 无 scope creep（03/04 边界；M7-04-03 定向最强） ===');
    {
        const actionsSrc = stripComments(readRepoText('components/NowPlaying/NowPlayingActions.tsx'));
        const helperSrc = stripComments(readRepoText('components/NowPlaying/draftTranscript.ts'));
        const transcriptSrc = stripComments(readRepoText('components/NowPlaying/TranscriptView.tsx'));
        const expandedSrc = stripComments(readRepoText('components/NowPlaying/ExpandedNowPlaying.tsx'));
        for (const token of ['上一段', '下一段', 'nextParagraph']) {
            assert.ok(!actionsSrc.includes(token), `Actions 不得含 ${token}`);
            assert.ok(!helperSrc.includes(token), `helper 不得含 ${token}`);
            assert.ok(!transcriptSrc.includes(token), `TranscriptView 不得含 ${token}`);
        }
        // M7-04-03 定向最强（非放宽）：03 职责由 creationActions 承接——
        // Work 继续创作隐藏（无真实调用）+ Draft 返回创作存在且零 send。
        for (const src of [actionsSrc, helperSrc, transcriptSrc, expandedSrc]) {
            assert.ok(!src.includes('continueFromStoryWork('), '无真实 continuation 调用（fail-closed）');
            assert.ok(!src.includes('请继续'), '禁拼 continuation Prompt');
            assert.ok(!src.includes('AUTO_CONTINUE_PROMPT'), '不得引用自动续写常量');
        }
        assert.ok(actionsSrc.includes('shouldShowDraftBackToCreation'), 'M7-04-03 Actions 承接返回创作（Draft 双口并存）');
        assert.ok(actionsSrc.includes('shouldShowWorkContinueCreation'), 'M7-04-03 Actions 预留继续创作判定（恒隐藏）');
        assert.ok(expandedSrc.includes('handleBackToCreation'), 'M7-04-03 Expanded 承接返回创作（close + push /chat）');
        assert.ok(!expandedSrc.includes('onContinueCreation'), 'Work 继续创作未缝合（隐藏，不伪造）');
        assert.ok(!expandedSrc.includes('/player'), 'Expanded 不碰 /player（04 职责）');
        console.log('PASS: M7-04-02-U7 no scope creep');
    }

    console.log('\nALL DRAFT TRANSCRIPT UNIT TESTS PASSED SUCCESSFULLY!');
}

const testPromise = runDraftTranscriptUnit()
    .then(() => {
        console.log('ALL DRAFT TRANSCRIPT UNIT TESTS PASSED SUCCESSFULLY!');
    })
    .catch((error) => {
        console.error('Draft transcript unit test failed:', error);
        process.exit(1);
    });

export default testPromise;
