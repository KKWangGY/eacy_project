import assert from 'node:assert/strict'
import { shouldClearProjectCrfHistory } from './src/routes/projects.js'

/**
 * 回归覆盖项目 CRF 历史清理策略，避免增量/定向抽取误删历史数据。
 */
function run() {
  assert.equal(
    shouldClearProjectCrfHistory('full', [], ['patient-1']),
    true,
    '全量重建且已有成功提交任务时才允许清理历史',
  )
  assert.equal(
    shouldClearProjectCrfHistory('incremental', [], ['patient-1']),
    false,
    '默认增量抽取必须保留既有 CRF 历史',
  )
  assert.equal(
    shouldClearProjectCrfHistory('full', ['/基本信息'], ['patient-1']),
    false,
    '定向字段组抽取不能清理全量历史',
  )
  assert.equal(
    shouldClearProjectCrfHistory('full', [], []),
    false,
    '没有成功提交任务时不能清理历史',
  )
}

run()
console.log('project extraction policy tests passed')
