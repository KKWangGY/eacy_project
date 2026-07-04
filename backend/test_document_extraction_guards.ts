import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import app from './src/app.js'
import db from './src/db.js'

const prefix = `guard_${Date.now()}_${randomUUID().slice(0, 8)}`
const ids = {
  patientA: `${prefix}_patient_a`,
  patientB: `${prefix}_patient_b`,
  schema: `${prefix}_schema`,
  project: `${prefix}_project`,
  document: `${prefix}_document`,
  mergeDocument: `${prefix}_merge_document`,
  instance: `${prefix}_instance`,
  run: `${prefix}_run`,
  candidate: `${prefix}_candidate`,
  selected: `${prefix}_selected`,
}

/**
 * 调用测试服务器并返回 JSON 响应。
 */
async function request(baseUrl: string, method: string, path: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, json: await response.json() as any }
}

/**
 * 清除本脚本写入的临时数据。
 */
function cleanup() {
  db.prepare(`DELETE FROM field_value_selected WHERE id = ? OR instance_id = ?`).run(ids.selected, ids.instance)
  db.prepare(`DELETE FROM field_value_candidates WHERE id = ? OR instance_id = ?`).run(ids.candidate, ids.instance)
  db.prepare(`DELETE FROM extraction_runs WHERE id = ? OR instance_id = ?`).run(ids.run, ids.instance)
  db.prepare(`DELETE FROM schema_instances WHERE id = ?`).run(ids.instance)
  db.prepare(`DELETE FROM project_patients WHERE project_id = ? OR patient_id IN (?, ?)`).run(ids.project, ids.patientA, ids.patientB)
  db.prepare(`DELETE FROM projects WHERE id = ?`).run(ids.project)
  db.prepare(`DELETE FROM documents WHERE id IN (?, ?)`).run(ids.document, ids.mergeDocument)
  db.prepare(`DELETE FROM patients WHERE id IN (?, ?)`).run(ids.patientA, ids.patientB)
  db.prepare(`DELETE FROM schemas WHERE id = ?`).run(ids.schema)
}

/**
 * 建立抽取归属校验所需的最小数据库夹具。
 */
function seed() {
  const ts = new Date().toISOString()
  db.prepare(`
    INSERT INTO schemas (id, name, code, schema_type, version, content_json, is_active, created_at, updated_at)
    VALUES (?, ?, ?, 'ehr', 1, '{}', 1, ?, ?)
  `).run(ids.schema, 'Guard Test Schema', `${prefix}_code`, ts, ts)
  db.prepare(`INSERT INTO patients (id, name, metadata) VALUES (?, ?, '{}')`).run(ids.patientA, 'Guard Patient A')
  db.prepare(`INSERT INTO patients (id, name, metadata) VALUES (?, ?, '{}')`).run(ids.patientB, 'Guard Patient B')
  db.prepare(`
    INSERT INTO projects (id, project_name, schema_id, status, created_at, updated_at)
    VALUES (?, 'Guard Project', ?, 'active', ?, ?)
  `).run(ids.project, ids.schema, ts, ts)
  db.prepare(`
    INSERT INTO documents
      (id, patient_id, file_name, file_size, mime_type, object_key, status, metadata, raw_text,
       extract_result_json, extract_status, created_at, updated_at)
    VALUES (?, ?, 'guard.pdf', 1, 'application/pdf', 'guard.pdf', 'ocr_succeeded', '{}', 'ocr done',
            '{"基本信息":{"姓名":"新值"}}', 'succeeded', ?, ?)
  `).run(ids.document, ids.patientA, ts, ts)
  db.prepare(`
    INSERT INTO documents
      (id, patient_id, file_name, file_size, mime_type, object_key, status, metadata, raw_text,
       extract_result_json, extract_status, created_at, updated_at)
    VALUES (?, ?, 'merge.pdf', 1, 'application/pdf', 'merge.pdf', 'ocr_succeeded', '{}', 'ocr done',
            '{"基本信息":{"姓名":"会覆盖用户值"}}', 'succeeded', ?, ?)
  `).run(ids.mergeDocument, ids.patientA, ts, ts)
  db.prepare(`
    INSERT INTO schema_instances (id, patient_id, schema_id, name, instance_type, status, created_at, updated_at)
    VALUES (?, ?, ?, 'Guard Instance', 'patient_ehr', 'draft', ?, ?)
  `).run(ids.instance, ids.patientA, ids.schema, ts, ts)
  db.prepare(`
    INSERT INTO extraction_runs (id, instance_id, document_id, status, created_at, finished_at)
    VALUES (?, ?, ?, 'succeeded', ?, ?)
  `).run(ids.run, ids.instance, ids.mergeDocument, ts, ts)
  db.prepare(`
    INSERT INTO field_value_candidates
      (id, instance_id, field_path, value_json, value_type, source_document_id, created_by)
    VALUES (?, ?, '/基本信息/姓名', '"旧值"', 'string', ?, 'user')
  `).run(ids.candidate, ids.instance, ids.mergeDocument)
  db.prepare(`
    INSERT INTO field_value_selected
      (id, instance_id, field_path, selected_candidate_id, selected_value_json, selected_by)
    VALUES (?, ?, '/基本信息/姓名', ?, '"用户保留值"', 'user')
  `).run(ids.selected, ids.instance, ids.candidate)
}

async function run() {
  cleanup()
  seed()

  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const { port } = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${port}`

  try {
    const mismatchedPatient = await request(baseUrl, 'POST', `/api/v1/documents/${ids.document}/extract-ehr`, {
      patient_id: ids.patientB,
    })
    assert.equal(mismatchedPatient.status, 409)
    assert.match(mismatchedPatient.json.message, /patient_id/)

    const missingProject = await request(baseUrl, 'POST', `/api/v1/documents/${ids.document}/extract-ehr`, {
      patient_id: ids.patientA,
      instance_type: 'project_crf',
    })
    assert.equal(missingProject.status, 400)
    assert.match(missingProject.json.message, /project_id/)

    const unenrolledProject = await request(baseUrl, 'POST', `/api/v1/documents/${ids.document}/extract-ehr`, {
      patient_id: ids.patientA,
      project_id: ids.project,
    })
    assert.equal(unenrolledProject.status, 400)
    assert.match(unenrolledProject.json.message, /未入组/)

    const blockedMerge = await request(baseUrl, 'POST', `/api/v1/patients/${ids.patientA}/merge-ehr`, {
      document_id: ids.mergeDocument,
    })
    assert.equal(blockedMerge.status, 409)
    assert.match(blockedMerge.json.message, /自动物化/)

    const selected = db.prepare(`
      SELECT selected_value_json, selected_by
      FROM field_value_selected
      WHERE id = ?
    `).get(ids.selected) as any
    assert.deepEqual(selected, { selected_value_json: '"用户保留值"', selected_by: 'user' })

    console.log('document extraction guard tests passed')
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
    cleanup()
  }
}

run().catch((error) => {
  cleanup()
  console.error(error)
  process.exit(1)
})
