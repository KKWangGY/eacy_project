import assert from 'node:assert/strict'
import { shouldClearProjectCrfHistory } from './src/routes/projectExtractionPolicy.js'

/**
 * 锁定项目 CRF 抽取历史清理策略，避免任务提交失败或局部抽取误删既有结果。
 */
function run() {
  assert.equal(
    shouldClearProjectCrfHistory({
      mode: 'incremental',
      targetSections: [],
      submittedPatientIds: ['patient-1'],
    }),
    false,
    '增量抽取必须保留已有 CRF 历史'
  )

  assert.equal(
    shouldClearProjectCrfHistory({
      mode: 'full',
      targetSections: ['基本信息'],
      submittedPatientIds: ['patient-1'],
    }),
    false,
    '靶向抽取必须保留未覆盖字段的历史'
  )

  assert.equal(
    shouldClearProjectCrfHistory({
      mode: 'full',
      targetSections: [],
      submittedPatientIds: [],
    }),
    false,
    '未成功提交任务时不能清理历史'
  )

  assert.equal(
    shouldClearProjectCrfHistory({
      mode: ' full ',
      targetSections: [],
      submittedPatientIds: ['patient-1'],
    }),
    true,
    '完整重抽且提交成功后才允许清理目标患者历史'
  )
}

run()
