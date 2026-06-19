import assert from 'node:assert/strict'
import http from 'node:http'
import app from './src/app.js'
import db from './src/db.js'

type JsonResponse = {
  status: number
  body: any
}

/**
 * 通过真实 Express 路由发起 JSON 请求，避免测试客户端依赖被 mock 的 global fetch。
 */
function postJson(port: number, path: string, body: unknown): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 0, body: data ? JSON.parse(data) : null })
          } catch (error) {
            reject(error)
          }
        })
      }
    )
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

/**
 * 清理本测试创建的固定前缀数据。
 */
function cleanup(ids: string[]) {
  const placeholders = ids.map(() => '?').join(',')
  if (!placeholders) return
  db.prepare(`DELETE FROM documents WHERE id IN (${placeholders})`).run(...ids)
  db.prepare(`DELETE FROM project_patients WHERE project_id IN (${placeholders}) OR patient_id IN (${placeholders})`).run(...ids, ...ids)
  db.prepare(`DELETE FROM projects WHERE id IN (${placeholders})`).run(...ids)
  db.prepare(`DELETE FROM schemas WHERE id IN (${placeholders})`).run(...ids)
  db.prepare(`DELETE FROM patients WHERE id IN (${placeholders})`).run(...ids)
}

/**
 * 回归测试单文档 EHR 抽取不能覆盖文档绑定患者，也不能写入未入组项目。
 */
async function run() {
  const suffix = `${Date.now()}`
  const patientA = `test-patient-a-${suffix}`
  const patientB = `test-patient-b-${suffix}`
  const schemaId = `test-schema-${suffix}`
  const projectId = `test-project-${suffix}`
  const docId = `test-doc-${suffix}`
  const ids = [patientA, patientB, schemaId, projectId, docId]
  const now = new Date().toISOString()
  const originalFetch = globalThis.fetch
  const submittedPayloads: any[] = []

  cleanup(ids)
  db.prepare(`INSERT INTO patients (id, name) VALUES (?, ?)`).run(patientA, '测试患者A')
  db.prepare(`INSERT INTO patients (id, name) VALUES (?, ?)`).run(patientB, '测试患者B')
  db.prepare(`
    INSERT INTO schemas (id, name, code, schema_type, version, content_json, is_active)
    VALUES (?, ?, ?, 'crf', ?, '{}', 1)
  `).run(schemaId, '测试CRF', `test-crf-${suffix}`, Number(suffix.slice(-6)))
  db.prepare(`
    INSERT INTO projects (id, project_name, schema_id, status)
    VALUES (?, ?, ?, 'active')
  `).run(projectId, '测试项目', schemaId)
  db.prepare(`
    INSERT INTO documents (
      id, patient_id, file_name, file_size, mime_type, object_key, status,
      metadata, raw_text, ocr_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(docId, patientA, 'test.pdf', 1, 'application/pdf', 'test.pdf', 'archived', '{}', 'ocr text', 'succeeded', now, now)

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    submittedPayloads.push(JSON.parse(String(init?.body || '{}')))
    return new Response(JSON.stringify({ job_id: 'job-1', celery_task_id: 'celery-1' }), { status: 202 })
  }) as typeof fetch

  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.equal(typeof address, 'object')
  const port = (address as any).port as number

  try {
    const mismatch = await postJson(port, `/api/v1/documents/${docId}/extract-ehr`, { patient_id: patientB })
    assert.equal(mismatch.status, 400)
    assert.equal(submittedPayloads.length, 0)

    const projectWithoutId = await postJson(port, `/api/v1/documents/${docId}/extract-ehr`, { instance_type: 'project_crf' })
    assert.equal(projectWithoutId.status, 400)
    assert.equal(submittedPayloads.length, 0)

    const notEnrolled = await postJson(port, `/api/v1/documents/${docId}/extract-ehr`, { project_id: projectId })
    assert.equal(notEnrolled.status, 403)
    assert.equal(submittedPayloads.length, 0)

    db.prepare(`
      INSERT INTO project_patients (id, project_id, patient_id)
      VALUES (?, ?, ?)
    `).run(`test-enrollment-${suffix}`, projectId, patientA)
    ids.push(`test-enrollment-${suffix}`)

    const valid = await postJson(port, `/api/v1/documents/${docId}/extract-ehr`, {
      patient_id: patientA,
      project_id: projectId,
    })
    assert.equal(valid.status, 200)
    assert.equal(submittedPayloads.length, 1)
    assert.equal(submittedPayloads[0].patient_id, patientA)
    assert.equal(submittedPayloads[0].project_id, projectId)
    assert.equal(submittedPayloads[0].instance_type, 'project_crf')
    assert.deepEqual(submittedPayloads[0].document_ids, [docId])
    console.log('document extract policy ok')
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    globalThis.fetch = originalFetch
    cleanup(ids)
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
