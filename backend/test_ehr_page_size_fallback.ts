import assert from 'node:assert/strict'
import {
  buildPageSizeFallback,
  parseSourceLocationWithFallback,
} from './src/routes/ehrData.js'

const rows = [
  {
    source_document_id: 'doc-a',
    source_page: 1,
    source_bbox_json: JSON.stringify({
      bbox: [100, 200, 300, 260],
      page_width: 2400,
      page_height: 3200,
    }),
  },
  {
    source_document_id: 'doc-b',
    source_page: 1,
    source_bbox_json: JSON.stringify({
      bbox: [10, 20, 30, 40],
      page_width: 1200,
      page_height: 1600,
    }),
  },
]

const fallback = buildPageSizeFallback(rows)

const sameDocPage = parseSourceLocationWithFallback(
  JSON.stringify([400, 500, 600, 700]),
  1,
  'doc-a',
  fallback
) as any

assert.equal(sameDocPage.page_width, 2400)
assert.equal(sameDocPage.page_height, 3200)

const otherDoc = parseSourceLocationWithFallback(
  JSON.stringify([400, 500, 600, 700]),
  1,
  'doc-c',
  fallback
) as any

assert.equal(otherDoc.page_width, undefined)
assert.equal(otherDoc.page_height, undefined)

const otherPage = parseSourceLocationWithFallback(
  JSON.stringify([400, 500, 600, 700]),
  2,
  'doc-a',
  fallback
) as any

assert.equal(otherPage.page_width, undefined)
assert.equal(otherPage.page_height, undefined)

console.log('EHR page-size fallback regression passed')
