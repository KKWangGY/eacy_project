import assert from 'node:assert/strict'
import { buildPageSizeFallback, parseSourceLocationWithFallback } from './src/routes/ehrData.js'

const rows = [
  {
    source_document_id: 'doc-a',
    source_page: 1,
    source_bbox_json: JSON.stringify({
      bbox: [100, 200, 300, 260],
      page_width: 1280,
      page_height: 1706,
    }),
  },
  {
    source_document_id: 'doc-b',
    source_page: 1,
    source_bbox_json: JSON.stringify({
      bbox: [200, 400, 600, 520],
      page_width: 2560,
      page_height: 3412,
    }),
  },
]

const fallback = buildPageSizeFallback(rows)

const sameDocumentLocation = parseSourceLocationWithFallback(
  JSON.stringify([120, 240, 320, 300]),
  1,
  'doc-a',
  fallback
) as any

assert.equal(sameDocumentLocation.page_width, 1280)
assert.equal(sameDocumentLocation.page_height, 1706)

const differentDocumentLocation = parseSourceLocationWithFallback(
  JSON.stringify([120, 240, 320, 300]),
  1,
  'doc-c',
  fallback
) as any

assert.equal(differentDocumentLocation.page_width, undefined)
assert.equal(differentDocumentLocation.page_height, undefined)

console.log('ehr page size fallback regression passed')
