import assert from 'node:assert/strict'
import { shouldClearProjectCrfHistory } from './src/routes/projects.js'
import { buildPageSizeFallback, parseSourceLocationWithFallback } from './src/routes/ehrData.js'

/**
 * 覆盖高风险回归：项目 CRF 只有明确全量且非靶向时才允许清空历史。
 */
function testProjectCrfClearPolicy() {
  assert.equal(shouldClearProjectCrfHistory('full', []), true)
  assert.equal(shouldClearProjectCrfHistory('full', ['治疗情况']), false)
  assert.equal(shouldClearProjectCrfHistory('incremental', []), false)
  assert.equal(shouldClearProjectCrfHistory('unexpected', []), false)
}

/**
 * 覆盖高风险回归：PDF source tracing 的页面尺寸只能从同文档同页回填。
 */
function testPdfPageSizeFallbackScope() {
  const fallback = buildPageSizeFallback([
    {
      source_document_id: 'doc-a',
      source_page: 1,
      source_bbox_json: JSON.stringify({
        bbox: [10, 20, 30, 40],
        page_width: 1000,
        page_height: 2000,
      }),
    },
    {
      source_document_id: 'doc-b',
      source_page: 1,
      source_bbox_json: JSON.stringify({ bbox: [100, 200, 300, 400] }),
    },
  ])

  const sameDocPage = parseSourceLocationWithFallback(
    JSON.stringify({ bbox: [11, 22, 33, 44] }),
    1,
    'doc-a',
    fallback
  ) as any
  assert.equal(sameDocPage.page_width, 1000)
  assert.equal(sameDocPage.page_height, 2000)

  const otherDoc = parseSourceLocationWithFallback(
    JSON.stringify({ bbox: [100, 200, 300, 400] }),
    1,
    'doc-b',
    fallback
  ) as any
  assert.equal(otherDoc.page_width, undefined)
  assert.equal(otherDoc.page_height, undefined)

  const otherPage = parseSourceLocationWithFallback(
    JSON.stringify({ bbox: [11, 22, 33, 44] }),
    2,
    'doc-a',
    fallback
  ) as any
  assert.equal(otherPage.page_width, undefined)
  assert.equal(otherPage.page_height, undefined)
}

testProjectCrfClearPolicy()
testPdfPageSizeFallbackScope()
console.log('critical regression tests passed')
