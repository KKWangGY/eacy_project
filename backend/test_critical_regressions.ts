import assert from 'node:assert/strict'
import http from 'node:http'
import app from './src/app.js'
import db from './src/db.js'
import { shouldClearProjectCrfHistory } from './src/utils/projectExtractionPolicy.js'

const prefix = `crit_${Date.now()}`

/**
 * Execute a request against a temporary in-process backend server.
 */
async function request(baseUrl: string, path: string, init?: RequestInit) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  })
  const body = await res.json().catch(() => null)
  return { res, body }
}

/**
 * Remove rows inserted by this regression script.
 */
function cleanup(ids: Record<string, string>) {
  const values = Object.values(ids)
  for (const value of values) {
    db.prepare(`DELETE FROM field_value_selected WHERE instance_id = ?`).run(value)
    db.prepare(`DELETE FROM field_value_candidates WHERE instance_id = ?`).run(value)
    db.prepare(`DELETE FROM row_instances WHERE instance_id = ?`).run(value)
    db.prepare(`DELETE FROM section_instances WHERE instance_id = ?`).run(value)
  }
  db.prepare(`DELETE FROM schema_instances WHERE id IN (?, ?)`).run(ids.patientInstanceId, ids.projectInstanceId)
  db.prepare(`DELETE FROM project_extraction_tasks WHERE project_id = ?`).run(ids.projectId)
  db.prepare(`DELETE FROM project_patients WHERE project_id = ?`).run(ids.projectId)
  db.prepare(`DELETE FROM documents WHERE patient_id IN (?, ?)`).run(ids.patientId, ids.otherPatientId)
  db.prepare(`DELETE FROM projects WHERE id = ?`).run(ids.projectId)
  db.prepare(`DELETE FROM patients WHERE id IN (?, ?)`).run(ids.patientId, ids.otherPatientId)
  db.prepare(`DELETE FROM schemas WHERE id = ?`).run(ids.schemaId)
}

/**
 * Seed the minimal project/EHR state required by the guarded routes.
 */
function seed() {
  const ids = {
    schemaId: `${prefix}_schema`,
    patientId: `${prefix}_patient`,
    otherPatientId: `${prefix}_other_patient`,
    projectId: `${prefix}_project`,
    patientInstanceId: `${prefix}_patient_instance`,
    projectInstanceId: `${prefix}_project_instance`,
  }
  cleanup(ids)

  db.prepare(`
    INSERT INTO schemas (id, name, code, schema_type, version, content_json, is_active)
    VALUES (?, 'Regression Schema', ?, 'ehr', 1, '{}', 1)
  `).run(ids.schemaId, `${prefix}_schema_code`)
  db.prepare(`INSERT INTO patients (id, name, pinyin, metadata) VALUES (?, 'A', '', '{}')`).run(ids.patientId)
  db.prepare(`INSERT INTO patients (id, name, pinyin, metadata) VALUES (?, 'B', '', '{}')`).run(ids.otherPatientId)
  db.prepare(`
    INSERT INTO projects (id, project_name, schema_id, status)
    VALUES (?, 'Regression Project', ?, 'active')
  `).run(ids.projectId, ids.schemaId)
  db.prepare(`
    INSERT INTO project_patients (id, project_id, patient_id, metadata)
    VALUES (?, ?, ?, '{}')
  `).run(`${prefix}_enrollment`, ids.projectId, ids.patientId)
  db.prepare(`
    INSERT INTO schema_instances (id, patient_id, schema_id, name, instance_type, status)
    VALUES (?, ?, ?, 'patient instance', 'patient_ehr', 'draft')
  `).run(ids.patientInstanceId, ids.patientId, ids.schemaId)
  db.prepare(`
    INSERT INTO schema_instances (id, patient_id, schema_id, project_id, name, instance_type, status)
    VALUES (?, ?, ?, ?, 'project instance', 'project_crf', 'draft')
  `).run(ids.projectInstanceId, ids.patientId, ids.schemaId, ids.projectId)
  return ids
}

async function main() {
  assert.equal(shouldClearProjectCrfHistory({
    mode: 'full',
    targetSections: [],
    submittedPatientIds: ['p1'],
  }), true)
  assert.equal(shouldClearProjectCrfHistory({
    mode: 'incremental',
    targetSections: [],
    submittedPatientIds: ['p1'],
  }), false)
  assert.equal(shouldClearProjectCrfHistory({
    mode: 'full',
    targetSections: ['/A'],
    submittedPatientIds: ['p1'],
  }), false)
  assert.equal(shouldClearProjectCrfHistory({
    mode: 'full',
    targetSections: [],
    submittedPatientIds: [],
  }), false)

  const ids = seed()
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}`

  try {
    const ehrSave = await request(baseUrl, `/api/v1/patients/${ids.patientId}/ehr-schema-data`, {
      method: 'PUT',
      body: JSON.stringify({ repeatable: [{ name: 'lost update' }] }),
    })
    assert.equal(ehrSave.res.status, 409)
    assert.deepEqual(ehrSave.body?.data?.unresolved_paths, ['/repeatable/0/name'])

    const crfSave = await request(baseUrl, `/api/v1/projects/${ids.projectId}/patients/${ids.patientId}/crf/fields`, {
      method: 'PATCH',
      body: JSON.stringify({ fields: [{ field_path: '/repeatable/0/name', value: 'lost update' }] }),
    })
    assert.equal(crfSave.res.status, 409)
    assert.deepEqual(crfSave.body?.data?.unresolved_paths, ['/repeatable/0/name'])

    const invalidExtraction = await request(baseUrl, `/api/v1/projects/${ids.projectId}/crf/extraction`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'full', patient_ids: [ids.otherPatientId] }),
    })
    assert.equal(invalidExtraction.res.status, 400)
    assert.deepEqual(invalidExtraction.body?.data?.invalid_patient_ids, [ids.otherPatientId])
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    cleanup(ids)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
