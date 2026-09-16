import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

/**
 * M9-C1 T2 L1：Prompt/Generation History 前后端退役。
 *
 * oracle 为行为级：在未改实现的 baseline 上，History 组件/store/client/server/router/
 * schema 均存在且被产品代码引用，断言必然不符（不是 import 级缺失、不是造接口缺失）。
 */

const REPO_ROOT = process.cwd();

/** History 必须被删除的文件（相对仓库根）。 */
const RETIRED_PATHS: string[] = [
  'app/(main)/chat/components/HistoryPanel/index.tsx',
  'app/(main)/chat/components/HistoryPanel/index.module.scss',
  'app/(main)/chat/components/HistoryRecords/index.tsx',
  'app/(main)/chat/components/GenerationHistory/index.tsx',
  'app/(main)/chat/components/HistoryList/index.tsx',
  'app/(main)/chat/components/HistoryList/index.module.scss',
  'stores/promptHistoryStore.ts',
  'stores/generationHistoryStore.ts',
  'lib/client/promptHistory.ts',
  'lib/client/generationHistory.ts',
  'lib/server/promptHistory.ts',
  'lib/server/generationHistory.ts',
  'lib/trpc/routers/promptHistory.ts',
  'lib/trpc/routers/generationHistory.ts',
  'lib/trpc/schemas/promptHistory.ts',
  'lib/trpc/schemas/generationHistory.ts',
  'stores/preloadStore.ts',
];

/** 产品代码（.ts/.tsx）中禁止残留的 History 标识符。 */
const FORBIDDEN_IDENTIFIERS: string[] = [
  'usePromptHistoryStore',
  'useGenerationHistoryStore',
  'promptHistoryStore',
  'generationHistoryStore',
  'HistoryPanel',
  'HistoryRecords',
  'AUTO_CONTINUE_PROMPT',
  "'prompt-history-store'",
  '打开历史',
  '回放此故事',
  '用此提示词重新创作',
];

/** 扫描目录（相对仓库根）。 */
const SCAN_DIRS: string[] = [
  'app',
  'stores',
  'lib/client',
  'lib/server',
  'lib/trpc',
  'components',
];

/** 文件是否存在于仓库根下。 */
function exists(relativePath: string): boolean {
  return fs.existsSync(path.join(REPO_ROOT, relativePath));
}

/** 读取仓库内文件文本。 */
function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

/**
 * 去掉行注释与块注释，只保留可执行代码/JSX 文本，避免把「已删除」的文档说明误判为残留引用。
 * @param source 原始源码。
 * @returns 去注释后的源码。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 递归收集目录下所有 .ts/.tsx 文件（跳过测试与 node_modules）。 */
function collectSourceFiles(relativeDir: string): string[] {
  const absolute = path.join(REPO_ROOT, relativeDir);
  if (!fs.existsSync(absolute)) {
    return [];
  }
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(absolute);
  return out;
}

async function runLegacyHistoryRetirementUnitTests(): Promise<void> {
  console.log('=== 1. History 前后端文件全部退役 ===');
  {
    const stillPresent = RETIRED_PATHS.filter((relativePath) => exists(relativePath));
    assert.deepStrictEqual(
      stillPresent,
      [],
      `以下 History/Preload 文件必须删除，但仍存在：\n${stillPresent.join('\n')}`,
    );
    console.log('PASS: 1');
  }

  console.log('=== 2. 产品代码零 History 标识符残留 ===');
  {
    const hits: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of collectSourceFiles(dir)) {
        const source = stripComments(fs.readFileSync(file, 'utf8'));
        for (const identifier of FORBIDDEN_IDENTIFIERS) {
          if (source.includes(identifier)) {
            hits.push(`${path.relative(REPO_ROOT, file)} :: ${identifier}`);
          }
        }
      }
    }
    assert.deepStrictEqual(hits, [], `产品代码仍引用 History 标识符：\n${hits.join('\n')}`);
    console.log('PASS: 2');
  }

  console.log('=== 3. tRPC router 不再注册 History ===');
  {
    const routersIndex = readSource('lib/trpc/routers/index.ts');
    assert.ok(
      !routersIndex.includes('promptHistory'),
      'routers/index.ts 不得再注册 promptHistory',
    );
    assert.ok(
      !routersIndex.includes('generationHistory'),
      'routers/index.ts 不得再注册 generationHistory',
    );
    console.log('PASS: 3');
  }

  console.log('=== 4. Rollout flags 默认关闭且无生产消费者 ===');
  {
    const rollout = readSource('lib/storyCollection/rollout.ts');
    assert.ok(
      /LEGACY_HISTORY_READS_ENABLED[\s\S]{0,80}?false/.test(rollout),
      'LEGACY_HISTORY_READS_ENABLED 默认必须为 false',
    );
    assert.ok(
      /LEGACY_HISTORY_WRITE_ENABLED[\s\S]{0,80}?false/.test(rollout),
      'LEGACY_HISTORY_WRITE_ENABLED 默认必须为 false',
    );
    console.log('PASS: 4');
  }

  console.log('=== 5. 自动发送桥不再由 History 驱动 ===');
  {
    const chatLayout = stripComments(readSource('app/(main)/chat/components/ChatLayout/index.tsx'));
    assert.ok(
      !chatLayout.includes('handleHistorySelectPrompt'),
      'ChatLayout 不得再保留 History 选择适配器',
    );
    assert.ok(!chatLayout.includes('historyOpen'), 'ChatLayout 不得再保留 History 面板状态');
    assert.ok(!chatLayout.includes('HistoryPanel'), 'ChatLayout 不得再挂载 HistoryPanel');
    console.log('PASS: 5');
  }

  console.log('=== 6. Artifact History codec 必须保留（不得误删） ===');
  {
    assert.ok(exists('lib/client/chatArtifactHistory.ts'), 'Artifact History codec 必须保留');
    const chatStore = readSource('stores/chatStore.ts');
    assert.ok(
      chatStore.includes('rehydrateServerMessages'),
      'chatStore 必须继续使用 Artifact History codec',
    );
    console.log('PASS: 6');
  }

  console.log('ALL LEGACY HISTORY RETIREMENT UNIT TESTS PASSED SUCCESSFULLY');
}

const testPromise = runLegacyHistoryRetirementUnitTests()
  .then(() => {
    console.log('ALL LEGACY HISTORY RETIREMENT UNIT TESTS PASSED SUCCESSFULLY');
  })
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });

export default testPromise;
