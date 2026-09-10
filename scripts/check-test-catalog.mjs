#!/usr/bin/env node
// 中文注释：测试资产目录校验器——读 catalog+schema+磁盘 tests/**，做六项校验并输出统计（零新依赖）。
// 用法：node scripts/check-test-catalog.mjs [--catalog <path>] [--schema <path>] [--repo-root <dir>] [--skip-registry-check]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// 中文注释：仓库根（默认 cwd，可用 --repo-root 覆盖，沙箱测试用）。
let repoRoot = process.cwd();
// 中文注释：catalog 与 schema 默认路径（相对仓库根）。
let catalogPath = path.join(repoRoot, 'tests', 'test-catalog.yaml');
let schemaPath = path.join(repoRoot, 'tests', 'test-catalog.schema.json');
// 中文注释：是否跳过 registry 三方一致（沙箱最小 catalog 用，真实 CI 不跳过）。
let skipRegistryCheck = false;
// 中文注释：是否强制 docs/e2e 场景文件全被 case 引用（真实 static 门用；沙箱最小 catalog 不开）。
let requireFullSpecCoverage = false;

/**
 * 解析命令行参数（未知参数即 exit 2）。
 * @param argv 参数表
 */
function parseArgs(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--catalog') {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) { console.error('参数错误：--catalog 缺取值'); process.exit(2); }
      catalogPath = path.isAbsolute(v) ? v : path.join(repoRoot, v);
      i += 1;
    } else if (a === '--schema') {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) { console.error('参数错误：--schema 缺取值'); process.exit(2); }
      schemaPath = path.isAbsolute(v) ? v : path.join(repoRoot, v);
      i += 1;
    } else if (a === '--repo-root') {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) { console.error('参数错误：--repo-root 缺取值'); process.exit(2); }
      repoRoot = path.isAbsolute(v) ? v : path.join(process.cwd(), v);
      // 中文注释：repo-root 变更后，若 catalog/schema 仍为默认则跟随重算。
      if (catalogPath.startsWith(process.cwd())) catalogPath = path.join(repoRoot, 'tests', 'test-catalog.yaml');
      if (schemaPath.startsWith(process.cwd())) schemaPath = path.join(repoRoot, 'tests', 'test-catalog.schema.json');
      i += 1;
    } else if (a === '--skip-registry-check') {
      skipRegistryCheck = true;
    } else if (a === '--require-full-spec-coverage') {
      requireFullSpecCoverage = true;
    } else if (a === '--help' || a === '-h') {
      console.log('用法：node scripts/check-test-catalog.mjs [--catalog <path>] [--schema <path>] [--repo-root <dir>] [--skip-registry-check] [--require-full-spec-coverage]');
      process.exit(0);
    } else {
      console.error(`参数错误：未知参数 ${a}`);
      process.exit(2);
    }
  }
}

// ===== 极简 YAML 子集解析器（仅支持本 catalog 用到子集：两空格缩进、key: value、- item、[a, b] 行内数组、注释行） =====

// 中文注释：行结构（原文、缩进、内容、行号）。
let yamlLines = [];
// 中文注释：当前行指针。
let yamlPos = 0;

/**
 * 去掉行尾注释（# 前为空格且不在引号内才算注释）。
 * @param line 原行
 * @returns 去注释后行
 */
function stripTrailingComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === '#' && !inSingle && !inDouble && i > 0 && (line[i - 1] === ' ' || line[i - 1] === '\t')) {
      return line.slice(0, i).replace(/[ \t]+$/, '');
    }
  }
  return line;
}

/**
 * 解析标量（含数字/布尔/null/引号剥离）。
 * @param raw 原始值文本
 * @returns JS 标量
 */
function parseScalar(raw) {
  const s = raw.trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  if (/^-?\d+$/.test(s)) return Number.parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return Number.parseFloat(s);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  return s;
}

/**
 * 按顶层逗号切分（忽略引号/方括号/花括号内逗号）。
 * @param inner 括号内文本
 * @returns 切分片段
 */
function splitTopLevel(inner) {
  const parts = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  let depthSquare = 0;
  let depthCurly = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble && c === '[') depthSquare += 1;
    else if (!inSingle && !inDouble && c === ']') depthSquare -= 1;
    else if (!inSingle && !inDouble && c === '{') depthCurly += 1;
    else if (!inSingle && !inDouble && c === '}') depthCurly -= 1;
    if (c === ',' && !inSingle && !inDouble && depthSquare === 0 && depthCurly === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  return parts;
}

/**
 * 解析行内值（标量/[a, b]/{k: v}）。
 * @param raw 原始值文本
 * @returns JS 值
 */
function parseInlineValue(raw) {
  const s = raw.trim();
  if (s === '') return '';
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (inner === '') return [];
    return splitTopLevel(inner).map((p) => parseInlineValue(p.trim()));
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1).trim();
    const obj = {};
    if (inner === '') return obj;
    for (const part of splitTopLevel(inner)) {
      const idx = part.indexOf(':');
      if (idx < 0) throw new Error(`行内映射缺冒号：${part}`);
      const k = part.slice(0, idx).trim().replace(/^["']|["']$/g, '');
      const v = parseInlineValue(part.slice(idx + 1).trim());
      obj[k] = v;
    }
    return obj;
  }
  return parseScalar(s);
}

/**
 * 预处理文本为行表（跳过空行/注释/文档标记，校验两空格缩进）。
 * @param text YAML 文本
 */
function prepareYamlLines(text) {
  yamlLines = [];
  yamlPos = 0;
  const raws = text.split(/\r?\n/);
  for (let i = 0; i < raws.length; i += 1) {
    let line = stripTrailingComment(raws[i]);
    if (line.trim() === '' || line.trim() === '---' || line.trim() === '...') continue;
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^(\s*)\S/);
    const indent = m ? m[1].length : 0;
    if (indent % 2 !== 0) throw new Error(`第 ${i + 1} 行缩进非两空格倍数（indent=${indent}）：${line.trim().slice(0, 40)}`);
    yamlLines.push({ indent, content: line.trim(), no: i + 1 });
  }
}

/**
 * 递归解析映射块（同缩进的 key: value 序列）。
 * @param indent 当前块缩进
 * @returns 解析对象
 */
function parseMapBlock(indent) {
  const obj = {};
  while (yamlPos < yamlLines.length && yamlLines[yamlPos].indent === indent && !yamlLines[yamlPos].content.startsWith('- ') && yamlLines[yamlPos].content !== '-') {
    const { content, no } = yamlLines[yamlPos];
    const idx = content.indexOf(':');
    if (idx < 0) throw new Error(`第 ${no} 行缺冒号：${content.slice(0, 60)}`);
    const key = content.slice(0, idx).trim();
    const rest = content.slice(idx + 1).trim();
    if (key === '') throw new Error(`第 ${no} 行键为空`);
    yamlPos += 1;
    if (rest !== '') {
      obj[key] = parseInlineValue(rest);
    } else {
      if (yamlPos >= yamlLines.length || yamlLines[yamlPos].indent <= indent) {
        obj[key] = null;
      } else {
        const next = yamlLines[yamlPos];
        if (next.content.startsWith('- ') || next.content === '-') {
          obj[key] = parseSeqBlock(next.indent);
        } else {
          obj[key] = parseMapBlock(next.indent);
        }
      }
    }
  }
  return obj;
}

/**
 * 递归解析序列块（同缩进的 - item 序列）。
 * @param indent 当前块缩进
 * @returns 解析数组
 */
function parseSeqBlock(indent) {
  const arr = [];
  while (yamlPos < yamlLines.length && yamlLines[yamlPos].indent === indent && (yamlLines[yamlPos].content.startsWith('- ') || yamlLines[yamlPos].content === '-')) {
    const { content, no } = yamlLines[yamlPos];
    const after = content === '-' ? '' : content.slice(2).trim();
    yamlPos += 1;
    if (after === '') {
      if (yamlPos < yamlLines.length && yamlLines[yamlPos].indent > indent) {
        const next = yamlLines[yamlPos];
        if (next.content.startsWith('- ') || next.content === '-') arr.push(parseSeqBlock(next.indent));
        else arr.push(parseMapBlock(next.indent));
      } else {
        arr.push(null);
      }
    } else {
      const idx = after.indexOf(':');
      const looksMap = idx > 0 && !after.startsWith('[') && !after.startsWith('{');
      if (looksMap) {
        const key = after.slice(0, idx).trim();
        const rest = after.slice(idx + 1).trim();
        const item = {};
        if (rest !== '') item[key] = parseInlineValue(rest);
        else if (yamlPos < yamlLines.length && yamlLines[yamlPos].indent > indent) {
          const next = yamlLines[yamlPos];
          if (next.content.startsWith('- ') || next.content === '-') item[key] = parseSeqBlock(next.indent);
          else item[key] = parseMapBlock(next.indent);
        } else item[key] = null;
        while (yamlPos < yamlLines.length && yamlLines[yamlPos].indent === indent + 2 && !yamlLines[yamlPos].content.startsWith('- ') && yamlLines[yamlPos].content !== '-') {
          const sub = yamlLines[yamlPos].content;
          const sIdx = sub.indexOf(':');
          if (sIdx < 0) throw new Error(`第 ${yamlLines[yamlPos].no} 行缺冒号：${sub.slice(0, 60)}`);
          const sk = sub.slice(0, sIdx).trim();
          const sv = sub.slice(sIdx + 1).trim();
          yamlPos += 1;
          if (sv !== '') item[sk] = parseInlineValue(sv);
          else if (yamlPos < yamlLines.length && yamlLines[yamlPos].indent > indent + 2) {
            const nn = yamlLines[yamlPos];
            if (nn.content.startsWith('- ') || nn.content === '-') item[sk] = parseSeqBlock(nn.indent);
            else item[sk] = parseMapBlock(nn.indent);
          } else item[sk] = null;
        }
        void no;
        arr.push(item);
      } else {
        arr.push(parseInlineValue(after));
      }
    }
  }
  return arr;
}

/**
 * 极简 YAML 子集解析入口。
 * @param text YAML 文本
 * @returns JS 对象
 */
function parseYamlSubset(text) {
  prepareYamlLines(text);
  if (yamlLines.length === 0) throw new Error('YAML 为空');
  const first = yamlLines[0];
  if (first.content.startsWith('- ') || first.content === '-') return parseSeqBlock(first.indent);
  return parseMapBlock(first.indent);
}

// ===== 手写 schema 断言（零新依赖，与 tests/test-catalog.schema.json 同口径） =====

// 中文注释：允许的枚举集合。
const PRIORITY_SET = new Set(['P0', 'P1', 'P2', 'P3']);
const LAYER_SET = new Set(['L1', 'L2', 'L3', 'CONTRACT', 'TOOLING', 'STATIC']);
const LIFECYCLE_SET = new Set(['PLANNED', 'ACTIVE', 'BLOCKED', 'MANUAL', 'LEGACY-NON-COVERAGE', 'RETIRED']);
const CI_TIER_SET = new Set(['CANDIDATE', 'NIGHTLY', 'RELEASE', 'PATH_FILTERED', 'NONE']);
// 中文注释：case 允许键集合（含条件键，run_verdict 明确不在其中）。
const CASE_ALLOWED_KEYS = new Set(['case_id', 'display_name_zh', 'legacy_aliases', 'journey_id', 'user_goal', 'priority', 'primary_defense', 'secondary_defenses', 'lifecycle_status', 'risk_tags', 'spec_path', 'required_assertions', 'executable_ids', 'fixtures', 'ci_tier', 'owner', 'blocked_reason', 'manual_reason']);
// 中文注释：executable 允许键集合（含 L3 必填 evidence_surfaces）。
const EXEC_ALLOWED_KEYS = new Set(['executable_id', 'display_name_zh', 'layer', 'path', 'case_ids', 'evidence_surfaces']);
// 中文注释：语义名 kebab-case 正则。
const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// 中文注释：spec 路径正则。
const SPEC_PATH_RE = /^docs\/e2e\/.+\.md(#.+)?$/;

/**
 * 断言值为非空字符串。
 * @param v 待验值
 * @returns 是否通过
 */
function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * 手写 schema 合法性校验（与 JSON Schema 同口径，错误信息指明原因）。
 * @param catalog 解析后 catalog 对象
 * @returns 错误列表（空即通过）
 */
function validateSchemaHandwritten(catalog) {
  const errors = [];
  if (catalog === null || typeof catalog !== 'object' || Array.isArray(catalog)) {
    return ['顶层必须为映射（object），实际为数组或标量'];
  }
  if ('run_verdict' in catalog) errors.push('顶层出现非法字段 run_verdict（run_verdict 不属于 catalog）');
  for (const k of Object.keys(catalog)) {
    if (!['schema_version', 'cases', 'executables'].includes(k)) errors.push(`顶层非法字段：${k}`);
  }
  if (catalog.schema_version !== 1) errors.push(`schema_version 非法（须为 1，实际=${JSON.stringify(catalog.schema_version)}）`);
  if (!Array.isArray(catalog.cases) || catalog.cases.length === 0) errors.push('cases 必须为非空数组');
  if (!Array.isArray(catalog.executables) || catalog.executables.length === 0) errors.push('executables 必须为非空数组');
  if (errors.length > 0 && (!Array.isArray(catalog.cases) || !Array.isArray(catalog.executables))) return errors;

  const caseIds = new Set();
  (catalog.cases || []).forEach((c, i) => {
    const label = `cases[${i}]`;
    if (c === null || typeof c !== 'object' || Array.isArray(c)) { errors.push(`${label} 必须为映射`); return; }
    if ('run_verdict' in c) errors.push(`${label} 出现非法字段 run_verdict（run_verdict 不属于 catalog）`);
    for (const k of Object.keys(c)) {
      if (!CASE_ALLOWED_KEYS.has(k)) errors.push(`${label} 非法字段：${k}`);
    }
    if (!isNonEmptyString(c.case_id)) errors.push(`${label} 缺 case_id（必须为非空语义名）`);
    else if (!KEBAB_RE.test(c.case_id)) errors.push(`${label} 非法 case_id（须为 kebab-case）：${c.case_id}`);
    else if (caseIds.has(c.case_id)) errors.push(`${label} 重复 case_id：${c.case_id}`);
    else caseIds.add(c.case_id);
    if (!isNonEmptyString(c.display_name_zh)) errors.push(`${label} 缺 display_name_zh`);
    if (!Array.isArray(c.legacy_aliases)) errors.push(`${label} 缺 legacy_aliases（须为数组）`);
    else if (!c.legacy_aliases.every(isNonEmptyString)) errors.push(`${label} 非法 legacy_aliases（须为非空字符串数组）`);
    if (!isNonEmptyString(c.journey_id)) errors.push(`${label} 缺 journey_id`);
    if (!isNonEmptyString(c.user_goal)) errors.push(`${label} 缺 user_goal`);
    if (!PRIORITY_SET.has(c.priority)) errors.push(`${label} 非法枚举 priority（须为 P0-P3，实际=${JSON.stringify(c.priority)}）`);
    if (!isNonEmptyString(c.primary_defense)) errors.push(`${label} 缺 primary_defense`);
    if (!Array.isArray(c.secondary_defenses)) errors.push(`${label} 缺 secondary_defenses（须为数组）`);
    if (!LIFECYCLE_SET.has(c.lifecycle_status)) errors.push(`${label} 非法枚举 lifecycle_status（六值之一，实际=${JSON.stringify(c.lifecycle_status)}）`);
    if (!Array.isArray(c.risk_tags)) errors.push(`${label} 缺 risk_tags（须为数组）`);
    if (!isNonEmptyString(c.spec_path) || !SPEC_PATH_RE.test(c.spec_path)) errors.push(`${label} 非法 spec_path（须形如 docs/e2e/...md，实际=${JSON.stringify(c.spec_path)}）`);
    if (!Array.isArray(c.required_assertions) || c.required_assertions.length === 0) errors.push(`${label} 缺 required_assertions（须为非空数组）`);
    else {
      c.required_assertions.forEach((a, j) => {
        if (a === null || typeof a !== 'object' || Array.isArray(a)) { errors.push(`${label}.required_assertions[${j}] 必须为映射`); return; }
        if ('run_verdict' in a) errors.push(`${label}.required_assertions[${j}] 出现非法字段 run_verdict`);
        if (!isNonEmptyString(a.assertion_id) || !KEBAB_RE.test(a.assertion_id)) errors.push(`${label}.required_assertions[${j}] 非法 assertion_id：${JSON.stringify(a.assertion_id)}`);
        if (!isNonEmptyString(a.display_name_zh)) errors.push(`${label}.required_assertions[${j}] 缺 display_name_zh`);
        for (const k of Object.keys(a)) {
          if (!['assertion_id', 'display_name_zh', 'surface'].includes(k)) errors.push(`${label}.required_assertions[${j}] 非法字段：${k}`);
        }
      });
    }
    if (!Array.isArray(c.executable_ids)) errors.push(`${label} 缺 executable_ids（须为数组）`);
    else if (!c.executable_ids.every(isNonEmptyString)) errors.push(`${label} 非法 executable_ids（须为非空字符串数组）`);
    if (!Array.isArray(c.fixtures)) errors.push(`${label} 缺 fixtures（须为数组）`);
    if (!CI_TIER_SET.has(c.ci_tier)) errors.push(`${label} 非法枚举 ci_tier（五值之一，实际=${JSON.stringify(c.ci_tier)}）`);
    if (!isNonEmptyString(c.owner)) errors.push(`${label} 缺 owner`);
    if (c.lifecycle_status === 'BLOCKED' && !isNonEmptyString(c.blocked_reason)) errors.push(`${label} 缺 blocked_reason（lifecycle=BLOCKED 时必填）`);
    if (c.lifecycle_status === 'MANUAL' && !isNonEmptyString(c.manual_reason)) errors.push(`${label} 缺 manual_reason（lifecycle=MANUAL 时必填）`);
  });

  const execIds = new Set();
  (catalog.executables || []).forEach((e, i) => {
    const label = `executables[${i}]`;
    if (e === null || typeof e !== 'object' || Array.isArray(e)) { errors.push(`${label} 必须为映射`); return; }
    if ('run_verdict' in e) errors.push(`${label} 出现非法字段 run_verdict（run_verdict 不属于 catalog）`);
    for (const k of Object.keys(e)) {
      if (!EXEC_ALLOWED_KEYS.has(k)) errors.push(`${label} 非法字段：${k}`);
    }
    if (!isNonEmptyString(e.executable_id)) errors.push(`${label} 缺 executable_id`);
    else if (!KEBAB_RE.test(e.executable_id)) errors.push(`${label} 非法 executable_id（须为 kebab-case）：${e.executable_id}`);
    else if (execIds.has(e.executable_id)) errors.push(`${label} 重复 executable_id（顶层唯一）：${e.executable_id}`);
    else execIds.add(e.executable_id);
    if (!isNonEmptyString(e.display_name_zh)) errors.push(`${label} 缺 display_name_zh`);
    if (!LAYER_SET.has(e.layer)) errors.push(`${label} 非法枚举 layer（须为 L1|L2|L3|CONTRACT|TOOLING|STATIC，实际=${JSON.stringify(e.layer)}）`);
    if (!isNonEmptyString(e.path)) errors.push(`${label} 缺 path`);
    if (!Array.isArray(e.case_ids) || e.case_ids.length === 0) errors.push(`${label} 缺 case_ids（须为非空数组）`);
    else if (!e.case_ids.every(isNonEmptyString)) errors.push(`${label} 非法 case_ids（须为非空字符串数组）`);
    if (e.layer === 'L3') {
      if (!Array.isArray(e.evidence_surfaces) || e.evidence_surfaces.length === 0 || !e.evidence_surfaces.every(isNonEmptyString)) {
        errors.push(`${label} 缺 evidence_surfaces（layer=L3 必填非空字符串数组，绑定真实证据面）`);
      }
    } else if (e.evidence_surfaces !== undefined) {
      if (!Array.isArray(e.evidence_surfaces) || !e.evidence_surfaces.every(isNonEmptyString)) {
        errors.push(`${label} 非法 evidence_surfaces（须为字符串数组）`);
      }
    }
  });
  return errors;
}

/**
 * 规范化套件路径（去 ./ 前缀，统一斜杠）。
 * @param p 原始路径
 * @returns 规范路径
 */
function normalizeSuitePath(p) {
  let s = String(p).replace(/\\/g, '/');
  if (s.startsWith('./')) s = s.slice(2);
  return s;
}

/**
 * 递归收集磁盘 suite 路径。
 *
 * 可执行集合口径（Fix 1 meta-suite 闭环后）：
 * - 纳入：tests/** 下全部 `*.test.ts`（含 tests/tooling/runner、tests/tooling/catalog、
 *   tests/tooling/ci 三个元测试目录——它们是 needs_db=false 的叶子套件，无自指递归，禁止排除掩盖）；
 * - 排除 tests/support/**（支撑实现非可执行套件）；
 * - 排除 tests/system/**（Playwright 浏览器域：由 playwright 直接执行的多浏览器 L3 spec，
 *   runner suite-worker 无法执行；其 L3 executable 另按“存在 + spec 绑定 + evidence surfaces”校验，
 *   不进入 Node 三方集合比较——执行器不同是 principled 划分，有测试与 manifest 证据，非掩盖）。
 * @param dir 起始目录
 * @param out 输出数组
 */
function collectDiskSuites(dir, out) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (abs.replace(/\\/g, '/').includes('tests/support')) continue;
      if (abs.replace(/\\/g, '/').includes('tests/system')) continue;
      collectDiskSuites(abs, out);
    } else if (ent.isFile() && ent.name.endsWith('.ts')) {
      const rel = path.relative(repoRoot, abs).replace(/\\/g, '/');
      if (!rel.startsWith('tests/')) continue;
      if (rel.startsWith('tests/support/')) continue;
      if (rel.startsWith('tests/system/')) continue;
      out.push(rel);
    }
  }
}

/**
 * 获取 runner 注册表路径集合（调 node scripts/run-tests.mjs --list）。
 * @returns 规范路径数组
 */
function getRegistryPaths() {
  const runner = path.join(repoRoot, 'scripts', 'run-tests.mjs');
  const out = execFileSync(process.execPath, [runner, '--list'], { cwd: repoRoot, encoding: 'utf8', timeout: 15000 });
  const arr = JSON.parse(out);
  if (!Array.isArray(arr)) throw new Error('registry --list 非数组');
  return arr.map((e) => normalizeSuitePath(e.path));
}

/**
 * 主流程：六项校验 + 统计输出。
 */
function main() {
  parseArgs(process.argv.slice(2));
  // 中文注释：读 catalog 文本（缺文件即 exit 1 并指明原因）。
  let yamlText = '';
  try {
    yamlText = fs.readFileSync(catalogPath, 'utf8');
  } catch (err) {
    console.error(`catalog 读取失败：${catalogPath} 原因=${err.message}`);
    process.exit(1);
  }
  // 中文注释：读 schema（仅验存在与 JSON 合法，断言手写以零依赖）。
  try {
    const schemaText = fs.readFileSync(schemaPath, 'utf8');
    JSON.parse(schemaText);
  } catch (err) {
    console.error(`schema 读取/解析失败：${schemaPath} 原因=${err.message}`);
    process.exit(1);
  }
  // 中文注释：①YAML 可解析且 schema 合法（手写断言）。
  let catalog = null;
  try {
    catalog = parseYamlSubset(yamlText);
  } catch (err) {
    console.error(`YAML 解析失败：${err.message}`);
    process.exit(1);
  }
  const schemaErrors = validateSchemaHandwritten(catalog);
  if (schemaErrors.length > 0) {
    for (const e of schemaErrors) console.error(`schema 非法：${e}`);
    process.exit(1);
  }

  const execById = new Map((catalog.executables || []).map((e) => [e.executable_id, e]));
  const caseById = new Map((catalog.cases || []).map((c) => [c.case_id, c]));

  // 中文注释：④executables 顶层唯一已在 schema 阶段覆盖，此处做 case_ids 反向引用一致。
  const refErrors = [];
  for (const e of catalog.executables) {
    for (const cid of e.case_ids) {
      if (!caseById.has(cid)) {
        refErrors.push(`反向引用断链：executable ${e.executable_id} 的 case_ids 含不存在的 case ${cid}`);
      } else {
        const c = caseById.get(cid);
        if (!Array.isArray(c.executable_ids) || !c.executable_ids.includes(e.executable_id)) {
          refErrors.push(`反向引用不一致：case ${cid} 的 executable_ids 缺 ${e.executable_id}（executable 侧声明了它）`);
        }
      }
    }
  }
  for (const c of catalog.cases) {
    for (const eid of (c.executable_ids || [])) {
      if (!execById.has(eid)) {
        refErrors.push(`反向引用断链：case ${c.case_id} 的 executable_ids 含不存在的 executable ${eid}`);
      } else {
        const e = execById.get(eid);
        if (!Array.isArray(e.case_ids) || !e.case_ids.includes(c.case_id)) {
          refErrors.push(`反向引用不一致：executable ${eid} 的 case_ids 缺 ${c.case_id}（case 侧声明了它）`);
        }
      }
    }
  }
  if (refErrors.length > 0) {
    for (const e of refErrors) console.error(`引用非法：${e}`);
    process.exit(1);
  }

  // 中文注释：②每 ACTIVE case 有 executable 且 path 在磁盘存在；③PLANNED/BLOCKED 允许缺 executable 但报告缺口。
  const gaps = [];
  for (const c of catalog.cases) {
    if ((c.lifecycle_status === 'PLANNED' || c.lifecycle_status === 'BLOCKED') && (!Array.isArray(c.executable_ids) || c.executable_ids.length === 0)) {
      gaps.push(`${c.case_id}（${c.lifecycle_status} 缺 executable，属预期缺口）`);
    }
  }

  // 中文注释：②ACTIVE 非空检查（STEP-1 RED 后补全，正式版）。
  const activeErrors = [];
  for (const c of catalog.cases) {
    if (c.lifecycle_status === 'ACTIVE' && (!Array.isArray(c.executable_ids) || c.executable_ids.length === 0)) {
      activeErrors.push(`ACTIVE 缺 executable：case ${c.case_id} 为 ACTIVE 但 executable_ids 为空`);
    }
  }
  if (activeErrors.length > 0) {
    for (const e of activeErrors) console.error(`ACTIVE 非法：${e}`);
    process.exit(1);
  }

  // 中文注释：②executable path 落盘检查。
  const pathErrors = [];
  for (const e of catalog.executables) {
    const abs = path.isAbsolute(e.path) ? e.path : path.join(repoRoot, normalizeSuitePath(e.path));
    if (!fs.existsSync(abs)) {
      pathErrors.push(`executable ${e.executable_id} 的 path 不存在：${e.path}`);
    }
  }
  if (pathErrors.length > 0) {
    for (const e of pathErrors) console.error(`path 非法：${e}`);
    process.exit(1);
  }

  // 中文注释：②c LEGACY-NON-COVERAGE 清零门（Fix 4：过渡状态收口后不得再出现，出现即 exit 1）。
  const legacyLeftovers = (catalog.cases || []).filter((c) => c.lifecycle_status === 'LEGACY-NON-COVERAGE');
  if (legacyLeftovers.length > 0) {
    for (const c of legacyLeftovers) console.error(`LEGACY 非法：LEGACY-NON-COVERAGE 未清零：${c.case_id}`);
    process.exit(1);
  }

  // 中文注释：②d case spec_path 落盘检查（去 # 锚点后 docs/e2e 下文件须存在）。
  const specErrors = [];
  const referencedSpecs = new Set();
  for (const c of catalog.cases || []) {
    if (!SPEC_PATH_RE.test(String(c.spec_path || ''))) {
      specErrors.push(`case ${c.case_id} 的 spec_path 格式非法：${c.spec_path}`);
      continue;
    }
    const specFile = String(c.spec_path).split('#')[0];
    referencedSpecs.add(specFile);
    if (!fs.existsSync(path.join(repoRoot, specFile))) {
      specErrors.push(`case ${c.case_id} 的 spec_path 不存在：${specFile}`);
    }
  }
  if (specErrors.length > 0) {
    for (const e of specErrors) console.error(`spec 非法：${e}`);
    process.exit(1);
  }

  // 中文注释：②e docs/e2e 场景文件全被认领检查（仅 --require-full-spec-coverage 真实 static 门开启；
  // 沙箱最小 catalog 不开，避免把全仓文件义务强加给 fixture）。
  if (requireFullSpecCoverage) {
    const allSpecs = [];
    (function walkDocs(dir) {
      let ents = [];
      try {
        ents = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of ents) {
        const abs = path.join(dir, ent.name);
        if (ent.isDirectory()) { walkDocs(abs); continue; }
        if (!ent.name.endsWith('.md')) continue;
        if (ent.name.toLowerCase() === 'readme.md') continue;
        allSpecs.push(path.relative(repoRoot, abs).replace(/\\/g, '/'));
      }
    })(path.join(repoRoot, 'docs', 'e2e'));
    const orphans = allSpecs.filter((s) => !referencedSpecs.has(s)).sort();
    if (orphans.length > 0) {
      for (const o of orphans) console.error(`spec 认领缺失：${o} 未被任何 case.spec_path 引用`);
      process.exit(1);
    }
  }

  // 中文注释：⑤suite path 集合与 runner registry 与磁盘三方一致（排除 support/** 与 Playwright tests/system/**）。
  // 中文注释：L3 executable 由 playwright 执行、不进 runner 注册表，故三方集合比较只覆盖 Node 层
  // （L1|L2|CONTRACT|TOOLING|STATIC）；L3 executable 仍受“path 落盘”检查（上文）约束，缺失即 exit 1。
  if (!skipRegistryCheck) {
    let registryPaths = [];
    try {
      registryPaths = getRegistryPaths();
    } catch (err) {
      console.error(`registry 读取失败：${err.message}`);
      process.exit(1);
    }
    const diskPaths = [];
    collectDiskSuites(path.join(repoRoot, 'tests'), diskPaths);
    const nodeExecPaths = catalog.executables
      .filter((e) => e.layer !== 'L3')
      .map((e) => normalizeSuitePath(e.path))
      .sort();
    const l3ExecPaths = catalog.executables
      .filter((e) => e.layer === 'L3')
      .map((e) => normalizeSuitePath(e.path));
    for (const p of l3ExecPaths) {
      if (p.startsWith('tests/system/')) continue;
      console.error(`L3 executable 路径非法（须位于 tests/system/ 由 playwright 执行）：${p}`);
      process.exit(1);
    }
    const catalogPaths = nodeExecPaths;
    const regSorted = [...registryPaths].sort();
    const diskSorted = [...diskPaths].sort();
    const catalogSet = new Set(catalogPaths);
    const regSet = new Set(regSorted);
    const diskSet = new Set(diskSorted);
    const diffs = [];
    for (const p of catalogSet) {
      if (!regSet.has(p)) diffs.push(`catalog 有而 registry 缺：${p}`);
      if (!diskSet.has(p)) diffs.push(`catalog 有而磁盘缺：${p}`);
    }
    for (const p of regSet) {
      if (!catalogSet.has(p)) diffs.push(`registry 有而 catalog 缺：${p}`);
      if (!diskSet.has(p)) diffs.push(`registry 有而磁盘缺：${p}`);
    }
    for (const p of diskSet) {
      if (!regSet.has(p)) diffs.push(`磁盘有而 registry 缺：${p}`);
      if (!catalogSet.has(p)) diffs.push(`磁盘有而 catalog 缺：${p}`);
    }
    if (diffs.length > 0) {
      for (const d of diffs) console.error(`三方不一致：${d}`);
      process.exit(1);
    }
  }

  // 中文注释：⑥统计输出（父组数/原子 case 数/声明自动化数/已实现数）。
  const specParents = new Set((catalog.cases || []).map((c) => String(c.spec_path).split('#')[0]));
  const atomicCount = (catalog.cases || []).length;
  const declaredCount = (catalog.cases || []).filter((c) => ['ACTIVE', 'PLANNED', 'BLOCKED'].includes(c.lifecycle_status)).length;
  const implementedCount = (catalog.cases || []).filter((c) => c.lifecycle_status === 'ACTIVE' && Array.isArray(c.executable_ids) && c.executable_ids.length > 0).length;
  console.log(`父组数=${specParents.size}`);
  console.log(`原子case数=${atomicCount}`);
  console.log(`声明自动化数=${declaredCount}`);
  console.log(`已实现数=${implementedCount}`);
  if (gaps.length > 0) {
    console.log(`缺口数=${gaps.length}`);
    for (const g of gaps) console.log(`缺口：${g}`);
  } else {
    console.log('缺口数=0');
  }
  console.log('CHECK PASS：测试资产目录校验通过');
}

// 中文注释：C3 导出共用解析函数供 scripts/check-tier-gate.mjs 复用（catalog 解析只允许这一份）。
// 被 import 时不执行 main；直接运行本文件时行为与输出不变。
// main 判定与加载器无关（与 scripts/evidence-schema.mjs 同一改法）：本文件经
// evidence-schema 被 Playwright reporter 链 CJS 转换加载（已由 smoke 实证），
// 故禁用 ESM-only 的 import.meta（亦不用 __filename/require），仅以被执行脚本的文件名判定。
export { parseYamlSubset, normalizeSuitePath };
const __runAsMain = typeof process.argv[1] === 'string'
  && path.basename(process.argv[1]) === 'check-test-catalog.mjs';
if (__runAsMain) {
  main();
}
