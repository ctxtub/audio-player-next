#!/usr/bin/env node
/**
 * 中文注释：actions pin 真实性校验器（供应链硬化）。
 *
 * 背景：旧守卫只做形状校验 /@[0-9a-f]{40}/，形状正确但值不存在的 SHA
 * 能完美通过——这是纸老虎。本脚本做真实解析：取 workflow 里
 * `uses: owner/repo@<sha> # <tag>` 的每一处，向 GitHub API 解析该 tag
 * 的真实 commit SHA，与钉住值逐字比对。
 *
 * 实测记录（2026-09-11，经 GitHub API 逐个验真，见
 * docs/specs/2026-09-11-main-auto-delivery.md §9）：
 * actions/checkout@v4.2.2、actions/setup-node@v4.2.0、
 * docker/setup-buildx-action@v3.10.0、docker/login-action@v3.3.0
 * 的钉住 SHA 与 upstream 真实 commit 逐字一致。
 *
 * 用法：
 *   node scripts/verify-action-pins.mjs            # 校验（任何不一致 -> 退出码 1）
 *   node scripts/verify-action-pins.mjs --update    # 解析并写入 lock 文件
 *
 * 故障分类（必须区分，不得互相掩盖）：
 *   A. unresolved  —— 解析失败（网络/限流/tag 不存在）。属于**基础设施故障**，
 *                    此时绝不能把结果说成"lock 陈旧"或其他业务结论。
 *   B. mismatched  —— 解析成功但与钉住值不一致。属于**伪造/失效 pin**，必须红。
 *   C. lock 漂移   —— lock 与 workflow 不一致（缺条目/陈旧条目）。
 *
 * 环境：可选 GITHUB_TOKEN / GH_TOKEN（提高速率上限；CI 由 github.token 提供，
 *       未认证上限仅 60 次/小时，容易在本地被限流）。
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const WORKFLOW_DIR = path.join(ROOT, '.github', 'workflows');
const LOCK_PATH = path.join(ROOT, 'tests', 'tooling', 'ci', 'action-pins.lock.json');
// 注意：此处不能用 /g 正则逐行 exec —— lastIndex 会跨行泄漏导致后续行全部误判。
const PIN_RE = /uses:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([0-9a-f]{40})\s*#\s*(v[\w.\-]+)/;
const USES_AT_RE = /uses:\s*[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@/;

/** 中文注释：扫描全部 workflow，抽出 pin 三元组（repo, sha, tag）并去重。 */
function collectPins() {
  const files = fs
    .readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort();
  const pins = new Map(); // key = `${repo}@${tag}` -> {repo, tag, sha, files}
  const tagless = []; // 缺 `# tag` 注释：无法解析，必须显式失败
  for (const f of files) {
    const text = fs.readFileSync(path.join(WORKFLOW_DIR, f), 'utf8');
    for (const line of text.split('\n')) {
      if (!line.includes('uses:')) continue;
      const m = PIN_RE.exec(line);
      if (m) {
        const key = `${m[1]}@${m[3]}`;
        if (!pins.has(key)) pins.set(key, { repo: m[1], tag: m[3], sha: m[2], files: new Set() });
        else if (pins.get(key).sha !== m[2]) {
          throw new Error(`同一 ${key} 存在多个不同 SHA：${pins.get(key).sha} / ${m[2]}（${f}）`);
        }
        pins.get(key).files.add(f);
      } else if (USES_AT_RE.test(line)) {
        tagless.push(`${f}: ${line.trim()}`);
      }
    }
  }
  return { pins, tagless };
}

/** 中文注释：解析 tag 指向的真实 commit SHA（附注 tag 需再解引用一层）。 */
async function resolveTag(repo, tag, token) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'verify-action-pins' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const chain = [];
  let url = `https://api.github.com/repos/${repo}/git/ref/tags/${tag}`;
  for (let depth = 0; depth < 3; depth += 1) {
    let res;
    try {
      res = await fetch(url, { headers });
    } catch (e) {
      throw new Error(`INFRA 网络不可达（${e.message}）`);
    }
    if (res.status === 403 || res.status === 429) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      throw new Error(
        `INFRA GitHub API 拒绝访问 HTTP ${res.status}（remaining=${remaining ?? '?'}）。` +
          (token ? '' : '未设 GITHUB_TOKEN 时上限仅 60 次/小时，请设 token 后重试。'),
      );
    }
    if (!res.ok) throw new Error(`tag 解析失败 HTTP ${res.status} ${res.statusText}`);
    const body = await res.json();
    chain.push(body.object.type);
    if (body.object.type === 'commit') return body.object.sha;
    if (body.object.type === 'tag') {
      url = `https://api.github.com/repos/${repo}/git/tags/${body.object.sha}`;
      continue;
    }
    throw new Error(`无法处理的 object.type=${body.object.type}`);
  }
  throw new Error('附注 tag 解引用层数过深');
}

function readLock() {
  if (!fs.existsSync(LOCK_PATH)) return { entries: [] };
  return JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
}

function writeLock(entries) {
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
  fs.writeFileSync(
    LOCK_PATH,
    `${JSON.stringify(
      {
        note: '由 scripts/verify-action-pins.mjs --update 生成；请勿手改。CI 会用真实 GitHub API 复验。',
        entries: [...entries].sort((a, b) =>
          `${a.repo}@${a.tag}`.localeCompare(`${b.repo}@${b.tag}`),
        ),
      },
      null,
      2,
    )}\n`,
  );
}

async function main() {
  const update = process.argv.includes('--update');
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  const { pins, tagless } = collectPins();

  if (pins.size === 0) {
    console.error('RED：未发现任何 action pin（预期应有若干 `uses: owner/repo@<40hex> # <tag>`）');
    process.exit(1);
  }
  if (tagless.length > 0) {
    console.error('RED：以下 uses 行缺少 `# <tag>` 注释，无法做真实解析校验：');
    for (const l of tagless) console.error(`  ${l}`);
    process.exit(1);
  }

  console.log(`扫描到 ${pins.size} 个唯一 pin，向 GitHub 解析真实 SHA…`);
  const resolved = [];
  const unresolved = [];
  const mismatched = [];
  for (const { repo, tag, sha, files } of pins.values()) {
    const where = [...files].sort().join(', ');
    let real;
    try {
      real = await resolveTag(repo, tag, token);
    } catch (e) {
      console.log(`  INFRA ${repo}@${tag}  ${e.message}`);
      unresolved.push({ repo, tag, sha, reason: e.message, where });
      continue;
    }
    if (real === sha) {
      console.log(`  OK    ${repo}@${tag}  pinned=${sha}  real=${real}`);
    } else {
      console.log(`  RED   ${repo}@${tag}  pinned=${sha}  real=${real}`);
      mismatched.push({ repo, tag, sha, real, where });
    }
    resolved.push({ repo, tag, sha: real, files: [...files].sort() });
  }

  // A) 解析失败必须最先、独立地报出来，绝不能污染其它结论。
  if (unresolved.length > 0) {
    console.error('');
    console.error(`INFRA：${unresolved.length} 个 pin 无法联系 GitHub 完成解析（非 pin 本身的结论）：`);
    for (const u of unresolved) console.error(`  ${u.repo}@${u.tag}  <- ${u.reason}  （${u.where}）`);
    console.error('这不是"pin 有问题"也不是"lock 陈旧"，请先解决网络/限流后重跑。');
    process.exit(1);
  }

  // B) 伪造/失效 pin：先报，且 --update 也拒绝据此写 lock。
  if (mismatched.length > 0) {
    console.error('');
    console.error('RED：以下 pin 与 upstream 真实 tag 不一致（伪造或已失效的 SHA）：');
    for (const b of mismatched) {
      console.error(`  ${b.repo}@${b.tag}`);
      console.error(`    pinned: ${b.sha}`);
      console.error(`    real  : ${b.real}`);
      console.error(`    位置  : ${b.where}`);
    }
    console.error('修法：用上面的 real 值替换 workflow，再跑本脚本 --update 重建 lock。');
    process.exit(1);
  }

  // C) lock 一致性 / 写入
  if (update) {
    writeLock(resolved);
    console.log(`已写入 lock：${path.relative(ROOT, LOCK_PATH)}（${resolved.length} 条）`);
  } else {
    const lockEntries = readLock().entries || [];
    const lockKeys = new Set(lockEntries.map((e) => `${e.repo}@${e.tag}`));
    const liveKeys = new Set(resolved.map((e) => `${e.repo}@${e.tag}`));
    const missing = [...liveKeys].filter((k) => !lockKeys.has(k));
    const stale = [...lockKeys].filter((k) => !liveKeys.has(k));
    const drifted = lockEntries.filter((e) => {
      const live = resolved.find((x) => x.repo === e.repo && x.tag === e.tag);
      return live && live.sha !== e.sha;
    });
    if (missing.length || stale.length || drifted.length) {
      console.error('');
      if (missing.length) console.error(`RED：lock 缺少条目：${missing.join(', ')}`);
      if (stale.length) console.error(`RED：lock 存在已不使用的陈旧条目：${stale.join(', ')}`);
      for (const d of drifted) console.error(`RED：lock 与 workflow 不一致：${d.repo}@${d.tag}`);
      console.error('修法：node scripts/verify-action-pins.mjs --update');
      process.exit(1);
    }
  }

  console.log(`PASS：${resolved.length} 个 action pin 全部与 upstream 真实 commit 一致`);
}

main().catch((e) => {
  console.error(`RED：verify-action-pins 异常：${e.message}`);
  process.exit(1);
});
