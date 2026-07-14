import { Router, Request, Response } from 'express'
import { randomUUID } from 'crypto'
import multer from 'multer'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import db from '../db.js'
import { parseDocument } from '../services/textin.js'
import {
  buildArchiveMatchGroups,
  buildArchiveMatchLookup,
  mapGroupToFrontendTaskStatus,
} from '../services/archiveMatching.js'
import {
  CRF_SERVICE_URL,
  crfServiceFetch,
  crfServiceSubmitBatch,
  crfServiceSubmitSingle,
} from '../services/crfServiceClient.js'

// ─── EHR Pipeline ────────────────────────────────────────────────────────────
// Pipeline daemon 会自动发现满足条件的文档并派发处理任务，
// 后端通过 ehr_extraction_jobs 表调度 extract/materialize 任务

const router = Router()

// ─── Multer 文件上传配置 ─────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const UPLOADS_DIR = path.resolve(__dirname, '../../uploads')

// 确保上传目录存在
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true })
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    // 用 UUID 命名避免冲突，保留扩展名
    const ext = path.extname(file.originalname)
    cb(null, `${randomUUID()}${ext}`)
  }
})

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
})

// ─── Types ───────────────────────────────────────────────────────────────────

type DocumentStatus =
  | 'pending_upload' | 'uploaded' | 'archived' | 'deleted'
  | 'ocr_pending' | 'ocr_running' | 'ocr_succeeded' | 'ocr_failed'

interface DocumentRecord {
  id: string
  patient_id: string | null
  file_name: string
  file_size: number
  mime_type: string
  object_key: string
  status: DocumentStatus
  batch_id: string | null
  doc_type: string | null
  doc_title: string | null
  effective_at: string | null
  metadata: string          // JSON string in SQLite
  raw_text: string | null
  ocr_payload: string | null
  ocr_status: string | null
  ocr_error_message: string | null
  extract_result_json: string | null
  extract_status: string | null
  extract_error_message: string | null
  meta_status: string | null
  meta_error_message: string | null
  materialize_status: string | null
  error_message: string | null
  created_at: string
  updated_at: string
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function now() {
  return new Date().toISOString()
}

function safeParseMetadata(raw: string | null | undefined): Record<string, unknown> {
  try {
    const v = JSON.parse(raw ?? '{}')
    return v != null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** 获取默认 schema 的 UUID id */
function getDefaultSchemaId(): string | null {
  const row = db.prepare(`
    SELECT id
    FROM schemas
    WHERE is_active = 1
      AND code IN ('patient_ehr_v2', 'patient_ehr_v2_crf')
    ORDER BY CASE code WHEN 'patient_ehr_v2' THEN 0 WHEN 'patient_ehr_v2_crf' THEN 1 ELSE 2 END,
             version DESC
    LIMIT 1
  `).get() as any
  return row?.id ?? null
}

function inferSingleProjectForPatient(patientId: string | null | undefined): { project_id: string; schema_id: string } | null {
  if (!patientId) return null
  const rows = db.prepare(`
    SELECT p.id AS project_id, p.schema_id
    FROM project_patients pp
    JOIN projects p ON p.id = pp.project_id
    WHERE pp.patient_id = ?
      AND p.schema_id IS NOT NULL
      AND TRIM(p.schema_id) != ''
    ORDER BY pp.enrolled_at DESC, pp.id DESC
    LIMIT 2
  `).all(patientId) as Array<{ project_id: string; schema_id: string }>
  return rows.length === 1 ? rows[0] : null
}

/**
 * 判断患者是否已入组指定项目，避免把文档抽取结果写入无关项目 CRF。
 */
function isPatientEnrolledInProject(patientId: string, projectId: string): boolean {
  const row = db.prepare(`
    SELECT 1
    FROM project_patients
    WHERE project_id = ? AND patient_id = ?
    LIMIT 1
  `).get(projectId, patientId) as { '1': number } | undefined
  return !!row
}

/** 从 ehr_extraction_jobs 获取文档的最新 job 状态 */
function getJobStatus(documentId: string, jobType: string): string {
  const row = db.prepare(`
    SELECT status FROM ehr_extraction_jobs
    WHERE document_id = ? AND job_type = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(documentId, jobType) as any
  return row?.status ?? 'pending'
}

/** 把 SQLite 行转成对外 JSON（metadata 反序列化） */
function serialize(row: DocumentRecord) {
  return {
    ...row,
    metadata: safeParseMetadata(row.metadata),
  }
}

function parseBooleanFlag(value: unknown, defaultValue = false): boolean {
  if (value == null || value === '') return defaultValue
  const normalized = String(value).trim().toLowerCase()
  if (['false', '0', 'no', 'off'].includes(normalized)) return false
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true
  return defaultValue
}

function parseCommaSeparatedIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean)
  }
  if (typeof value === 'string') {
    return value.split(',').map((item) => item.trim()).filter(Boolean)
  }
  return []
}

function getAllPatientRows(): any[] {
  return db.prepare(`SELECT * FROM patients`).all() as any[]
}

function getCompletedDocumentsForMatching(): any[] {
  return db.prepare(`
    SELECT * FROM documents
    WHERE meta_status = 'completed' AND status != 'deleted'
    ORDER BY created_at DESC
  `).all() as any[]
}

function buildGlobalMatchLookup() {
  const docs = getCompletedDocumentsForMatching()
  const patients = getAllPatientRows()
  return {
    docs,
    patients,
    ...buildArchiveMatchLookup(docs, patients),
  }
}

function mapDocumentToFrontendTaskStatus(row: any, matchGroup?: any | null): string | null {
  if (row.status === 'pending_upload') return 'uploading'
  if (row.status === 'uploaded' || row.status === 'ocr_pending') return 'uploaded'
  if (row.status === 'ocr_running') return 'parsing'
  if (row.status === 'ocr_failed') return 'parse_failed'
  if (row.status === 'archived') return 'archived'
  if (row.status === 'ocr_succeeded') {
    if (row.meta_status === 'completed') {
      return mapGroupToFrontendTaskStatus(matchGroup ?? null, row) ?? 'pending_confirm_uncertain'
    }
    return 'parsed'
  }
  return row.status || null
}

function buildDocumentListItem(row: any, matchGroup?: any | null) {
  const metadata = safeParseMetadata(row.metadata)
  const metaResult = (metadata.result && typeof metadata.result === 'object' && !Array.isArray(metadata.result))
    ? metadata.result as Record<string, any>
    : metadata
  const ext = path.extname(row.file_name || '').replace('.', '').toLowerCase()
  const fileType = ext || (row.mime_type ? String(row.mime_type).split('/')[1] : null) || 'unknown'
  const taskStatus = mapDocumentToFrontendTaskStatus(row, matchGroup)
  const topCandidate = matchGroup?.candidatePatients?.[0] ?? null

  return {
    ...row,
    metadata,
    file_type: fileType,
    file_path: row.object_key || null,
    document_type: row.doc_type || metaResult['文档类型'] || null,
    document_sub_type: metaResult['文档子类型'] || null,
    is_parsed: row.status === 'ocr_succeeded' || row.status === 'archived',
    meta_status: row.meta_status ?? 'pending',
    extract_status: getJobStatus(row.id, 'extract'),
    materialize_status: getJobStatus(row.id, 'materialize'),
    task_status: taskStatus,
    match_score: topCandidate?.similarity ?? 0,
    ai_recommendation: topCandidate?.patientId ?? null,
  }
}

function normalizePatientPayload(body: any) {
  const payload = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  const name = String(payload.name ?? '').trim()
  const gender = payload.gender == null ? null : String(payload.gender).trim()
  const ageValue = payload.age
  const parsedAge = ageValue == null || ageValue === ''
    ? null
    : Number.isFinite(Number(ageValue)) ? String(parseInt(String(ageValue), 10)) : String(ageValue).trim()
  const birthDateRaw = payload.birth_date ?? payload.birthDate ?? null
  const phone = payload.phone == null ? null : String(payload.phone).trim()
  const idCard = payload.id_card ?? payload.idNumber ?? null
  const address = payload.address == null ? null : String(payload.address).trim()

  return {
    name: name || null,
    gender: gender || null,
    age: parsedAge || null,
    birthDate: birthDateRaw == null ? null : String(birthDateRaw).trim() || null,
    phone: phone || null,
    idCard: idCard == null ? null : String(idCard).trim() || null,
    address: address || null,
  }
}

function buildPatientDraftFromDocuments(documentRows: DocumentRecord[], overrides: ReturnType<typeof normalizePatientPayload>) {
  const names: string[] = []
  let gender: string | null = null
  let age: string | null = null
  let birthDate: string | null = null
  let phone: string | null = null
  let address: string | null = null
  let hospitalName: string | null = null
  let deptName: string | null = null
  const allIdentifiers: any[] = []

  for (const docRow of documentRows) {
    const meta = safeParseMetadata(docRow.metadata)
    const result = (meta.result && typeof meta.result === 'object' && !Array.isArray(meta.result))
      ? meta.result as Record<string, any>
      : meta

    if (result['患者姓名']) names.push(String(result['患者姓名']))
    if (!gender && result['患者性别']) gender = String(result['患者性别'])
    if (!age && result['患者年龄']) age = String(result['患者年龄'])
    if (!birthDate && result['出生日期']) birthDate = String(result['出生日期'])
    if (!phone && result['联系电话']) phone = String(result['联系电话'])
    if (!address && (result['地址'] || result['家庭住址'])) {
      address = String(result['地址'] || result['家庭住址'])
    }
    if (!hospitalName && result['机构名称']) hospitalName = String(result['机构名称'])
    if (!deptName && result['科室信息']) deptName = String(result['科室信息'])
    if (Array.isArray(result['唯一标识符'])) {
      allIdentifiers.push(...result['唯一标识符'])
    }
  }

  const nameCounts = new Map<string, number>()
  let mostFreqName: string | null = null
  let maxNameCount = 0
  for (const name of names) {
    const count = (nameCounts.get(name) || 0) + 1
    nameCounts.set(name, count)
    if (count > maxNameCount) {
      maxNameCount = count
      mostFreqName = name
    }
  }

  const dedupedIdentifierMap = new Map<string, any>()
  for (const identifier of allIdentifiers) {
    if (!identifier || typeof identifier !== 'object') continue
    const type = String((identifier as any)['标识符类型'] || 'Unknown')
    const value = String((identifier as any)['标识符编号'] || 'Unknown')
    dedupedIdentifierMap.set(`${type}-${value}`, identifier)
  }

  if (overrides.idCard) {
    dedupedIdentifierMap.set(`身份证号-${overrides.idCard}`, {
      '标识符类型': '身份证号',
      '标识符编号': overrides.idCard,
    })
  }

  const patientName = overrides.name || mostFreqName || '未命名患者'
  const patientMeta = {
    '患者性别': overrides.gender ?? gender,
    '患者年龄': overrides.age ?? age,
    '出生日期': overrides.birthDate ?? birthDate,
    '联系电话': overrides.phone ?? phone,
    '身份证号': overrides.idCard ?? null,
    '地址': overrides.address ?? address,
    '唯一标识符': Array.from(dedupedIdentifierMap.values()),
    '机构名称': hospitalName,
    '科室信息': deptName,
  }

  return {
    patientName,
    patientMeta,
  }
}

function createPatientAndArchiveDocuments(documentIds: string[], payload: any = {}) {
  const overrides = normalizePatientPayload(payload)

  const tx = db.transaction(() => {
    const documents: DocumentRecord[] = []
    for (const documentId of documentIds) {
      const row = stmtFindById.get(documentId) as DocumentRecord | undefined
      if (!row) throw new Error(`DOCUMENT_NOT_FOUND:${documentId}`)
      if (row.status === 'deleted') throw new Error(`DOCUMENT_DELETED:${documentId}`)
      if (row.patient_id) throw new Error(`DOCUMENT_ALREADY_ARCHIVED:${documentId}`)
      documents.push(row)
    }

    const { patientName, patientMeta } = buildPatientDraftFromDocuments(documents, overrides)
    const patientId = randomUUID()
    const currentTs = now()

    db.prepare(`
      INSERT INTO patients (id, name, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(patientId, patientName, JSON.stringify(patientMeta), currentTs, currentTs)

    const stmtUpdate = db.prepare(`
      UPDATE documents
      SET patient_id = ?, status = 'archived', materialize_status = 'pending', updated_at = ?
      WHERE id = ?
    `)

    for (const documentId of documentIds) {
      stmtUpdate.run(patientId, currentTs, documentId)
    }

    return {
      patientId,
      patientName,
      archivedDocumentIds: documentIds,
    }
  })

  return tx()
}

function archiveDocumentToPatient(documentId: string, patientId: string) {
  const row = stmtFindById.get(documentId) as DocumentRecord | undefined
  if (!row || row.status === 'deleted') {
    throw new Error('DOCUMENT_NOT_FOUND')
  }

  const patient = db.prepare(`SELECT * FROM patients WHERE id = ?`).get(patientId) as any
  if (!patient) {
    throw new Error('PATIENT_NOT_FOUND')
  }

  const currentTs = now()
  db.prepare(`
    UPDATE documents
    SET patient_id = ?, status = 'archived', materialize_status = 'pending', updated_at = ?
    WHERE id = ?
  `).run(patientId, currentTs, documentId)

  return {
    updated: stmtFindById.get(documentId) as DocumentRecord,
    patientName: patient.name || null,
  }
}

function buildAiMatchPayload(row: DocumentRecord) {
  const patients = getAllPatientRows()
  const allDocs = getCompletedDocumentsForMatching()
  const lookup = buildArchiveMatchLookup(allDocs, patients)
  let group = lookup.byDocumentId.get(row.id) || null

  if (!group) {
    group = buildArchiveMatchGroups([row], patients, { includeRawDocuments: true })[0] || null
  }

  const meta = safeParseMetadata(row.metadata)
  const result = (meta.result && typeof meta.result === 'object' && !Array.isArray(meta.result))
    ? meta.result as Record<string, any>
    : meta
  const identifiers = Array.isArray(result['唯一标识符'])
    ? result['唯一标识符']
        .map((item: any) => String(item?.['标识符编号'] ?? item?.value ?? '').trim())
        .filter(Boolean)
    : []
  const topCandidate = group?.candidatePatients?.[0] ?? null

  const matchResult = group?.status === 'matched_existing'
    ? 'matched'
    : group?.status === 'needs_confirmation'
      ? 'review'
      : group?.status === 'new_patient_candidate'
        ? 'new'
        : 'uncertain'

  return {
    document_id: row.id,
    matched_patient_id: group?.matched_patient_id ?? null,
    extracted_info: {
      name: result['患者姓名'] ?? null,
      gender: result['患者性别'] ?? null,
      age: result['患者年龄'] ?? null,
      birth_date: result['出生日期'] ?? null,
      phone: result['联系电话'] ?? null,
      id_number: result['身份证号'] ?? null,
      address: result['地址'] ?? result['家庭住址'] ?? null,
    },
    document_metadata: {
      name: result['患者姓名'] ?? null,
      gender: result['患者性别'] ?? null,
      age: result['患者年龄'] ?? null,
      birth_date: result['出生日期'] ?? null,
      phone: result['联系电话'] ?? null,
      id_number: result['身份证号'] ?? null,
      address: result['地址'] ?? result['家庭住址'] ?? null,
    },
    identifiers,
    confidence: group?.confidence ?? 'low',
    match_score: topCandidate?.similarity ?? 0,
    match_result: matchResult,
    ai_recommendation: topCandidate?.patientId ?? null,
    ai_reason: group?.matchReason ?? '暂无可用匹配结果',
    candidates: (group?.candidatePatients ?? []).map((candidate: any) => ({
      id: candidate.patientId,
      name: candidate.name,
      patient_code: candidate.patient_code,
      similarity: candidate.similarity,
      match_reasoning: candidate.match_reasoning,
      key_evidence: candidate.key_evidence,
      concerns: candidate.concerns,
      gender: candidate.gender,
      age: candidate.age,
    })),
    group_id: group?.groupId ?? null,
    group_reason: group?.groupReason ?? '',
    match_reason: group?.matchReason ?? '',
    patient_snapshot: group?.patientSnapshot ?? null,
  }
}

function getTodoMatchGroups() {
  const { groups } = buildGlobalMatchLookup()
  return groups.filter((group) => group.documents.some((doc) => doc.status !== 'archived'))
}

function getMatchGroupById(groupId: string) {
  if (!groupId) return null
  return getTodoMatchGroups().find((group) => group.groupId === groupId) || null
}

function buildPatientLabelInfo(patientRow: any) {
  const metadata = safeParseMetadata(patientRow?.metadata)
  return {
    name: patientRow?.name || '未知患者',
    gender: metadata.gender ?? metadata['患者性别'] ?? '--',
    age: metadata.age ?? metadata['患者年龄'] ?? '--',
  }
}

/** 中文 metadata key → 前端英文 key 映射 */
const META_KEY_MAP: Record<string, string> = {
  '机构名称': 'organizationName',
  '患者姓名': 'patientName',
  '患者性别': 'gender',
  '患者年龄': 'age',
  '文档类型': 'documentType',
  '文档子类型': 'documentSubtype',
  '文档标题': 'docTitle',
  '文档生效日期': 'effectiveDate',
  '唯一标识符': 'identifiers',
  '出生日期': 'birthDate',
  '联系电话': 'phone',
  '诊断': 'diagnosis',
  '科室信息': 'department',
}

/** 反向映射：英文 key → 中文 key */
const META_KEY_MAP_REVERSE: Record<string, string> = Object.fromEntries(
  Object.entries(META_KEY_MAP).map(([k, v]) => [v, k])
)

/** 从 metadata JSON 中提取 result 并映射为前端期望的英文 key */
function normalizeMetadata(metadataStr: string): Record<string, any> {
  let meta: any = {}
  try { meta = JSON.parse(metadataStr || '{}') } catch {}
  const result = meta?.result || meta || {}
  const normalized: Record<string, any> = {}
  for (const [cnKey, enKey] of Object.entries(META_KEY_MAP)) {
    if (result[cnKey] !== undefined) {
      normalized[enKey] = result[cnKey]
    }
  }
  return normalized
}

/** 从 raw_text 生成简化的 content_list（无 ocr_payload 时的降级方案） */
function rawTextToContentList(rawText: string | null): any[] {
  if (!rawText || rawText.trim().length === 0) return []
  // 按连续空行分段
  const paragraphs = rawText.split(/\n{2,}/).filter(p => p.trim().length > 0)
  return paragraphs.map((text, idx) => ({
    type: 'paragraph',
    sub_type: idx === 0 ? 'header' : 'body',
    text: text.trim(),
    page_id: 1,
    position: [],
    _originalIndex: idx
  }))
}

/** 从 ocr_payload 或 raw_text 解析 content_list */
function buildContentList(row: DocumentRecord): any[] {
  // 1. 优先使用 ocr_payload
  if (row.ocr_payload) {
    try {
      const payload = JSON.parse(row.ocr_payload)
      if (Array.isArray(payload.segments) && payload.segments.length > 0) {
        return payload.segments.map((seg: any, idx: number) => ({
          ...seg,
          _originalIndex: idx
        }))
      }
    } catch {}
  }
  // 2. 尝试将 raw_text 当作 OCR JSON 解析（当前 OCR worker 将结构化结果存入了 raw_text）
  if (row.raw_text) {
    try {
      const payload = JSON.parse(row.raw_text)
      if (Array.isArray(payload.segments) && payload.segments.length > 0) {
        return payload.segments.map((seg: any, idx: number) => ({
          ...seg,
          _originalIndex: idx
        }))
      }
    } catch {
      // 不是 JSON，当作纯文本处理
    }
  }
  // 3. 最终降级：按段落分割纯文本
  return rawTextToContentList(row.raw_text)
}

/** 组装 linked_patients */
function buildLinkedPatients(patientId: string | null): any[] {
  if (!patientId) return []
  const patient = db.prepare(`SELECT * FROM patients WHERE id = ?`).get(patientId) as any
  if (!patient) return []
  let meta: any = {}
  try { meta = JSON.parse(patient.metadata || '{}') } catch {}
  return [{
    patient_id: patient.id,
    patient_name: patient.name || '未知患者',
    patient_code: patient.id.substring(0, 8),
    gender: meta['患者性别'] || null,
    age: meta['患者年龄'] || null,
    birth_date: meta['出生日期'] || null,
    phone: meta['联系电话'] || null,
    id_card: meta['身份证号'] || null,
    address: meta['地址'] || null,
    department: meta['科室信息'] || null,
    attending_doctor: meta['主治医师'] || null,
    diagnoses: Array.isArray(meta['主要诊断']) ? meta['主要诊断'] : (meta['诊断'] ? [meta['诊断']] : []),
  }]
}

/** 组装 extraction_records（从 documents.extract_result_json + extraction_runs 表） */
function buildExtractionRecords(documentId: string): { records: any[], count: number } {
  // 1. 先查 extraction_runs 表
  const runs = db.prepare(`
    SELECT * FROM extraction_runs WHERE document_id = ? ORDER BY created_at DESC
  `).all(documentId) as any[]

  if (runs.length > 0) {
    const records = runs.map(run => ({
      extraction_id: run.id,
      created_at: run.created_at,
      status: run.status,
      model_name: run.model_name,
      is_merged: false,  // TODO: 后续从合并记录判断
      merged_at: null,
      conflict_count: 0,
      extracted_ehr_data: {},  // extraction_runs 的数据需要另外从 field_value_candidates 聚合
    }))
    return { records, count: records.length }
  }

  // 2. 降级方案：从 documents.extract_result_json 读取
  const doc = db.prepare(`SELECT extract_result_json, extract_status, extract_completed_at FROM documents WHERE id = ?`).get(documentId) as any
  if (!doc?.extract_result_json) return { records: [], count: 0 }

  try {
    const ehrData = JSON.parse(doc.extract_result_json)
    const records = [{
      extraction_id: `${documentId}-extract-0`,
      created_at: doc.extract_completed_at || now(),
      status: doc.extract_status || 'succeeded',
      model_name: ehrData?._extraction_metadata?.model || 'unknown',
      is_merged: false,
      merged_at: null,
      conflict_count: 0,
      extracted_ehr_data: ehrData,
    }]
    return { records, count: 1 }
  } catch {
    return { records: [], count: 0 }
  }
}

/** 触发 Celery 文档流水线 */
function triggerPipelineProcess(documentId: string, tasks: string[]) {
  crfServiceFetch('/api/pipeline/process', {
    method: 'POST',
    body: JSON.stringify({ document_id: documentId, tasks })
  }).catch(err => {
    console.error(`[triggerPipelineProcess] 触发任务失败: document_id=${documentId}, tasks=${tasks}`, err)
  })
}

// ─── Prepared statements ──────────────────────────────────────────────────────

const stmtInsert = db.prepare(`
  INSERT INTO documents
    (id, patient_id, file_name, file_size, mime_type, object_key,
     status, batch_id, doc_type, doc_title, effective_at, metadata, raw_text,
     created_at, updated_at)
  VALUES
    (@id, @patient_id, @file_name, @file_size, @mime_type, @object_key,
     @status, @batch_id, @doc_type, @doc_title, @effective_at, @metadata, @raw_text,
     @created_at, @updated_at)
`)

const stmtFindById = db.prepare<[string]>(`
  SELECT * FROM documents WHERE id = ?
`)

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/documents/upload
 * 接收文件二进制 (multipart/form-data)，保存到本地磁盘，创建 DB 记录，
 * 自动设置 status = ocr_pending 以便 pipeline-daemon 自动发现并处理
 */
router.post('/upload', upload.single('file'), (req: Request, res: Response) => {
  const file = (req as any).file as Express.Multer.File | undefined

  if (!file) {
    return res.status(400).json({
      success: false, code: 400,
      message: '缺少文件',
      data: null,
    })
  }

  const batchId = req.body.batchId ?? null

  const id = randomUUID()
  // object_key 指向本地磁盘路径（相对于 uploads 目录）
  const objectKey = path.join(UPLOADS_DIR, file.filename)
  const ts = now()

  stmtInsert.run({
    id,
    patient_id:   null,
    file_name:    file.originalname,
    file_size:    file.size,
    mime_type:    file.mimetype,
    object_key:   objectKey,
    status:       'ocr_pending',   // 直接进入 OCR 排队
    batch_id:     batchId,
    doc_type:     null,
    doc_title:    file.originalname,
    effective_at: null,
    metadata:     '{}',
    raw_text:     null,
    created_at:   ts,
    updated_at:   ts,
  })

  const row = stmtFindById.get(id) as DocumentRecord
  
  // 触发后台流水线 (OCR -> Meta)
  triggerPipelineProcess(id, ['ocr', 'meta'])

  return res.status(201).json({
    success: true, code: 0,
    message: '上传成功，解析流水线已调度',
    data: serialize(row),
  })
})

/**
 * POST /api/v1/documents/upload-init
 */
router.post('/upload-init', (req: Request, res: Response) => {
  const { fileName, fileSize, mimeType, patientId, batchId } = req.body

  if (!fileName || fileSize === undefined || !mimeType) {
    return res.status(400).json({
      success: false, code: 400,
      message: '缺少必填参数：fileName, fileSize, mimeType',
      data: null,
    })
  }

  if (typeof fileSize !== 'number' || fileSize <= 0) {
    return res.status(400).json({
      success: false, code: 400,
      message: 'fileSize 必须为正整数',
      data: null,
    })
  }

  const id = randomUUID()
  const objectKey = `uploads/${id}/${fileName}`
  const ts = now()

  stmtInsert.run({
    id,
    patient_id:   patientId ?? null,
    file_name:    fileName,
    file_size:    fileSize,
    mime_type:    mimeType,
    object_key:   objectKey,
    status:       'pending_upload',
    batch_id:     batchId ?? null,
    doc_type:     null,
    doc_title:    fileName,
    effective_at: null,
    metadata:     '{}',
    raw_text:     null,
    created_at:   ts,
    updated_at:   ts,
  })

  return res.status(201).json({
    success: true, code: 0,
    message: '初始化上传成功',
    data: { documentId: id, objectKey, status: 'pending_upload' },
  })
})

/**
 * POST /api/v1/documents/complete
 */
router.post('/complete', async (req: Request, res: Response) => {
  const { documentId, objectKey } = req.body

  if (!documentId || !objectKey) {
    return res.status(400).json({
      success: false, code: 400,
      message: '缺少必填参数：documentId, objectKey',
      data: null,
    })
  }

  const row = stmtFindById.get(documentId) as DocumentRecord | undefined
  if (!row) {
    return res.status(404).json({ success: false, code: 404, message: '文档不存在', data: null })
  }

  if (row.status !== 'pending_upload') {
    return res.status(409).json({
      success: false, code: 409,
      message: `当前状态 ${row.status} 不允许执行 complete 操作`,
      data: null,
    })
  }

  // 更新为 ocr_pending
  db.prepare(`
    UPDATE documents SET object_key = ?, status = 'ocr_pending', updated_at = ? WHERE id = ?
  `).run(objectKey, now(), documentId)

  // 触发后台流水线 (OCR -> Meta)
  triggerPipelineProcess(documentId, ['ocr', 'meta'])

  const updated = stmtFindById.get(documentId) as DocumentRecord
  return res.json({ success: true, code: 0, message: '上传完成，解析流水线已调度', data: serialize(updated) })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 靶向上传（SchemaForm 右上角"上传文档"按钮发起）
// ═══════════════════════════════════════════════════════════════════════════════

// CRF_SERVICE_URL 已从 ../services/crfServiceClient 统一导入，保留此处注释便于检索。

/** 把前端 dot 分隔的 selectedPath 前两层转成 CRF Service 期望的 form_name 格式。
 *  例："基本信息.人口学情况" → "基本信息 / 人口学情况"；单层 → 原样返回。 */
function targetSectionToFormName(dotPath: string | null | undefined): string | null {
  if (!dotPath) return null
  const parts = String(dotPath).split('.').filter(Boolean).slice(0, 2)
  if (parts.length === 0) return null
  return parts.join(' / ')
}

/**
 * POST /api/v1/documents/upload-and-archive-async
 *
 * 靶向上传：multer 接文件 → 直接绑定 patient_id + target_section → 触发 OCR+meta 流水线。
 * 抽取由 GET /tasks/:id 在 meta 完成后隐式触发（带 target_section，让 CRF Service 走靶向模式）。
 */
function handleUploadAndArchiveAsync(req: Request, res: Response) {
  const file = (req as any).file as Express.Multer.File | undefined
  if (!file) {
    return res.status(400).json({ success: false, code: 400, message: '缺少文件', data: null })
  }

  const patientId = String(req.body.patient_id ?? req.query.patient_id ?? '').trim()
  if (!patientId) {
    return res.status(400).json({ success: false, code: 400, message: '缺少 patient_id', data: null })
  }
  const patient = db.prepare(`SELECT id FROM patients WHERE id = ?`).get(patientId) as any
  if (!patient) {
    return res.status(404).json({ success: false, code: 404, message: '患者不存在', data: null })
  }

  const targetSection = req.body.target_section ?? req.query.target_section
  const projectId = req.body.project_id ?? req.query.project_id
  const autoMergeEhr = parseBooleanFlag(req.body.auto_merge_ehr ?? req.query.auto_merge_ehr, true)
  const parserType = String(req.body.parser_type ?? req.query.parser_type ?? '').trim() || null

  // 若带 projectId，校验患者是否已入组该项目
  if (projectId) {
    const enrolled = db
      .prepare(`SELECT 1 FROM project_patients WHERE project_id = ? AND patient_id = ?`)
      .get(projectId, patientId) as any
    if (!enrolled) {
      return res.status(400).json({
        success: false, code: 400,
        message: '患者未入组指定项目，无法靶向上传到项目 CRF',
        data: null,
      })
    }
  }

  const id = randomUUID()
  const objectKey = path.join(UPLOADS_DIR, file.filename)
  const ts = now()
  const metadataObj: Record<string, unknown> = {
    target_section: targetSection ? String(targetSection).trim() : null,
    project_id: projectId ? String(projectId).trim() : null,
    auto_merge_ehr: autoMergeEhr,
    parser_type: parserType,
  }

  stmtInsert.run({
    id,
    patient_id: patientId,                  // 直接绑定，不走归档
    file_name: file.originalname,
    file_size: file.size,
    mime_type: file.mimetype,
    object_key: objectKey,
    status: 'ocr_pending',
    batch_id: null,
    doc_type: null,
    doc_title: file.originalname,
    effective_at: null,
    metadata: JSON.stringify(metadataObj),
    raw_text: null,
    created_at: ts,
    updated_at: ts,
  })

  triggerPipelineProcess(id, ['ocr', 'meta'])

  return res.status(201).json({
    success: true, code: 0,
    message: '上传成功，OCR / 元数据 / 抽取流水线将依次推进',
    data: { task_id: id, document_id: id },
  })
}

router.post('/upload-and-archive-async', upload.single('file'), handleUploadAndArchiveAsync)
router.post('/upload-and-archive/async', upload.single('file'), handleUploadAndArchiveAsync)
router.post('/upload-and-archive', upload.single('file'), handleUploadAndArchiveAsync)

/** 合成进度状态机。返回 { status, progress, current_step, file_name, message }
 *
 *  注：documents 表里 OCR 完成状态实际由两列维护，历史原因 OCR worker 只写
 *  `status`（总览列），**不**写 `ocr_status` 独立列。所以这里把 OCR 的完成状态
 *  由 `ocr_status ∈ {succeeded,completed}` **或** `status ∈ {ocr_succeeded,archived}` 任一满足即视为完成。
 */
function buildTaskProgress(doc: any, job: any): {
  status: 'pending' | 'processing' | 'completed' | 'failed'
  progress: number
  current_step: string
  file_name: string
  message: string
} {
  const fileName = doc.file_name || ''
  const rawStatus = (doc.status || '').toLowerCase()
  const ocrCol = (doc.ocr_status || 'pending').toLowerCase()
  const meta = (doc.meta_status || 'pending').toLowerCase()
  const extract = (doc.extract_status || 'pending').toLowerCase()

  // 归一化 OCR 状态：任一信号提示 OCR 成功都算成功
  const ocrDone =
    ocrCol === 'succeeded' || ocrCol === 'completed' ||
    rawStatus === 'ocr_succeeded' || rawStatus === 'archived'
  const ocrRunning = ocrCol === 'running'
  const ocrFailed = ocrCol === 'failed' || rawStatus === 'ocr_failed'

  if (ocrFailed) {
    return { status: 'failed', progress: 0, current_step: 'OCR 失败', file_name: fileName, message: doc.ocr_error_message || 'OCR 解析失败' }
  }
  if (meta === 'failed') {
    return { status: 'failed', progress: 20, current_step: '元数据抽取失败', file_name: fileName, message: doc.meta_error_message || '文档元数据识别失败' }
  }

  if (!ocrDone && !ocrRunning) {
    return { status: 'pending', progress: 5, current_step: '已上传，等待 OCR...', file_name: fileName, message: '' }
  }
  if (!ocrDone && ocrRunning) {
    return { status: 'processing', progress: 15, current_step: 'OCR 解析中...', file_name: fileName, message: '' }
  }
  // ocr 已完成
  if (meta === 'pending' || meta === 'queued' || !meta) {
    return { status: 'processing', progress: 40, current_step: 'OCR 完成，准备识别文档类型...', file_name: fileName, message: '' }
  }
  if (meta === 'running') {
    return { status: 'processing', progress: 55, current_step: '识别文档类型和字段...', file_name: fileName, message: '' }
  }
  // meta = completed
  if (extract === 'failed') {
    const jobErr = job?.last_error || doc.extract_error_message || 'AI 抽取失败'
    return { status: 'failed', progress: 70, current_step: 'AI 抽取失败', file_name: fileName, message: jobErr }
  }
  if (!extract || extract === 'pending') {
    return { status: 'processing', progress: 70, current_step: '准备 AI 抽取...', file_name: fileName, message: '' }
  }
  if (extract === 'running') {
    return { status: 'processing', progress: 85, current_step: 'AI 抽取中...', file_name: fileName, message: '' }
  }
  // extract = succeeded / completed
  return { status: 'completed', progress: 100, current_step: '完成', file_name: fileName, message: '文档已抽取并回填' }
}

/** 判定是否该在此次 progress 查询里自动触发一次 extract。
 *  条件：OCR 完成 & meta 完成 & 还没触发过 extract 任务 & autoMergeEhr=true
 *  OCR 完成判定与 buildTaskProgress 对齐（兼容总览 status 和独立 ocr_status 两列）。*/
function shouldAutoTriggerExtract(doc: any, autoMergeEhr: boolean): boolean {
  if (!autoMergeEhr) return false
  const rawStatus = (doc.status || '').toLowerCase()
  const ocrCol = (doc.ocr_status || '').toLowerCase()
  const meta = (doc.meta_status || '').toLowerCase()
  const ocrDone =
    ocrCol === 'succeeded' || ocrCol === 'completed' ||
    rawStatus === 'ocr_succeeded' || rawStatus === 'archived'
  if (!ocrDone) return false
  if (meta !== 'completed' && meta !== 'succeeded') return false

  // 已有任何 pending/running 的 extract job 则不重复触发
  const active = db.prepare(`
    SELECT 1 FROM ehr_extraction_jobs
    WHERE document_id = ? AND job_type = 'extract' AND status IN ('pending', 'running')
    LIMIT 1
  `).get(doc.id) as any
  if (active) return false

  // 已经 completed 过（extract_status = succeeded/completed）也不再触发
  const ex = (doc.extract_status || '').toLowerCase()
  if (ex === 'succeeded' || ex === 'completed') return false

  return true
}

function handleTaskProgress(req: Request, res: Response) {
  const taskId = String(req.params.taskId || '').trim()
  if (!taskId) {
    return res.status(400).json({ success: false, code: 400, message: '缺少 taskId', data: null })
  }

  const doc = db.prepare(`
    SELECT id, patient_id, file_name, status, metadata,
           ocr_status, ocr_error_message,
           meta_status, meta_error_message,
           extract_status, extract_error_message
    FROM documents WHERE id = ?
  `).get(taskId) as any
  if (!doc) {
    return res.status(404).json({ success: false, code: 404, message: '任务不存在', data: null })
  }

  const meta = safeParseMetadata(doc.metadata)
  const targetSectionDot = (meta.target_section as string | null) || null
  const projectId = (meta.project_id as string | null) || null
  const autoMergeEhr = meta.auto_merge_ehr !== false

  // 隐式 auto-trigger：meta 完成 → 触发一次 extract
  if (shouldAutoTriggerExtract(doc, autoMergeEhr)) {
    // 决定 schema_id / instance_type
    let schemaId: string | null = null
    let instanceType: 'patient_ehr' | 'project_crf' = 'patient_ehr'
    if (projectId) {
      const proj = db.prepare(`SELECT schema_id FROM projects WHERE id = ?`).get(projectId) as any
      if (proj?.schema_id) {
        schemaId = proj.schema_id
        instanceType = 'project_crf'
      }
    }
    if (!schemaId) {
      schemaId = getDefaultSchemaId()
    }

    if (schemaId && doc.patient_id) {
      const payload: Record<string, unknown> = {
        patient_id: doc.patient_id,
        schema_id: schemaId,
        document_ids: [doc.id],
        instance_type: instanceType,
      }
      if (projectId && instanceType === 'project_crf') payload.project_id = projectId
      const targetForm = targetSectionToFormName(targetSectionDot)
      if (targetForm) payload.target_section = targetForm

      // fire-and-forget；CRF Service 返回 202 后我们不等
      crfServiceSubmitBatch(payload).catch(err => {
        console.error(`[tasks/${taskId}] auto-trigger extract 失败:`, err)
      })
    }
  }

  const job = db.prepare(`
    SELECT status, last_error
    FROM ehr_extraction_jobs
    WHERE document_id = ? AND job_type = 'extract'
    ORDER BY created_at DESC LIMIT 1
  `).get(taskId) as any

  const progress = buildTaskProgress(doc, job)
  return res.json({
    success: true, code: 0, message: 'ok',
    data: {
      task_id: taskId,
      document_id: taskId,
      ...progress,
    },
  })
}

/**
 * GET /api/v1/documents/tasks/:taskId
 * GET /api/v1/documents/tasks/:taskId/progress
 */
router.get('/tasks/:taskId', handleTaskProgress)
router.get('/tasks/:taskId/progress', handleTaskProgress)

/**
 * GET /api/v1/documents
 */
router.get('/', (req: Request, res: Response) => {
  try {
    const { patientId, status, ids, task_status, page, page_size, keyword } = req.query

    let sql = `SELECT * FROM documents WHERE status != 'deleted'`
    const params: string[] = []

    if (patientId) {
      sql += ` AND patient_id = ?`
      params.push(String(patientId))
    }
    if (status) {
      sql += ` AND status = ?`
      params.push(String(status))
    }
    // 支持按 id 列表过滤（逗号分隔）
    if (ids) {
      const idList = String(ids).split(',')
      const placeholders = idList.map(() => '?').join(',')
      sql += ` AND id IN (${placeholders})`
      params.push(...idList)
    }
    sql += ` ORDER BY created_at DESC`

    const rows = db.prepare(sql).all(...params) as any[]
    const { byDocumentId } = buildGlobalMatchLookup()

    let filteredRows = rows
    const taskStatusFilters = parseCommaSeparatedIds(task_status)
    if (taskStatusFilters.length > 0) {
      const allowed = new Set(taskStatusFilters)
      filteredRows = filteredRows.filter((row) => {
        const derivedTaskStatus = mapDocumentToFrontendTaskStatus(row, byDocumentId.get(row.id) ?? null)
        return derivedTaskStatus ? allowed.has(derivedTaskStatus) : false
      })
    }

    if (typeof keyword === 'string' && keyword.trim()) {
      const q = keyword.trim().toLowerCase()
      filteredRows = filteredRows.filter((row) => String(row.file_name || '').toLowerCase().includes(q))
    }

    const pageNumber = Math.max(1, Number.parseInt(String(page ?? '1'), 10) || 1)
    const rawPageSize = page_size == null ? String(filteredRows.length || 1) : String(page_size)
    const pageSize = Math.max(1, Number.parseInt(rawPageSize, 10) || filteredRows.length || 1)
    const total = filteredRows.length
    const start = (pageNumber - 1) * pageSize
    const pagedRows = filteredRows.slice(start, start + pageSize)

    return res.json({
      success: true, code: 0, message: 'ok',
      data: pagedRows.map((row) => buildDocumentListItem(row, byDocumentId.get(row.id) ?? null)),
      pagination: {
        page: pageNumber,
        page_size: pageSize,
        total,
        total_pages: Math.max(1, Math.ceil(total / pageSize)),
      },
    })
  } catch (err: any) {
    console.error('[GET /documents]', err)
    return res.status(500).json({
      success: false,
      code: 500,
      message: err?.message || '服务器错误',
      data: null,
    })
  }
})

/**
 * GET /api/v1/documents/v2/tree
 * 为患者视图返回待归档分组与已归档患者树。
 */
router.get('/v2/tree', (_req: Request, res: Response) => {
  try {
    const docs = db.prepare(`
      SELECT * FROM documents
      WHERE status != 'deleted'
      ORDER BY created_at DESC
    `).all() as any[]
    const patients = getAllPatientRows()
    const patientMap = new Map<string, any>()
    patients.forEach((patient) => {
      if (patient?.id) patientMap.set(String(patient.id), patient)
    })

    let parseTotal = 0
    let todoTotal = 0
    let archivedTotal = 0
    const archivedByPatientId = new Map<string, any[]>()

    const { byDocumentId } = buildGlobalMatchLookup()
    docs.forEach((row) => {
      const taskStatus = mapDocumentToFrontendTaskStatus(row, byDocumentId.get(row.id) ?? null)
      if (taskStatus === 'archived') {
        archivedTotal += 1
        if (row.patient_id) {
          const patientId = String(row.patient_id)
          if (!archivedByPatientId.has(patientId)) archivedByPatientId.set(patientId, [])
          archivedByPatientId.get(patientId)!.push(row)
        }
      } else if (['pending_confirm_new', 'pending_confirm_review', 'pending_confirm_uncertain', 'auto_archived'].includes(String(taskStatus))) {
        todoTotal += 1
      } else if (['uploaded', 'parsing', 'parsed', 'extracted', 'parse_failed', 'ai_matching', 'uploading'].includes(String(taskStatus))) {
        parseTotal += 1
      }
    })

    const todoGroups = getTodoMatchGroups().map((group) => {
      const activeDocs = group.documents.filter((doc) => doc.status !== 'archived')
      const statusSet = Array.from(new Set(
        activeDocs
          .map((doc) => {
            const row = docs.find((item) => item.id === doc.id)
            return row ? mapDocumentToFrontendTaskStatus(row, group) : null
          })
          .filter(Boolean),
      ))

      return {
        group_id: group.groupId,
        label: {
          name: group.patientSnapshot?.name || group.displayName || '未知患者',
          gender: group.patientSnapshot?.gender || '--',
          age: group.patientSnapshot?.age || '--',
        },
        count: activeDocs.length,
        document_ids: activeDocs.map((doc) => doc.id),
        status_set: statusSet,
        matched_patient_id: group.matched_patient_id,
      }
    }).filter((group) => group.count > 0)

    const archivedPatients = Array.from(archivedByPatientId.entries()).map(([patientId, items]) => {
      const patient = patientMap.get(patientId)
      return {
        patient_id: patientId,
        patient_code: patient?.patient_code || patientId.slice(0, 8),
        label: buildPatientLabelInfo(patient),
        count: items.length,
        patient_status: 'active',
      }
    })

    return res.json({
      success: true,
      code: 0,
      message: 'ok',
      data: {
        total: docs.length,
        counts: {
          parse_total: parseTotal,
          todo_total: todoTotal,
          archived_total: archivedTotal,
        },
        todo_groups: todoGroups,
        archived_patients: archivedPatients,
      },
    })
  } catch (err: any) {
    console.error('[GET /documents/v2/tree]', err)
    return res.status(500).json({
      success: false,
      code: 500,
      message: err?.message || '服务器错误',
      data: null,
    })
  }
})

/**
 * GET /api/v1/documents/v2/groups/:groupId/documents
 * 兼容 frontend_new 的分组详情读取。
 */
router.get('/v2/groups/:groupId/documents', (req: Request, res: Response) => {
  const group = getMatchGroupById(String(req.params.groupId || '').trim())
  if (!group) {
    return res.status(404).json({ success: false, code: 404, message: '分组不存在', data: null })
  }

  // 待归档分组详情只返回当前仍未归档的文档，避免患者视图把同组已归档历史文档一起混进来。
  const activeGroupDocuments = group.documents.filter((doc) => doc.status !== 'archived')
  const pageNumber = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1)
  const rawGroupPageSize = req.query.page_size == null ? String(activeGroupDocuments.length || 1) : String(req.query.page_size)
  const pageSize = Math.max(1, Number.parseInt(rawGroupPageSize, 10) || activeGroupDocuments.length || 1)
  const allRows = activeGroupDocuments
    .map((doc) => stmtFindById.get(doc.id) as DocumentRecord | undefined)
    .filter(Boolean) as DocumentRecord[]
  const total = allRows.length
  const start = (pageNumber - 1) * pageSize
  const pagedRows = allRows.slice(start, start + pageSize)
  const matchInfo = {
    matched_patient_id: group.matched_patient_id,
    match_score: group.candidatePatients[0]?.similarity ?? 0,
    match_result: group.status === 'matched_existing'
      ? 'matched'
      : group.status === 'needs_confirmation'
        ? 'review'
        : group.status === 'new_patient_candidate'
          ? 'new'
          : 'uncertain',
    candidates: group.candidatePatients.map((candidate) => ({
      id: candidate.patientId,
      name: candidate.name,
      patient_code: candidate.patient_code,
      similarity: candidate.similarity,
      match_reasoning: candidate.match_reasoning,
      key_evidence: candidate.key_evidence,
      concerns: candidate.concerns,
    })),
    ai_recommendation: group.matched_patient_id,
    ai_reason: group.matchReason,
  }

  return res.json({
    success: true,
    code: 0,
    message: 'ok',
    data: {
      items: pagedRows.map((row) => buildDocumentListItem(row, group)),
      group: {
        group_id: group.groupId,
        display_name: group.displayName,
        status: group.status,
        confidence: group.confidence,
      },
      match_info: matchInfo,
      pagination: {
        page: pageNumber,
        page_size: pageSize,
        total,
        total_pages: Math.max(1, Math.ceil(total / pageSize)),
      },
    },
  })
})

/**
 * POST /api/v1/documents/v2/rebuild-groups
 * 当前为即时计算分组，返回摘要用于兼容前端调用。
 */
router.post('/v2/rebuild-groups', (_req: Request, res: Response) => {
  const groups = getTodoMatchGroups()
  const docsUpdated = groups.reduce((sum, group) => sum + group.documents.filter((doc) => doc.status !== 'archived').length, 0)
  return res.json({
    success: true,
    code: 0,
    message: '分组重建完成',
    data: {
      groups_count: groups.length,
      docs_updated: docsUpdated,
    },
  })
})

/**
 * POST /api/v1/documents/v2/groups/:groupId/match
 */
router.post('/v2/groups/:groupId/match', (req: Request, res: Response) => {
  const group = getMatchGroupById(String(req.params.groupId || '').trim())
  if (!group) {
    return res.status(404).json({ success: false, code: 404, message: '分组不存在', data: null })
  }

  return res.json({
    success: true,
    code: 0,
    message: 'ok',
    data: {
      group_id: group.groupId,
      matched_patient_id: group.matched_patient_id,
      match_score: group.candidatePatients[0]?.similarity ?? 0,
      match_result: group.status === 'matched_existing'
        ? 'matched'
        : group.status === 'needs_confirmation'
          ? 'review'
          : group.status === 'new_patient_candidate'
            ? 'new'
            : 'uncertain',
      confidence: group.confidence,
      ai_recommendation: group.matched_patient_id,
      ai_reason: group.matchReason,
      candidates: group.candidatePatients.map((candidate) => ({
        id: candidate.patientId,
        name: candidate.name,
        patient_code: candidate.patient_code,
        similarity: candidate.similarity,
        match_reasoning: candidate.match_reasoning,
        key_evidence: candidate.key_evidence,
        concerns: candidate.concerns,
      })),
    },
  })
})

/**
 * POST /api/v1/documents/v2/groups/:groupId/confirm-archive
 */
router.post('/v2/groups/:groupId/confirm-archive', (req: Request, res: Response) => {
  const group = getMatchGroupById(String(req.params.groupId || '').trim())
  if (!group) {
    return res.status(404).json({ success: false, code: 404, message: '分组不存在', data: null })
  }

  const patientId = String(req.body?.patientId ?? req.body?.patient_id ?? req.query.patient_id ?? req.query.patientId ?? '').trim()
  if (!patientId) {
    return res.status(400).json({ success: false, code: 400, message: '缺少 patient_id', data: null })
  }

  let archivedCount = 0
  let failedCount = 0
  const errors: Array<{ document_id: string, message: string }> = []
  for (const doc of group.documents.filter((item) => item.status !== 'archived')) {
    try {
      archiveDocumentToPatient(doc.id, patientId)
      archivedCount += 1
    } catch (err: any) {
      failedCount += 1
      errors.push({ document_id: doc.id, message: err?.message || '归档失败' })
    }
  }

  return res.json({
    success: true,
    code: 0,
    message: '分组归档完成',
    data: {
      archived_count: archivedCount,
      failed_count: failedCount,
      errors,
    },
  })
})

/**
 * POST /api/v1/documents/v2/groups/:groupId/create-patient-and-archive
 */
router.post('/v2/groups/:groupId/create-patient-and-archive', (req: Request, res: Response) => {
  const group = getMatchGroupById(String(req.params.groupId || '').trim())
  if (!group) {
    return res.status(404).json({ success: false, code: 404, message: '分组不存在', data: null })
  }

  const documentIds = group.documents.filter((doc) => doc.status !== 'archived').map((doc) => doc.id)
  if (documentIds.length === 0) {
    return res.status(400).json({ success: false, code: 400, message: '分组内没有可归档文档', data: null })
  }

  try {
    const result = createPatientAndArchiveDocuments(documentIds, req.body)
    return res.json({
      success: true,
      code: 0,
      message: '新建患者并归档成功',
      data: {
        patient_id: result.patientId,
        patient_name: result.patientName,
        patientId: result.patientId,
        patientName: result.patientName,
        archived_count: result.archivedDocumentIds.length,
        archived_document_ids: result.archivedDocumentIds,
      },
    })
  } catch (err: any) {
    const msg = err.message as string
    if (msg.startsWith('DOCUMENT_ALREADY_ARCHIVED:')) {
      return res.status(409).json({ success: false, code: 409, message: `文档已归档，无法新建患者: ${msg.split(':')[1]}`, data: null })
    }
    console.error('[group create-patient-and-archive] error:', err)
    return res.status(500).json({ success: false, code: 500, message: '服务器内部错误', data: null })
  }
})

/**
 * POST /api/v1/documents/v2/documents/:documentId/move-to-group
 * 当前分组为规则即时计算，先返回 no-op 兼容响应。
 */
router.post('/v2/documents/:documentId/move-to-group', (req: Request, res: Response) => {
  const documentId = String(req.params.documentId || '').trim()
  const row = stmtFindById.get(documentId) as DocumentRecord | undefined
  if (!row || row.status === 'deleted') {
    return res.status(404).json({ success: false, code: 404, message: '文档不存在', data: null })
  }

  return res.json({
    success: true,
    code: 0,
    message: '当前版本使用规则即时分组，未持久化移动操作',
    data: {
      document_id: documentId,
      new_group_id: String(req.query.target_group_id ?? '').trim() || null,
      old_group_id: null,
    },
  })
})

/**
 * GET /api/v1/documents/:id/pdf-stream
 * 流式返回文档原始文件（供前端 PDF 渲染器直接使用）
 * 直接 redirect 到 /uploads/{filename}，由 express.static 中间件服务
 */
router.get('/:id/pdf-stream', (req: Request, res: Response) => {
  const row = stmtFindById.get(String(req.params.id)) as DocumentRecord | undefined
  if (!row || row.status === 'deleted') {
    return res.status(404).json({ success: false, code: 404, message: '文档不存在', data: null })
  }
  const objectKey = row.object_key || ''
  if (!fs.existsSync(objectKey)) {
    return res.status(404).json({ success: false, code: 404, message: '文件不存在于磁盘', data: null })
  }
  const fileName = path.basename(objectKey)
  res.redirect(`/uploads/${encodeURIComponent(fileName)}`)
})

/**
 * GET /api/v1/documents/:id
 * 增强版文档详情：返回 normalized_metadata, linked_patients, content_list, extraction_records
 */
router.get('/:id', (req: Request, res: Response) => {
  const row = stmtFindById.get(String(req.params.id)) as DocumentRecord | undefined

  if (!row || row.status === 'deleted') {
    return res.status(404).json({ success: false, code: 404, message: '文档不存在', data: null })
  }

  const includePatients = req.query.include_patients !== 'false'
  const includeExtracted = req.query.include_extracted !== 'false'

  // 基础序列化
  const base = serialize(row)

  // 规范化元数据（中文 key → 英文 key）
  const normalizedMeta = normalizeMetadata(row.metadata)

  // OCR 内容块列表
  const contentList = buildContentList(row)

  // 关联患者
  const linkedPatients = includePatients ? buildLinkedPatients(row.patient_id) : []

  // 抽取记录
  const { records: extractionRecords, count: extractionCount } = includeExtracted
    ? buildExtractionRecords(row.id)
    : { records: [], count: 0 }

  // 文件类型
  const ext = path.extname(row.file_name || '').replace('.', '').toLowerCase()
  const fileType = ext || (row.mime_type?.split('/')[1]) || 'unknown'

  return res.json({
    success: true, code: 0, message: 'ok',
    data: {
      ...base,
      // 前端期望的规范化字段
      metadata: normalizedMeta,
      raw_metadata: JSON.parse(row.metadata ?? '{}'),
      file_type: fileType,
      // 文档状态
      isParsed: row.status === 'ocr_succeeded',
      meta_status: (row as any).meta_status ?? 'pending',
      extract_status: getJobStatus(row.id, 'extract'),
      materialize_status: getJobStatus(row.id, 'materialize'),
      // 关联数据
      linked_patients: linkedPatients,
      content_list: contentList,
      extraction_records: extractionRecords,
      extraction_count: extractionCount,
    }
  })
})

/**
 * GET /api/v1/documents/:id/ai-match-info
 * 兼容 frontend_new 的单文档匹配详情接口，复用 archive-batches 的规则打分逻辑。
 */
router.get('/:id/ai-match-info', (req: Request, res: Response) => {
  const row = stmtFindById.get(String(req.params.id)) as DocumentRecord | undefined
  if (!row || row.status === 'deleted') {
    return res.status(404).json({ success: false, code: 404, message: '文档不存在', data: null })
  }

  return res.json({
    success: true,
    code: 0,
    message: 'ok',
    data: buildAiMatchPayload(row),
  })
})

/**
 * GET /api/v1/documents/:id/temp-url
 * 获取文档预览的临时 URL
 */
router.get('/:id/temp-url', (req: Request, res: Response) => {
  const row = stmtFindById.get(String(req.params.id)) as DocumentRecord | undefined

  if (!row || row.status === 'deleted') {
    return res.status(404).json({ success: false, code: 404, message: '文档不存在', data: null })
  }

  // 本地模式：直接返回静态文件 URL
  // object_key 存的是完整路径如 /xxx/uploads/uuid.jpg
  const objectKey = row.object_key || ''
  const fileName = path.basename(objectKey)
  const ext = path.extname(row.file_name || '').replace('.', '').toLowerCase()
  const fileType = ext || (row.mime_type?.split('/')[1]) || 'unknown'

  // 检查文件是否存在
  if (!fs.existsSync(objectKey)) {
    return res.status(404).json({ success: false, code: 404, message: '文件不存在于磁盘', data: null })
  }

  const tempUrl = `/uploads/${fileName}`

  return res.json({
    success: true, code: 0, message: 'ok',
    data: {
      temp_url: tempUrl,
      file_type: fileType,
      file_name: row.file_name,
      mime_type: row.mime_type,
    }
  })
})

/**
 * PUT /api/v1/documents/:id/metadata
 * 保存用户编辑的元数据字段（英文 key → 中文 key 存库）
 */
router.put('/:id/metadata', (req: Request, res: Response) => {
  const row = stmtFindById.get(String(req.params.id)) as DocumentRecord | undefined

  if (!row || row.status === 'deleted') {
    return res.status(404).json({ success: false, code: 404, message: '文档不存在', data: null })
  }

  const updates = req.body
  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ success: false, code: 400, message: '请求体必须是 JSON 对象', data: null })
  }

  // 读取现有 metadata
  let meta: any = {}
  try { meta = JSON.parse(row.metadata || '{}') } catch {}
  if (!meta.result) meta.result = {}

  // 将前端英文 key 映射回中文 key 写入 result
  let changedCount = 0
  for (const [enKey, value] of Object.entries(updates)) {
    const cnKey = META_KEY_MAP_REVERSE[enKey]
    if (cnKey) {
      meta.result[cnKey] = value
      changedCount++
    }
  }

  // 同步更新 doc_type / effective_at 等顶层字段
  const docType = updates.documentType ?? row.doc_type
  const effectiveAt = updates.effectiveDate ?? row.effective_at

  db.prepare(`
    UPDATE documents SET metadata = ?, doc_type = ?, effective_at = ?, updated_at = ? WHERE id = ?
  `).run(JSON.stringify(meta), docType, effectiveAt, now(), String(req.params.id))

  return res.json({
    success: true, code: 0, message: '元数据保存成功',
    data: { updated_fields: changedCount }
  })
})

/**
 * POST /api/v1/documents/:id/extract-metadata
 * 触发重新抽取元数据（重置 meta_status 让 daemon 自动调度）
 */
router.post('/:id/extract-metadata', (req: Request, res: Response) => {
  const row = stmtFindById.get(String(req.params.id)) as DocumentRecord | undefined

  if (!row || row.status === 'deleted') {
    return res.status(404).json({ success: false, code: 404, message: '文档不存在', data: null })
  }

  // 与 buildTaskProgress 的 OCR 判定逻辑对齐：ocr_status 或 status 任一信号即可
  const ocrStatusCol = (row.ocr_status || '').toLowerCase()
  const rawStatus = (row.status || '').toLowerCase()
  const ocrDone =
    ocrStatusCol === 'succeeded' || ocrStatusCol === 'completed' ||
    rawStatus === 'ocr_succeeded' || rawStatus === 'archived' ||
    !!row.raw_text || !!row.ocr_payload
  if (!ocrDone) {
    return res.status(400).json({
      success: false, code: 400,
      message: '文档尚未完成 OCR 解析，无法抽取元数据', data: null
    })
  }
  db.prepare(`
    UPDATE documents SET meta_status = 'pending', meta_error_message = NULL, updated_at = ? WHERE id = ?
  `).run(now(), String(req.params.id))

  // 仅触发元数据流水线阶段
  triggerPipelineProcess(String(req.params.id), ['meta'])

  return res.json({
    success: true, code: 0, message: '元数据抽取任务已排队',
    data: { status: 'pending', document_id: String(req.params.id) }
  })
})

/**
 * POST /api/v1/documents/:id/extract-ehr
 * 触发 EHR 结构化抽取（重置 extract_status 让 daemon 自动调度）
 */
router.post('/:id/extract-ehr', async (req: Request, res: Response) => {
  const row = stmtFindById.get(String(req.params.id)) as DocumentRecord | undefined

  if (!row || row.status === 'deleted') {
    return res.status(404).json({ success: false, code: 404, message: '文档不存在', data: null })
  }

  // 与 buildTaskProgress 的 OCR 判定逻辑对齐：ocr_status 或 status 任一信号即可
  const ocrStatusCol2 = (row.ocr_status || '').toLowerCase()
  const rawStatus2 = (row.status || '').toLowerCase()
  const ocrDone2 =
    ocrStatusCol2 === 'succeeded' || ocrStatusCol2 === 'completed' ||
    rawStatus2 === 'ocr_succeeded' || rawStatus2 === 'archived' ||
    !!row.raw_text || !!row.ocr_payload
  if (!ocrDone2) {
    return res.status(400).json({
      success: false, code: 400,
      message: '文档尚未完成 OCR 解析，无法进行 EHR 抽取', data: null
    })
  }

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, any>
  const documentPatientId = String(row.patient_id || '').trim()
  const requestedPatientId = String(body.patient_id || '').trim()
  if (!documentPatientId) {
    return res.status(400).json({ success: false, code: 400, message: '文档未绑定患者，无法进行 EHR 抽取', data: null })
  }
  if (requestedPatientId && requestedPatientId !== documentPatientId) {
    return res.status(409).json({
      success: false,
      code: 409,
      message: '请求患者与文档绑定患者不一致',
      data: { document_patient_id: documentPatientId, requested_patient_id: requestedPatientId },
    })
  }
  const patientId = documentPatientId;
  if (!patientId) {
    return res.status(400).json({ success: false, code: 400, message: '无可用的 patient_id 绑定', data: null })
  }

  const meta = safeParseMetadata(row.metadata)
  let requestedProjectId = String(body.project_id || meta.project_id || '').trim() || null
  let schemaId = body.schema_id || null
  let instanceType = body.instance_type || null

  if (!requestedProjectId && instanceType === 'project_crf') {
    return res.status(400).json({
      success: false,
      code: 400,
      message: 'project_crf 抽取必须指定 project_id',
      data: null,
    })
  }

  if (requestedProjectId) {
    const proj = db.prepare(`SELECT schema_id FROM projects WHERE id = ?`).get(requestedProjectId) as { schema_id?: string } | undefined
    if (!proj?.schema_id) {
      return res.status(400).json({
        success: false,
        code: 400,
        message: '项目未绑定 CRF 模板/schema，无法进行科研靶向抽取',
        data: { project_id: requestedProjectId },
      })
    }
    if (!isPatientEnrolledInProject(patientId, requestedProjectId)) {
      return res.status(403).json({
        success: false,
        code: 403,
        message: '文档绑定患者未入组该项目，无法写入项目 CRF',
        data: { patient_id: patientId, project_id: requestedProjectId },
      })
    }
    schemaId = proj.schema_id
    instanceType = 'project_crf'
  }

  schemaId = schemaId || getDefaultSchemaId();
  if (!schemaId) {
    return res.status(500).json({
      success: false, code: 500,
      message: '未找到可用的 EHR schema', data: null
    })
  }

  const targetSection = body.target_section || null;
  try {
    const payload: Record<string, unknown> = {
      patient_id: patientId,
      schema_id: schemaId,
      document_ids: [String(req.params.id)],
      instance_type: instanceType || 'patient_ehr',
    };
    if (requestedProjectId && payload.instance_type === 'project_crf') payload.project_id = requestedProjectId;
    if (targetSection) payload.target_section = targetSection;

    let response: Awaited<ReturnType<typeof crfServiceSubmitSingle>>;
    try {
      response = await crfServiceSubmitSingle(payload);
    } catch (error: any) {
      return res.status(502).json({
        success: false,
        code: 502,
        message: `CRF 服务不可用：${error?.message || '提交失败'}`,
        data: { payload },
      });
    }

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ success: false, code: response.status, message: errorText, data: { payload } });
    }

    const responseData = await response.json();

    return res.json({
      success: true, code: 0, message: 'EHR 抽取任务已排队',
      data: { status: 'pending', document_id: String(req.params.id), job_id: responseData.job_id, celery_task_id: responseData.celery_task_id }
    });
  } catch (e: any) {
    return res.status(500).json({ success: false, code: 500, message: e.message, data: null });
  }
})

/**
 * POST /api/v1/documents/:id/reparse
 * 同步重新解析文档（重置 OCR 状态让 daemon 自动调度）
 */
router.post('/:id/reparse', (req: Request, res: Response) => {
  const row = stmtFindById.get(String(req.params.id)) as DocumentRecord | undefined

  if (!row || row.status === 'deleted') {
    return res.status(404).json({ success: false, code: 404, message: '文档不存在', data: null })
  }

  // 重置为 ocr_pending
  db.prepare(`
    UPDATE documents SET status = 'ocr_pending', raw_text = NULL, ocr_payload = NULL, 
      meta_status = 'pending', extract_status = 'pending', updated_at = ? WHERE id = ?
  `).run(now(), String(req.params.id))

  // 清除该文档的所有活跃 job（重解析后需要重新走流程）
  const schemaId = getDefaultSchemaId()
  if (schemaId) {
    db.prepare(`
      DELETE FROM ehr_extraction_jobs
      WHERE document_id = ? AND schema_id = ? AND status IN ('pending', 'running')
    `).run(String(req.params.id), schemaId)
  }

  // 触发后台流水线 (OCR -> Meta)
  triggerPipelineProcess(String(req.params.id), ['ocr', 'meta'])

  return res.json({
    success: true, code: 0, message: '重新解析任务已调度',
    data: { status: 'ocr_pending', document_id: String(req.params.id) }
  })
})

function handleUnarchive(req: Request, res: Response) {
  const row = stmtFindById.get(String(req.params.id)) as DocumentRecord | undefined

  if (!row || row.status === 'deleted') {
    return res.status(404).json({ success: false, code: 404, message: '文档不存在', data: null })
  }

  if (!row.patient_id) {
    return res.status(400).json({ success: false, code: 400, message: '文档未绑定患者', data: null })
  }

  // 清除 patient_id，状态回退到 ocr_succeeded（如果已 OCR 完）
  const newStatus = row.raw_text ? 'ocr_succeeded' : row.status
  db.prepare(`
    UPDATE documents SET patient_id = NULL, status = ?, materialize_status = 'pending', updated_at = ? WHERE id = ?
  `).run(newStatus, now(), String(req.params.id))

  return res.json({
    success: true, code: 0, message: '已解除患者绑定',
    data: { document_id: String(req.params.id) }
  })
}

/**
 * POST /api/v1/documents/:id/unarchive
 * PUT  /api/v1/documents/:id/unarchive
 * 兼容新旧前端的解除患者绑定请求。
 */
router.post('/:id/unarchive', handleUnarchive)
router.put('/:id/unarchive', handleUnarchive)

/**
 * GET /api/v1/documents/:id/operation-history
 * 操作历史 — 从现有数据聚合（简化实现）
 */
router.get('/:id/operation-history', (req: Request, res: Response) => {
  const row = stmtFindById.get(String(req.params.id)) as DocumentRecord | undefined

  if (!row || row.status === 'deleted') {
    return res.status(404).json({ success: false, code: 404, message: '文档不存在', data: null })
  }

  const history: any[] = []

  // 1. 上传事件
  history.push({
    id: `${row.id}-upload`,
    type: 'upload',
    title: '文档上传',
    description: `上传文件 ${row.file_name} (${(row.file_size / 1024).toFixed(1)}KB)`,
    operator_type: 'system',
    operator_name: '系统',
    created_at: row.created_at
  })

  // 2. OCR 完成事件
  if (row.status === 'ocr_succeeded' || row.raw_text) {
    history.push({
      id: `${row.id}-ocr`,
      type: 'extraction',
      title: 'OCR 解析完成',
      description: `文档已完成 OCR 文字识别`,
      operator_type: 'ai',
      operator_name: 'OCR引擎',
      created_at: row.updated_at
    })
  }

  // 3. 元数据抽取事件
  const metaStatus = (row as any).meta_status
  if (metaStatus === 'completed') {
    const metaCompletedAt = (row as any).meta_completed_at
    history.push({
      id: `${row.id}-meta`,
      type: 'extraction',
      title: '元数据抽取完成',
      description: '提取到文档类型、患者信息等元数据字段',
      operator_type: 'ai',
      operator_name: 'AI系统',
      created_at: metaCompletedAt || row.updated_at
    })
  }

  return res.json({
    success: true, code: 0, message: 'ok',
    data: {
      history: history.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()),
      extraction_count: history.filter(h => h.type === 'extraction').length,
      field_change_count: 0,
      conflict_resolve_count: 0
    }
  })
})

function handleArchive(req: Request, res: Response) {
  const patientId = String(
    req.body?.patientId
    ?? req.body?.patient_id
    ?? req.query.patientId
    ?? req.query.patient_id
    ?? '',
  ).trim()

  if (!patientId) {
    return res.status(400).json({
      success: false, code: 400,
      message: '缺少必填参数：patientId',
      data: null,
    })
  }

  try {
    const { updated, patientName } = archiveDocumentToPatient(String(req.params.id), patientId)
    return res.json({
      success: true,
      code: 0,
      message: '归档成功',
      data: {
        ...serialize(updated),
        patient_id: patientId,
        patient_name: patientName,
      },
    })
  } catch (err: any) {
    if (err.message === 'DOCUMENT_NOT_FOUND') {
      return res.status(404).json({ success: false, code: 404, message: '文档不存在', data: null })
    }
    if (err.message === 'PATIENT_NOT_FOUND') {
      return res.status(404).json({ success: false, code: 404, message: '目标患者不存在', data: null })
    }
    console.error('[archive document] error:', err)
    return res.status(500).json({ success: false, code: 500, message: '服务器内部错误', data: null })
  }
}

/**
 * POST /api/v1/documents/:id/archive
 * 兼容 body.patientId 与 query.patient_id 两种入参。
 */
router.post('/:id/archive', handleArchive)

/**
 * PUT /api/v1/documents/:id/change-archive-patient
 * frontend_new 兼容接口：切换已归档文档的目标患者。
 */
router.put('/:id/change-archive-patient', (req: Request, res: Response) => {
  const newPatientId = String(
    req.body?.newPatientId
    ?? req.body?.new_patient_id
    ?? req.query.newPatientId
    ?? req.query.new_patient_id
    ?? '',
  ).trim()

  if (!newPatientId) {
    return res.status(400).json({ success: false, code: 400, message: '缺少必填参数：new_patient_id', data: null })
  }

  const row = stmtFindById.get(String(req.params.id)) as DocumentRecord | undefined
  if (!row || row.status === 'deleted') {
    return res.status(404).json({ success: false, code: 404, message: '文档不存在', data: null })
  }

  const patient = db.prepare(`SELECT * FROM patients WHERE id = ?`).get(newPatientId) as any
  if (!patient) {
    return res.status(404).json({ success: false, code: 404, message: '目标患者不存在', data: null })
  }

  db.prepare(`
    UPDATE documents
    SET patient_id = ?, status = 'archived', materialize_status = 'pending', updated_at = ?
    WHERE id = ?
  `).run(newPatientId, now(), String(req.params.id))

  return res.json({
    success: true,
    code: 0,
    message: '更换归档患者成功',
    data: {
      document_id: String(req.params.id),
      patient_id: newPatientId,
      patient_name: patient.name || null,
    },
  })
})

/**
 * POST /api/v1/documents/:id/ocr
 * 对指定文档调用 Textin OCR，返回解析后的段落列表（不落库）
 */
router.post('/:id/ocr', async (req: Request, res: Response) => {
  const row = stmtFindById.get(String(req.params.id)) as DocumentRecord | undefined

  if (!row || row.status === 'deleted') {
    return res.status(404).json({ success: false, code: 404, message: '文档不存在', data: null })
  }

  if (!row.object_key) {
    return res.status(400).json({ success: false, code: 400, message: '文档尚无 object_key，无法 OCR', data: null })
  }

  try {
    const ocrResult = await parseDocument(row.id, row.object_key)
    return res.json({
      success: true,
      code: 0,
      message: `OCR 完成，共 ${ocrResult.segments.length} 个段落`,
      data: ocrResult,
    })
  } catch (err: any) {
    console.error('[OCR] 失败:', err)
    return res.status(502).json({
      success: false,
      code: 502,
      message: `OCR 调用失败: ${err.message}`,
      data: null,
    })
  }
})

/**
 * DELETE /api/v1/documents/:id
 */
router.delete('/:id', (req: Request, res: Response) => {
  const row = stmtFindById.get(String(req.params.id)) as DocumentRecord | undefined

  if (!row || row.status === 'deleted') {
    return res.status(404).json({ success: false, code: 404, message: '文档不存在', data: null })
  }

  db.prepare(`
    UPDATE documents SET status = 'deleted', updated_at = ? WHERE id = ?
  `).run(now(), String(req.params.id))

  return res.json({ success: true, code: 0, message: '删除成功', data: null })
})
/**
 * POST /api/v1/documents/archive-to-patient
 */
router.post('/archive-to-patient', (req: Request, res: Response) => {
  const { documentIds, patientId, batchId } = req.body

  if (!Array.isArray(documentIds) || documentIds.length === 0) {
    return res.status(400).json({ success: false, code: 400, message: 'documentIds 必须是非空数组', data: null })
  }
  if (!patientId) {
    return res.status(400).json({ success: false, code: 400, message: '缺少必填参数：patientId', data: null })
  }

  const archiveTransaction = db.transaction(() => {
    const patientRow = db.prepare('SELECT * FROM patients WHERE id = ?').get(patientId) as any
    if (!patientRow) throw new Error(`PATIENT_NOT_FOUND`)

    let patientMeta: any = {}
    try { patientMeta = JSON.parse(patientRow.metadata || '{}') } catch {}
    let patientName = patientRow.name

    const archivedIds: string[] = []
    const docsToArchive: any[] = []
    const stmtCheck = db.prepare(`SELECT * FROM documents WHERE id = ?`)
    const stmtUpdate = db.prepare(`UPDATE documents SET patient_id = ?, status = 'archived', updated_at = ? WHERE id = ?`)
    const currentTs = now()

    for (const docId of documentIds) {
      const docRaw = stmtCheck.get(docId) as DocumentRecord | undefined
      if (!docRaw) throw new Error(`DOCUMENT_NOT_FOUND:${docId}`)
      if (docRaw.status === 'deleted') throw new Error(`DOCUMENT_DELETED:${docId}`)
      if (docRaw.patient_id && docRaw.patient_id !== patientId) {
         throw new Error(`DOCUMENT_ALREADY_ARCHIVED:${docId}`)
      }

      stmtUpdate.run(patientId, currentTs, docId)
      archivedIds.push(docId)
      docsToArchive.push(docRaw)
    }

    // 补充归档到已有患者的信息合并逻辑
    const names: string[] = []
    const allIdentifiers: any[] = Array.isArray(patientMeta['唯一标识符']) ? [...patientMeta['唯一标识符']] : []
    let hasChanges = false

    for (const docLine of docsToArchive) {
      let docMeta: any = {}
      try { docMeta = JSON.parse(docLine.metadata || '{}') } catch {}
      const metaResult = docMeta?.result || docMeta || {}

      if (metaResult['患者姓名']) names.push(metaResult['患者姓名'])
      
      const scalarFields = ['患者性别', '患者年龄', '出生日期', '联系电话', '机构名称', '科室信息']
      for (const f of scalarFields) {
        // 如果患者原先没有这个项，但新文档里有，则补进去
        // 不等于 null / undefined / 空字符串 可视为“有值”
        if (!patientMeta[f] && metaResult[f]) {
          patientMeta[f] = metaResult[f]
          hasChanges = true
        }
      }

      if (Array.isArray(metaResult['唯一标识符'])) {
         allIdentifiers.push(...metaResult['唯一标识符'])
      }
    }

    // 标识符去重
    if (allIdentifiers.length > 0) {
      const uniqueIdentifiersMap = new Map()
      for (const idObj of allIdentifiers) {
          if (!idObj) continue
          const key = `${idObj['标识符类型'] || 'Unknown'}-${idObj['标识符编号'] || 'Unknown'}`
          if (!uniqueIdentifiersMap.has(key)) {
              uniqueIdentifiersMap.set(key, idObj)
          }
      }
      const dedupedIdentifiers = Array.from(uniqueIdentifiersMap.values())
      if (JSON.stringify(patientMeta['唯一标识符'] || []) !== JSON.stringify(dedupedIdentifiers)) {
         patientMeta['唯一标识符'] = dedupedIdentifiers
         hasChanges = true
      }
    }

    // 尝试补全患者姓名
    if (!patientName && names.length > 0) {
      const nameCounts = new Map<string, number>()
      let maxNameCount = 0
      let mostFreqName: string | null = null
      for (const n of names) {
         const cnt = (nameCounts.get(n) || 0) + 1
         nameCounts.set(n, cnt)
         if (cnt > maxNameCount) {
           maxNameCount = cnt
           mostFreqName = n
         }
      }
      if (mostFreqName) {
        patientName = mostFreqName
        hasChanges = true
      }
    }

    if (hasChanges) {
       db.prepare(`UPDATE patients SET name = ?, metadata = ?, updated_at = ? WHERE id = ?`)
         .run(patientName, JSON.stringify(patientMeta), currentTs, patientId)
    }

    return archivedIds
  })

  try {
    const archivedIds = archiveTransaction()

    return res.json({
      success: true,
      code: 0,
      data: {
        patientId,
        archivedDocumentIds: archivedIds,
        skippedDocumentIds: [],
        message: `${archivedIds.length} 份文档已归档到已有患者`
      }
    })
  } catch (err: any) {
    const msg = err.message as string
    if (msg === 'PATIENT_NOT_FOUND') {
      return res.status(404).json({ success: false, code: 404, message: '目标患者不存在', data: null })
    }
    if (msg.startsWith('DOCUMENT_NOT_FOUND:')) {
      return res.status(400).json({ success: false, code: 400, message: `文档不存在: ${msg.split(':')[1]}`, data: null })
    }
    if (msg.startsWith('DOCUMENT_DELETED:')) {
      return res.status(400).json({ success: false, code: 400, message: `文档已删除: ${msg.split(':')[1]}`, data: null })
    }
    if (msg.startsWith('DOCUMENT_ALREADY_ARCHIVED:')) {
      return res.status(409).json({ success: false, code: 409, message: `已归档到其他患者，禁止覆盖: ${msg.split(':')[1]}`, data: null })
    }
    console.error('[archive-to-patient] error:', err)
    return res.status(500).json({ success: false, code: 500, message: '服务器内部错误', data: null })
  }
})

/**
 * POST /api/v1/documents/:id/confirm-create-patient
 * frontend_new 兼容接口：基于文档信息（及前端编辑值）创建患者并归档当前文档。
 */
router.post('/:id/confirm-create-patient', (req: Request, res: Response) => {
  try {
    const result = createPatientAndArchiveDocuments([String(req.params.id)], req.body)
    return res.json({
      success: true,
      code: 0,
      message: '已创建患者并归档文档',
      data: {
        patient_id: result.patientId,
        patient_name: result.patientName,
        patientId: result.patientId,
        patientName: result.patientName,
        document_id: String(req.params.id),
        archived_count: 1,
      },
    })
  } catch (err: any) {
    const msg = err.message as string
    if (msg.startsWith('DOCUMENT_NOT_FOUND:')) {
      return res.status(400).json({ success: false, code: 400, message: `文档不存在: ${msg.split(':')[1]}`, data: null })
    }
    if (msg.startsWith('DOCUMENT_DELETED:')) {
      return res.status(400).json({ success: false, code: 400, message: `文档已删除: ${msg.split(':')[1]}`, data: null })
    }
    if (msg.startsWith('DOCUMENT_ALREADY_ARCHIVED:')) {
      return res.status(409).json({ success: false, code: 409, message: `文档已归档，无法新建患者: ${msg.split(':')[1]}`, data: null })
    }
    console.error('[confirm-create-patient] error:', err)
    return res.status(500).json({ success: false, code: 500, message: '服务器内部错误', data: null })
  }
})

/**
 * POST /api/v1/documents/actions/batch-create-patient-and-archive
 * frontend_new 兼容接口：body 使用 document_ids。
 */
router.post('/actions/batch-create-patient-and-archive', (req: Request, res: Response) => {
  const documentIds = parseCommaSeparatedIds(req.body?.document_ids ?? req.body?.documentIds)
  if (documentIds.length === 0) {
    return res.status(400).json({ success: false, code: 400, message: 'document_ids 必须是非空数组', data: null })
  }

  try {
    const result = createPatientAndArchiveDocuments(documentIds, req.body)
    return res.json({
      success: true,
      code: 0,
      message: '批量创建患者并归档成功',
      data: {
        patient_id: result.patientId,
        patient_name: result.patientName,
        patientId: result.patientId,
        patientName: result.patientName,
        success_count: result.archivedDocumentIds.length,
        failed_count: 0,
        success_documents: result.archivedDocumentIds.map((documentId) => ({ document_id: documentId })),
        failed_documents: [],
      },
    })
  } catch (err: any) {
    const msg = err.message as string
    if (msg.startsWith('DOCUMENT_NOT_FOUND:')) {
      return res.status(400).json({ success: false, code: 400, message: `文档不存在: ${msg.split(':')[1]}`, data: null })
    }
    if (msg.startsWith('DOCUMENT_DELETED:')) {
      return res.status(400).json({ success: false, code: 400, message: `文档已删除: ${msg.split(':')[1]}`, data: null })
    }
    if (msg.startsWith('DOCUMENT_ALREADY_ARCHIVED:')) {
      return res.status(409).json({ success: false, code: 409, message: `文档已归档，无法新建患者: ${msg.split(':')[1]}`, data: null })
    }
    console.error('[batch-create-patient-and-archive] error:', err)
    return res.status(500).json({ success: false, code: 500, message: '服务器内部错误', data: null })
  }
})

/**
 * POST /api/v1/documents/create-patient-and-archive
 */
router.post('/create-patient-and-archive', (req: Request, res: Response) => {
  const documentIds = parseCommaSeparatedIds(req.body?.documentIds ?? req.body?.document_ids)
  if (documentIds.length === 0) {
    return res.status(400).json({ success: false, code: 400, message: 'documentIds 必须是非空数组', data: null })
  }

  try {
    const result = createPatientAndArchiveDocuments(documentIds, req.body)

    return res.json({
      success: true,
      code: 0,
      data: {
        patientId: result.patientId,
        patientName: result.patientName,
        patient_id: result.patientId,
        patient_name: result.patientName,
        archivedDocumentIds: result.archivedDocumentIds,
        message: `已新建患者并归档 ${result.archivedDocumentIds.length} 份文档`,
      }
    })
  } catch (err: any) {
    const msg = err.message as string
    if (msg.startsWith('DOCUMENT_NOT_FOUND:')) {
      return res.status(400).json({ success: false, code: 400, message: `文档不存在: ${msg.split(':')[1]}`, data: null })
    }
    if (msg.startsWith('DOCUMENT_DELETED:')) {
      return res.status(400).json({ success: false, code: 400, message: `文档已删除: ${msg.split(':')[1]}`, data: null })
    }
    if (msg.startsWith('DOCUMENT_ALREADY_ARCHIVED:')) {
      return res.status(409).json({ success: false, code: 409, message: `文档已归档，无法新建患者: ${msg.split(':')[1]}`, data: null })
    }
    console.error('[create-patient-and-archive] error:', err)
    return res.status(500).json({ success: false, code: 500, message: '服务器内部错误', data: null })
  }
})

/**
 * POST /api/v1/documents/:id/confirm-auto-archive
 * 按当前系统打分规则直接确认推荐患者并归档。
 */
router.post('/:id/confirm-auto-archive', (req: Request, res: Response) => {
  const row = stmtFindById.get(String(req.params.id)) as DocumentRecord | undefined
  if (!row || row.status === 'deleted') {
    return res.status(404).json({ success: false, code: 404, message: '文档不存在', data: null })
  }

  const matchInfo = buildAiMatchPayload(row)
  if (!matchInfo.ai_recommendation || Number(matchInfo.match_score || 0) < 90) {
    return res.status(400).json({ success: false, code: 400, message: '当前文档没有可自动确认的高置信度推荐患者', data: null })
  }

  try {
    const { updated, patientName } = archiveDocumentToPatient(String(req.params.id), matchInfo.ai_recommendation)
    return res.json({
      success: true,
      code: 0,
      message: '确认归档成功',
      data: {
        document_id: String(req.params.id),
        patient_id: matchInfo.ai_recommendation,
        patient_name: patientName,
        match_score: matchInfo.match_score,
        document: serialize(updated),
      },
    })
  } catch (err: any) {
    if (err.message === 'PATIENT_NOT_FOUND') {
      return res.status(404).json({ success: false, code: 404, message: '推荐患者不存在', data: null })
    }
    console.error('[confirm-auto-archive] error:', err)
    return res.status(500).json({ success: false, code: 500, message: '服务器内部错误', data: null })
  }
})

/**
 * POST /api/v1/documents/actions/batch-confirm-auto-archive
 */
router.post('/actions/batch-confirm-auto-archive', (req: Request, res: Response) => {
  const documentIds = parseCommaSeparatedIds(req.body)
  if (documentIds.length === 0) {
    return res.status(400).json({ success: false, code: 400, message: '文档列表不能为空', data: null })
  }

  let successCount = 0
  let failedCount = 0
  const failedDocuments: Array<{ document_id: string, message: string }> = []

  for (const documentId of documentIds) {
    const row = stmtFindById.get(documentId) as DocumentRecord | undefined
    if (!row || row.status === 'deleted') {
      failedCount += 1
      failedDocuments.push({ document_id: documentId, message: '文档不存在' })
      continue
    }

    const matchInfo = buildAiMatchPayload(row)
    if (!matchInfo.ai_recommendation || Number(matchInfo.match_score || 0) < 90) {
      failedCount += 1
      failedDocuments.push({ document_id: documentId, message: '没有可确认的高置信度推荐患者' })
      continue
    }

    try {
      archiveDocumentToPatient(documentId, matchInfo.ai_recommendation)
      successCount += 1
    } catch (err: any) {
      failedCount += 1
      failedDocuments.push({ document_id: documentId, message: err?.message || '归档失败' })
    }
  }

  return res.json({
    success: true,
    code: 0,
    message: '批量确认完成',
    data: {
      success_count: successCount,
      failed_count: failedCount,
      failed_documents: failedDocuments,
    },
  })
})

export default router
