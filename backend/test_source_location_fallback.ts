import assert from 'node:assert/strict'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import app from './src/app.js'
import db from './src/db.js'

/**
 * 启动临时 HTTP 服务，返回可访问的 baseUrl。
 */
function listen(server: http.Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      assert(address && typeof address === 'object')
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

/**
 * 清理本测试插入的固定 id 数据，避免污染开发数据库。
 */
function cleanup(ids: string[]) {
  for (const id of ids) {
    db.prepare('DELETE FROM field_value_candidates WHERE id = ?').run(id)
    db.prepare('DELETE FROM schema_instances WHERE id = ?').run(id)
    db.prepare('DELETE FROM documents WHERE id = ?').run(id)
    db.prepare('DELETE FROM patients WHERE id = ?').run(id)
    db.prepare('DELETE FROM schemas WHERE id = ?').run(id)
  }
}

/**
 * 插入一个最小 EHR 实例和来源候选，用真实接口验证 PDF 页面尺寸回填边界。
 */
function seedFixture() {
  const suffix = randomUUID()
  const patientId = `patient-${suffix}`
  const schemaId = `schema-${suffix}`
  const instanceId = `instance-${suffix}`
  const docBareCross = `doc-bare-cross-${suffix}`
  const docSizedCross = `doc-sized-cross-${suffix}`
  const docSame = `doc-same-${suffix}`
  const candidateBareCross = `candidate-bare-cross-${suffix}`
  const candidateSizedCross = `candidate-sized-cross-${suffix}`
  const candidateBareSame = `candidate-bare-same-${suffix}`
  const candidateSizedSame = `candidate-sized-same-${suffix}`

  db.prepare(`
    INSERT INTO patients (id, name, metadata)
    VALUES (?, ?, '{}')
  `).run(patientId, 'source fallback test')

  db.prepare(`
    INSERT INTO schemas (id, name, code, schema_type, version, content_json, is_active)
    VALUES (?, ?, ?, 'ehr', 1, '{}', 1)
  `).run(schemaId, 'source fallback schema', `source_fallback_${suffix}`)

  db.prepare(`
    INSERT INTO schema_instances (id, patient_id, schema_id, name, instance_type, status)
    VALUES (?, ?, ?, 'source fallback instance', 'patient_ehr', 'draft')
  `).run(instanceId, patientId, schemaId)

  const insertDocument = db.prepare(`
    INSERT INTO documents (id, patient_id, file_name, file_size, mime_type, object_key, status, metadata)
    VALUES (?, ?, ?, 1, 'application/pdf', ?, 'processed', '{}')
  `)
  insertDocument.run(docBareCross, patientId, 'bare-cross.pdf', docBareCross)
  insertDocument.run(docSizedCross, patientId, 'sized-cross.pdf', docSizedCross)
  insertDocument.run(docSame, patientId, 'same-doc.pdf', docSame)

  const insertCandidate = db.prepare(`
    INSERT INTO field_value_candidates
      (id, instance_id, field_path, value_json, value_type, source_document_id, source_page, source_bbox_json, source_text, confidence, created_by, created_at)
    VALUES (?, ?, ?, ?, 'string', ?, 1, ?, ?, 0.9, 'ai', ?)
  `)
  insertCandidate.run(
    candidateBareCross,
    instanceId,
    '/cross/doc/field',
    JSON.stringify('bare-cross'),
    docBareCross,
    JSON.stringify([100, 100, 300, 180]),
    'bare cross text',
    '2026-01-01T00:00:01.000Z'
  )
  insertCandidate.run(
    candidateSizedCross,
    instanceId,
    '/cross/doc/field',
    JSON.stringify('sized-cross'),
    docSizedCross,
    JSON.stringify({ bbox: [200, 200, 400, 280], page_width: 2560, page_height: 3412 }),
    'sized cross text',
    '2026-01-01T00:00:02.000Z'
  )
  insertCandidate.run(
    candidateBareSame,
    instanceId,
    '/same/doc/field',
    JSON.stringify('bare-same'),
    docSame,
    JSON.stringify([50, 60, 150, 160]),
    'bare same text',
    '2026-01-01T00:00:03.000Z'
  )
  insertCandidate.run(
    candidateSizedSame,
    instanceId,
    '/same/doc/field',
    JSON.stringify('sized-same'),
    docSame,
    JSON.stringify({ bbox: [500, 600, 700, 800], page_width: 1280, page_height: 1706 }),
    'sized same text',
    '2026-01-01T00:00:04.000Z'
  )

  return {
    patientId,
    ids: [
      candidateBareCross,
      candidateSizedCross,
      candidateBareSame,
      candidateSizedSame,
      docBareCross,
      docSizedCross,
      docSame,
      instanceId,
      patientId,
      schemaId,
    ],
  }
}

/**
 * 调用候选接口并按候选值索引结果。
 */
async function fetchCandidates(baseUrl: string, patientId: string, fieldPath: string) {
  const res = await fetch(
    `${baseUrl}/api/v1/patients/${patientId}/ehr-field-candidates?field_path=${encodeURIComponent(fieldPath)}`
  )
  assert.equal(res.status, 200)
  const payload = await res.json()
  assert.equal(payload.success, true)
  return new Map(payload.data.candidates.map((candidate: any) => [candidate.value, candidate]))
}

async function run() {
  const fixture = seedFixture()
  const server = http.createServer(app)
  try {
    const baseUrl = await listen(server)

    const crossDocCandidates = await fetchCandidates(baseUrl, fixture.patientId, '/cross/doc/field')
    const bareCross = crossDocCandidates.get('bare-cross') as any
    const sizedCross = crossDocCandidates.get('sized-cross') as any
    assert(bareCross, '裸 bbox 跨文档候选应存在')
    assert(sizedCross, '带尺寸跨文档候选应存在')
    assert.equal(bareCross.source_location.page_width, undefined)
    assert.equal(bareCross.source_location.page_height, undefined)
    assert.equal(sizedCross.source_location.page_width, 2560)
    assert.equal(sizedCross.source_location.page_height, 3412)

    const sameDocCandidates = await fetchCandidates(baseUrl, fixture.patientId, '/same/doc/field')
    const bareSame = sameDocCandidates.get('bare-same') as any
    assert(bareSame, '裸 bbox 同文档候选应存在')
    assert.equal(bareSame.source_location.page_width, 1280)
    assert.equal(bareSame.source_location.page_height, 1706)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    cleanup(fixture.ids)
  }
}

run().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
