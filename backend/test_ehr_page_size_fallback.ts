import assert from 'node:assert/strict'
import {
  buildPageSizeFallback,
  parseSourceLocationWithFallback,
} from './src/routes/ehrData.js'

/**
 * 验证旧版裸 bbox 只能使用同文档同页的 OCR 页面尺寸回填。
 * 跨文档回填会把 PDF 溯源红框缩放到错误位置。
 */
function run() {
  const rows = [
    {
      source_document_id: 'docA',
      source_page: 1,
      source_bbox_json: JSON.stringify([100, 200, 300, 400]),
    },
    {
      source_document_id: 'docB',
      source_page: 1,
      source_bbox_json: JSON.stringify({
        bbox: [10, 20, 30, 40],
        page_width: 4344,
        page_height: 5792,
      }),
    },
    {
      source_document_id: 'docA',
      source_page: 2,
      source_bbox_json: JSON.stringify({
        bbox: [50, 60, 70, 80],
        page_width: 2000,
        page_height: 3000,
      }),
    },
  ]

  const fallback = buildPageSizeFallback(rows)
  const docABarePage1 = parseSourceLocationWithFallback(
    JSON.stringify([100, 200, 300, 400]),
    1,
    'docA',
    fallback
  ) as any

  assert.equal(docABarePage1.page_width, undefined)
  assert.equal(docABarePage1.page_height, undefined)

  const docABarePage2 = parseSourceLocationWithFallback(
    JSON.stringify([100, 200, 300, 400]),
    2,
    'docA',
    fallback
  ) as any

  assert.equal(docABarePage2.page_width, 2000)
  assert.equal(docABarePage2.page_height, 3000)
}

run()
console.log('ehr page size fallback regression passed')
