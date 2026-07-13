import assert from 'node:assert/strict'
import {
  buildPageSizeFallback,
  parseSourceLocationWithFallback,
} from './src/routes/ehrData.js'

const bareBbox = JSON.stringify([100, 200, 300, 400])
const sizedBbox = JSON.stringify({
  bbox: [10, 20, 30, 40],
  page_width: 4344,
  page_height: 5792,
})

const fallback = buildPageSizeFallback([
  {
    source_document_id: 'docB',
    source_page: 1,
    source_bbox_json: sizedBbox,
  },
  {
    source_document_id: 'docA',
    source_page: 1,
    source_bbox_json: bareBbox,
  },
])

const crossDocumentLocation = parseSourceLocationWithFallback(
  bareBbox,
  1,
  'docA',
  fallback
) as any

assert.deepEqual(crossDocumentLocation.bbox, [100, 200, 300, 400])
assert.equal(crossDocumentLocation.page_width, undefined)
assert.equal(crossDocumentLocation.page_height, undefined)

const sameDocumentFallback = buildPageSizeFallback([
  {
    source_document_id: 'docA',
    source_page: 1,
    source_bbox_json: sizedBbox,
  },
  {
    source_document_id: 'docA',
    source_page: 1,
    source_bbox_json: bareBbox,
  },
])

const sameDocumentLocation = parseSourceLocationWithFallback(
  bareBbox,
  1,
  'docA',
  sameDocumentFallback
) as any

assert.equal(sameDocumentLocation.page_width, 4344)
assert.equal(sameDocumentLocation.page_height, 5792)

console.log('source location fallback regression passed')
