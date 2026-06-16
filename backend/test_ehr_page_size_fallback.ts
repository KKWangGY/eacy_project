import assert from 'node:assert/strict'
import { buildPageSizeFallback, parseSourceLocationWithFallback } from './src/routes/ehrDataPageSizeFallback.js'

const rows = [
  {
    source_document_id: 'doc-a',
    source_page: 2,
    source_bbox_json: JSON.stringify({
      bbox: [10, 20, 110, 120],
      page_width: 4000,
      page_height: 5000,
    }),
  },
  {
    source_document_id: 'doc-b',
    source_page: 1,
    source_bbox_json: JSON.stringify({
      bbox: [5, 6, 50, 60],
      page_width: 900,
      page_height: 1200,
    }),
  },
]

const fallback = buildPageSizeFallback(rows)

/**
 * 旧版裸 bbox 只能从完全相同的文档与页码继承 OCR 原图尺寸。
 */
const sameDocSamePage = parseSourceLocationWithFallback(
  JSON.stringify([1, 2, 3, 4]),
  2,
  'doc-a',
  fallback
) as any

assert.equal(sameDocSamePage.page_width, 4000)
assert.equal(sameDocSamePage.page_height, 5000)

/**
 * 不同文档或不同页的尺寸不能作为兜底，否则会把其它 PDF 的坐标系套到当前红框。
 */
const differentDoc = parseSourceLocationWithFallback(
  JSON.stringify([1, 2, 3, 4]),
  2,
  'doc-c',
  fallback
) as any
const sameDocDifferentPage = parseSourceLocationWithFallback(
  JSON.stringify([1, 2, 3, 4]),
  3,
  'doc-a',
  fallback
) as any

assert.equal(differentDoc.page_width, undefined)
assert.equal(differentDoc.page_height, undefined)
assert.equal(sameDocDifferentPage.page_width, undefined)
assert.equal(sameDocDifferentPage.page_height, undefined)

console.log('ehr page-size fallback tests passed')
