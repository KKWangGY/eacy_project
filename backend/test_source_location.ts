import assert from 'node:assert/strict'
import {
  buildPageSizeFallback,
  parseSourceLocationWithFallback,
} from './src/utils/sourceLocation.js'

function run() {
  const rows = [
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
  ]
  const fallback = buildPageSizeFallback(rows)

  const sameDoc = parseSourceLocationWithFallback(
    JSON.stringify([1, 2, 3, 4]),
    1,
    'doc-a',
    fallback
  ) as any
  assert.equal(sameDoc.page_width, 1000)
  assert.equal(sameDoc.page_height, 2000)

  const crossDoc = parseSourceLocationWithFallback(
    JSON.stringify([1, 2, 3, 4]),
    2,
    'doc-a',
    fallback
  ) as any
  assert.equal(crossDoc.page_width, undefined)
  assert.equal(crossDoc.page_height, undefined)

  const unknownDoc = parseSourceLocationWithFallback(
    JSON.stringify([1, 2, 3, 4]),
    1,
    'doc-c',
    fallback
  ) as any
  assert.equal(unknownDoc.page_width, undefined)
  assert.equal(unknownDoc.page_height, undefined)
}

run()
console.log('source location fallback policy ok')
