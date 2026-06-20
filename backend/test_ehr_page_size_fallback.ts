import assert from 'node:assert/strict'
import {
  buildPageSizeFallback,
  parseSourceLocationWithFallback,
} from './src/routes/ehrData.ts'

function bboxJson(value: unknown): string {
  return JSON.stringify(value)
}

const rows = [
  {
    source_document_id: 'doc-a',
    source_page: 1,
    source_bbox_json: bboxJson({
      bbox: [100, 120, 300, 360],
      page_width: 2000,
      page_height: 3000,
    }),
  },
  {
    source_document_id: 'doc-a',
    source_page: 1,
    source_bbox_json: bboxJson([400, 500, 600, 700]),
  },
  {
    source_document_id: 'doc-a',
    source_page: 2,
    source_bbox_json: bboxJson([40, 50, 60, 70]),
  },
  {
    source_document_id: 'doc-b',
    source_page: 1,
    source_bbox_json: bboxJson([800, 900, 1000, 1100]),
  },
]

const fallback = buildPageSizeFallback(rows)

const sameDocPage = parseSourceLocationWithFallback(
  bboxJson([400, 500, 600, 700]),
  1,
  'doc-a',
  fallback
) as any
assert.equal(sameDocPage.page_width, 2000)
assert.equal(sameDocPage.page_height, 3000)

const differentPage = parseSourceLocationWithFallback(
  bboxJson([40, 50, 60, 70]),
  2,
  'doc-a',
  fallback
) as any
assert.equal(differentPage.page_width, undefined)
assert.equal(differentPage.page_height, undefined)

const differentDocument = parseSourceLocationWithFallback(
  bboxJson([800, 900, 1000, 1100]),
  1,
  'doc-b',
  fallback
) as any
assert.equal(differentDocument.page_width, undefined)
assert.equal(differentDocument.page_height, undefined)

console.log('ehr page-size fallback policy ok')
