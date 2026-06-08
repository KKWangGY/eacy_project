import assert from 'node:assert/strict'
import {
  normalizeProjectExtractionMode,
  shouldClearProjectCrfHistory,
} from './src/routes/projectExtractionPolicy.js'

assert.equal(normalizeProjectExtractionMode(' Full '), 'full')
assert.equal(normalizeProjectExtractionMode(''), 'incremental')
assert.equal(normalizeProjectExtractionMode(undefined), 'incremental')

assert.equal(
  shouldClearProjectCrfHistory({
    mode: 'incremental',
    targetSections: [],
    submittedPatientIds: ['pat1'],
  }),
  false,
  '增量抽取不得清空既有 CRF 历史'
)

assert.equal(
  shouldClearProjectCrfHistory({
    mode: 'full',
    targetSections: ['基本信息 / 入院信息'],
    submittedPatientIds: ['pat1'],
  }),
  false,
  '定向字段组抽取不得清空其它字段历史'
)

assert.equal(
  shouldClearProjectCrfHistory({
    mode: 'full',
    targetSections: [],
    submittedPatientIds: [],
  }),
  false,
  '没有成功提交任务时不得清空历史'
)

assert.equal(
  shouldClearProjectCrfHistory({
    mode: ' FULL ',
    targetSections: [],
    submittedPatientIds: ['pat1', 'pat2'],
  }),
  true,
  '仅完整重跑且任务已成功提交时才允许清空历史'
)

console.log('project extraction clear-history policy tests passed')
