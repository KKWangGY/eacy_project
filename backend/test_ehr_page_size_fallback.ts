import assert from 'node:assert/strict'
import {
  buildPageSizeFallback,
  parseSourceLocationWithFallback,
} from './src/routes/ehrData.js'

/**
 * 回归验证：同字段候选可能来自多个文档，裸 bbox 只能继承同文档同页的页面尺寸。
 */
function run() {
  const rows = [
    {
      source_document_id: 'doc-a',
      source_page: 1,
      source_bbox_json: JSON.stringify({
        bbox: [100, 200, 300, 400],
        page_width: 1280,
        page_height: 1706,
      }),
    },
    {
      source_document_id: 'doc-b',
      source_page: 1,
      source_bbox_json: JSON.stringify({ bbox: [10, 20, 30, 40] }),
    },
    {
      source_document_id: 'doc-a',
      source_page: 1,
      source_bbox_json: JSON.stringify({ bbox: [500, 600, 700, 800] }),
    },
  ]

  const fallback = buildPageSizeFallback(rows)

  const sameDoc = parseSourceLocationWithFallback(
    JSON.stringify({ bbox: [500, 600, 700, 800] }),
    1,
    'doc-a',
    fallback
  ) as any
  assert.equal(sameDoc.page_width, 1280)
  assert.equal(sameDoc.page_height, 1706)

  const otherDoc = parseSourceLocationWithFallback(
    JSON.stringify({ bbox: [10, 20, 30, 40] }),
    1,
    'doc-b',
    fallback
  ) as any
  assert.equal(otherDoc.page_width, null)
  assert.equal(otherDoc.page_height, null)

  console.log('ehr page-size fallback regression passed')
}

run()
