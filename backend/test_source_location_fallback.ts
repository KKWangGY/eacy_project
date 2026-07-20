import assert from 'node:assert/strict'
import { buildPageSizeFallback, parseSourceLocationWithFallback } from './src/routes/ehrData'

const rows = [
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
    source_bbox_json: JSON.stringify({
      bbox: [30, 40, 130, 140],
    }),
  },
]

const fallback = buildPageSizeFallback(rows)

const sameDocument = parseSourceLocationWithFallback(
  JSON.stringify({ bbox: [50, 60, 150, 160] }),
  1,
  'doc-a',
  fallback
) as any

assert.equal(sameDocument.page_width, 1280)
assert.equal(sameDocument.page_height, 1706)

const differentDocument = parseSourceLocationWithFallback(
  JSON.stringify({ bbox: [30, 40, 130, 140] }),
  1,
  'doc-b',
  fallback
) as any

assert.equal(differentDocument.page_width, null)
assert.equal(differentDocument.page_height, null)

const differentPage = parseSourceLocationWithFallback(
  JSON.stringify({ bbox: [70, 80, 170, 180] }),
  2,
  'doc-a',
  fallback
) as any

assert.equal(differentPage.page_width, null)
assert.equal(differentPage.page_height, null)

console.log('source location fallback regression checks passed')
