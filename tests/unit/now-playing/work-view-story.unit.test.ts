import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// 中文注释：M7-04-01 Work 查看正文导航单测（L1，纯函数 + 架构守卫，不触库/网络）。
// 锁定验收 1/3/4/5/6 的确定性切面：workId 直接派生（§34，无猜测）、
// 同 Detail 去重（§34.1）、Draft 隐藏（§35 禁止 fake-id）、
// ViewModel 增补向后兼容、Actions 无 Library 管理面（§33）、
// Expanded 先关后导且播放继续（§44/§9）、无 prev/next 回退（§40）。

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

async function runWorkViewStoryUnit(): Promise<void> {
    installUnitStubs();

    console.log('=== M7-04-01-U1: 目标直接派生 workId（验收 1，§34） ===');
    {
        const helper = loadViaJiti('./components/NowPlaying/workViewStoryNavigation.ts') as unknown as {
            resolveWorkLibraryTarget: (source: unknown) => string | null;
            shouldShowWorkViewStory: (source: unknown) => boolean;
        };
        assert.strictEqual(helper.resolveWorkLibraryTarget({ kind: 'work', workId: 481 }), '/library/481');
        assert.strictEqual(helper.resolveWorkLibraryTarget({ kind: 'work', workId: 1 }), '/library/1');
        assert.strictEqual(helper.shouldShowWorkViewStory({ kind: 'work', workId: 481 }), true, 'Work 即展示');
        // 非法 workId fail-closed（绝不拼凑目标）。
        for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '481', null, undefined]) {
            assert.strictEqual(
                helper.resolveWorkLibraryTarget({ kind: 'work', workId: bad }),
                null,
                `非法 workId 必须 null：${String(bad)}`
            );
        }
        // Draft / 空 / 未知 kind 一律 null（§35 禁止 fake-id）。
        assert.strictEqual(helper.resolveWorkLibraryTarget({ kind: 'draft', messageId: 'msg_01' }), null);
        assert.strictEqual(helper.resolveWorkLibraryTarget(null), null);
        assert.strictEqual(helper.resolveWorkLibraryTarget(undefined), null);
        assert.strictEqual(helper.resolveWorkLibraryTarget({ kind: 'unknown' }), null);
        assert.strictEqual(helper.shouldShowWorkViewStory({ kind: 'draft', messageId: 'msg_01' }), false, 'Draft 不展示');
        assert.strictEqual(helper.shouldShowWorkViewStory(null), false);
        // 源码级：必须直接消费 workId，不得经其它标识猜。
        const helperSrc = stripComments(readRepoText('components/NowPlaying/workViewStoryNavigation.ts'));
        assert.ok(helperSrc.includes('.workId'), '必须直接消费 source.workId');
        assert.ok(helperSrc.includes('LIBRARY_ROUTE_BASE'), '目标基座为 /library/（经 LIBRARY_ROUTE_BASE）');
        assert.ok(!helperSrc.includes('sourceMessageId'), '不得经 sourceMessageId 猜');
        assert.ok(!helperSrc.includes('contentHash'), '不得经 contentHash 猜');
        assert.ok(!helperSrc.includes('.title'), '不得经 title 猜');
        console.log('PASS: M7-04-01-U1 direct workId');
    }

    console.log('=== M7-04-01-U2: 常量冻结（文案/testid/基座） ===');
    {
        const helper = loadViaJiti('./components/NowPlaying/workViewStoryNavigation.ts') as unknown as {
            VIEW_STORY_LABEL: string;
            EXPANDED_ACTIONS_TESTID: string;
            EXPANDED_VIEW_STORY_BUTTON_TESTID: string;
            LIBRARY_ROUTE_BASE: string;
        };
        assert.strictEqual(helper.VIEW_STORY_LABEL, '查看正文');
        assert.strictEqual(helper.EXPANDED_ACTIONS_TESTID, 'expanded-actions');
        assert.strictEqual(helper.EXPANDED_VIEW_STORY_BUTTON_TESTID, 'expanded-view-story-button');
        assert.strictEqual(helper.LIBRARY_ROUTE_BASE, '/library');
        console.log('PASS: M7-04-01-U2 constants');
    }

    console.log('=== M7-04-01-U3: 同 Detail 去重（验收 3/4，§34.1） ===');
    {
        const helper = loadViaJiti('./components/NowPlaying/workViewStoryNavigation.ts') as unknown as {
            isSameLibraryDetail: (pathname: unknown, target: unknown) => boolean;
            normalizeLibraryPathname: (pathname: unknown) => string | null;
        };
        assert.strictEqual(helper.isSameLibraryDetail('/library/481', '/library/481'), true, '同 id 只关');
        assert.strictEqual(helper.isSameLibraryDetail('/library/481/', '/library/481'), true, '尾斜杠归一');
        assert.strictEqual(helper.isSameLibraryDetail('/library/481', '/library/481/'), true, '目标尾斜杠归一');
        assert.strictEqual(helper.isSameLibraryDetail('/library/999', '/library/481'), false, '它 id 正常 push');
        assert.strictEqual(helper.isSameLibraryDetail('/chat', '/library/481'), false);
        assert.strictEqual(helper.isSameLibraryDetail('/library', '/library/481'), false, '列表页非同一 Detail');
        assert.strictEqual(helper.isSameLibraryDetail(null, '/library/481'), false);
        assert.strictEqual(helper.isSameLibraryDetail('/library/481', null), false);
        assert.strictEqual(helper.normalizeLibraryPathname('  /library/481/  '), '/library/481', '空白+尾斜杠归一');
        console.log('PASS: M7-04-01-U3 dedupe');
    }

    console.log('=== M7-04-01-U4: 总决策（visible/target/shouldPush） ===');
    {
        const helper = loadViaJiti('./components/NowPlaying/workViewStoryNavigation.ts') as unknown as {
            decideWorkViewStoryNavigation: (input: {
                source: unknown;
                pathname: unknown;
            }) => { visible: boolean; target: string | null; shouldPush: boolean };
        };
        assert.deepStrictEqual(
            helper.decideWorkViewStoryNavigation({ source: { kind: 'work', workId: 481 }, pathname: '/chat' }),
            { visible: true, target: '/library/481', shouldPush: true }
        );
        assert.deepStrictEqual(
            helper.decideWorkViewStoryNavigation({ source: { kind: 'work', workId: 481 }, pathname: '/library/481' }),
            { visible: true, target: '/library/481', shouldPush: false },
            '已在同一 Detail：只关不推'
        );
        assert.deepStrictEqual(
            helper.decideWorkViewStoryNavigation({ source: { kind: 'work', workId: 481 }, pathname: '/library/999' }),
            { visible: true, target: '/library/481', shouldPush: true },
            '在它 Detail：正常 push 当前 Work'
        );
        assert.deepStrictEqual(
            helper.decideWorkViewStoryNavigation({ source: { kind: 'draft', messageId: 'm1' }, pathname: '/chat' }),
            { visible: false, target: null, shouldPush: false },
            'Draft：不生成导航'
        );
        assert.deepStrictEqual(
            helper.decideWorkViewStoryNavigation({ source: null, pathname: '/chat' }),
            { visible: false, target: null, shouldPush: false }
        );
        console.log('PASS: M7-04-01-U4 decision');
    }

    console.log('=== M7-04-01-U5: ViewModel 增补向后兼容（§14 additive） ===');
    {
        const vm = loadViaJiti('./components/NowPlaying/useExpandedNowPlayingViewModel.ts') as unknown as {
            deriveWorkLibraryTarget: (source: unknown) => string | null;
            deriveExpandedCanViewStory: (source: unknown, status: string) => boolean;
            deriveExpandedNowPlayingViewModel: (
                s: Record<string, unknown>,
                t: Record<string, unknown>,
                o: Array<{ value: string; label: string }>
            ) => Record<string, unknown>;
        };
        assert.strictEqual(vm.deriveWorkLibraryTarget({ kind: 'work', workId: 481 }), '/library/481');
        assert.strictEqual(vm.deriveWorkLibraryTarget({ kind: 'draft', messageId: 'm1' }), null);
        assert.strictEqual(vm.deriveExpandedCanViewStory({ kind: 'work', workId: 481 }, 'paused'), true);
        assert.strictEqual(vm.deriveExpandedCanViewStory({ kind: 'work', workId: 481 }, 'idle'), false, 'idle 无会话不展示');
        assert.strictEqual(vm.deriveExpandedCanViewStory(null, 'paused'), false);
        assert.strictEqual(vm.deriveExpandedCanViewStory({ kind: 'draft', messageId: 'm1' }, 'paused'), false);
        const full = vm.deriveExpandedNowPlayingViewModel(
            { source: { kind: 'work', workId: 481 }, status: 'paused', title: '故事', voiceId: 'v1', nextParagraphIndex: 0, totalParagraphs: 2, speed: 1.0 },
            { isPlaying: false, currentTime: 0, duration: 1, playbackRate: 1.0 },
            [{ value: 'v1', label: '小雅' }]
        ) as unknown as {
            canViewStory: boolean;
            viewStoryTarget: string | null;
            title: string;
            playbackRate: number;
            primaryAction: string;
            timeline: { mode: string };
            sleepTimer: { mode: string };
        };
        assert.strictEqual(full.canViewStory, true);
        assert.strictEqual(full.viewStoryTarget, '/library/481');
        // M7-01/02/03 既有面不受损。
        assert.strictEqual(full.title, '故事');
        assert.strictEqual(full.playbackRate, 1.0);
        assert.strictEqual(full.primaryAction, 'play');
        assert.strictEqual(full.timeline.mode, 'segment');
        assert.strictEqual(full.sleepTimer.mode, 'off');
        const draftVm = vm.deriveExpandedNowPlayingViewModel(
            { source: { kind: 'draft', messageId: 'm1' }, status: 'paused', title: '草稿', voiceId: '', nextParagraphIndex: 0, totalParagraphs: 1 },
            { isPlaying: false, currentTime: 0, duration: 0 },
            []
        ) as unknown as { canViewStory: boolean; viewStoryTarget: string | null };
        assert.strictEqual(draftVm.canViewStory, false, 'Draft 不展示查看正文');
        assert.strictEqual(draftVm.viewStoryTarget, null, 'Draft 不生成 Library 目标');
        const vmSrc = stripComments(readRepoText('components/NowPlaying/useExpandedNowPlayingViewModel.ts'));
        assert.ok(vmSrc.includes('resolveWorkLibraryTarget'), 'VM 经 helper 单一派生（无第二目标源）');
        assert.ok(!vmSrc.includes('sourceMessageId') && !vmSrc.includes('contentHash'), 'VM 不得经其它标识猜 workId');
        assert.ok(!vmSrc.includes('pausePlayback') && !vmSrc.includes('seekCurrentSegment'), 'ViewModel 不得调 Flow（只派生）');
        console.log('PASS: M7-04-01-U5 viewmodel additive');
    }

    console.log('=== M7-04-01-U6: Actions 无管理面（验收 6，§33） ===');
    {
        const src = stripComments(readRepoText('components/NowPlaying/NowPlayingActions.tsx'));
        assert.ok(src.includes('expanded-view-story-button') || src.includes('EXPANDED_VIEW_STORY_BUTTON_TESTID'), '按钮 testid');
        assert.ok(src.includes('expanded-actions') || src.includes('EXPANDED_ACTIONS_TESTID'), '容器 testid');
        assert.ok(src.includes('查看正文') || src.includes('VIEW_STORY_LABEL'), '文案为查看正文');
        assert.ok(src.includes('shouldShowWorkViewStory'), '展示唯一依据为 Work 合法目标');
        assert.ok(src.includes('onViewStory'), '点击透传父级回调（本组件不自导路由）');
        assert.ok(src.includes('return null'), '非 Work 返回 null（不占位）');
        for (const forbidden of ['rename', 'favorite', 'trash', 'delete', 'usePlaybackSessionStore', 'usePlaybackStore', 'useRouter', 'AudioController', 'pausePlayback']) {
            assert.ok(!src.includes(forbidden), `Actions 不得含 ${forbidden}`);
        }
        console.log('PASS: M7-04-01-U6 actions purity');
    }

    console.log('=== M7-04-01-U7: Expanded 先关后导且播放继续（§34/§44/§9） ===');
    {
        const src = stripComments(readRepoText('components/NowPlaying/ExpandedNowPlaying.tsx'));
        assert.ok(src.includes('NowPlayingActions'), 'Expanded 必须挂载 NowPlayingActions');
        assert.ok(src.includes('viewModel.viewStoryTarget'), '目标来自 ViewModel（workId 直接派生链）');
        assert.ok(src.includes('viewModel.source'), '来源来自 ViewModel.source');
        assert.ok(src.includes('handleViewStory'), '统一查看正文回调');
        assert.ok(src.includes('useRouter') && src.includes('usePathname'), '经 Next 路由（客户端导航，音频连续）');
        assert.ok(src.includes('isSameLibraryDetail'), '同 Detail 去重（只关不推）');
        assert.ok(src.includes('router.push'), '它 Detail 正常 push');
        // 顺序：handleViewStory 段内 close 先于 push。
        const handlerAt = src.indexOf('handleViewStory');
        assert.ok(handlerAt >= 0, 'handler 存在');
        const handlerSeg = src.slice(handlerAt, handlerAt + 1200);
        assert.ok(handlerSeg.includes('handleClose'), 'handler 先 closeExpanded');
        assert.ok(handlerSeg.includes('router.push'), 'handler 按需 push');
        assert.ok(
            handlerSeg.indexOf('handleClose') < handlerSeg.indexOf('router.push'),
            '顺序固定：close 先于 push（§44）'
        );
        // 播放继续：查看正文路径不得 pause/改 Session/碰 audio。
        assert.ok(!handlerSeg.includes('pause'), '查看正文不得 pause');
        assert.ok(!src.includes('/player'), '不得碰 /player（后续子项职责）');
        assert.ok(!src.includes("push('/chat')") && !src.includes('push("/chat")'), '不得顺手导航创作面');
        assert.ok(!src.includes('AudioController'), '不得操作 <audio>');
        assert.ok(!src.includes('sourceMessageId') && !src.includes('contentHash'), '不得猜 workId');
        console.log('PASS: M7-04-01-U7 close-then-push playback-continues');
    }

    console.log('=== M7-04-01-U8: 无 scope creep（§40 + 后续子项边界） ===');
    {
        const actionsSrc = stripComments(readRepoText('components/NowPlaying/NowPlayingActions.tsx'));
        const helperSrc = stripComments(readRepoText('components/NowPlaying/workViewStoryNavigation.ts'));
        const expandedSrc = stripComments(readRepoText('components/NowPlaying/ExpandedNowPlaying.tsx'));
        // §40 无 prev/next 回退（Actions 不得引入段落跳转）。
        for (const token of ['上一段', '下一段', 'nextParagraph', 'TranscriptView', 'continueFromStoryWork']) {
            assert.ok(!actionsSrc.includes(token), `Actions 不得含 ${token}`);
            assert.ok(!helperSrc.includes(token), `helper 不得含 ${token}`);
        }
        // Draft Transcript（02）与继续创作（03）不在本轮：Expanded 不得新增其入口。
        assert.ok(!expandedSrc.includes('TranscriptView'), '本轮不碰 Draft Transcript（02 职责）');
        assert.ok(!expandedSrc.includes('continueFromStoryWork'), '本轮不碰继续创作（03 职责）');
        console.log('PASS: M7-04-01-U8 no scope creep');
    }

    console.log('\nALL WORK VIEW STORY UNIT TESTS PASSED SUCCESSFULLY!');
}

const testPromise = runWorkViewStoryUnit()
    .then(() => {
        console.log('ALL WORK VIEW STORY UNIT TESTS PASSED SUCCESSFULLY!');
    })
    .catch((error) => {
        console.error('Work view story unit test failed:', error);
        process.exit(1);
    });

export default testPromise;
