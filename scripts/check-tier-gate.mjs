#!/usr/bin/env node
// 中文注释：tier 完整性门（WS3/C3）——候选/发布路径 P0/P1 非 ACTIVE 或缺 executable 即阻断。
// 用法：node scripts/check-tier-gate.mjs --select <CANDIDATE|RELEASE> [--catalog <path>] [--waivers <path>]
// exit 0 通过；exit 1 阻断并逐条打印 `case_id reason[ WAIVED]`；exit 2 参数非法。
// 零依赖；catalog 解析复用 scripts/check-test-catalog.mjs 导出的共用解析函数（只允许这一份）。
import fs from 'node:fs';
import path from 'node:path';
import { parseYamlSubset, normalizeSuitePath } from './check-test-catalog.mjs';

// 中文注释：仓库根（executable.path 落盘口径与 checker 一致：相对路径相对仓库根）。
const repoRoot = process.cwd();
// 中文注释：合法 --select 取值。
const SELECT_VALUES = new Set(['CANDIDATE', 'RELEASE']);
// 中文注释：waiver 条目必填字段。
const WAIVER_REQUIRED_FIELDS = ['case_id', 'reason', 'owner', 'issue', 'expires_at'];
// 中文注释：expires_at 格式（YYYY-MM-DD，UTC）。
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 解析命令行参数（缺 --select、非法值、未知参数即 exit 2）。
 * @param argv 参数表
 * @returns {{ select, catalogPath, waiversPath }}
 */
function parseArgs(argv) {
  let select = null;
  let catalogPath = path.join(repoRoot, 'tests', 'test-catalog.yaml');
  let waiversPath = path.join(repoRoot, 'tests', 'tier-waivers.yaml');
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--select' || a.startsWith('--select=')) {
      let v = null;
      if (a.startsWith('--select=')) {
        v = a.slice('--select='.length);
      } else {
        v = argv[i + 1];
        i += 1;
      }
      if (typeof v !== 'string' || v.length === 0 || v.startsWith('--')) {
        console.error('参数错误：--select 缺取值（须为 CANDIDATE|RELEASE）');
        process.exit(2);
      }
      if (!SELECT_VALUES.has(v)) {
        console.error(`参数错误：非法 --select ${v}（须为 CANDIDATE|RELEASE）`);
        process.exit(2);
      }
      select = v;
    } else if (a === '--catalog') {
      const v = argv[i + 1];
      if (typeof v !== 'string' || v.length === 0 || v.startsWith('--')) {
        console.error('参数错误：--catalog 缺取值');
        process.exit(2);
      }
      catalogPath = path.isAbsolute(v) ? v : path.join(repoRoot, v);
      i += 1;
    } else if (a === '--waivers') {
      const v = argv[i + 1];
      if (typeof v !== 'string' || v.length === 0 || v.startsWith('--')) {
        console.error('参数错误：--waivers 缺取值');
        process.exit(2);
      }
      waiversPath = path.isAbsolute(v) ? v : path.join(repoRoot, v);
      i += 1;
    } else if (a === '--help' || a === '-h') {
      console.log('用法：node scripts/check-tier-gate.mjs --select <CANDIDATE|RELEASE> [--catalog <path>] [--waivers <path>]');
      process.exit(0);
    } else {
      console.error(`参数错误：未知参数 ${a}`);
      process.exit(2);
    }
  }
  if (select === null) {
    console.error('参数错误：缺 --select（须为 CANDIDATE|RELEASE）');
    process.exit(2);
  }
  return { select, catalogPath, waiversPath };
}

/**
 * 读 catalog 并经共用解析器解析（失败即 fail-closed exit 1）。
 * @param catalogPath catalog 路径
 * @returns 解析后对象
 */
function loadCatalog(catalogPath) {
  let text = '';
  try {
    text = fs.readFileSync(catalogPath, 'utf8');
  } catch (err) {
    console.log(`none catalog-unreadable:${catalogPath}`);
    console.error(`catalog 读取失败：${catalogPath} 原因=${err.message}`);
    process.exit(1);
  }
  try {
    return parseYamlSubset(text);
  } catch (err) {
    console.log('none catalog-unreadable');
    console.error(`catalog 解析失败：${err.message}`);
    process.exit(1);
  }
}

/**
 * 校验 expires_at 合法且未过期（YYYY-MM-DD UTC，当天有效）。
 * @param v 待验值
 * @param todayUtc 今日 UTC 日期串
 * @returns { ok, why }（why 仅非法时有值）
 */
function checkExpiresAt(v, todayUtc) {
  if (typeof v !== 'string') return { ok: false, why: `bad-date:${String(v)}` };
  const m = DATE_RE.exec(v);
  if (m === null) return { ok: false, why: `bad-date:${v}` };
  const y = Number.parseInt(m[1], 10);
  const mo = Number.parseInt(m[2], 10);
  const d = Number.parseInt(m[3], 10);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return { ok: false, why: `bad-date:${v}` };
  const stamp = Date.UTC(y, mo - 1, d);
  const back = new Date(stamp);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return { ok: false, why: `bad-date:${v}` };
  }
  if (v < todayUtc) return { ok: false, why: 'expired' };
  return { ok: true, why: '' };
}

/**
 * 读 waiver 文件并建成 case_id → 有效 waiver 映射。
 * 空文件/注释-only/`[]` 即空数组；缺文件视同空数组（豁免缺席只会更严格）；
 * 整文件不可解析视同空数组并告警（忽略豁免只会更严格，永不放行）。
 * 非法/过期/缺字段条目逐条 stderr 注销并忽略（不得放行）。
 * @param waiversPath waiver 路径
 * @returns Map(case_id → waiver 条目)
 */
function loadWaivers(waiversPath) {
  const valid = new Map();
  let text = null;
  try {
    text = fs.readFileSync(waiversPath, 'utf8');
  } catch {
    return valid;
  }
  const trimmed = text.trim();
  if (trimmed === '') return valid;
  // 中文注释：显著行（去空行/注释/文档标记）为空或仅 `[]` 即空数组豁免。
  const significant = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#') && l !== '---' && l !== '...');
  if (significant.length === 0 || (significant.length === 1 && significant[0] === '[]')) return valid;
  let doc = null;
  try {
    doc = parseYamlSubset(text);
  } catch (err) {
    console.error(`waiver 解析失败已忽略（视同无豁免）：${waiversPath} 原因=${err.message}`);
    return valid;
  }
  if (!Array.isArray(doc)) {
    console.error(`waiver 顶层非数组已忽略（视同无豁免）：${waiversPath}`);
    return valid;
  }
  const todayUtc = new Date().toISOString().slice(0, 10);
  for (const entry of doc) {
    const caseId = entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? entry.case_id : undefined;
    const label = typeof caseId === 'string' && caseId.length > 0 ? caseId : '<unknown-case>';
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      console.error(`waiver-ignored ${label} invalid-entry`);
      continue;
    }
    let missing = '';
    for (const f of WAIVER_REQUIRED_FIELDS) {
      if (typeof entry[f] !== 'string' || entry[f].length === 0) {
        missing = f;
        break;
      }
    }
    if (missing !== '') {
      console.error(`waiver-ignored ${label} missing-field:${missing}`);
      continue;
    }
    const dateCheck = checkExpiresAt(entry.expires_at, todayUtc);
    if (!dateCheck.ok) {
      console.error(`waiver-ignored ${label} ${dateCheck.why}`);
      continue;
    }
    if (!valid.has(entry.case_id)) {
      valid.set(entry.case_id, entry);
    }
  }
  return valid;
}

/**
 * 选择语义：CANDIDATE → ci_tier==CANDIDATE 且 P0/P1；
 * RELEASE → ci_tier∈{CANDIDATE,NIGHTLY,RELEASE} 且 P0/P1。
 * PATH_FILTERED/NONE/P2/P3 永不参与。
 * @param catalog 解析后 catalog
 * @param select CANDIDATE|RELEASE
 * @returns 选中 case 数组
 */
function selectCases(catalog, select) {
  const cases = Array.isArray(catalog?.cases) ? catalog.cases : [];
  return cases.filter((c) => {
    if (c === null || typeof c !== 'object') return false;
    if (c.priority !== 'P0' && c.priority !== 'P1') return false;
    if (select === 'CANDIDATE') return c.ci_tier === 'CANDIDATE';
    return c.ci_tier === 'CANDIDATE' || c.ci_tier === 'NIGHTLY' || c.ci_tier === 'RELEASE';
  });
}

/**
 * 判定单 case 阻断原因（无则返回空串；checker 口径复用：未知 executable/相对路径落盘）。
 * @param c case 对象
 * @param execById executable 索引
 * @returns 原因串（空即不阻断）
 */
function blockReason(c, execById) {
  if (c.lifecycle_status !== 'ACTIVE') return `lifecycle:${String(c.lifecycle_status)}`;
  if (!Array.isArray(c.executable_ids) || c.executable_ids.length === 0) return 'empty-executable-ids';
  for (const eid of c.executable_ids) {
    const e = execById.get(eid);
    if (e === undefined) return `unknown-executable:${String(eid)}`;
    const p = typeof e.path === 'string' ? e.path : '';
    const abs = path.isAbsolute(p) ? p : path.join(repoRoot, normalizeSuitePath(p));
    if (p === '' || !fs.existsSync(abs)) return `missing-path:${p}`;
  }
  return '';
}

/**
 * 主流程。
 */
function main() {
  const { select, catalogPath, waiversPath } = parseArgs(process.argv.slice(2));
  const catalog = loadCatalog(catalogPath);
  const waivers = loadWaivers(waiversPath);
  const execById = new Map(
    (Array.isArray(catalog?.executables) ? catalog.executables : [])
      .filter((e) => e !== null && typeof e === 'object')
      .map((e) => [e.executable_id, e]),
  );
  const selected = selectCases(catalog, select);
  if (selected.length === 0) {
    console.log('empty-selection');
    console.log(`TIER-GATE BLOCKED select=${select} selected=0 blocked=0 waived=0`);
    process.exit(1);
  }
  let blocked = 0;
  let waived = 0;
  for (const c of selected) {
    const reason = blockReason(c, execById);
    if (reason === '') continue;
    const caseId = typeof c?.case_id === 'string' ? c.case_id : '<unknown-case>';
    if (waivers.has(caseId)) {
      waived += 1;
      console.log(`${caseId} ${reason} WAIVED`);
    } else {
      blocked += 1;
      console.log(`${caseId} ${reason}`);
    }
  }
  if (blocked > 0) {
    console.log(`TIER-GATE BLOCKED select=${select} selected=${selected.length} blocked=${blocked} waived=${waived}`);
    process.exit(1);
  }
  console.log(`TIER-GATE PASS select=${select} selected=${selected.length} blocked=0 waived=${waived}`);
  process.exit(0);
}

main();
