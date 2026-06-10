import assert from 'node:assert/strict'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import app from './src/app.js'
import db from './src/db.js'
import {
  buildPageSizeFallback,
  parseSourceLocationWithFallback,
} from './src/routes/ehrData.js'

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      assert(address && typeof address === 'object')
      resolve(address.port)
    })
  })
}

async function requestJson(port: number, path: string, body: unknown) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { response, json: await response.json() as any }
}

function testPageSizeFallbackIsolation() {
  const bareBox = JSON.stringify({ bbox: [100, 200, 300, 400] })
  const fallback = buildPageSizeFallback([
    {
      source_document_id: 'doc-b',
      source_page: 1,
      source_bbox_json: JSON.stringify({
        bbox: [10, 20, 30, 40],
        page_width: 2560,
        page_height: 3412,
      }),
    },
  ])

  const crossDoc = parseSourceLocationWithFallback(bareBox, 1, 'doc-a', fallback) as any
  assert.equal(crossDoc.page_width, undefined)
  assert.equal(crossDoc.page_height, undefined)

  const sameDocFallback = buildPageSizeFallback([
    {
      source_document_id: 'doc-a',
      source_page: 1,
      source_bbox_json: JSON.stringify({
        bbox: [10, 20, 30, 40],
        page_width: 1280,
        page_height: 1706,
      }),
    },
  ])
  const sameDoc = parseSourceLocationWithFallback(bareBox, 1, 'doc-a', sameDocFallback) as any
  assert.equal(sameDoc.page_width, 1280)
  assert.equal(sameDoc.page_height, 1706)
}

async function testUnresolvedIndexedSaveDoesNotSilentlySucceed() {
  const ids = {
    patient: `test_patient_${randomUUID()}`,
    schema: `test_schema_${randomUUID()}`,
    instance: `test_instance_${randomUUID()}`,
  }
  const schemaCode = `test_ehr_${randomUUID()}`
  const server = http.createServer(app)
  const port = await listen(server)

  try {
    db.prepare(`INSERT INTO patients (id, name, metadata) VALUES (?, ?, '{}')`).run(ids.patient, 'scope regression')
    db.prepare(`
      INSERT INTO schemas (id, name, code, schema_type, version, content_json, is_active)
      VALUES (?, 'scope regression schema', ?, 'ehr', 1, '{}', 1)
    `).run(ids.schema, schemaCode)
    db.prepare(`
      INSERT INTO schema_instances (id, patient_id, schema_id, name, instance_type, status)
      VALUES (?, ?, ?, 'scope regression instance', 'patient_ehr', 'draft')
    `).run(ids.instance, ids.patient, ids.schema)

    const { response, json } = await requestJson(
      port,
      `/api/v1/patients/${ids.patient}/ehr-schema-data`,
      { 检查: [{ 项目: 'ALT' }] },
    )

    assert.equal(response.status, 409)
    assert.equal(json.success, false)
    assert.deepEqual(json.data.unresolved_paths, ['/检查/0/项目'])

    const selectedCount = db.prepare(`
      SELECT COUNT(*) AS count FROM field_value_selected WHERE instance_id = ?
    `).get(ids.instance) as { count: number }
    const candidateCount = db.prepare(`
      SELECT COUNT(*) AS count FROM field_value_candidates WHERE instance_id = ?
    `).get(ids.instance) as { count: number }
    assert.equal(selectedCount.count, 0)
    assert.equal(candidateCount.count, 0)
  } finally {
    server.close()
    db.prepare(`DELETE FROM schema_instances WHERE id = ?`).run(ids.instance)
    db.prepare(`DELETE FROM schemas WHERE id = ?`).run(ids.schema)
    db.prepare(`DELETE FROM patients WHERE id = ?`).run(ids.patient)
  }
}

async function main() {
  testPageSizeFallbackIsolation()
  await testUnresolvedIndexedSaveDoesNotSilentlySucceed()
  console.log('EHR critical regression tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
