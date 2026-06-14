import assert from 'node:assert/strict'
import {
  getProjectCrfHistoryPatientsToClear,
  normalizeProjectExtractionMode,
} from './src/routes/projectExtractionPolicy.ts'

assert.equal(normalizeProjectExtractionMode('full'), 'full')
assert.equal(normalizeProjectExtractionMode(' FULL '), 'full')
assert.equal(normalizeProjectExtractionMode(undefined), 'incremental')
assert.equal(normalizeProjectExtractionMode('unknown'), 'incremental')

assert.deepEqual(
  getProjectCrfHistoryPatientsToClear({
    mode: 'full',
    targetSections: [],
    submittedPatientIds: ['p1', 'p2', 'p1'],
  }),
  ['p1', 'p2']
)

assert.deepEqual(
  getProjectCrfHistoryPatientsToClear({
    mode: 'incremental',
    targetSections: [],
    submittedPatientIds: ['p1'],
  }),
  []
)

assert.deepEqual(
  getProjectCrfHistoryPatientsToClear({
    mode: 'full',
    targetSections: ['基本信息'],
    submittedPatientIds: ['p1'],
  }),
  []
)

assert.deepEqual(
  getProjectCrfHistoryPatientsToClear({
    mode: 'full',
    targetSections: [],
    submittedPatientIds: [],
  }),
  []
)

console.log('projectExtractionPolicy tests passed')
