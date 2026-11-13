/**
 * 「从零建包」的宿主侧接口，给界面用。
 *
 * 两条：
 *   /pack/preview  算计划（建哪些目录、抄哪个模板、占多少空间）—— 不写盘
 *   /pack/apply    真建（POST，只有在用户点了「确认建包」之后）
 *
 * 和 MCP 工具的 pack_create 走的是同一对函数（packages/core/pack-create.js），
 * 所以界面里点出来的包和模型建出来的包长得一模一样。
 */
import { applyPackPlan, buildPackPlan, describePackPlan, describePackResult } from '../../packages/core/pack-create.js';
import { formatSize } from '../../packages/core/mod-source.js';
import { boolOr, readParams } from './params.js';

/** 从参数算计划。预览和真建共用，保证两边看到的是同一份计划。 */
function planFrom(params) {
  return buildPackPlan({
    mcRoot: String(params.mcRoot ?? params.root ?? '').trim(),
    name: String(params.name ?? '').trim(),
    templateDir: String(params.templateDir ?? params.dir ?? '').trim(),
    templateId: String(params.id ?? params.templateId ?? '').trim(),
    withQuestBook: boolOr(params.withQuestBook, true),
    withKubejs: boolOr(params.withKubejs, true),
  });
}

/** 把计划摊平成界面能直接渲染的形状。 */
function planPayload(plan) {
  return {
    ok: true,
    name: plan.name,
    mcRoot: plan.mcRoot,
    targetDir: plan.targetDir,
    versionsDir: plan.versionsDir,
    templateId: plan.template.id,
    mcVersion: plan.template.mcVersion,
    loader: plan.template.loader,
    loaderVersion: plan.template.loaderVersion,
    templateMods: plan.template.modsCount,
    dirCount: plan.dirs.length,
    fileCount: plan.files.length,
    totalBytes: plan.totalBytes,
    totalText: formatSize(plan.totalBytes),
    questBook: plan.questBook,
    kubejs: plan.kubejs,
    warnings: plan.warnings,
    dirs: plan.dirs,
    files: plan.files.map((f) => ({
      rel: f.rel,
      kind: f.kind,
      note: f.note,
      sizeText: formatSize(f.bytes || 0),
    })),
    lines: describePackPlan(plan),
  };
}

export async function handlePackPreview(request) {
  const params = await readParams(request);
  return planPayload(planFrom(params));
}

export async function handlePackApply(request) {
  const params = await readParams(request);
  const plan = planFrom(params);
  const result = applyPackPlan(plan);
  const payload = planPayload(plan);
  return {
    ...payload,
    applied: true,
    createdDirs: result.created.dirs,
    createdFiles: result.created.files,
    lines: describePackResult(result, plan),
  };
}