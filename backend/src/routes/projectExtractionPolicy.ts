export type ProjectExtractionMode = 'full' | 'incremental'

export interface ProjectCrfHistoryClearPolicyInput {
  mode: string
  targetSections: string[]
  submittedPatientIds: string[]
}

/**
 * 规范化项目抽取模式，未知值按增量抽取处理以保护既有人工修订数据。
 */
export function normalizeProjectExtractionMode(mode: unknown): ProjectExtractionMode {
  const normalized = String(mode ?? '').trim().toLowerCase()
  return normalized === 'full' ? 'full' : 'incremental'
}

/**
 * 仅全量项目重抽、无靶向字段组、且患者已有成功提交 job 时才允许清理历史。
 */
export function shouldClearProjectCrfHistory(input: ProjectCrfHistoryClearPolicyInput): boolean {
  return (
    normalizeProjectExtractionMode(input.mode) === 'full' &&
    input.targetSections.length === 0 &&
    input.submittedPatientIds.length > 0
  )
}
