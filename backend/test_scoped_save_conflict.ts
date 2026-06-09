import assert from 'assert'
import http from 'http'
import { randomUUID } from 'crypto'
import app from './src/app.js'
import db from './src/db.js'

type JsonResponse = {
  success?: boolean
  code?: number
  message?: string
  data?: any
}

const suffix = randomUUID()
const ids = {
  patient: `test-patient-${suffix}`,
  schema: `test-schema-${suffix}`,
  ehrInstance: `test-ehr-instance-${suffix}`,
  project: `test-project-${suffix}`,
  enrollment: `test-enrollment-${suffix}`,
  projectInstance: `test-project-instance-${suffix}`,
}

/**
 * 删除本测试创建的固定 ID 数据，避免测试失败后污染本地数据库。
 */
function cleanup() {
  db.prepare(`DELETE FROM field_value_selected WHERE instance_id IN (?, ?)`).run(ids.ehrInstance, ids.projectInstance)
  db.prepare(`DELETE FROM field_value_candidates WHERE instance_id IN (?, ?)`).run(ids.ehrInstance, ids.projectInstance)
  db.prepare(`DELETE FROM schema_instances WHERE id IN (?, ?)`).run(ids.ehrInstance, ids.projectInstance)
  db.prepare(`DELETE FROM project_patients WHERE id = ?`).run(ids.enrollment)
  db.prepare(`DELETE FROM projects WHERE id = ?`).run(ids.project)
  db.prepare(`DELETE FROM patients WHERE id = ?`).run(ids.patient)
  db.prepare(`DELETE FROM schemas WHERE id = ?`).run(ids.schema)
}

/**
 * 写入两个批量保存接口需要的最小数据集。
 */
function seed() {
  cleanup()
  db.prepare(`INSERT INTO patients (id, name, metadata) VALUES (?, ?, ?)`).run(ids.patient, 'Scoped Save Test', '{}')
  db.prepare(`
    INSERT INTO schemas (id, name, code, schema_type, version, content_json)
    VALUES (?, ?, ?, 'ehr', 1, '{}')
  `).run(ids.schema, 'Scoped Save Test Schema', `scoped_save_${suffix}`)
  db.prepare(`
    INSERT INTO schema_instances (id, patient_id, schema_id, name, instance_type, status)
    VALUES (?, ?, ?, 'Scoped Save EHR', 'patient_ehr', 'draft')
  `).run(ids.ehrInstance, ids.patient, ids.schema)
  db.prepare(`
    INSERT INTO projects (id, project_name, schema_id, status)
    VALUES (?, 'Scoped Save Project', ?, 'active')
  `).run(ids.project, ids.schema)
  db.prepare(`
    INSERT INTO project_patients (id, project_id, patient_id)
    VALUES (?, ?, ?)
  `).run(ids.enrollment, ids.project, ids.patient)
  db.prepare(`
    INSERT INTO schema_instances (id, patient_id, schema_id, project_id, name, instance_type, status)
    VALUES (?, ?, ?, ?, 'Scoped Save CRF', 'project_crf', 'draft')
  `).run(ids.projectInstance, ids.patient, ids.schema, ids.project)
}

/**
 * 向临时 HTTP 服务发送 JSON 请求。
 */
async function requestJson(port: number, path: string, method: string, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json() as JsonResponse
  return { status: res.status, json }
}

/**
 * 统计某个 schema_instance 下的候选/选中写入数量。
 */
function scopedWriteCounts(instanceId: string) {
  const candidates = db.prepare(`
    SELECT COUNT(*) AS count FROM field_value_candidates WHERE instance_id = ?
  `).get(instanceId) as { count: number }
  const selected = db.prepare(`
    SELECT COUNT(*) AS count FROM field_value_selected WHERE instance_id = ?
  `).get(instanceId) as { count: number }
  return { candidates: candidates.count, selected: selected.count }
}

async function run() {
  seed()
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  const port = address.port

  try {
    const ehr = await requestJson(port, `/api/v1/patients/${ids.patient}/ehr-schema-data`, 'PUT', {
      basic: { name: 'kept only if request succeeds' },
      labs: [{ result: 'must not be silently dropped' }],
    })
    assert.equal(ehr.status, 409)
    assert.equal(ehr.json.success, false)
    assert.deepEqual(scopedWriteCounts(ids.ehrInstance), { candidates: 0, selected: 0 })

    const project = await requestJson(
      port,
      `/api/v1/projects/${ids.project}/patients/${ids.patient}/crf/fields`,
      'PATCH',
      {
        fields: [
          { field_path: '/basic/name', value: 'kept only if request succeeds' },
          { field_path: '/visit/0/date', value: 'must not be silently dropped' },
        ],
      },
    )
    assert.equal(project.status, 409)
    assert.equal(project.json.success, false)
    assert.deepEqual(scopedWriteCounts(ids.projectInstance), { candidates: 0, selected: 0 })
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
    cleanup()
  }
}

run().then(() => {
  console.log('scoped save conflict regression passed')
}).catch((err) => {
  console.error(err)
  process.exit(1)
})
