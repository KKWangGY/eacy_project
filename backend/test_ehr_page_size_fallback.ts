import assert from 'node:assert/strict'
import {
  buildPageSizeFallback,
  parseSourceLocationWithFallback,
} from './src/routes/ehrData.ts'

const fallback = buildPageSizeFallback([
  {
    source_document_id: 'doc-a',
    source_page: 1,
    source_bbox_json: JSON.stringify({
      bbox: [10, 20, 110, 120],
      page_width: 1280,
      page_height: 1706,
    }),
  },
  {
    source_document_id: 'doc-b',
    source_page: 1,
    source_bbox_json: JSON.stringify([200, 300, 400, 500]),
  },
])

const sameDoc = parseSourceLocationWithFallback(
  JSON.stringify([200, 300, 400, 500]),
  1,
  'doc-a',
  fallback
) as any

assert.equal(sameDoc.page_width, 1280)
assert.equal(sameDoc.page_height, 1706)

const otherDoc = parseSourceLocationWithFallback(
  JSON.stringify([200, 300, 400, 500]),
  1,
  'doc-b',
  fallback
) as any

assert.equal(otherDoc.page_width, undefined, '不能用其它文档的 OCR 页面宽度回填')
assert.equal(otherDoc.page_height, undefined, '不能用其它文档的 OCR 页面高度回填')

console.log('ehr page size fallback tests passed')
