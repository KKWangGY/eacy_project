import assert from 'node:assert/strict'
import { buildPageSizeFallback, parseSourceLocationWithFallback } from './src/routes/ehrData.js'

/**
 * 验证裸 bbox 只会从同一文档同一页的兄弟候选回填 OCR 原图尺寸。
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
      source_bbox_json: JSON.stringify([10, 20, 30, 40]),
    },
    {
      source_document_id: 'doc-c',
      source_page: 2,
      source_bbox_json: JSON.stringify({
        bbox: [50, 60, 70, 80],
        page_width: 2560,
        page_height: 3412,
      }),
    },
    {
      source_document_id: 'doc-c',
      source_page: 2,
      source_bbox_json: JSON.stringify([11, 22, 33, 44]),
    },
  ]

  const fallback = buildPageSizeFallback(rows)

  const crossDoc = parseSourceLocationWithFallback(
    JSON.stringify([10, 20, 30, 40]),
    1,
    'doc-b',
    fallback
  ) as any
  assert.equal(crossDoc.page_width, undefined)
  assert.equal(crossDoc.page_height, undefined)

  const sameDocPage = parseSourceLocationWithFallback(
    JSON.stringify([11, 22, 33, 44]),
    2,
    'doc-c',
    fallback
  ) as any
  assert.equal(sameDocPage.page_width, 2560)
  assert.equal(sameDocPage.page_height, 3412)
}

run()
console.log('test_ehr_page_size_fallback passed')
