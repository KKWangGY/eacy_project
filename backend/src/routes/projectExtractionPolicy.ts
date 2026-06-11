export interface ProjectExtractionClearHistoryInput {
  mode: string
  targetSections: string[]
  submittedPatientIds: string[]
}

/**
 * 判断项目 CRF 抽取启动时是否可以清空既有历史。
 *
 * 只有完整重抽且已有任务成功提交给 CRF 服务的患者，才允许删除旧的
 * project_crf 实例数据。增量/靶向抽取需要保留未覆盖字段；提交失败或
 * 无新任务时也不能先删除用户已有结果。
 */
export function shouldClearProjectCrfHistory(input: ProjectExtractionClearHistoryInput): boolean {
  const mode = String(input.mode || '').trim().toLowerCase()
  return (
    mode === 'full' &&
    input.targetSections.length === 0 &&
    input.submittedPatientIds.length > 0
  )
}
