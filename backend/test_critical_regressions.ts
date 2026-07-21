import assert from 'node:assert/strict'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import app from './src/app.js'
import db from './src/db.js'

type JsonResponse = {
  status: number
  body: any
}

const testIds: string[] = []

function id(prefix: string): string {
  const value = `${prefix}_${randomUUID()}`
  testIds.push(value)
  return value
}

async function requestJson(port: number, path: string, init?: RequestInit): Promise<JsonResponse> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers || {}),
    },
  })
  return { status: response.status, body: await response.json() }
}

function cleanup() {
  const placeholders = testIds.map(() => '?').join(',')
  if (!placeholders) return

  db.prepare(`DELETE FROM field_value_selected WHERE instance_id IN (${placeholders})`).run(...testIds)
  db.prepare(`DELETE FROM field_value_candidates WHERE instance_id IN (${placeholders}) OR id IN (${placeholders})`).run(...testIds, ...testIds)
  db.prepare(`DELETE FROM row_instances WHERE instance_id IN (${placeholders}) OR id IN (${placeholders})`).run(...testIds, ...testIds)
  db.prepare(`DELETE FROM section_instances WHERE instance_id IN (${placeholders}) OR id IN (${placeholders})`).run(...testIds, ...testIds)
  db.prepare(`DELETE FROM schema_instances WHERE id IN (${placeholders}) OR patient_id IN (${placeholders}) OR schema_id IN (${placeholders})`).run(...testIds, ...testIds, ...testIds)
  db.prepare(`DELETE FROM project_patients WHERE id IN (${placeholders}) OR project_id IN (${placeholders}) OR patient_id IN (${placeholders})`).run(...testIds, ...testIds, ...testIds)
  db.prepare(`DELETE FROM projects WHERE id IN (${placeholders}) OR schema_id IN (${placeholders})`).run(...testIds, ...testIds)
  db.prepare(`DELETE FROM documents WHERE id IN (${placeholders}) OR patient_id IN (${placeholders})`).run(...testIds, ...testIds)
  db.prepare(`DELETE FROM patients WHERE id IN (${placeholders})`).run(...testIds)
  db.prepare(`DELETE FROM schemas WHERE id IN (${placeholders})`).run(...testIds)
}

async function testEhrSaveRejectsUnresolvedRepeatablePath(port: number) {
  const patientId = id('patient')
  const schemaId = id('schema')
  const instanceId = id('instance')

  db.prepare(`INSERT INTO patients (id, name) VALUES (?, ?)`).run(patientId, 'critical regression patient')
  db.prepare(`INSERT INTO schemas (id, name, code, schema_type, content_json) VALUES (?, ?, ?, 'ehr', '{}')`).run(schemaId, 'critical regression schema', schemaId)
  db.prepare(`INSERT INTO schema_instances (id, patient_id, schema_id, name, instance_type, status) VALUES (?, ?, ?, ?, 'patient_ehr', 'draft')`).run(instanceId, patientId, schemaId, 'critical regression instance')

  const response = await requestJson(port, `/api/v1/patients/${patientId}/ehr-schema-data`, {
    method: 'PUT',
    body: JSON.stringify({ labs: [{ result: 'lost without 409' }] }),
  })

  assert.equal(response.status, 409)
  assert.deepEqual(response.body.data.unresolved_paths, ['/labs/0/result'])
  const selectedCount = db.prepare(`SELECT COUNT(*) AS count FROM field_value_selected WHERE instance_id = ?`).get(instanceId) as { count: number }
  assert.equal(selectedCount.count, 0)
}

async function testProjectSaveRejectsUnresolvedRepeatablePath(port: number) {
  const patientId = id('patient')
  const schemaId = id('schema')
  const projectId = id('project')
  const enrollmentId = id('enrollment')

  db.prepare(`INSERT INTO patients (id, name) VALUES (?, ?)`).run(patientId, 'critical regression project patient')
  db.prepare(`INSERT INTO schemas (id, name, code, schema_type, content_json) VALUES (?, ?, ?, 'crf', '{}')`).run(schemaId, 'critical regression crf schema', schemaId)
  db.prepare(`INSERT INTO projects (id, project_name, schema_id, status) VALUES (?, ?, ?, 'active')`).run(projectId, 'critical regression project', schemaId)
  db.prepare(`INSERT INTO project_patients (id, project_id, patient_id) VALUES (?, ?, ?)`).run(enrollmentId, projectId, patientId)

  const response = await requestJson(port, `/api/v1/projects/${projectId}/patients/${patientId}/crf/fields`, {
    method: 'PATCH',
    body: JSON.stringify({ fields: [{ field_path: '/visits/0/result', value: 'lost without 409' }] }),
  })

  assert.equal(response.status, 409)
  assert.deepEqual(response.body.data.unresolved_paths, ['/visits/0/result'])
  const instanceCount = db.prepare(`SELECT COUNT(*) AS count FROM schema_instances WHERE project_id = ?`).get(projectId) as { count: number }
  assert.equal(instanceCount.count, 0)
}

async function testPdfPageSizeFallbackStaysWithinSameDocument(port: number) {
  const patientId = id('patient')
  const schemaId = id('schema')
  const instanceId = id('instance')
  const docWithSize = id('doc')
  const docBare = id('doc')
  const candidateWithSize = id('candidate')
  const candidateBare = id('candidate')

  db.prepare(`INSERT INTO patients (id, name) VALUES (?, ?)`).run(patientId, 'critical regression source patient')
  db.prepare(`INSERT INTO schemas (id, name, code, schema_type, content_json) VALUES (?, ?, ?, 'ehr', '{}')`).run(schemaId, 'critical regression source schema', schemaId)
  db.prepare(`INSERT INTO schema_instances (id, patient_id, schema_id, name, instance_type, status) VALUES (?, ?, ?, ?, 'patient_ehr', 'draft')`).run(instanceId, patientId, schemaId, 'critical regression source instance')
  db.prepare(`INSERT INTO documents (id, patient_id, file_name, file_size, status, metadata) VALUES (?, ?, ?, 1, 'processed', '{}')`).run(docWithSize, patientId, 'with-size.pdf')
  db.prepare(`INSERT INTO documents (id, patient_id, file_name, file_size, status, metadata) VALUES (?, ?, ?, 1, 'processed', '{}')`).run(docBare, patientId, 'bare.pdf')

  db.prepare(`
    INSERT INTO field_value_candidates
      (id, instance_id, field_path, value_json, value_type, source_document_id, source_page, source_bbox_json, source_text, created_by, created_at)
    VALUES (?, ?, '/diagnosis/main', '"A"', 'string', ?, 1, ?, 'with size', 'ai', '2026-01-01T00:00:00.000Z')
  `).run(candidateWithSize, instanceId, docWithSize, JSON.stringify({ bbox: [10, 20, 30, 40], page_width: 1000, page_height: 2000 }))
  db.prepare(`
    INSERT INTO field_value_candidates
      (id, instance_id, field_path, value_json, value_type, source_document_id, source_page, source_bbox_json, source_text, created_by, created_at)
    VALUES (?, ?, '/diagnosis/main', '"B"', 'string', ?, 1, ?, 'bare', 'ai', '2026-01-01T00:00:01.000Z')
  `).run(candidateBare, instanceId, docBare, JSON.stringify([50, 60, 70, 80]))

  const response = await requestJson(port, `/api/v1/patients/${patientId}/ehr-field-candidates?field_path=${encodeURIComponent('/diagnosis/main')}`)

  assert.equal(response.status, 200)
  const bareCandidate = response.body.data.candidates.find((candidate: any) => candidate.source_document_id === docBare)
  const sizedCandidate = response.body.data.candidates.find((candidate: any) => candidate.source_document_id === docWithSize)
  assert.equal(bareCandidate.source_location.page_width, undefined)
  assert.equal(bareCandidate.source_location.page_height, undefined)
  assert.equal(sizedCandidate.source_location.page_width, 1000)
  assert.equal(sizedCandidate.source_location.page_height, 2000)
}

async function main() {
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')

  try {
    await testEhrSaveRejectsUnresolvedRepeatablePath(address.port)
    await testProjectSaveRejectsUnresolvedRepeatablePath(address.port)
    await testPdfPageSizeFallbackStaysWithinSameDocument(address.port)
    console.log('critical regression tests passed')
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    cleanup()
  }
}

main().catch((error) => {
  console.error(error)
  cleanup()
  process.exit(1)
})
