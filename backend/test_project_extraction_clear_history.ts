import assert from 'node:assert/strict'
import {
  decideProjectCrfHistoryClearance,
  normalizeProjectExtractionMode,
} from './src/routes/projectExtractionPolicy.ts'

assert.equal(normalizeProjectExtractionMode(' FULL '), 'full')
assert.equal(normalizeProjectExtractionMode(''), 'incremental')

assert.deepEqual(
  decideProjectCrfHistoryClearance({
    mode: 'incremental',
    targetSections: [],
    submittedPatientIds: ['patient-1'],
  }),
  {
    shouldClear: false,
    patientIds: [],
    reason: 'not_full_mode',
  }
)

assert.deepEqual(
  decideProjectCrfHistoryClearance({
    mode: 'full',
    targetSections: ['/vitals'],
    submittedPatientIds: ['patient-1'],
  }),
  {
    shouldClear: false,
    patientIds: [],
    reason: 'targeted_extraction',
  }
)

assert.deepEqual(
  decideProjectCrfHistoryClearance({
    mode: 'full',
    targetSections: [],
    submittedPatientIds: [],
  }),
  {
    shouldClear: false,
    patientIds: [],
    reason: 'no_submitted_patients',
  }
)

assert.deepEqual(
  decideProjectCrfHistoryClearance({
    mode: 'full',
    targetSections: [],
    submittedPatientIds: ['patient-1', 'patient-1', ' patient-2 '],
  }),
  {
    shouldClear: true,
    patientIds: ['patient-1', 'patient-2'],
    reason: 'full_resubmit',
  }
)

console.log('project extraction clear-history policy: ok')
