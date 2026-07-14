/**
 * 仅完整全量重抽才允许清空旧的项目 CRF 物化结果。
 */
export function shouldClearProjectCrfHistory(mode: string, targetGroups: string[], targetSections: string[]): boolean {
  const normalizedMode = String(mode || '').trim().toLowerCase()
  return normalizedMode === 'full' && targetGroups.length === 0 && targetSections.length === 0
}
