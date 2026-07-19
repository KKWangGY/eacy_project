import assert from 'node:assert/strict'
import {
  buildPageSizeFallback,
  parseSourceLocationWithFallback,
} from './src/routes/ehrData.js'

const rows = [
  {
    source_document_id: 'doc_with_size',
    source_page: 1,
    source_bbox_json: JSON.stringify({
      bbox: [10, 20, 30, 40],
      page_width: 1000,
      page_height: 2000,
    }),
  },
  {
    source_document_id: 'doc_bare_bbox',
    source_page: 1,
    source_bbox_json: JSON.stringify({ bbox: [1, 2, 3, 4] }),
  },
]

const fallback = buildPageSizeFallback(rows)

const crossDocument = parseSourceLocationWithFallback(
  JSON.stringify({ bbox: [1, 2, 3, 4] }),
  1,
  'doc_bare_bbox',
  fallback,
) as any
assert.ok(!crossDocument.page_width)
assert.ok(!crossDocument.page_height)

const sameDocument = parseSourceLocationWithFallback(
  JSON.stringify({ bbox: [1, 2, 3, 4] }),
  1,
  'doc_with_size',
  fallback,
) as any
assert.equal(sameDocument.page_width, 1000)
assert.equal(sameDocument.page_height, 2000)

console.log('source location fallback regression passed')
