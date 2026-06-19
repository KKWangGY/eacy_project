import assert from 'node:assert/strict'
import { shouldClearProjectCrfHistory } from './src/routes/projects.js'

/**
 * 回归测试项目 CRF 历史清理策略，防止增量、靶向或未提交任务时清空既有数据。
 */
function run() {
  assert.equal(shouldClearProjectCrfHistory('incremental', [], ['patient-a']), false)
  assert.equal(shouldClearProjectCrfHistory('full', ['检查信息'], ['patient-a']), false)
  assert.equal(shouldClearProjectCrfHistory('full', [], []), false)
  assert.equal(shouldClearProjectCrfHistory('FULL', [], ['patient-a']), true)
  console.log('project extraction clear policy ok')
}

run()
