import assert from 'node:assert/strict'
import {
  buildPageSizeFallback,
  parseSourceLocationWithFallback,
} from './src/routes/ehrData.js'

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
    source_bbox_json: JSON.stringify({
      bbox: [50, 60, 70, 80],
      page_width: 3000,
      page_height: 4000,
    }),
  },
])

const sameDocPage = parseSourceLocationWithFallback(
  JSON.stringify([100, 200, 300, 400]),
  1,
  'doc-a',
  fallback
) as any

assert.equal(sameDocPage.page_width, 1000)
assert.equal(sameDocPage.page_height, 2000)

const differentDoc = parseSourceLocationWithFallback(
  JSON.stringify([100, 200, 300, 400]),
  1,
  'doc-c',
  fallback
) as any

assert.equal(differentDoc.page_width, undefined)
assert.equal(differentDoc.page_height, undefined)

const differentPage = parseSourceLocationWithFallback(
  JSON.stringify([100, 200, 300, 400]),
  2,
  'doc-a',
  fallback
) as any

assert.equal(differentPage.page_width, undefined)
assert.equal(differentPage.page_height, undefined)

console.log('ehr page-size fallback policy ok')
