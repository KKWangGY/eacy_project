import assert from 'node:assert/strict'
import { __ehrDataTest } from './src/routes/ehrData.js'

/**
 * 回归测试 source bbox 尺寸回填，防止把其它文档的 OCR 坐标系套给当前证据。
 */
function run() {
  const fallback = __ehrDataTest.buildPageSizeFallback([
    {
      source_document_id: 'doc-a',
      source_page: 1,
      source_bbox_json: JSON.stringify({ bbox: [10, 20, 30, 40] }),
    },
    {
      source_document_id: 'doc-b',
      source_page: 1,
      source_bbox_json: JSON.stringify({
        bbox: [100, 200, 300, 400],
        page_width: 2000,
        page_height: 3000,
      }),
    },
  ])

  const docALoc = __ehrDataTest.parseSourceLocationWithFallback(
    JSON.stringify({ bbox: [10, 20, 30, 40] }),
    1,
    'doc-a',
    fallback
  ) as any
  assert.equal(docALoc.page_width, undefined)
  assert.equal(docALoc.page_height, undefined)

  const docBLoc = __ehrDataTest.parseSourceLocationWithFallback(
    JSON.stringify({ bbox: [100, 200, 300, 400] }),
    1,
    'doc-b',
    fallback
  ) as any
  assert.equal(docBLoc.page_width, 2000)
  assert.equal(docBLoc.page_height, 3000)
  console.log('ehr page size fallback ok')
}

run()
