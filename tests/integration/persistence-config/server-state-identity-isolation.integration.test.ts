import assert from 'node:assert';
import { createRequire } from 'node:module';
import React from 'react';
import { render, act } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import * as queryClientModule from '../../../lib/client/queryClient';
import {
  computeIdentityFingerprint,
  clearQueryClientForIdentityTransition,
  createQueryClient,
  getQueryClient,
} from '../../../lib/client/queryClient';
import { useAuthStore } from '../../../stores/authStore';
import { ServerStateProvider, MainQueryProvider } from '../../../components/ServerStateProvider';

const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);
const { JSDOM } = nodeRequire('jsdom') as {
  JSDOM: new (html: string, opts?: Record<string, unknown>) => { window: Record<string, unknown> };
};

// 初始化 jsdom 全局环境，供真实 React Provider 挂载断言
if (typeof window === 'undefined') {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  const win = dom.window as unknown as Record<string, unknown>;
  const g = globalThis as unknown as Record<string, unknown>;
  try {
    Object.defineProperty(g, 'window', { value: win, writable: true, configurable: true });
  } catch {
    g.window = win;
  }
  try {
    Object.defineProperty(g, 'document', { value: win.document, writable: true, configurable: true });
  } catch {
    g.document = win.document;
  }
  try {
    Object.defineProperty(g, 'navigator', { value: win.navigator, writable: true, configurable: true });
  } catch {
    g.navigator = win.navigator;
  }
}

/**
 * E2E-07-08: Library Server State 与身份隔离集成测试套件。
 */
async function runServerStateIdentityIsolationTests() {
  console.log('=== 1. Identity Fingerprint 纯净性与边界判定（排除 nickname / loading / error）===');
  {
    const base = {
      initialized: true,
      isLogin: false,
      isGuest: true,
      username: '',
    };
    const baseFp = computeIdentityFingerprint(base);
    assert.strictEqual(baseFp, '1:0:1:', 'Guest 基础指纹应匹配');

    // 1) 变更身份四元组的任一字段，指纹必须改变
    const uninitFp = computeIdentityFingerprint({ ...base, initialized: false });
    assert.notStrictEqual(uninitFp, baseFp, 'initialized 变化必须改变指纹');

    const loginFp = computeIdentityFingerprint({ ...base, isLogin: true, isGuest: false, username: 'alice' });
    assert.notStrictEqual(loginFp, baseFp, '登录跃迁必须改变指纹');

    const switchUserFp = computeIdentityFingerprint({ ...base, isLogin: true, isGuest: false, username: 'bob' });
    assert.notStrictEqual(switchUserFp, loginFp, '切号 username 变化必须改变指纹');

    // 2) 证明：无论 nickname / loading 如何变化，指纹绝对不变
    const withExtraFields1 = {
      ...base,
      nickname: 'Old Nickname',
      loading: false,
      error: undefined,
    } as unknown as typeof base;
    const withExtraFields2 = {
      ...base,
      nickname: 'New Changed Nickname',
      loading: true,
      error: 'Some error message',
    } as unknown as typeof base;

    const fp1 = computeIdentityFingerprint(withExtraFields1);
    const fp2 = computeIdentityFingerprint(withExtraFields2);
    assert.strictEqual(fp1, baseFp, '带有旧 nickname/loading 的指纹必须与 base 相同');
    assert.strictEqual(fp2, baseFp, 'nickname/loading 变化后的指纹必须完全恒等于 base');
    console.log('PASS: 1. Identity Fingerprint 纯净性与字段边界断言通过');
  }

  console.log('=== 2. 核心竞态：Guest 在途 Query A 遇身份切换，User Query B 覆盖，A 晚返回绝不复活旧数据 ===');
  {
    const qc = createQueryClient();
    const queryKey = ['story-works', 'list'];

    let resolveGuestA: (value: { author: string; title: string }) => void = () => {};
    const guestPromiseA = new Promise<{ author: string; title: string }>((resolve) => {
      resolveGuestA = resolve;
    });

    // 1) Guest 发起 query A（deferred promise，尚未 resolve）
    let guestAError: unknown = null;
    const queryAPromise = qc.fetchQuery({
      queryKey,
      queryFn: () => guestPromiseA,
    }).catch((err) => {
      guestAError = err;
      return null;
    });

    // 确认此时 Query A 处于在途 pending 态
    assert.strictEqual(qc.isFetching({ queryKey }), 1, 'Query A 应处于 in-flight 状态');

    // 2) 发生 Guest → User 身份切换，触发标准清理契约：cancelQueries() + clear()
    await clearQueryClientForIdentityTransition(qc);

    // 确认清理后缓存已清空，且在途计数为 0
    assert.strictEqual(qc.getQueryCache().getAll().length, 0, '清理后缓存 entries 必须为 0');
    assert.strictEqual(qc.isFetching({ queryKey }), 0, '清理后 in-flight fetching 必须降为 0');

    // 3) User 身份建立，发起同 queryKey 的 query B（deferred promise）
    let resolveUserB: (value: { author: string; title: string }) => void = () => {};
    const userPromiseB = new Promise<{ author: string; title: string }>((resolve) => {
      resolveUserB = resolve;
    });

    const queryBPromise = qc.fetchQuery({
      queryKey,
      queryFn: () => userPromiseB,
    });

    // 4) User Query B 正常完成并 resolve
    const userBData = { author: 'user-alice', title: 'User Private Novel' };
    resolveUserB(userBData);
    const resultB = await queryBPromise;
    assert.deepStrictEqual(resultB, userBData, 'Query B 应成功获取 User 数据');

    // 断言此时缓存包含 Query B 的数据
    assert.deepStrictEqual(qc.getQueryData(queryKey), userBData, '缓存中应为 User B 的数据');

    // 5) Guest Query A 终于在网络延迟后晚返回 resolve！
    const guestAData = { author: 'guest-temp', title: 'Guest Temporary Draft' };
    resolveGuestA(guestAData);
    await queryAPromise;

    // 等待微任务与调度器结算
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 6) 核心断言：最终 cache 只能包含 B 的数据；A 晚返回绝对不得复活或污染旧身份数据
    const finalCachedData = qc.getQueryData(queryKey);
    assert.deepStrictEqual(
      finalCachedData,
      userBData,
      '核心断言：最终 cache 只能包含 User B 的数据，Guest A 绝不得复活覆盖'
    );

    const allQueries = qc.getQueryCache().getAll();
    assert.strictEqual(allQueries.length, 1, '缓存中应严格仅存 1 条活跃查询');
    assert.deepStrictEqual(allQueries[0].state.data, userBData, '活跃查询数据必须为 User B');

    // 校验 query A 在取消时触发了 Cancellation
    assert(
      guestAError !== null,
      'Query A 必须在 cancelQueries() 时收到取消通知或被拒绝'
    );

    console.log('PASS: 2. 核心竞态（A 晚返回绝不复活旧数据，B 完整保留）断言通过');
  }

  console.log('=== 3. 独立延迟在途请求：无后续 Query 时 A 晚返回不复活旧缓存 ===');
  {
    const qc = createQueryClient();
    const queryKey = ['guest-orphan', 'record'];

    let resolveOrphanA: (value: { draft: string }) => void = () => {};
    const orphanPromise = new Promise<{ draft: string }>((resolve) => {
      resolveOrphanA = resolve;
    });

    const queryPromise = qc.fetchQuery({
      queryKey,
      queryFn: () => orphanPromise,
    }).catch(() => null);

    // 发生身份切换并清理
    await clearQueryClientForIdentityTransition(qc);

    // A 延迟返回
    resolveOrphanA({ draft: 'stale-guest-draft' });
    await queryPromise;
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 缓存必须依然为空，绝不复活
    assert.strictEqual(qc.getQueryCache().getAll().length, 0, '无后续 Query 时缓存必须保持为空');
    assert.strictEqual(qc.getQueryData(queryKey), undefined, '已清理的 queryKey 数据必须为 undefined');
    console.log('PASS: 3. 独立延迟在途请求晚 resolve 不复活旧缓存断言通过');
  }

  console.log('=== 4. 身份清理契约：证明 invalidateQueries 保留 stale 缓存，必须使用 cancel + clear ===');
  {
    const qcInvalidateOnly = createQueryClient();
    const testKey = ['test-contrast'];

    // 预填一条旧数据
    qcInvalidateOnly.setQueryData(testKey, { secret: 'guest-secret-token' });
    assert.strictEqual(qcInvalidateOnly.getQueryCache().getAll().length, 1);

    // 仅调用 invalidateQueries（错误的反模式）
    await qcInvalidateOnly.invalidateQueries();

    // 证实：invalidateQueries 保留了条目与 stale 数据
    assert.strictEqual(
      qcInvalidateOnly.getQueryCache().getAll().length,
      1,
      'invalidateQueries 错误保留了 stale 缓存条目'
    );
    assert.deepStrictEqual(
      qcInvalidateOnly.getQueryData(testKey),
      { secret: 'guest-secret-token' },
      'invalidateQueries 错误保留了旧数据'
    );

    // 与合规的 clearQueryClientForIdentityTransition 对比
    const qcCompliant = createQueryClient();
    qcCompliant.setQueryData(testKey, { secret: 'guest-secret-token' });
    await clearQueryClientForIdentityTransition(qcCompliant);

    assert.strictEqual(
      qcCompliant.getQueryCache().getAll().length,
      0,
      '合规 cancel+clear 必须彻底清空所有条目'
    );
    assert.strictEqual(
      qcCompliant.getQueryData(testKey),
      undefined,
      '合规 cancel+clear 数据必须为 undefined'
    );

    console.log('PASS: 4. invalidateQueries vs cancel+clear 隔离安全性严格证明通过');
  }

  console.log('=== 5. 快速切号 (User A -> User B) 隔离（两端均 isLogin=true 但 username 变化）===');
  {
    const qc = createQueryClient();
    const userWorksKey = ['library', 'list'];

    // Alice 登录并缓存自己的数据
    qc.setQueryData(userWorksKey, [{ id: 10, title: "Alice's Story" }]);
    assert.strictEqual(qc.getQueryCache().getAll().length, 1);

    const aliceFp = computeIdentityFingerprint({
      initialized: true,
      isLogin: true,
      isGuest: false,
      username: 'alice',
    });
    const bobFp = computeIdentityFingerprint({
      initialized: true,
      isLogin: true,
      isGuest: false,
      username: 'bob',
    });

    assert.notStrictEqual(aliceFp, bobFp, '虽然均为 isLogin: true，但 username 变化必须生成不同指纹');

    // 触发身份切换清理
    await clearQueryClientForIdentityTransition(qc);

    // Bob 登录时缓存已被清空
    assert.strictEqual(qc.getQueryCache().getAll().length, 0, 'Bob 不得看到 Alice 任何残留缓存');
    assert.strictEqual(qc.getQueryData(userWorksKey), undefined);

    // Bob 写入自己的数据
    qc.setQueryData(userWorksKey, [{ id: 20, title: "Bob's Story" }]);
    assert.deepStrictEqual(qc.getQueryData(userWorksKey), [{ id: 20, title: "Bob's Story" }]);

    console.log('PASS: 5. 快速切号 (User A -> User B) 缓存绝对隔离断言通过');
  }

  console.log('=== 6. useAuthStore 订阅集成：状态变更触发清理，nickname/loading 变更免死 ===');
  {
    const qc = createQueryClient();
    const probeKey = ['probe', 'state'];

    // 重置 useAuthStore 为初始访客态
    useAuthStore.setState({
      initialized: true,
      isLogin: false,
      isGuest: true,
      username: '',
      nickname: 'Original Nickname',
      loading: false,
    });

    // 模拟 ServerStateProvider 内部单权威订阅逻辑
    const initialState = useAuthStore.getState();
    let prevFingerprint: string | null = initialState.initialized
      ? computeIdentityFingerprint({
          initialized: initialState.initialized,
          isLogin: initialState.isLogin,
          isGuest: initialState.isGuest,
          username: initialState.username,
        })
      : null;

    const unsubscribe = useAuthStore.subscribe((state) => {
      if (!state.initialized) {
        prevFingerprint = null;
        return;
      }
      const nextFingerprint = computeIdentityFingerprint({
        initialized: state.initialized,
        isLogin: state.isLogin,
        isGuest: state.isGuest,
        username: state.username,
      });

      if (prevFingerprint !== null && prevFingerprint !== nextFingerprint) {
        void clearQueryClientForIdentityTransition(qc);
      }
      prevFingerprint = nextFingerprint;
    });

    try {
      // 写入一条探测缓存
      qc.setQueryData(probeKey, { active: true });
      assert.strictEqual(qc.getQueryCache().getAll().length, 1);

      // 1) 仅变更 nickname（展示字段）
      useAuthStore.setState({ nickname: 'Updated Nickname Display' });
      assert.strictEqual(
        qc.getQueryCache().getAll().length,
        1,
        'nickname 变更绝不得触发 queryClient 清理'
      );
      assert.deepStrictEqual(qc.getQueryData(probeKey), { active: true });

      // 2) 仅变更 loading（过程态字段）
      useAuthStore.setState({ loading: true });
      assert.strictEqual(
        qc.getQueryCache().getAll().length,
        1,
        'loading 变更绝不得触发 queryClient 清理'
      );
      assert.deepStrictEqual(qc.getQueryData(probeKey), { active: true });

      useAuthStore.setState({ loading: false });
      assert.strictEqual(
        qc.getQueryCache().getAll().length,
        1,
        'loading 复位绝不得触发 queryClient 清理'
      );

      // 3) 登录状态变更（isLogin -> true, username -> 'eva'）
      useAuthStore.setState({
        isLogin: true,
        isGuest: false,
        username: 'eva',
        nickname: 'Eva User',
      });

      // 订阅同步触发清理
      assert.strictEqual(
        qc.getQueryCache().getAll().length,
        0,
        'isLogin/username 跃迁必须同步触发 queryClient 清理'
      );
      assert.strictEqual(qc.getQueryData(probeKey), undefined);
    } finally {
      unsubscribe();
    }

    console.log('PASS: 6. useAuthStore 订阅集成与展示态免死断言通过');
  }

  console.log('=== 7. ServerStateProvider 组件 mount 与单次清理回归（clear次数===1，新身份Query B在render周期存活）===');
  {
    const qc = createQueryClient();
    let clearCount = 0;
    const origClear = qc.clear.bind(qc);
    qc.clear = () => {
      clearCount += 1;
      origClear();
    };

    // 初始状态：Guest 访客已解析完成
    useAuthStore.setState({
      initialized: true,
      isLogin: false,
      isGuest: true,
      username: '',
      nickname: 'Guest User',
      loading: false,
    });

    // 挂载一个模拟子组件，当 isLogin=true 时立即发起新身份 Query B
    function ProbeChild() {
      const isLogin = useAuthStore((s) => s.isLogin);
      React.useEffect(() => {
        if (isLogin) {
          // 模拟新身份挂载后发起的请求 B
          qc.setQueryData(['user-probe-b'], { workId: 888, author: 'alice' });
        }
      }, [isLogin]);
      return React.createElement('div', null, isLogin ? 'User' : 'Guest');
    }

    // 挂载真实 ServerStateProvider
    const { rerender } = render(
      React.createElement(ServerStateProvider, { queryClient: qc }, React.createElement(ProbeChild))
    );
    assert.strictEqual(clearCount, 0, '首次 mount 时无身份跃迁，clearCount 必须为 0');

    // 发生 Guest → User 身份跃迁
    act(() => {
      useAuthStore.setState({
        isLogin: true,
        isGuest: false,
        username: 'alice',
        nickname: 'Alice Real',
      });
    });

    // 核心回归断言：clear 次数必须严格等于 1，绝不允许在 render-cycle 发生第二次清除！
    assert.strictEqual(
      clearCount,
      1,
      '核心断言：身份切换时 clear() 必须且只能调用 1 次（杜绝双清理竞态）'
    );

    // 核心安全强化断言：新身份 Query B 启动后，随后 React render/effects 不得再次清除或取消 B
    const probeBData = qc.getQueryData(['user-probe-b']);
    assert.deepStrictEqual(
      probeBData,
      { workId: 888, author: 'alice' },
      '新身份发起的数据 B 必须完好保存在缓存中'
    );

    // 再次触发重渲染（模拟路由或全局 UI 状态刷新）
    rerender(
      React.createElement(ServerStateProvider, { queryClient: qc }, React.createElement(ProbeChild))
    );

    // 断言 clearCount 仍然保持为 1，且 Query B 依然存活
    assert.strictEqual(clearCount, 1, '重渲染后 clearCount 仍必须为 1');
    assert.deepStrictEqual(
      qc.getQueryData(['user-probe-b']),
      { workId: 888, author: 'alice' },
      '重渲染后新身份 Query B 必须稳定存活'
    );

    console.log('PASS: 7. ServerStateProvider 单次清理与新身份 Query B 存活回归断言通过');
  }

  console.log('=== 8. ServerStateProvider 组件与导出规范校验（无 production test seam）===');
  {
    assert.strictEqual(typeof ServerStateProvider, 'function', 'ServerStateProvider 应为 React 组件函数');
    assert.strictEqual(typeof MainQueryProvider, 'function', 'MainQueryProvider 应为别名函数');
    assert.strictEqual(ServerStateProvider, MainQueryProvider, 'MainQueryProvider 必须严格引用 ServerStateProvider');

    // 断言生产 queryClient 模块严禁导出 setBrowserQueryClientForTesting
    const exportedKeys = Object.keys(queryClientModule);
    assert(
      !exportedKeys.includes('setBrowserQueryClientForTesting'),
      'lib/client/queryClient.ts 严禁导出 setBrowserQueryClientForTesting（production test seam 已清除）'
    );
    assert.strictEqual(
      (queryClientModule as unknown as Record<string, unknown>).setBrowserQueryClientForTesting,
      undefined,
      'setBrowserQueryClientForTesting 必须为 undefined'
    );

    const client1 = getQueryClient();
    assert(client1 instanceof QueryClient, 'getQueryClient 必须返回 QueryClient 实例');

    const customClient = createQueryClient();
    assert(customClient instanceof QueryClient, 'createQueryClient 必须返回 QueryClient 实例');
    assert.notStrictEqual(client1, customClient, '每次 createQueryClient 必须生成独立实例');

    console.log('PASS: 8. ServerStateProvider 导出规范与 test seam 清除校验通过');
  }

  console.log('ALL SERVER STATE IDENTITY ISOLATION TESTS PASSED SUCCESSFULLY');
}

const testPromise = runServerStateIdentityIsolationTests()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });

export default testPromise;
