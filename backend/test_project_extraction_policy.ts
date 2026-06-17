import assert from 'node:assert/strict'
import { shouldClearProjectCrfHistory } from './src/routes/projects.ts'

assert.equal(
  shouldClearProjectCrfHistory({ mode: 'incremental', targetSections: [] }),
  false,
  '增量抽取不能清空既有项目 CRF 历史'
)

assert.equal(
  shouldClearProjectCrfHistory({ mode: 'full', targetSections: ['/入院记录'] }),
  false,
  '靶向抽取不能清空完整项目 CRF 历史'
)

assert.equal(
  shouldClearProjectCrfHistory({ mode: 'full', targetSections: [] }),
  true,
  '只有非靶向 full 重跑才允许清空旧项目 CRF 历史'
)

console.log('project extraction policy tests passed')
