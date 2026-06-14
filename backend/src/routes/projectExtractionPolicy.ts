export interface ProjectCrfHistoryClearInput {
  mode: unknown
  targetSections: unknown
  submittedPatientIds: unknown
}

/**
 * 规范化项目抽取模式。
 *
 * 只有显式 full 才表示全量重抽；其它值都按增量处理，避免未知调用方
 * 误传空值或拼写错误时触发破坏性清理。
 */
export function normalizeProjectExtractionMode(mode: unknown): 'full' | 'incremental' {
  return String(mode ?? '').trim().toLowerCase() === 'full' ? 'full' : 'incremental'
}

/**
 * 将任意输入压成去重后的非空字符串列表。
 */
function normalizeStringList(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  return [...new Set(values.map((item) => String(item ?? '').trim()).filter(Boolean))]
}

/**
 * 计算允许清理项目 CRF 历史的患者集合。
 *
 * 清理是破坏性操作，只能在全量、非靶向抽取且任务已成功提交给
 * CRF-service 后执行。这样患者无文档、CRF-service 提交失败、靶向字段组
 * 补抽等场景都不会丢失已有 CRF 数据。
 */
export function getProjectCrfHistoryPatientsToClear(input: ProjectCrfHistoryClearInput): string[] {
  const mode = normalizeProjectExtractionMode(input.mode)
  const targetSections = normalizeStringList(input.targetSections)
  if (mode !== 'full' || targetSections.length > 0) return []
  return normalizeStringList(input.submittedPatientIds)
}
