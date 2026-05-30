/**
 * 科研候选值固化回调的契约测试。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const schemaFormPath = resolve(
  process.cwd(),
  'src/components/SchemaForm/SchemaForm.jsx',
)

test('SchemaForm 应暴露科研候选固化回调入口', () => {
  const content = readFileSync(schemaFormPath, 'utf-8')
  assert.match(content, /onFieldCandidateSolidified/)
  assert.match(
    content,
    /if \(!isDirty && projectMode && typeof onFieldCandidateSolidified === 'function'\)/,
  )
  assert.match(content, /actions\.applyPersistedFieldValue\(fieldPath, value, rowUid\)/)
})
