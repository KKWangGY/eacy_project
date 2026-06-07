export interface ProjectCrfHistoryClearanceDecision {
  shouldClear: boolean
  patientIds: string[]
  reason: 'full_resubmit' | 'not_full_mode' | 'targeted_extraction' | 'no_submitted_patients'
}

export interface ProjectCrfHistoryClearanceInput {
  mode: string
  targetSections: string[]
  submittedPatientIds: string[]
}

/**
 * 规范化 CRF 抽取模式，避免大小写或空白导致清理策略误判。
 * @param rawMode 接口请求中的 mode 字段。
 * @returns 规范化后的抽取模式。
 */
export function normalizeProjectExtractionMode(rawMode: unknown): string {
  return String(rawMode || 'incremental').trim().toLowerCase() || 'incremental'
}

/**
 * 判定项目 CRF 重抽前是否可以清理旧历史。
 *
 * 只有真正的全量重抽才删除旧 project_crf 实例；增量抽取、靶向字段组抽取、
 * 以及没有成功提交任何任务的请求都必须保留历史，避免失败提交造成数据丢失。
 *
 * @param input 清理策略所需的抽取上下文。
 * @returns 清理决策与实际允许清理的患者列表。
 */
export function decideProjectCrfHistoryClearance(
  input: ProjectCrfHistoryClearanceInput
): ProjectCrfHistoryClearanceDecision {
  const mode = normalizeProjectExtractionMode(input.mode)
  const targetSections = Array.isArray(input.targetSections) ? input.targetSections.filter(Boolean) : []
  const patientIds = Array.isArray(input.submittedPatientIds)
    ? [...new Set(input.submittedPatientIds.map((id) => String(id || '').trim()).filter(Boolean))]
    : []

  if (mode !== 'full') {
    return { shouldClear: false, patientIds: [], reason: 'not_full_mode' }
  }
  if (targetSections.length > 0) {
    return { shouldClear: false, patientIds: [], reason: 'targeted_extraction' }
  }
  if (patientIds.length === 0) {
    return { shouldClear: false, patientIds: [], reason: 'no_submitted_patients' }
  }
  return { shouldClear: true, patientIds, reason: 'full_resubmit' }
}
