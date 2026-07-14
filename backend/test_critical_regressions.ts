import assert from 'node:assert/strict'
import { shouldClearProjectCrfHistory } from './src/utils/projectExtractionPolicy.js'

assert.equal(
  shouldClearProjectCrfHistory('full', [], []),
  true,
  '完整全量重抽允许清空旧项目 CRF 历史'
)

assert.equal(
  shouldClearProjectCrfHistory('incremental', [], []),
  false,
  '增量抽取不能清空旧项目 CRF 历史'
)

assert.equal(
  shouldClearProjectCrfHistory('full', ['实验室检查'], []),
  false,
  '字段组靶向抽取不能清空整份项目 CRF 历史'
)

assert.equal(
  shouldClearProjectCrfHistory('full', [], ['实验室检查']),
  false,
  '已解析为目标章节的靶向抽取不能清空整份项目 CRF 历史'
)

console.log('critical regression policy checks passed')
