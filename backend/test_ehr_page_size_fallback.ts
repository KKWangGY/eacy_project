import assert from 'node:assert/strict'
import {
  buildPageSizeFallback,
  parseSourceLocationWithFallback,
} from './src/utils/sourceLocation.js'

/**
 * 回归验证 PDF 溯源坐标尺寸回填策略：
 * 只能使用同一 source_document_id + source_page 的兄弟候选尺寸。
 */
function run() {
  const rows = [
    {
      source_document_id: 'doc-a',
      source_page: 1,
      source_bbox_json: JSON.stringify([100, 200, 300, 400]),
    },
    {
      source_document_id: 'doc-a',
      source_page: 2,
      source_bbox_json: JSON.stringify({ bbox: [10, 20, 30, 40], page_width: 2000, page_height: 4000 }),
    },
    {
      source_document_id: 'doc-b',
      source_page: 1,
      source_bbox_json: JSON.stringify({ bbox: [50, 60, 70, 80], page_width: 1200, page_height: 2400 }),
    },
    {
      source_document_id: 'doc-c',
      source_page: 1,
      source_bbox_json: JSON.stringify([500, 600, 700, 800]),
    },
    {
      source_document_id: 'doc-d',
      source_page: 3,
      source_bbox_json: JSON.stringify({ bbox: [1, 2, 3, 4], page_width: 1600, page_height: 3200 }),
    },
    {
      source_document_id: 'doc-d',
      source_page: 3,
      source_bbox_json: JSON.stringify([100, 200, 300, 400]),
    },
  ]

  const fallback = buildPageSizeFallback(rows)

  const crossPage = parseSourceLocationWithFallback(rows[0].source_bbox_json, 1, 'doc-a', fallback) as any
  assert.equal(crossPage.page_width, undefined)
  assert.equal(crossPage.page_height, undefined)

  const crossDocument = parseSourceLocationWithFallback(rows[3].source_bbox_json, 1, 'doc-c', fallback) as any
  assert.equal(crossDocument.page_width, undefined)
  assert.equal(crossDocument.page_height, undefined)

  const sameDocPage = parseSourceLocationWithFallback(rows[5].source_bbox_json, 3, 'doc-d', fallback) as any
  assert.equal(sameDocPage.page_width, 1600)
  assert.equal(sameDocPage.page_height, 3200)

  const existingDimensions = parseSourceLocationWithFallback(rows[2].source_bbox_json, 1, 'doc-b', fallback) as any
  assert.equal(existingDimensions.page_width, 1200)
  assert.equal(existingDimensions.page_height, 2400)

  console.log('ok: EHR page size fallback is constrained to exact document/page matches')
}

run()
