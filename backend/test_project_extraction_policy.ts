import assert from 'node:assert/strict'
import {
  normalizeProjectExtractionMode,
  shouldClearProjectCrfHistory,
} from './src/routes/projectExtractionPolicy.js'

assert.equal(normalizeProjectExtractionMode('full'), 'full')
assert.equal(normalizeProjectExtractionMode('FULL'), 'full')
assert.equal(normalizeProjectExtractionMode('incremental'), 'incremental')
assert.equal(normalizeProjectExtractionMode('unexpected'), 'incremental')
assert.equal(normalizeProjectExtractionMode(undefined), 'incremental')

assert.equal(
  shouldClearProjectCrfHistory({
    mode: 'incremental',
    targetSections: [],
    submittedPatientIds: ['patient-1'],
  }),
  false,
)

assert.equal(
  shouldClearProjectCrfHistory({
    mode: 'full',
    targetSections: ['基本信息'],
    submittedPatientIds: ['patient-1'],
  }),
  false,
)

assert.equal(
  shouldClearProjectCrfHistory({
    mode: 'full',
    targetSections: [],
    submittedPatientIds: [],
  }),
  false,
)

assert.equal(
  shouldClearProjectCrfHistory({
    mode: 'full',
    targetSections: [],
    submittedPatientIds: ['patient-1'],
  }),
  true,
)
