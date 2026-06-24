import assert from 'node:assert/strict'
import {
  buildPageSizeFallback,
  parseSourceLocationWithFallback,
} from './src/routes/ehrData.js'

/**
 * 覆盖旧版裸 bbox 回填策略：
 * - 同一文档同一页的候选可以提供 page_width/page_height；
 * - 不同文档或不同页的候选不能作为兜底，否则 PDF 证据高亮会按错误尺寸缩放。
 */
function run() {
  const rows = [
    {
      source_document_id: 'doc-with-size',
      source_page: 1,
      source_bbox_json: JSON.stringify({
        bbox: [100, 200, 300, 240],
        page_width: 2400,
        page_height: 3200,
      }),
    },
    {
      source_document_id: 'legacy-doc',
      source_page: 1,
      source_bbox_json: JSON.stringify({ bbox: [50, 60, 150, 90] }),
    },
    {
      source_document_id: 'legacy-doc',
      source_page: 2,
      source_bbox_json: JSON.stringify({
        bbox: [10, 20, 110, 80],
        page_width: 1200,
        page_height: 1600,
      }),
    },
  ]

  const fallback = buildPageSizeFallback(rows)
  const sameDocPage = parseSourceLocationWithFallback(
    JSON.stringify({ bbox: [20, 30, 120, 70] }),
    2,
    'legacy-doc',
    fallback
  ) as any
  assert.equal(sameDocPage.page_width, 1200)
  assert.equal(sameDocPage.page_height, 1600)

  const differentDoc = parseSourceLocationWithFallback(
    JSON.stringify({ bbox: [50, 60, 150, 90] }),
    1,
    'legacy-doc',
    fallback
  ) as any
  assert.equal(differentDoc.page_width, null)
  assert.equal(differentDoc.page_height, null)

  const sameDocPageWithSize = parseSourceLocationWithFallback(
    JSON.stringify({ bbox: [50, 60, 150, 90] }),
    1,
    'doc-with-size',
    fallback
  ) as any
  assert.equal(sameDocPageWithSize.page_width, 2400)
  assert.equal(sameDocPageWithSize.page_height, 3200)

  const differentPage = parseSourceLocationWithFallback(
    JSON.stringify({ bbox: [50, 60, 150, 90] }),
    2,
    'doc-with-size',
    fallback
  ) as any
  assert.equal(differentPage.page_width, null)
  assert.equal(differentPage.page_height, null)

  console.log('page-size fallback regression passed')
}

run()
