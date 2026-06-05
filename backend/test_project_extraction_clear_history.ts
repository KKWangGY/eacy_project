import assert from 'node:assert/strict'
import { shouldClearProjectCrfHistory } from './src/routes/projects.js'

/**
 * 回归验证项目 CRF 抽取的历史清理门槛。
 *
 * 历史数据只能在“全量重抽”且 CRF 服务已经成功返回新 job 后清理；
 * 增量抽取、提交失败或无可提交文档都必须保留现有 CRF 数据。
 */
function run() {
  assert.equal(
    shouldClearProjectCrfHistory('incremental', ['job-1']),
    false,
    '增量抽取不应清理已有 CRF 历史'
  )
  assert.equal(
    shouldClearProjectCrfHistory('full', []),
    false,
    '全量抽取在没有成功提交 job 时不应清理历史'
  )
  assert.equal(
    shouldClearProjectCrfHistory('full', ['job-1']),
    true,
    '全量抽取且已有成功提交 job 时才允许清理历史'
  )
  assert.equal(
    shouldClearProjectCrfHistory('FULL', ['job-1']),
    true,
    '抽取模式大小写不应影响全量清理判定'
  )
}

run()
