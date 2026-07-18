import assert from 'node:assert/strict'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import app from './src/app.js'
import db from './src/db.js'

type CandidateResponse = {
  success: boolean
  data?: {
    candidates?: Array<{
      source_document_id: string | null
      source_location: Record<string, unknown> | null
    }>
  }
}

const prefix = `source-fallback-${randomUUID()}`
const patientId = `${prefix}-patient`
const schemaId = `${prefix}-schema`
const instanceId = `${prefix}-instance`
const docA = `${prefix}-doc-a`
const docB = `${prefix}-doc-b`
const fieldPath = '/检查/结果'

const cleanup = () => {
  db.prepare(`DELETE FROM field_value_candidates WHERE instance_id = ?`).run(instanceId)
  db.prepare(`DELETE FROM field_value_selected WHERE instance_id = ?`).run(instanceId)
  db.prepare(`DELETE FROM documents WHERE id IN (?, ?)`).run(docA, docB)
  db.prepare(`DELETE FROM schema_instances WHERE id = ?`).run(instanceId)
  db.prepare(`DELETE FROM schemas WHERE id = ?`).run(schemaId)
  db.prepare(`DELETE FROM patients WHERE id = ?`).run(patientId)
}

async function run() {
  cleanup()
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert(address && typeof address === 'object')

  try {
    db.prepare(`INSERT INTO patients (id, name) VALUES (?, ?)`).run(patientId, 'source fallback regression')
    db.prepare(
      `INSERT INTO schemas (id, name, code, schema_type, version, content_json)
       VALUES (?, ?, ?, 'ehr', 1, '{}')`
    ).run(schemaId, 'source fallback schema', `${prefix}-schema-code`)
    db.prepare(
      `INSERT INTO schema_instances (id, patient_id, schema_id, name, instance_type, status)
       VALUES (?, ?, ?, 'source fallback instance', 'patient_ehr', 'draft')`
    ).run(instanceId, patientId, schemaId)
    db.prepare(
      `INSERT INTO documents (id, patient_id, file_name, file_size, file_type, status)
       VALUES (?, ?, ?, 1, 'pdf', 'uploaded')`
    ).run(docA, patientId, 'doc-a.pdf')
    db.prepare(
      `INSERT INTO documents (id, patient_id, file_name, file_size, file_type, status)
       VALUES (?, ?, ?, 1, 'pdf', 'uploaded')`
    ).run(docB, patientId, 'doc-b.pdf')

    const insertCandidate = db.prepare(`
      INSERT INTO field_value_candidates
        (id, instance_id, field_path, value_json, value_type,
         source_document_id, source_page, source_bbox_json, source_text, confidence, created_by, created_at)
      VALUES (?, ?, ?, ?, 'string', ?, ?, ?, ?, 0.9, 'ai', ?)
    `)
    insertCandidate.run(
      `${prefix}-candidate-a`,
      instanceId,
      fieldPath,
      JSON.stringify('bare bbox'),
      docA,
      1,
      JSON.stringify([100, 100, 200, 200]),
      'bare bbox evidence',
      '2026-01-01T00:00:00.000Z'
    )
    insertCandidate.run(
      `${prefix}-candidate-b`,
      instanceId,
      fieldPath,
      JSON.stringify('sized bbox'),
      docB,
      1,
      JSON.stringify({ bbox: [10, 10, 20, 20], page_width: 4344, page_height: 5792 }),
      'sized bbox evidence',
      '2026-01-01T00:00:01.000Z'
    )

    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/patients/${patientId}/ehr-field-candidates?field_path=${encodeURIComponent(fieldPath)}`
    )
    assert.equal(response.status, 200)
    const body = await response.json() as CandidateResponse
    assert.equal(body.success, true)

    const candidates = body.data?.candidates || []
    const bareCandidate = candidates.find((c) => c.source_document_id === docA)
    const sizedCandidate = candidates.find((c) => c.source_document_id === docB)
    assert(bareCandidate?.source_location, 'bare candidate should include parsed source location')
    assert(sizedCandidate?.source_location, 'sized candidate should include parsed source location')
    assert.equal(bareCandidate.source_location.page_width, undefined)
    assert.equal(bareCandidate.source_location.page_height, undefined)
    assert.equal(sizedCandidate.source_location.page_width, 4344)
    assert.equal(sizedCandidate.source_location.page_height, 5792)
  } finally {
    server.close()
    cleanup()
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
