import assert from 'node:assert/strict'
import {
  buildPageSizeFallback,
  parseSourceLocationWithFallback,
} from './src/routes/ehrData.js'

const rows = [
  {
    source_document_id: 'doc-a',
    source_page: 1,
    source_bbox_json: JSON.stringify([10, 20, 30, 40]),
  },
  {
    source_document_id: 'doc-b',
    source_page: 1,
    source_bbox_json: JSON.stringify({
      bbox: [100, 120, 180, 220],
      page_width: 2000,
      page_height: 3000,
    }),
  },
  {
    source_document_id: 'doc-a',
    source_page: 2,
    source_bbox_json: JSON.stringify({
      bbox: [50, 60, 70, 80],
      page_width: 1111,
      page_height: 2222,
    }),
  },
  {
    source_document_id: 'doc-a',
    source_page: 1,
    source_bbox_json: JSON.stringify({
      bbox: [15, 25, 35, 45],
      page_width: 1234,
      page_height: 5678,
    }),
  },
]

const fallback = buildPageSizeFallback(rows)

const sameDocSamePage = parseSourceLocationWithFallback(
  JSON.stringify([10, 20, 30, 40]),
  1,
  'doc-a',
  fallback
) as any

assert.equal(sameDocSamePage.page_width, 1234)
assert.equal(sameDocSamePage.page_height, 5678)

const differentDoc = parseSourceLocationWithFallback(
  JSON.stringify([10, 20, 30, 40]),
  1,
  'doc-c',
  fallback
) as any

assert.equal(differentDoc.page_width, undefined)
assert.equal(differentDoc.page_height, undefined)

const sameDocDifferentPage = parseSourceLocationWithFallback(
  JSON.stringify([10, 20, 30, 40]),
  3,
  'doc-a',
  fallback
) as any

assert.equal(sameDocDifferentPage.page_width, undefined)
assert.equal(sameDocDifferentPage.page_height, undefined)

console.log('EHR page-size fallback regression passed')
