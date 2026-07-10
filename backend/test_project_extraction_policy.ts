import assert from 'node:assert/strict'
import { shouldClearProjectCrfHistory } from './src/utils/projectExtractionPolicy.js'

function run() {
  assert.equal(
    shouldClearProjectCrfHistory({ mode: 'incremental', targetGroups: [], targetSections: [] }),
    false,
    'incremental extraction must preserve existing CRF history',
  )

  assert.equal(
    shouldClearProjectCrfHistory({ mode: '', targetGroups: [], targetSections: [] }),
    false,
    'default/blank mode must be non-destructive',
  )

  assert.equal(
    shouldClearProjectCrfHistory({ mode: 'full', targetGroups: ['人口学'], targetSections: ['人口学情况'] }),
    false,
    'targeted extraction must not clear the whole CRF instance',
  )

  assert.equal(
    shouldClearProjectCrfHistory({ mode: ' FULL ', targetGroups: [], targetSections: [] }),
    true,
    'explicit full extraction without targets may rebuild CRF history',
  )
}

run()
console.log('project extraction policy tests passed')
