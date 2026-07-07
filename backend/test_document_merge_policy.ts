import assert from 'node:assert/strict'
import { canMergeDocumentIntoPatient } from './src/routes/ehrData.js'

/**
 * 回归覆盖旧版 EHR 合并入口的文档归属校验，避免跨患者污染病历。
 */
function run() {
  assert.equal(
    canMergeDocumentIntoPatient('patient-a', 'patient-a'),
    true,
    '当前患者自己的文档可以合并',
  )
  assert.equal(
    canMergeDocumentIntoPatient('patient-a', 'patient-b'),
    false,
    '其他患者的文档不能合并',
  )
  assert.equal(
    canMergeDocumentIntoPatient(null, 'patient-a'),
    false,
    '未绑定患者的文档不能通过患者病历合并入口写入',
  )
}

run()
console.log('document merge policy tests passed')
