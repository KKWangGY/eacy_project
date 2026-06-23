import assert from 'node:assert/strict'
import {
  buildPageSizeFallback,
  parseSourceLocationWithFallback,
} from './src/utils/sourceLocation.js'

const rows = [
  {
    source_document_id: 'doc-a',
    source_page: 1,
    source_bbox_json: JSON.stringify({
      bbox: [100, 200, 300, 240],
      page_width: 2000,
      page_height: 3000,
    }),
  },
  {
    source_document_id: 'doc-b',
    source_page: 1,
    source_bbox_json: JSON.stringify([500, 700, 900, 760]),
  },
  {
    source_document_id: 'doc-a',
    source_page: 2,
    source_bbox_json: JSON.stringify([50, 80, 120, 110]),
  },
  {
    source_document_id: 'doc-a',
    source_page: 1,
    source_bbox_json: JSON.stringify([400, 600, 500, 660]),
  },
]

const fallback = buildPageSizeFallback(rows)

const sameDocPage = parseSourceLocationWithFallback(
  rows[3].source_bbox_json,
  rows[3].source_page,
  rows[3].source_document_id,
  fallback
) as any

assert.equal(sameDocPage.page_width, 2000)
assert.equal(sameDocPage.page_height, 3000)

const differentDoc = parseSourceLocationWithFallback(
  rows[1].source_bbox_json,
  rows[1].source_page,
  rows[1].source_document_id,
  fallback
) as any

assert.equal(differentDoc.page_width, undefined)
assert.equal(differentDoc.page_height, undefined)

const differentPage = parseSourceLocationWithFallback(
  rows[2].source_bbox_json,
  rows[2].source_page,
  rows[2].source_document_id,
  fallback
) as any

assert.equal(differentPage.page_width, undefined)
assert.equal(differentPage.page_height, undefined)

console.log('ehr page size fallback regression passed')
