import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// 中文注释：M7-04-03 Creation Actions Boundary 单测（L1，纯函数 + 架构守卫，不触库/网络）。
// 锁定 spec §36/§36.2/§37/§75/M7-P07：Draft 返回创作（close + push('/chat') + 零 send，
// 与查看正文并存）、Work 继续创作隐藏（fail-closed，绝不伪造 continuation，
// additive-ready）、静态守卫（无 prompt 拼接、无真实 continuation 调用）。

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

const DRAFT = { kind: 'draft', messageId: 'msg_creation_03_01' } as const;
const WORK = { kind: 'work', workId: 481 } as const;

async function runCreationActionsUnit(): Promise<void> {
    installUnitStubs();

    console.log('=== M7-04-03-U1: Draft 返回创作纯派生 + Work 继续创作恒隐藏（§36.2/§37） ===');
    {
        const helper = loadViaJiti('./components/NowPlaying/creationActions.ts') as unknown as {
            shouldShowDraftBackToCreation: (s: unknown, st: unknown) => boolean;
            shouldShowWorkContinueCreation: (s: unknown, st: unknown) => boolean;
            resolveBackToCreationTarget: (s: unknown, st: unknown) => string | null;
            decideDraftBackToCreation: (i: { source: unknown; status: unknown }) => { visible: boolean; target: string | null; shouldPush: boolean };
            decideWorkContinueCreation: (i: { source: unknown; status: unknown }) => { visible: boolean; target: string | null; shouldPush: boolean };
        };
        // Draft + 可展示会话即展示（与 storyText 无关：返回创作不依赖正文有无）。
        assert.strictEqual(helper.shouldShowDraftBackToCreation(DRAFT, 'paused'), true, 'Draft paused 即展示返回创作');
        assert.strictEqual(helper.shouldShowDraftBackToCreation(DRAFT, 'playing'), true);
        assert.strictEqual(helper.shouldShowDraftBackToCreation(DRAFT, 'ended'), true, 'ended 仍可返回创作（只关导，不改播放）');
        assert.strictEqual(helper.resolveBackToCreationTarget(DRAFT, 'paused'), '/chat', '目标恒为 /chat');
        assert.deepStrictEqual(
            helper.decideDraftBackToCreation({ source: DRAFT, status: 'paused' }),
            { visible: true, target: '/chat', shouldPush: true },
            'Draft 决策：可见 + 目标 /chat + 需 push（先关后导，无同址去重）'
        );
        // Work/空/idle 一律隐藏（fail-closed）。
        assert.strictEqual(helper.shouldShowDraftBackToCreation(WORK, 'paused'), false, 'Work 不走返回创作');
        assert.strictEqual(helper.shouldShowDraftBackToCreation(null, 'paused'), false);
        assert.strictEqual(helper.shouldShowDraftBackToCreation(undefined, 'paused'), false);
        assert.strictEqual(helper.shouldShowDraftBackToCreation(DRAFT, 'idle'), false, 'idle 无会话不展示');
        assert.strictEqual(helper.shouldShowDraftBackToCreation(DRAFT, null), false);
        assert.strictEqual(helper.shouldShowDraftBackToCreation(DRAFT, undefined), false);
        assert.strictEqual(helper.resolveBackToCreationTarget(WORK, 'paused'), null);
        assert.strictEqual(helper.resolveBackToCreationTarget(null, 'paused'), null);
        assert.deepStrictEqual(
            helper.decideDraftBackToCreation({ source: WORK, status: 'paused' }),
            { visible: false, target: null, shouldPush: false }
        );
        assert.deepStrictEqual(
            helper.decideDraftBackToCreation({ source: null, status: 'paused' }),
            { visible: false, target: null, shouldPush: false }
        );
        // Work 继续创作恒隐藏（M4 契约缺失，fail-closed，绝不伪造）。
        for (const st of ['paused', 'playing', 'ended', 'idle']) {
            assert.strictEqual(helper.shouldShowWorkContinueCreation(WORK, st), false, `Work ${st} 继续创作恒隐藏`);
            assert.strictEqual(helper.shouldShowWorkContinueCreation(DRAFT, st), false, `Draft ${st} 不走继续创作`);
        }
        assert.strictEqual(helper.shouldShowWorkContinueCreation(null, 'paused'), false);
        assert.deepStrictEqual(
            helper.decideWorkContinueCreation({ source: WORK, status: 'paused' }),
            { visible: false, target: null, shouldPush: false },
            'Work 决策恒隐藏（fail-closed）'
        );
        assert.deepStrictEqual(
            helper.decideWorkContinueCreation({ source: DRAFT, status: 'paused' }),
            { visible: false, target: null, shouldPush: false }
        );
        console.log('PASS: M7-04-03-U1 draft-show work-hidden');
    }

    console.log('=== M7-04-03-U2: 常量冻结（文案/testid/路由） ===');
    {
        const helper = loadViaJiti('./components/NowPlaying/creationActions.ts') as unknown as {
            BACK_TO_CREATION_LABEL: string;
            EXPANDED_BACK_TO_CREATION_BUTTON_TESTID: string;
            CONTINUE_CREATION_LABEL: string;
            EXPANDED_CONTINUE_CREATION_BUTTON_TESTID: string;
            CHAT_ROUTE: string;
        };
        assert.strictEqual(helper.BACK_TO_CREATION_LABEL, '返回创作', 'Draft 文案精确为返回创作（不是继续创作）');
        assert.strictEqual(helper.EXPANDED_BACK_TO_CREATION_BUTTON_TESTID, 'expanded-back-to-creation-button');
        assert.strictEqual(helper.CONTINUE_CREATION_LABEL, '继续创作', 'Work 预留文案为继续创作（additive-ready）');
        assert.strictEqual(helper.EXPANDED_CONTINUE_CREATION_BUTTON_TESTID, 'expanded-continue-creation-button');
        assert.strictEqual(helper.CHAT_ROUTE, '/chat', '返回目标恒为 /chat');
        // Draft 返回创作绝不是「继续创作」文案（§37 与 §36 严格区分）。
        assert.notStrictEqual(helper.BACK_TO_CREATION_LABEL, helper.CONTINUE_CREATION_LABEL, '两 CTA 文案严格区分');
        assert.notStrictEqual(
            helper.EXPANDED_BACK_TO_CREATION_BUTTON_TESTID,
            helper.EXPANDED_CONTINUE_CREATION_BUTTON_TESTID,
            '两 CTA testid 独立'
        );
        console.log('PASS: M7-04-03-U2 constants');
    }

    console.log('=== M7-04-03-U3: Actions 受控并存（Draft 双口 + Work 单口 + 继续隐藏） ===');
    {
        const src = stripComments(readRepoText('components/NowPlaying/NowPlayingActions.tsx'));
        // Draft 双口：transcript + 返回创作同容器并存，各自独立回调/testid。
        assert.ok(src.includes('shouldShowDraftBackToCreation'), 'Draft 返回创作经 helper 判定');
        assert.ok(src.includes('EXPANDED_BACK_TO_CREATION_BUTTON_TESTID'), '返回创作独立 testid');
        assert.ok(src.includes('onBackToCreation'), '返回创作独立回调（父级先关后导）');
        assert.ok(src.includes('BACK_TO_CREATION_LABEL'), '返回创作经单文案源（精确返回创作）');
        assert.ok(src.includes('shouldShowDraftTranscript'), 'Transcript 口冻结保留（并存非替换）');
        assert.ok(src.includes('EXPANDED_VIEW_TRANSCRIPT_BUTTON_TESTID'), 'Transcript 独立 testid 保留');
        // Work 继续创作 additive-ready 但恒隐藏。
        assert.ok(src.includes('shouldShowWorkContinueCreation'), 'Work 继续创作经 helper 判定（additive-ready）');
        assert.ok(src.includes('EXPANDED_CONTINUE_CREATION_BUTTON_TESTID'), '继续创作独立 testid 预留');
        assert.ok(src.includes('onContinueCreation'), '继续创作回调预留（M4 落地后委托）');
        assert.ok(src.includes('CONTINUE_CREATION_LABEL'), '继续创作经单文案源（精确继续创作）');
        // 受控组件纯度：不读 store，不直调路由/播放写面以外东西。
        for (const forbidden of ['usePlaybackSessionStore', 'usePlaybackStore', 'useRouter', 'router.push', '/library', '/chat', 'AudioController', 'pausePlayback', 'useChatStore', 'pendingAutoSend', 'chatFlow', 'storyFlow', 'dispatch']) {
            assert.ok(!src.includes(forbidden), `Actions 不得含 ${forbidden}`);
        }
        // 禁 prompt 拼接：Actions 不得拼 continuation 指令。
        assert.ok(!src.includes('AUTO_CONTINUE_PROMPT'), 'Actions 不得引用自动续写常量');
        // helper 层隐藏断言（运行时）：Work 继续恒 false。
        const helper = loadViaJiti('./components/NowPlaying/creationActions.ts') as unknown as {
            shouldShowWorkContinueCreation: (s: unknown, st: unknown) => boolean;
        };
        assert.strictEqual(helper.shouldShowWorkContinueCreation(WORK, 'paused'), false, 'Work 继续创作运行时隐藏');
        console.log('PASS: M7-04-03-U3 actions controlled coexistence');
    }

    console.log('=== M7-04-03-U4: Expanded 返回创作 = close + push(/chat) + 零 send（§37/§44） ===');
    {
        const src = stripComments(readRepoText('components/NowPlaying/ExpandedNowPlaying.tsx'));
        assert.ok(src.includes('NowPlayingActions'), 'Expanded 挂载 Actions');
        assert.ok(src.includes('handleBackToCreation'), '返回创作统一回调存在');
        assert.ok(src.includes('onBackToCreation'), 'Actions 接线 onBackToCreation');
        assert.ok(src.includes('CHAT_ROUTE') || src.includes("'/chat'"), '目标为 /chat（经单路由源）');
        // handler 段内顺序与零 send：close 先于 push，无发送/续写/正文拼接。
        const at = src.indexOf('handleBackToCreation');
        assert.ok(at >= 0, 'handler 存在');
        const seg = src.slice(at, at + 800);
        assert.ok(seg.includes('handleClose'), '先 closeExpanded');
        assert.ok(seg.includes('router.push'), '再 router.push');
        assert.ok(
            seg.indexOf('handleClose') < seg.indexOf('router.push'),
            '顺序固定：close 先于 push（§44）'
        );
        const segLower = seg.toLowerCase();
        assert.ok(!segLower.includes('send'), '返回创作不得自动发送（零 send）');
        assert.ok(!seg.includes('dispatch'), '不得经 dispatch 预填即发');
        assert.ok(!seg.includes('pendingAutoSend') && !seg.includes('setInputValue'), '不得预填即发/消息追加');
        assert.ok(!seg.includes('storyText') && !seg.includes('prompt'), '不得拼装 continuation Prompt');
        assert.ok(!seg.includes('continueFromStoryWork('), '不得真实调用 continuation（行为归 M4）');
        assert.ok(!seg.includes('pause'), '返回创作不得 pause（播放继续，§36.3 同原则）');
        // Work 继续不越界：Expanded 不传 onContinueCreation（fail-closed），不拼 Prompt。
        assert.ok(!src.includes('onContinueCreation'), '本轮 Expanded 不缝合继续创作（M4 缺失，隐藏）');
        assert.ok(!src.includes("push('/player')") && !src.includes('push("/player")'), '不得碰 /player（04 职责）');
        console.log('PASS: M7-04-03-U4 close-push-chat zero-send');
    }

    console.log('=== M7-04-03-U5: 静态守卫（无 prompt 拼接、无真实 continuation 调用） ===');
    {
        const files = [
            'components/NowPlaying/creationActions.ts',
            'components/NowPlaying/NowPlayingActions.tsx',
            'components/NowPlaying/ExpandedNowPlaying.tsx',
        ];
        for (const rel of files) {
            const src = stripComments(readRepoText(rel));
            assert.ok(!src.includes('AUTO_CONTINUE_PROMPT'), `${rel} 不得引用自动续写常量`);
            assert.ok(!src.includes('continueFromStoryWork('), `${rel} 不得真实调用 continuation（行为归 M4）`);
            // 中文指令守卫：M7 内绝不拼装「请继续」类 continuation Prompt。
            // （合法续写指令归 chatFlow/storyFlow，本面禁入。）
            assert.ok(!src.includes('请继续'), `${rel} 不得拼装 continuation Prompt`);
        }
        // creationActions 纯度：不读 store/路由/发送面，不消费 storyText（返回创作与正文无关）。
        const helperSrc = stripComments(readRepoText('components/NowPlaying/creationActions.ts'));
        for (const forbidden of ['usePlaybackSessionStore', 'usePlaybackStore', 'useRouter', 'router.push', 'useChatStore', 'dispatch', 'pendingAutoSend', 'chatFlow', 'storyFlow', 'AudioController', 'pausePlayback', 'nowPlayingUiStore']) {
            assert.ok(!helperSrc.includes(forbidden), `helper 不得含 ${forbidden}（纯函数）`);
        }
        assert.ok(!helperSrc.includes('storyText'), 'helper 不得消费 storyText（返回创作与正文无关，不拼 Prompt）');
        assert.ok(!helperSrc.includes('/library'), 'helper 不得拼凑 Library 目标（创作面只回 /chat）');
        // Actions/Expanded 亦不得直调发送面（受控 + 命令面边界）。
        for (const rel of ['components/NowPlaying/NowPlayingActions.tsx', 'components/NowPlaying/ExpandedNowPlaying.tsx']) {
            const src = stripComments(readRepoText(rel));
            for (const forbidden of ['useChatStore', 'pendingAutoSend', 'AUTO_CONTINUE_PROMPT']) {
                assert.ok(!src.includes(forbidden), `${rel} 不得含 ${forbidden}（零自动发送）`);
            }
        }
        console.log('PASS: M7-04-03-U5 static guards');
    }

    console.log('\nALL CREATION ACTIONS UNIT TESTS PASSED SUCCESSFULLY!');
}

const testPromise = runCreationActionsUnit()
    .then(() => {
        console.log('ALL CREATION ACTIONS UNIT TESTS PASSED SUCCESSFULLY!');
    })
    .catch((error) => {
        console.error('Creation actions unit test failed:', error);
        process.exit(1);
    });

export default testPromise;
