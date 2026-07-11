/**
 * 判断项目 CRF 重抽是否允许删除旧的物化历史。
 *
 * 只有全量、非定向抽取，并且至少有患者任务已经成功提交时，才清理这些患者的旧历史。
 * 增量或定向抽取必须保留既有字段，否则失败/跳过会造成静默数据丢失。
 */
export function shouldClearProjectCrfHistory(params: {
  mode: string
  targetSections: string[]
  submittedPatientIds: string[]
}): boolean {
  const normalizedMode = String(params.mode || '').trim().toLowerCase()
  return normalizedMode === 'full' &&
    params.targetSections.length === 0 &&
    params.submittedPatientIds.length > 0
}
