import assert from 'node:assert/strict'
import {
  buildPageSizeFallback,
  parseSourceLocationWithFallback,
} from './src/routes/ehrDataPageSizeFallback.js'

const rows = [
  {
    source_document_id: 'doc-a',
    source_page: 1,
    source_bbox_json: JSON.stringify({
      bbox: [10, 20, 200, 300],
      page_width: 1280,
      page_height: 1706,
    }),
  },
  {
    source_document_id: 'doc-b',
    source_page: 1,
    source_bbox_json: JSON.stringify([1200, 1600, 1500, 1700]),
  },
  {
    source_document_id: 'doc-a',
    source_page: 1,
    source_bbox_json: JSON.stringify([30, 40, 50, 60]),
  },
]

const fallback = buildPageSizeFallback(rows)

const sameDocument = parseSourceLocationWithFallback(
  rows[2].source_bbox_json,
  rows[2].source_page,
  rows[2].source_document_id,
  fallback
) as any

assert.equal(sameDocument.page_width, 1280)
assert.equal(sameDocument.page_height, 1706)

const otherDocument = parseSourceLocationWithFallback(
  rows[1].source_bbox_json,
  rows[1].source_page,
  rows[1].source_document_id,
  fallback
) as any

assert.deepEqual(otherDocument.bbox, [1200, 1600, 1500, 1700])
assert.equal(otherDocument.page_width, undefined)
assert.equal(otherDocument.page_height, undefined)

console.log('ehr page-size fallback regression passed')
