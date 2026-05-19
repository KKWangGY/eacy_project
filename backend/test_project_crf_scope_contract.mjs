/**
 * 项目 CRF 可重复字段保存契约测试。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const projectsRoutePath = resolve(process.cwd(), 'src/routes/projects.ts')

test('项目 CRF 保存应创建缺失的可重复 scope，不能静默跳过字段', () => {
  const content = readFileSync(projectsRoutePath, 'utf-8')

  assert.match(content, /function ensureProjectSectionInstance/)
  assert.match(content, /function ensureProjectRowInstance/)
  assert.match(content, /resolveProjectFieldScope\(instanceId, requestedFieldPath, true\)/)
  assert.doesNotMatch(content, /if \(!scope\.resolved\) continue/)
})
