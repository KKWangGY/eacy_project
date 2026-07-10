export interface ProjectCrfHistoryClearPolicyInput {
  mode: string
  targetGroups: string[]
  targetSections: string[]
}

/**
 * 判断项目 CRF 抽取是否允许删除已有实例历史。
 *
 * 只有明确的全量重抽才会重建整份 CRF；增量抽取和靶向字段组抽取都必须保留
 * 既有候选值、用户选中值和抽取历史，避免常规补抽把已整理的数据清空。
 */
export function shouldClearProjectCrfHistory(input: ProjectCrfHistoryClearPolicyInput): boolean {
  const mode = String(input.mode || '').trim().toLowerCase()
  return mode === 'full' && input.targetGroups.length === 0 && input.targetSections.length === 0
}
