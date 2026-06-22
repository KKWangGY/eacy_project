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
      page_width: 4000,
      page_height: 5000,
    }),
  },
  {
    source_document_id: 'doc-b',
    source_page: 1,
    source_bbox_json: JSON.stringify({
      bbox: [50, 80, 150, 120],
      page_width: 1200,
      page_height: 1600,
    }),
  },
]

const fallback = buildPageSizeFallback(rows)

assert.deepEqual(
  parseSourceLocationWithFallback(JSON.stringify([10, 20, 30, 40]), 1, 'doc-a', fallback),
  {
    bbox: [10, 20, 30, 40],
    page: 1,
    position: { x: 10, y: 20 },
    page_width: 4000,
    page_height: 5000,
  }
)

assert.deepEqual(
  parseSourceLocationWithFallback(JSON.stringify([10, 20, 30, 40]), 2, 'doc-a', fallback),
  {
    bbox: [10, 20, 30, 40],
    page: 2,
    position: { x: 10, y: 20 },
  }
)

assert.deepEqual(
  parseSourceLocationWithFallback(JSON.stringify([10, 20, 30, 40]), 1, 'doc-c', fallback),
  {
    bbox: [10, 20, 30, 40],
    page: 1,
    position: { x: 10, y: 20 },
  }
)

console.log('ehr page-size fallback tests passed')
