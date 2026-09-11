#!/usr/bin/env node
// 中文注释：证据 schema v1 校验器（WS5/C5）——Node/浏览器/CI 共用同一校验口径。
// 用法：node scripts/evidence-schema.mjs --check <results.jsonl> [--catalog <path>] [--repo-root <dir>]
// exit 0 全部行合法；exit 1 任一行非法（逐行打印原因）；exit 2 参数/文件/catalog 非法。
// 零依赖；catalog 解析复用 scripts/check-test-catalog.mjs 导出的共用解析函数（只允许这一份）。
import fs from 'node:fs';
import path from 'node:path';
import { parseYamlSubset, normalizeSuitePath } from './check-test-catalog.mjs';

// 中文注释：v1 版本号（行内 schema_version 必须全等此值）。
export const SCHEMA_VERSION = 1;
// 中文注释：verdict 枚举（与 runner/浏览器 harness 一致）。
const VERDICTS = new Set(['PASS', 'FAIL', 'BLOCKED', 'SKIPPED', 'FLAKY']);
// 中文注释：行种类——summary（产品汇总）与 tooling-summary（基础设施汇总）。
const KINDS = new Set(['summary', 'tooling-summary']);
// 中文注释：仓库根（默认 cwd，可用 --repo-root 覆盖）。
let repoRoot = process.cwd();
// 中文注释：catalog 默认路径（相对仓库根）。
let catalogPath = path.join(repoRoot, 'tests', 'test-catalog.yaml');

/**
 * 解析命令行参数（未知参数/缺取值即 exit 2）。
 * @param argv 参数表
 * @returns {{ checkFile }}
 */
function parseArgs(argv) {
  let checkFile = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--check') {
      const v = argv[i + 1];
      if (typeof v !== 'string' || v.length === 0 || v.startsWith('--')) {
        console.error('参数错误：--check 缺取值');
        process.exit(2);
      }
      checkFile = path.isAbsolute(v) ? v : path.join(repoRoot, v);
      i += 1;
    } else if (a === '--catalog') {
      const v = argv[i + 1];
      if (typeof v !== 'string' || v.length === 0 || v.startsWith('--')) {
        console.error('参数错误：--catalog 缺取值');
        process.exit(2);
      }
      catalogPath = path.isAbsolute(v) ? v : path.join(repoRoot, v);
      i += 1;
    } else if (a === '--repo-root') {
      const v = argv[i + 1];
      if (typeof v !== 'string' || v.length === 0 || v.startsWith('--')) {
        console.error('参数错误：--repo-root 缺取值');
        process.exit(2);
      }
      repoRoot = path.isAbsolute(v) ? v : path.join(process.cwd(), v);
      catalogPath = path.join(repoRoot, 'tests', 'test-catalog.yaml');
      i += 1;
    } else if (a === '--help' || a === '-h') {
      console.log('用法：node scripts/evidence-schema.mjs --check <results.jsonl> [--catalog <path>] [--repo-root <dir>]');
      process.exit(0);
    } else {
      console.error(`参数错误：未知参数 ${a}`);
      process.exit(2);
    }
  }
  if (checkFile === null) {
    console.error('参数错误：缺 --check <results.jsonl>');
    process.exit(2);
  }
  return { checkFile };
}

// 中文注释：catalog 缓存（同进程内同路径只解析一次；catalog 在单次运行中不变）。
let cachedCatalogPath = '';
let cachedCatalog = null;

// 中文注释：tooling 套件缓存。
let cachedToolingSuites = null;
let cachedToolingSuitesRoot = '';

/**
 * 提取已注册的 tooling 套件 ID 集合（从 scripts/run-tests.mjs 静态提取）。
 * @param root 仓库根
 * @returns {Set<string>}
 */
export function loadToolingSuites(root = repoRoot) {
  const r = root ?? repoRoot;
  if (cachedToolingSuites !== null && cachedToolingSuitesRoot === r) return cachedToolingSuites;
  const set = new Set();
  try {
    const runnerPath = path.join(r, 'scripts', 'run-tests.mjs');
    if (fs.existsSync(runnerPath)) {
      const runnerText = fs.readFileSync(runnerPath, 'utf8');
      const re = /\{\s*id:\s*['"]([^'"]+)['"][^}]+group:\s*['"]tooling['"]/g;
      let m;
      while ((m = re.exec(runnerText)) !== null) {
        set.add(m[1]);
      }
      const re2 = /\{\s*[^}]+group:\s*['"]tooling['"][^}]+id:\s*['"]([^'"]+)['"]/g;
      while ((m = re2.exec(runnerText)) !== null) {
        set.add(m[1]);
      }
    }
  } catch {
    // 忽略读取错误
  }
  cachedToolingSuites = set;
  cachedToolingSuitesRoot = r;
  return set;
}

/**
 * 读并解析 catalog，建成 case/executable 双索引与 tooling 套件集合（失败即抛，调用方定退出码）。
 * @param root 仓库根（缺省模块级 repoRoot；测试可显式传入）
 * @param catalog catalog 文件绝对路径（缺省默认路径）
 * @returns {{ cases: Map, executables: Map, toolingSuites: Set<string> }}
 */
export function loadEvidenceCatalog(root = repoRoot, catalog = null) {
  const r = root ?? repoRoot;
  const c = catalog ?? path.join(r, 'tests', 'test-catalog.yaml');
  if (cachedCatalog !== null && cachedCatalogPath === c) return cachedCatalog;
  const text = fs.readFileSync(c, 'utf8');
  const doc = parseYamlSubset(text);
  const cases = new Map();
  for (const item of (doc && doc.cases) || []) {
    if (item !== null && typeof item === 'object' && typeof item.case_id === 'string') {
      cases.set(item.case_id, item);
    }
  }
  const executables = new Map();
  for (const item of (doc && doc.executables) || []) {
    if (item !== null && typeof item === 'object' && typeof item.executable_id === 'string') {
      executables.set(item.executable_id, item);
    }
  }
  const toolingSuites = loadToolingSuites(r);
  const executableToCaseIds = new Map();
  for (const c of cases.values()) {
    for (const eid of (c.executable_ids || [])) {
      if (!executableToCaseIds.has(eid)) executableToCaseIds.set(eid, []);
      executableToCaseIds.get(eid).push(c.case_id);
    }
  }
  cachedCatalog = { cases, executables, toolingSuites, executableToCaseIds };
  cachedCatalogPath = c;
  return cachedCatalog;
}

/**
 * 从 catalog 反向索引查询 executable 绑定的 case_id 列表（由 case.executable_ids 派生）。
 * @param catalog loadEvidenceCatalog 产物
 * @param executableId 可执行 ID
 * @returns {string[]} 绑定的 case_id 列表
 */
export function getCaseIdsForExecutable(catalog, executableId) {
  if (catalog && catalog.executableToCaseIds) {
    return catalog.executableToCaseIds.get(executableId) ?? [];
  }
  const map = new Map();
  for (const c of (catalog?.cases?.values() ?? [])) {
    for (const eid of (c.executable_ids || [])) {
      if (!map.has(eid)) map.set(eid, []);
      map.get(eid).push(c.case_id);
    }
  }
  return map.get(executableId) ?? [];
}

/**
 * 按规范化相对路径找 executable（layer 过滤由调用方指定）。
 * @param catalog loadEvidenceCatalog 产物
 * @param specRelPosix 相对仓库根的 posix 路径（无 ./ 前缀）
 * @param layer 限定 layer（'L3' 浏览器 / null 不限）
 * @returns 匹配 executable 数组
 */
export function findExecutablesForPath(catalog, specRelPosix, layer) {
  const out = [];
  for (const e of catalog.executables.values()) {
    if (layer !== null && layer !== undefined && e.layer !== layer) continue;
    if (typeof e.path !== 'string') continue;
    if (normalizeSuitePath(e.path) === specRelPosix) out.push(e);
  }
  return out;
}


/**
 * 是否为非空字符串。
 * @param v 待验值
 * @returns 布尔
 */
function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * evidence_path 合法性：非空相对路径，不含 .. 段（相对仓库根口径）。
 * @param v 待验值
 * @returns 布尔
 */
function isRelativeEvidencePath(v) {
  if (!isNonEmptyString(v)) return false;
  if (path.isAbsolute(v)) return false;
  if (/^[a-zA-Z]:[\\/]/.test(v)) return false;
  const segs = String(v).split(/[\\/]/);
  if (segs.includes('..')) return false;
  return true;
}

/**
 * 校验单行 v1（Node/浏览器共用同一口径；未知字段透传忽略，唯 synthetic 行拒收）。
 * summary 行规则（防伪造）：verdict 为 PASS/FAIL/FLAKY 须有有效绑定
 * （非空 case_ids 全 join 或单 case_id 已 join）；无绑定的 BLOCKED/SKIPPED 须带非空 reason。
 * @param row 待验行（已解析对象）
 * @param catalog loadEvidenceCatalog 产物（缺省按 cwd 自载；自载失败记行错而非抛）
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateRow(row, catalog = null) {
  const errors = [];
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    return { ok: false, errors: ['not-an-object'] };
  }
  let cat = catalog;
  if (cat === null || cat === undefined) {
    try {
      cat = loadEvidenceCatalog();
    } catch (err) {
      return { ok: false, errors: [`catalog-unreadable:${err instanceof Error ? err.message : String(err)}`] };
    }
  }
  if (row.synthetic === true) {
    errors.push('synthetic-row（非真实执行调用产物，拒收）');
    return { ok: false, errors };
  }
  if (row.schema_version !== SCHEMA_VERSION) {
    errors.push(`bad-schema_version（须为 ${SCHEMA_VERSION}，实际=${JSON.stringify(row.schema_version)})`);
  }
  if (typeof row.kind !== 'string' || !KINDS.has(row.kind)) {
    errors.push(`bad-kind（须为 summary|tooling-summary，实际=${JSON.stringify(row.kind)})`);
  }
  if (!isNonEmptyString(row.run_id)) {
    errors.push('bad-run_id（须为非空字符串）');
  }
  if (typeof row.verdict !== 'string' || !VERDICTS.has(row.verdict)) {
    errors.push(`bad-verdict（须为 PASS|FAIL|BLOCKED|SKIPPED|FLAKY，实际=${JSON.stringify(row.verdict)})`);
  }
  if (!isRelativeEvidencePath(row.evidence_path)) {
    errors.push(`bad-evidence_path（须为相对仓库根的非空相对路径，实际=${JSON.stringify(row.evidence_path)})`);
  }
  for (const field of ['assertion' + '_id', 'surface']) {
    if (Object.prototype.hasOwnProperty.call(row, field)) {
      errors.push(`unsupported-field:${field}（已废弃字段）`);
    }
  }
  if (row.kind === 'summary') {
    // 中文注释：case_ids（数组）逐项须 join；单 case_id 若出现须为已知 case。
    let boundCount = 0;
    if (row.case_ids !== undefined) {
      if (!Array.isArray(row.case_ids)) {
        errors.push('bad-case_ids（须为数组）');
      } else {
        for (const cid of row.case_ids) {
          if (!cat.cases.has(cid)) {
            errors.push(`unknown-case_ids-entry:${String(cid)}`);
          } else {
            boundCount += 1;
          }
        }
      }
    }
    if (row.case_id !== undefined && row.case_id !== null) {
      if (!isNonEmptyString(row.case_id) || !cat.cases.has(row.case_id)) {
        errors.push(`unknown-case_id:${String(row.case_id)}`);
      } else {
        boundCount += 1;
      }
    }
    if (row.verdict === 'PASS' || row.verdict === 'FAIL' || row.verdict === 'FLAKY') {
      if (boundCount === 0) {
        errors.push(`summary-without-binding（${String(row.verdict)} 汇总行须带有效 case 绑定，防伪造 PASS)`);
      }
    } else if (row.verdict === 'BLOCKED' || row.verdict === 'SKIPPED') {
      if (boundCount === 0 && !isNonEmptyString(row.reason)) {
        errors.push('summary-blocked-without-reason（无绑定 BLOCKED/SKIPPED 须带非空 reason)');
      }
    }
  } else if (row.kind === 'tooling-summary') {
    // 中文注释：tooling-summary（基础设施汇总）——必须来自已注册 tooling suite，不得声明产品 case 覆盖。
    const suiteId = row.suite_id || row.suite || row.id;
    if (!isNonEmptyString(suiteId)) {
      errors.push('missing-suite_id（tooling-summary 必须有真实 runner suite 标识）');
    } else {
      const toolingSuites = (cat && cat.toolingSuites instanceof Set) ? cat.toolingSuites : loadToolingSuites();
      if (!toolingSuites.has(suiteId)) {
        errors.push(`unregistered-tooling-suite（${String(suiteId)} 不是已注册的 tooling suite）`);
      }
    }
    if (row.group !== undefined && row.group !== 'tooling') {
      errors.push(`bad-group（tooling-summary 的 group 必须为 tooling，实际=${JSON.stringify(row.group)}）`);
    }
    if (Object.prototype.hasOwnProperty.call(row, 'case_id')) {
      errors.push('tooling-summary-has-product-coverage（tooling-summary 不得包含 case_id）');
    }
    if (Object.prototype.hasOwnProperty.call(row, 'case_ids')) {
      errors.push('tooling-summary-has-product-coverage（tooling-summary 不得包含 case_ids）');
    }
    if (row.reason !== undefined && !isNonEmptyString(row.reason)) {
      errors.push('bad-reason（reason 须为非空字符串）');
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 主流程：逐行 JSON 解析 + validateRow，汇总退出码。
 */
function main() {
  const { checkFile } = parseArgs(process.argv.slice(2));
  let catalog = null;
  try {
    catalog = loadEvidenceCatalog(repoRoot, catalogPath);
  } catch (err) {
    console.error(`catalog 读取/解析失败：${catalogPath} 原因=${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  let text = '';
  try {
    text = fs.readFileSync(checkFile, 'utf8');
  } catch (err) {
    console.error(`结果文件读取失败：${checkFile} 原因=${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  const lines = text.split('\n');
  let total = 0;
  let failed = 0;
  lines.forEach((line, idx) => {
    if (line.trim() === '') return;
    total += 1;
    let row = null;
    try {
      row = JSON.parse(line);
    } catch (err) {
      failed += 1;
      console.error(`line ${idx + 1} json-parse-failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const res = validateRow(row, catalog);
    if (!res.ok) {
      failed += 1;
      console.error(`line ${idx + 1} rejected: ${res.errors.join('; ')}`);
    }
  });
  if (failed > 0) {
    console.error(`EVIDENCE-CHECK FAIL file=${checkFile} lines=${total} failed=${failed}`);
    process.exit(1);
  }
  console.log(`EVIDENCE-CHECK PASS file=${checkFile} lines=${total}`);
  process.exit(0);
}

export { normalizeSuitePath };

// 中文注释：main 判定（与加载器无关：ESM 直接执行 / ESM import / jiti / Playwright CJS
// 转换加载下均安全）。Playwright 经 babel 把本文件转 CJS 后编译，`import.meta` 会原样残留
// 导致 SyntaxError（test:browser reporter 加载阶段崩），故此处禁用一切 ESM-only 语法
// （import.meta）与 CJS-only 标识（__filename/require）：仅以被执行脚本的文件名判定。
// 直接 `node scripts/evidence-schema.mjs --check …` 时 argv[1] basename 命中；被 import/require
// 时 argv[1] 指向导入者（suite-worker/playwright runner 等），basename 不同 → 不误触发 CLI。
const __runAsMain = typeof process.argv[1] === 'string'
  && path.basename(process.argv[1]) === 'evidence-schema.mjs';
if (__runAsMain) {
  main();
}
