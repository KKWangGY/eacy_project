import assert from 'node:assert/strict'
import {
  buildPageSizeFallback,
  parseSourceLocationWithFallback,
} from './src/routes/ehrData.js'

/**
 * 验证 PDF 溯源尺寸回填只能使用同文档同页的 OCR 原图尺寸。
 */
function run() {
  const rows = [
    {
      source_document_id: 'doc-a',
      source_page: 1,
      source_bbox_json: JSON.stringify({ bbox: [100, 200, 300, 400], page_width: 1000, page_height: 2000 }),
    },
    {
      source_document_id: 'doc-b',
      source_page: 1,
      source_bbox_json: JSON.stringify({ bbox: [10, 20, 30, 40] }),
    },
    {
      source_document_id: 'doc-c',
      source_page: 2,
      source_bbox_json: JSON.stringify({ bbox: [50, 60, 70, 80], page_width: 3000, page_height: 4000 }),
    },
  ]

  const fallback = buildPageSizeFallback(rows)

  const sameDocPage = parseSourceLocationWithFallback(
    JSON.stringify({ bbox: [110, 210, 310, 410] }),
    1,
    'doc-a',
    fallback
  ) as any
  assert.equal(sameDocPage.page_width, 1000)
  assert.equal(sameDocPage.page_height, 2000)

  const otherDocSamePage = parseSourceLocationWithFallback(
    JSON.stringify({ bbox: [10, 20, 30, 40] }),
    1,
    'doc-b',
    fallback
  ) as any
  assert.equal(otherDocSamePage.page_width, null)
  assert.equal(otherDocSamePage.page_height, null)

  const sameDocDifferentPage = parseSourceLocationWithFallback(
    JSON.stringify({ bbox: [10, 20, 30, 40] }),
    2,
    'doc-a',
    fallback
  ) as any
  assert.equal(sameDocDifferentPage.page_width, null)
  assert.equal(sameDocDifferentPage.page_height, null)
}

run()
console.log('test_ehr_page_size_fallback passed')
