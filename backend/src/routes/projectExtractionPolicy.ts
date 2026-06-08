/**
 * 归一化项目 CRF 抽取模式，避免大小写或空白让策略判断失效。
 */
export function normalizeProjectExtractionMode(rawMode: unknown): string {
  const mode = String(rawMode || 'incremental').trim().toLowerCase()
  return mode || 'incremental'
}

/**
 * 判断本次项目 CRF 抽取是否允许清空既有物化历史。
 *
 * 只有“完整重跑”才应先废弃旧 CRF 值；增量抽取和定向字段组抽取都必须保留
 * 既有值，等待新候选覆盖对应字段。清理还必须发生在任务已经成功提交之后，
 * 否则 CRF 服务不可用或无可提交文档会造成不可恢复的数据丢失。
 */
export function shouldClearProjectCrfHistory(params: {
  mode: string
  targetSections: string[]
  submittedPatientIds: string[]
}): boolean {
  return (
    normalizeProjectExtractionMode(params.mode) === 'full' &&
    params.targetSections.length === 0 &&
    params.submittedPatientIds.length > 0
  )
}
