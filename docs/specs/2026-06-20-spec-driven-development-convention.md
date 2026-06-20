# 规范驱动开发（SDD）约定 — Spec

> 日期：2026-06-20
> 状态：已采纳
> 类型：流程约定（meta）

## 1. 背景与目标

本仓库希望以"规范驱动开发（Spec-Driven Development, SDD）"作为非平凡任务的默认工作方式：**先写规范与计划，再编码**，并将过程文档沉淀到仓库内，使决策可追溯、变更可复盘。

此前 superpowers 技能流程已在 `docs/superpowers/specs|plans/` 下产出过文档（Design Upgrade v2），但路径与技能实现绑定，不够通用。本约定将其规整为仓库级、与具体工具解耦的标准结构，并写入 `CLAUDE.md` 作为长期约束。

**目标：**

- 在 `CLAUDE.md` 中明确 SDD 工作流与适用范围。
- 建立统一的顶层文档目录 `docs/specs/`、`docs/plans/`。
- 明确与既有文档（`DESIGN_SPEC.md`、旧 `docs/superpowers/`）的关系，避免多套结构并存。

## 2. 适用范围（关键决策）

**仅非平凡任务必须留档。** 包括：新功能、跨模块重构、架构调整、数据模型/接口变更、影响多页面的设计改动。

**可豁免（无需留档）：** 纯 bugfix、文案修改、依赖升级、局部样式微调、重命名等低风险小改动。

判断原则：若改动需要做方案取舍、或会影响他人理解/后续维护，则按非平凡处理。

## 3. 目录结构（关键决策）

采用顶层、与工具解耦的结构：

```
docs/
  specs/    # 设计规范：需求 + 设计 + 方案权衡 + 验收标准
  plans/    # 实施计划：可独立验证的任务拆解，与对应 spec 配套
```

- 命名统一为 `YYYY-MM-DD-<topic>.md`。
- 同一任务的 spec 与 plan **同名**，便于配对查找。

## 4. 工作流

非平凡任务遵循四步：

1. **Spec** — 写 `docs/specs/`：明确目标、约束、方案对比、验收标准。
2. **Plan** — 写 `docs/plans/`：把实现拆成可独立验证的步骤。
3. **Implement** — 按 plan 编码。
4. **Verify** — 跑 `yarn lint`、`yarn tsc --noEmit`、`yarn build`，将结果记录在对应文档或提交说明中。

## 5. 与既有文档的关系

| 文档 | 定位 | 是否变更 |
|------|------|----------|
| `DESIGN_SPEC.md` | UI 设计 Token 的唯一规范（横切 SSOT），约束所有样式取值 | 不变 |
| `docs/specs/`、`docs/plans/` | **单个任务**的设计与实施留档 | 新建为标准结构 |
| `docs/superpowers/` | superpowers 技能的旧产出路径 | **废弃**，内容已迁移至上方新结构 |

说明：`DESIGN_SPEC.md` 是"跨任务的设计规范"，本约定的 `docs/specs/` 是"单任务的设计文档"，两者层级不同、互不替代。

superpowers 的 brainstorming / writing-plans 技能默认写入 `docs/superpowers/`；技能文档允许用户偏好覆盖默认路径，故本仓库统一重定向到 `docs/specs/`、`docs/plans/`。

## 6. 本次变更内容

1. 新建 `docs/specs/`、`docs/plans/`。
2. 迁移既有文档：
   - `docs/superpowers/specs/2026-04-19-design-upgrade-v2.md` → `docs/specs/`
   - `docs/superpowers/plans/2026-04-19-design-upgrade-v2.md` → `docs/plans/`
   - 删除空的 `docs/superpowers/` 目录。
3. 在 `CLAUDE.md` 的"设计规范"与"提交规范"之间新增 `## 规范驱动开发（Spec-Driven Development）` 一节，承载本约定。
4. 本文件作为该约定自身的 spec 留档。

## 7. 验收标准

- `CLAUDE.md` 含 SDD 章节，描述适用范围、目录结构、四步工作流、豁免清单与文档关系。
- `docs/specs/`、`docs/plans/` 存在且包含迁移后的 v2 文档；`docs/superpowers/` 不再存在。
- 纯文档改动，不影响 `yarn lint` / `yarn tsc --noEmit` / `yarn build`。
