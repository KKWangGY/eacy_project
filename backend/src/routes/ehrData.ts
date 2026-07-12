/**
 * EHR Data API — 投影/组装层
 * 从 field_value_selected 读取数据，组装为前端可渲染的 { schema, data } 结构
 */
import { Router, Request, Response } from 'express'
import { randomUUID } from 'crypto'
import db from '../db.js'
import { buildPageSizeFallback, parseSourceLocationWithFallback } from '../utils/sourceLocation.js'

const router = Router()

function parseStoredValue(raw: string) {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function inferValueType(value: any): string {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'string'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'object') return 'object'
  return 'string'
}

function ensureObjectPath(target: any, parts: string[]) {
  let current = target
  for (const part of parts) {
    if (current[part] === undefined || current[part] === null || typeof current[part] !== 'object' || Array.isArray(current[part])) {
      current[part] = {}
    }
    current = current[part]
  }
  return current
}

function setObjectValue(target: any, parts: string[], value: any) {
  if (parts.length === 0) return
  const parent = ensureObjectPath(target, parts.slice(0, -1))
  parent[parts[parts.length - 1]] = value
}

function normalizeRequestFieldPath(rawFieldPath: string): string {
  let fieldPath = String(rawFieldPath || '').trim()
  if (!fieldPath) return '/'
  if (!fieldPath.startsWith('/')) {
    fieldPath = '/' + fieldPath.replace(/\./g, '/')
  }
  return fieldPath.replace(/\/+/g, '/')
}

function normalizeIndexedFieldPath(path: string): string {
  return '/' + String(path || '')
    .split('/')
    .filter(Boolean)
    .filter((seg) => !/^\d+$/.test(seg))
    .join('/')
}

/**
 * 把前端传入的字段路径归一化为候选/历史查询路径列表。
 * 与物化层 _normalize_field_path 对齐，并兼容 repeatable 行/单元格点击路径。
 */
function buildCandidateFieldPaths(rawFieldPath: string): string[] {
  const fieldPath = normalizeRequestFieldPath(rawFieldPath)
  const pathsToTry: string[] = [fieldPath]
  const normalizedIndexedPath = normalizeIndexedFieldPath(fieldPath)
  if (normalizedIndexedPath !== fieldPath) {
    pathsToTry.push(normalizedIndexedPath)
  }
  const cellMatch = fieldPath.match(/^(.+)\/\d+\/.+$/)
  if (cellMatch) pathsToTry.push(cellMatch[1])
  const rowMatch = fieldPath.match(/^(.+)\/\d+$/)
  if (rowMatch) pathsToTry.push(rowMatch[1])
  return [...new Set(pathsToTry)]
}

function normalizeScopePath(rawPath: string): string {
  return normalizeRequestFieldPath(rawPath)
}

function buildSelectableCandidateFieldPaths(rawFieldPath: string): string[] {
  const fieldPath = normalizeRequestFieldPath(rawFieldPath)
  const pathsToTry: string[] = [fieldPath]
  const normalizedIndexedPath = normalizeIndexedFieldPath(fieldPath)
  if (normalizedIndexedPath !== fieldPath) {
    pathsToTry.push(normalizedIndexedPath)
  }
  return [...new Set(pathsToTry)]
}

function buildFieldPathSuffixes(paths: string[]): string[] {
  const suffixes: string[] = []
  for (const path of paths) {
    const parts = String(path || '').split('/').filter(Boolean)
    for (let start = 1; start < parts.length - 1; start += 1) {
      suffixes.push('/' + parts.slice(start).join('/'))
    }
  }
  return [...new Set(suffixes)]
}

interface ResolvedScope {
  sectionInstanceId: string | null
  rowInstanceId: string | null
  hasIndices: boolean
  resolved: boolean
}

/**
 * 根据请求路径中的索引段，定位唯一的 (section_instance_id, row_instance_id)。
 *
 * 物化侧的约定（crf-service/app/core/materializer.py）：
 *   - 可重复 section 的 idx 会被保留在其后代的 current_path 中
 *     → row_instances.group_path 会包含祖先的 section idx（如 /实验室检查/传染学检测/0/检验结果）
 *   - 可重复 row 的 idx 不会进入后代 path，只通过 row_instances.repeat_index 区分
 *   - field_value_candidates.field_path 一律用 _normalize_field_path 剥掉所有数字段
 *
 * 逆向解析规则：逐段前进，遇到数字段时先尝试匹配 row_instances（不把该 idx 追加到累积路径），
 * 再退化到 section_instances（把 idx 追加到累积路径，供后续 group_path 拼接）。
 */
function resolveScopeFromPath(instanceId: string, rawPath: string): ResolvedScope {
  const normalizedPath = normalizeScopePath(rawPath)
  const segments = normalizedPath.split('/').filter(Boolean)
  const hasIndices = segments.some((s) => /^\d+$/.test(s))
  if (!hasIndices) {
    return { sectionInstanceId: null, rowInstanceId: null, hasIndices: false, resolved: true }
  }

  let sectionInstanceId: string | null = null
  let rowInstanceId: string | null = null
  let parentSectionId: string | null = null
  let parentRowId: string | null = null
  const cumulative: string[] = []

  for (const seg of segments) {
    if (!/^\d+$/.test(seg)) {
      cumulative.push(seg)
      continue
    }

    const idx = Number(seg)
    const groupPath = '/' + cumulative.join('/')

    const row = db.prepare(`
      SELECT id FROM row_instances
      WHERE instance_id = ? AND group_path = ? AND repeat_index = ?
        AND COALESCE(parent_row_id, '__null__') = COALESCE(?, '__null__')
      LIMIT 1
    `).get(instanceId, groupPath, idx, parentRowId) as { id: string } | undefined

    if (row) {
      parentRowId = row.id
      rowInstanceId = row.id
      continue
    }

    const sectionPath = '/' + cumulative.filter((s) => !/^\d+$/.test(s)).join('/')
    const section = db.prepare(`
      SELECT id FROM section_instances
      WHERE instance_id = ? AND section_path = ? AND repeat_index = ?
        AND COALESCE(parent_section_id, '__null__') = COALESCE(?, '__null__')
      LIMIT 1
    `).get(instanceId, sectionPath, idx, parentSectionId) as { id: string } | undefined

    if (section) {
      parentSectionId = section.id
      sectionInstanceId = section.id
      cumulative.push(seg)
      continue
    }

    return { sectionInstanceId, rowInstanceId, hasIndices: true, resolved: false }
  }

  return { sectionInstanceId, rowInstanceId, hasIndices: true, resolved: true }
}

/**
 * 将 ResolvedScope 转换为 SQL WHERE 片段 + 参数列表，供 field_value_candidates /
 * field_value_selected 查询附加使用。
 *   - 无索引路径：不加过滤（向后兼容 "查所有行" 的语义）
 *   - 有索引但解析失败：返回 "1=0"，避免跨行串台
 *   - 解析成功：按 row_instance_id / section_instance_id 精确定位
 */
function buildScopeWhereClause(scope: ResolvedScope, alias: string): { sql: string; params: any[] } {
  if (!scope.hasIndices) return { sql: '', params: [] }
  if (!scope.resolved) return { sql: 'AND 1 = 0', params: [] }
  const clauses: string[] = []
  const params: any[] = []
  if (scope.rowInstanceId) {
    clauses.push(`${alias}.row_instance_id = ?`)
    params.push(scope.rowInstanceId)
  } else {
    clauses.push(`${alias}.row_instance_id IS NULL`)
  }
  if (scope.sectionInstanceId) {
    clauses.push(`${alias}.section_instance_id = ?`)
    params.push(scope.sectionInstanceId)
  }
  return { sql: 'AND ' + clauses.join(' AND '), params }
}

/**
 * GET /api/v1/patients/:patientId/ehr-schema-data
 *
 * 返回该患者的 schema + draftData，前端 SchemaEhrTab 直接消费
 */
router.get('/:patientId/ehr-schema-data', (req: Request, res: Response) => {
  try {
    const { patientId } = req.params

    // 1. 查找该患者的 schema instance
    let instance = db.prepare(`
      SELECT si.id as instance_id, si.schema_id, si.status, si.name as instance_name,
             s.content_json, s.name as schema_name, s.code, s.version
      FROM schema_instances si
      JOIN schemas s ON s.id = si.schema_id
      WHERE si.patient_id = ? AND si.instance_type = 'patient_ehr'
      ORDER BY si.created_at DESC
      LIMIT 1
    `).get(patientId) as any

    if (!instance) {
      // 延迟初始化：查询基准 schema（与 documents.ts getDefaultSchemaId 保持一致）
      let defaultSchema = db.prepare(
        `SELECT * FROM schemas WHERE code = 'patient_ehr_v2' AND is_active = 1 ORDER BY version DESC LIMIT 1`
      ).get() as any
      if (!defaultSchema) {
        // 找不到 patient_ehr_v2 时回退到最新 schema
        defaultSchema = db.prepare(`SELECT * FROM schemas WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1`).get() as any
      }
      if (!defaultSchema) {
        return res.json({
          success: false,
          code: 40401,
          message: '系统尚无预设 Schema',
          data: { schema: {}, data: {} }
        })
      }
      
      const newInstanceId = randomUUID()
      db.prepare(`
        INSERT INTO schema_instances (id, patient_id, schema_id, name, instance_type, status)
        VALUES (?, ?, ?, ?, 'patient_ehr', 'draft')
      `).run(newInstanceId, patientId, defaultSchema.id, '自动初始化病历夹')

      instance = {
        instance_id: newInstanceId,
        schema_id: defaultSchema.id,
        status: 'draft',
        instance_name: '自动初始化病历夹',
        content_json: defaultSchema.content_json,
        schema_name: defaultSchema.name,
        code: defaultSchema.code,
        version: defaultSchema.version
      }
    }

    // 2. 解析 schema
    let schema: any = {}
    try {
      schema = JSON.parse(instance.content_json)
    } catch (e) {
      console.error('[ehr-schema-data] Failed to parse schema JSON:', e)
      return res.status(500).json({
        success: false,
        code: 500,
        message: 'Schema JSON 解析失败'
      })
    }

    // 3. 读取所有 field_value_selected，组装为嵌套 JSON
    const rawSelectedRows = db.prepare(`
      SELECT
        fvs.field_path,
        fvs.selected_value_json,
        fvs.section_instance_id,
        fvs.row_instance_id,
        si.section_path,
        si.repeat_index AS section_repeat_index,
        si.is_repeatable AS section_is_repeatable,
        ri.group_path,
        ri.repeat_index AS row_repeat_index
      FROM field_value_selected fvs
      LEFT JOIN section_instances si ON si.id = fvs.section_instance_id
      LEFT JOIN row_instances ri ON ri.id = fvs.row_instance_id
      WHERE fvs.instance_id = ?
      ORDER BY
        COALESCE(si.section_path, ''),
        COALESCE(si.repeat_index, 0),
        COALESCE(ri.group_path, ''),
        COALESCE(ri.repeat_index, 0),
        fvs.field_path,
        fvs.updated_at ASC,
        fvs.selected_at ASC
    `).all(instance.instance_id) as any[]

    const selectedByPath = new Map<string, any>()
    for (const row of rawSelectedRows) {
      const hasRowScope = !!row.section_instance_id || !!row.row_instance_id
      const dedupeKey = hasRowScope
        ? [row.section_instance_id || '', row.row_instance_id || '', row.field_path || ''].join('::')
        : String(row.field_path || '')
      const existing = selectedByPath.get(dedupeKey)
      if (!existing || String(row.updated_at || '') >= String(existing.updated_at || '')) {
        selectedByPath.set(dedupeKey, row)
      }
    }
    const selectedRows = Array.from(selectedByPath.values())

    const draftData: any = {}

    for (const row of selectedRows) {
      const path = row.field_path  // e.g. "/基本信息/人口学情况/身份信息/患者姓名"
      const parts = path.split('/').filter((p: string) => p !== '')

      if (parts.length === 0) continue

      const value = parseStoredValue(row.selected_value_json)

      const hasRepeatableSection =
        !!row.section_instance_id &&
        typeof row.section_path === 'string' &&
        !!row.section_path &&
        Number(row.section_is_repeatable || 0) === 1
      const hasRepeatableRow = !!row.row_instance_id && typeof row.group_path === 'string' && row.group_path

      if (hasRepeatableSection) {
        const sectionParts = String(row.section_path).split('/').filter((p: string) => p !== '')
        const sectionParent = ensureObjectPath(draftData, sectionParts.slice(0, -1))
        const sectionKey = sectionParts[sectionParts.length - 1]
        if (!Array.isArray(sectionParent[sectionKey])) {
          sectionParent[sectionKey] = []
        }

        const sectionArray = sectionParent[sectionKey]
        const sectionIndex = Number(row.section_repeat_index || 0)
        while (sectionArray.length <= sectionIndex) {
          sectionArray.push({})
        }
        if (!sectionArray[sectionIndex] || typeof sectionArray[sectionIndex] !== 'object' || Array.isArray(sectionArray[sectionIndex])) {
          sectionArray[sectionIndex] = {}
        }

        const sectionRecord = sectionArray[sectionIndex]
        const relativeToSection = parts.slice(sectionParts.length)

        if (hasRepeatableRow) {
          const groupParts = String(row.group_path).split('/').filter((p: string) => p !== '')
          const relativeGroupParts = groupParts.slice(sectionParts.length)
          const rowContainer = ensureObjectPath(sectionRecord, relativeGroupParts.slice(0, -1))
          const rowKey = relativeGroupParts[relativeGroupParts.length - 1]
          if (!Array.isArray(rowContainer[rowKey])) {
            rowContainer[rowKey] = []
          }

          const rowArray = rowContainer[rowKey]
          const rowIndex = Number(row.row_repeat_index || 0)
          while (rowArray.length <= rowIndex) {
            rowArray.push({})
          }
          if (!rowArray[rowIndex] || typeof rowArray[rowIndex] !== 'object' || Array.isArray(rowArray[rowIndex])) {
            rowArray[rowIndex] = {}
          }

          const relativeToRow = parts.slice(groupParts.length)
          if (relativeToRow.length === 0) continue
          setObjectValue(rowArray[rowIndex], relativeToRow, value)
          continue
        }

        if (relativeToSection.length === 0) continue
        setObjectValue(sectionRecord, relativeToSection, value)
        continue
      }

      setObjectValue(draftData, parts, value)
    }

    // 4. Return assembled response
    return res.json({
      success: true,
      code: 0,
      message: 'ok',
      data: {
        schema,
        data: draftData,
        instance: {
          id: instance.instance_id,
          name: instance.instance_name,
          status: instance.status,
          schema_name: instance.schema_name,
          schema_code: instance.code,
          schema_version: instance.version
        }
      }
    })
  } catch (err: any) {
    console.error('[GET ehr-schema-data]', err)
    return res.status(500).json({
      success: false,
      code: 500,
      message: err.message
    })
  }
})

/**
 * PUT /api/v1/patients/:patientId/ehr-schema-data
 *
 * 保存前端编辑后的 draftData
 * 对比现有值，仅对变化字段生成 field_value_candidates 记录（手动修改），
 * 然后更新 field_value_selected
 */
router.put('/:patientId/ehr-schema-data', (req: Request, res: Response) => {
  try {
    const { patientId } = req.params
    const newData = req.body

    if (!newData || typeof newData !== 'object') {
      return res.status(400).json({
        success: false,
        code: 400,
        message: '请求体必须是 JSON 对象'
      })
    }

    // Find instance
    const instance = db.prepare(`
      SELECT id FROM schema_instances
      WHERE patient_id = ? AND instance_type = 'patient_ehr'
      ORDER BY created_at DESC LIMIT 1
    `).get(patientId) as any

    if (!instance) {
      return res.status(404).json({
        success: false,
        code: 404,
        message: '该患者暂无病历夹实例'
      })
    }

    // Flatten newData into editable leaf field paths. Keep repeatable indices in
    // requestedPath for scope resolution, but store normalized field_path without
    // numeric indices to match extractor/materializer conventions.
    const flatFields: Array<{ requestedPath: string; storagePath: string; valueJson: string; rawValue: any }> = []
    function flatten(obj: any, parts: string[] = []) {
      if (parts.length > 0 && String(parts[0] || '').startsWith('_')) return
      if (Array.isArray(obj)) {
        obj.forEach((item, index) => flatten(item, [...parts, String(index)]))
        if (obj.length === 0 && parts.length > 0) {
          const requestedPath = '/' + parts.join('/')
          flatFields.push({
            requestedPath,
            storagePath: normalizeIndexedFieldPath(requestedPath),
            valueJson: JSON.stringify(obj),
            rawValue: obj,
          })
        }
        return
      }
      if (typeof obj === 'object') {
        if (obj === null) {
          const requestedPath = '/' + parts.join('/')
          flatFields.push({
            requestedPath,
            storagePath: normalizeIndexedFieldPath(requestedPath),
            valueJson: 'null',
            rawValue: null,
          })
          return
        }
        for (const key of Object.keys(obj)) {
          if (key.startsWith('_')) continue
          flatten(obj[key], [...parts, key])
        }
        return
      }
      const requestedPath = '/' + parts.join('/')
      flatFields.push({
        requestedPath,
        storagePath: normalizeIndexedFieldPath(requestedPath),
        valueJson: JSON.stringify(obj),
        rawValue: obj,
      })
    }
    flatten(newData)


    const insertCandidate = db.prepare(`
      INSERT INTO field_value_candidates
        (id, instance_id, field_path, value_json, value_type, source_text, confidence, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'user')
    `)

    const insertScopedCandidate = db.prepare(`
      INSERT INTO field_value_candidates
        (id, instance_id, section_instance_id, row_instance_id, field_path, value_json, value_type, source_text, confidence, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'user')
    `)

    const upsertSelected = db.prepare(`
      INSERT INTO field_value_selected
        (id, instance_id, field_path, selected_candidate_id, selected_value_json, selected_by)
      VALUES (?, ?, ?, ?, ?, 'user')
      ON CONFLICT(instance_id, COALESCE(section_instance_id, '__null__'), COALESCE(row_instance_id, '__null__'), field_path)
      DO UPDATE SET
        selected_candidate_id = excluded.selected_candidate_id,
        selected_value_json = excluded.selected_value_json,
        selected_by = 'user',
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `)

    const upsertScopedSelected = db.prepare(`
      INSERT INTO field_value_selected
        (id, instance_id, section_instance_id, row_instance_id, field_path, selected_candidate_id, selected_value_json, selected_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'user')
      ON CONFLICT(instance_id, COALESCE(section_instance_id, '__null__'), COALESCE(row_instance_id, '__null__'), field_path)
      DO UPDATE SET
        selected_candidate_id = excluded.selected_candidate_id,
        selected_value_json = excluded.selected_value_json,
        selected_by = 'user',
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `)

    let changedCount = 0
    let totalCount = 0

    const saveAll = db.transaction(() => {
      for (const field of flatFields) {
        totalCount++
        const scope = resolveScopeFromPath(instance.id, field.requestedPath)
        if (!scope.resolved) continue

        const oldRow = db.prepare(`
          SELECT selected_value_json FROM field_value_selected
          WHERE instance_id = ?
            AND COALESCE(section_instance_id, '__null__') = COALESCE(?, '__null__')
            AND COALESCE(row_instance_id, '__null__') = COALESCE(?, '__null__')
            AND field_path = ?
          LIMIT 1
        `).get(instance.id, scope.sectionInstanceId, scope.rowInstanceId, field.storagePath) as { selected_value_json: string } | undefined
        const oldValue = oldRow?.selected_value_json

        if (oldValue === field.valueJson) {
          // Value unchanged — skip
          continue
        }

        changedCount++

        // Create a new candidate (extraction history record)
        const candidateId = randomUUID()
        const valueType = inferValueType(field.rawValue)

        if (scope.sectionInstanceId || scope.rowInstanceId) {
          insertScopedCandidate.run(
            candidateId,
            instance.id,
            scope.sectionInstanceId,
            scope.rowInstanceId,
            field.storagePath,
            field.valueJson,
            valueType,
            '用户手动编辑',
            null
          )
        } else {
          insertCandidate.run(
            candidateId,
            instance.id,
            field.storagePath,
            field.valueJson,
            valueType,
            '用户手动编辑',
            null // no confidence for manual edits
          )
        }

        // Update selected value
        const selectedId = randomUUID()
        if (scope.sectionInstanceId || scope.rowInstanceId) {
          upsertScopedSelected.run(
            selectedId,
            instance.id,
            scope.sectionInstanceId,
            scope.rowInstanceId,
            field.storagePath,
            candidateId,
            field.valueJson
          )
        } else {
          upsertSelected.run(selectedId, instance.id, field.storagePath, candidateId, field.valueJson)
        }
      }
    })

    saveAll()

    return res.json({
      success: true,
      code: 0,
      message: '保存成功',
      data: { total_fields: totalCount, changed_fields: changedCount }
    })
  } catch (err: any) {
    console.error('[PUT ehr-schema-data]', err)
    return res.status(500).json({
      success: false,
      code: 500,
      message: err.message
    })
  }
})

/**
 * GET /api/v1/patients/:patientId/ehr-field-history
 *
 * 返回某个字段路径的所有候选值历史记录
 * Query:
 *   - field_path (required) — 字段路径，如 "基本信息.人口学情况.身份信息.患者姓名"
 *   - project_id (optional) — 若传入，则查询该项目对应 schema 的 project_crf 实例（而非 patient_ehr）
 * 前端 ModificationHistory 组件直接消费
 */
router.get('/:patientId/ehr-field-history', (req: Request, res: Response) => {
  try {
    const { patientId } = req.params
    const rawFieldPath = req.query.field_path as string
    const projectIdParam = typeof req.query.project_id === 'string' ? req.query.project_id.trim() : ''

    if (!rawFieldPath) {
      return res.json({
        success: true,
        code: 0,
        data: { history: [] }
      })
    }

    const fieldPath = normalizeRequestFieldPath(rawFieldPath)
    const uniquePaths = buildSelectableCandidateFieldPaths(rawFieldPath)
    const suffixPaths = buildFieldPathSuffixes(uniquePaths)

    // Find schema instance: 病历夹默认 patient_ehr；科研项目详情传 project_id 时用 project_crf
    let instance: { id: string } | undefined
    if (projectIdParam) {
      const proj = db.prepare(`SELECT schema_id FROM projects WHERE id = ?`).get(projectIdParam) as
        | { schema_id: string }
        | undefined
      if (proj?.schema_id) {
        instance = db.prepare(`
          SELECT id FROM schema_instances
          WHERE patient_id = ? AND schema_id = ? AND project_id = ? AND instance_type = 'project_crf'
          ORDER BY updated_at DESC LIMIT 1
        `).get(patientId, proj.schema_id, projectIdParam) as { id: string } | undefined
      }
    } else {
      instance = db.prepare(`
        SELECT id FROM schema_instances
        WHERE patient_id = ? AND instance_type = 'patient_ehr'
        ORDER BY created_at DESC LIMIT 1
      `).get(patientId) as { id: string } | undefined
    }

    if (!instance) {
      return res.json({
        success: true,
        code: 0,
        data: { history: [] }
      })
    }

    // Query all candidates for this field path (try multiple path variants).
    // Exact/normalized paths are preferred; suffix fallback covers project template paths
    // whose group prefix differs from the extraction/materialized field_path.
    const placeholders = uniquePaths.map(() => '?').join(',')
    const suffixClauses = suffixPaths.map(() => `fvc.field_path LIKE ?`).join(' OR ')
    const suffixParams = suffixPaths.map((suffix) => `%${suffix}`)
    const historyScope = resolveScopeFromPath(instance.id, rawFieldPath)
    const historyScopeClause = buildScopeWhereClause(historyScope, 'fvc')
    const candidates = db.prepare(`
      SELECT
        fvc.id,
        fvc.field_path,
        fvc.value_json,
        fvc.value_type,
        fvc.source_document_id,
        fvc.source_page,
        fvc.source_block_id,
        fvc.source_bbox_json,
        fvc.source_text,
        fvc.confidence,
        fvc.created_by,
        fvc.created_at,
        fvc.extraction_run_id,
        d.file_name AS source_document_name,
        COALESCE(
          NULLIF(TRIM(json_extract(d.metadata, '$.target_section')), ''),
          NULLIF(TRIM(er.target_path), '')
        ) AS source_target_section
      FROM field_value_candidates fvc
      LEFT JOIN documents d ON d.id = fvc.source_document_id
      LEFT JOIN extraction_runs er ON er.id = fvc.extraction_run_id
      WHERE fvc.instance_id = ?
        AND (
          fvc.field_path IN (${placeholders})
          ${suffixClauses ? `OR ${suffixClauses}` : ''}
        )
        ${historyScopeClause.sql}
      ORDER BY
        CASE WHEN fvc.field_path IN (${placeholders}) THEN 0 ELSE 1 END,
        fvc.created_at DESC
    `).all(instance.id, ...uniquePaths, ...suffixParams, ...historyScopeClause.params, ...uniquePaths) as any[]

    // 用同文档同页的兄弟候选回填 page_width/page_height，使前端 PDF 红框
    // 在新旧两种 source_bbox_json 格式下渲染一致。
    const historyPageSizeFallback = buildPageSizeFallback(candidates)

    // Transform into the format the ModificationHistory component expects
    const history = candidates.map((c, idx) => {
      let newValue: any
      try { newValue = JSON.parse(c.value_json) } catch { newValue = c.value_json }

      // Determine the "old_value" — the value from the next (older) candidate
      const olderCandidate = candidates[idx + 1]
      let oldValue: any = null
      if (olderCandidate) {
        try { oldValue = JSON.parse(olderCandidate.value_json) } catch { oldValue = olderCandidate.value_json }
      }

      // 靶向上传：文档 metadata.target_section，或物化时写入的 extraction_runs.target_path（项目/病历夹一致）
      const targetSection = (c.source_target_section || null) as string | null
      const createdBy = String(c.created_by || '').toLowerCase()
      const isTargetedUpload = createdBy === 'ai' && !!targetSection

      let changeType: string
      let changeTypeDisplay: string
      if (createdBy === 'user') {
        changeType = 'manual_edit'
        changeTypeDisplay = '手动修改'
      } else if (createdBy === 'ai') {
        changeType = isTargetedUpload ? 'targeted_upload' : 'extract'
        changeTypeDisplay = isTargetedUpload ? '靶向上传' : 'AI 抽取'
      } else {
        changeType = 'initial_extract'
        changeTypeDisplay = '系统初始化'
      }

      return {
        id: c.id,
        field_path: fieldPath,
        matched_field_path: c.field_path,
        old_value: oldValue,
        new_value: newValue,
        change_type: changeType,
        change_type_display: changeTypeDisplay,
        operator_type: c.created_by,
        operator_name: createdBy === 'ai' ? (isTargetedUpload ? '靶向上传' : 'AI系统') : (createdBy === 'user' ? '用户' : '系统'),
        source_document_id: c.source_document_id,
        source_document_name: c.source_document_name,
        source_target_section: targetSection,
        source_page: c.source_page,
        source_text: c.source_text,
        confidence: c.confidence,
        source_location: parseSourceLocationWithFallback(
          c.source_bbox_json,
          c.source_page,
          c.source_document_id,
          historyPageSizeFallback
        ),
        remark: c.source_text || null,
        created_at: c.created_at
      }
    })

    return res.json({
      success: true,
      code: 0,
      data: { history }
    })
  } catch (err: any) {
    console.error('[GET ehr-field-history]', err)
    return res.status(500).json({
      success: false,
      code: 500,
      message: err.message
    })
  }
})

/**
 * POST /api/v1/patients/:patientId/merge-ehr
 *
 * 将文档抽取的 EHR 数据合并到患者病历夹
 * Body: { document_id, source_extraction_id? }
 */
router.post('/:patientId/merge-ehr', (req: Request, res: Response) => {
  try {
    const { patientId } = req.params
    const { document_id, source_extraction_id } = req.body

    if (!document_id) {
      return res.status(400).json({ success: false, code: 400, message: '缺少 document_id', data: null })
    }

    // 1. 获取文档的 extract_result_json
    const doc = db.prepare(`SELECT extract_result_json FROM documents WHERE id = ?`).get(document_id) as any
    if (!doc?.extract_result_json) {
      return res.status(400).json({
        success: false, code: 400,
        message: '该文档无可合并的抽取结果',
        data: null
      })
    }

    let ehrData: any = {}
    try { ehrData = JSON.parse(doc.extract_result_json) } catch {
      return res.status(400).json({
        success: false, code: 400,
        message: '抽取结果 JSON 解析失败',
        data: null
      })
    }

    // 2. 获取或创建 schema instance
    let instance = db.prepare(`
      SELECT id FROM schema_instances
      WHERE patient_id = ? AND instance_type = 'patient_ehr'
      ORDER BY created_at DESC LIMIT 1
    `).get(patientId) as any

    if (!instance) {
      const defaultSchema = db.prepare(`SELECT id FROM schemas ORDER BY created_at DESC LIMIT 1`).get() as any
      if (!defaultSchema) {
        return res.status(400).json({ success: false, code: 400, message: '系统尚无预设 Schema', data: null })
      }
      const newInstanceId = randomUUID()
      db.prepare(`
        INSERT INTO schema_instances (id, patient_id, schema_id, name, instance_type, status)
        VALUES (?, ?, ?, ?, 'patient_ehr', 'draft')
      `).run(newInstanceId, patientId, defaultSchema.id, '自动初始化病历夹')
      instance = { id: newInstanceId }
    }

    // 3. 打平 ehrData 为 field paths，然后 upsert 到 field_value_candidates + field_value_selected
    const flatFields: Array<{ path: string; value: string }> = []
    function flatten(obj: any, parts: string[] = []) {
      if (obj === null || obj === undefined) return
      // 跳过 _extraction_metadata 等内部字段
      if (parts.length > 0 && parts[0].startsWith('_')) return
      if (Array.isArray(obj)) {
        flatFields.push({ path: '/' + parts.join('/'), value: JSON.stringify(obj) })
        return
      }
      if (typeof obj === 'object') {
        for (const key of Object.keys(obj)) {
          if (key.startsWith('_')) continue
          flatten(obj[key], [...parts, key])
        }
        return
      }
      flatFields.push({ path: '/' + parts.join('/'), value: JSON.stringify(obj) })
    }
    flatten(ehrData)

    const insertCandidate = db.prepare(`
      INSERT INTO field_value_candidates
        (id, instance_id, field_path, value_json, value_type, source_document_id, source_text, confidence, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ai')
    `)

    const upsertSelected = db.prepare(`
      INSERT INTO field_value_selected
        (id, instance_id, field_path, selected_candidate_id, selected_value_json, selected_by)
      VALUES (?, ?, ?, ?, ?, 'ai')
      ON CONFLICT(instance_id, COALESCE(section_instance_id, '__null__'), COALESCE(row_instance_id, '__null__'), field_path)
      DO UPDATE SET
        selected_candidate_id = excluded.selected_candidate_id,
        selected_value_json = excluded.selected_value_json,
        selected_by = 'ai',
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `)

    let newFieldCount = 0
    let updatedFieldCount = 0
    let appendedArrayCount = 0

    // 读取已有 selected values
    const existingRows = db.prepare(`
      SELECT field_path, selected_value_json FROM field_value_selected WHERE instance_id = ?
    `).all(instance.id) as any[]
    const existingMap = new Map<string, string>()
    for (const row of existingRows) {
      existingMap.set(row.field_path, row.selected_value_json)
    }

    const mergeAll = db.transaction(() => {
      for (const field of flatFields) {
        const candidateId = randomUUID()
        const valueType = field.value.startsWith('[') ? 'array'
          : field.value.startsWith('"') ? 'string'
          : /^\d/.test(field.value) ? 'number'
          : 'string'

        insertCandidate.run(
          candidateId,
          instance.id,
          field.path,
          field.value,
          valueType,
          document_id,
          'AI抽取合并',
          0.85  // 默认置信度
        )

        const selectedId = randomUUID()
        upsertSelected.run(selectedId, instance.id, field.path, candidateId, field.value)

        if (existingMap.has(field.path)) {
          if (existingMap.get(field.path) !== field.value) {
            updatedFieldCount++
          }
        } else {
          newFieldCount++
        }
        if (valueType === 'array') appendedArrayCount++
      }
    })

    mergeAll()

    return res.json({
      success: true, code: 0, message: '合并成功',
      data: {
        new_field_count: newFieldCount,
        updated_field_count: updatedFieldCount,
        appended_array_count: appendedArrayCount,
        conflict_count: 0
      }
    })
  } catch (err: any) {
    console.error('[POST merge-ehr]', err)
    return res.status(500).json({ success: false, code: 500, message: err.message, data: null })
  }
})

// ============================================================
// 候选值（Field Value Candidates）— 列表 & 固化
// ============================================================

/**
 * 定位某患者（可选 project_id）的 schema instance。
 * 与 /ehr-field-history 的 instance 解析逻辑保持一致。
 */
function resolveSchemaInstance(
  patientId: string,
  projectIdParam: string
): { id: string } | undefined {
  if (projectIdParam) {
    const proj = db
      .prepare(`SELECT schema_id FROM projects WHERE id = ?`)
      .get(projectIdParam) as { schema_id: string } | undefined
    if (!proj?.schema_id) return undefined
    return db
      .prepare(
        `SELECT id FROM schema_instances
         WHERE patient_id = ? AND schema_id = ? AND project_id = ? AND instance_type = 'project_crf'
         ORDER BY updated_at DESC LIMIT 1`
      )
      .get(patientId, proj.schema_id, projectIdParam) as { id: string } | undefined
  }
  return db
    .prepare(
      `SELECT id FROM schema_instances
       WHERE patient_id = ? AND instance_type = 'patient_ehr'
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(patientId) as { id: string } | undefined
}

/**
 * GET /api/v1/patients/:patientId/ehr-field-candidates
 *
 * 返回某字段路径下的全部候选事件（不去重），以及当前选中的 candidate。
 * Query:
 *   - field_path (required)
 *   - project_id (optional) — 项目 CRF 模式
 *
 * 响应：
 * {
 *   candidates: Array<{
 *     id, value, source_document_id, source_document_name,
 *     source_page, source_location, source_text, confidence,
 *     created_by, created_at, occurrence_count
 *   }>,
 *   selected_candidate_id: string | null,
 *   selected_value: any,
 *   has_value_conflict: boolean,
 *   distinct_value_count: number
 * }
 */
router.get('/:patientId/ehr-field-candidates', (req: Request, res: Response) => {
  try {
    const patientId = String(req.params.patientId || '')
    const rawFieldPath = req.query.field_path as string
    const projectIdParam =
      typeof req.query.project_id === 'string' ? req.query.project_id.trim() : ''

    if (!rawFieldPath) {
      return res.status(400).json({
        success: false,
        code: 400,
        message: '缺少 field_path',
      })
    }

    const instance = resolveSchemaInstance(patientId, projectIdParam)
    if (!instance) {
      return res.json({
        success: true,
        code: 0,
        data: {
          candidates: [],
          selected_candidate_id: null,
          selected_value: null,
          has_value_conflict: false,
          distinct_value_count: 0,
        },
      })
    }

    const uniquePaths = buildCandidateFieldPaths(rawFieldPath)
    const placeholders = uniquePaths.map(() => '?').join(',')
    const scope = resolveScopeFromPath(instance.id, rawFieldPath)
    const scopeCandidate = buildScopeWhereClause(scope, 'fvc')
    const scopeSelected = buildScopeWhereClause(scope, 'fvs')

    const rows = db
      .prepare(
        `SELECT
           fvc.id,
           fvc.field_path,
           fvc.value_json,
           fvc.value_type,
           fvc.source_document_id,
           fvc.source_page,
           fvc.source_bbox_json,
           fvc.source_text,
           fvc.confidence,
           fvc.created_by,
           fvc.created_at,
           d.file_name AS source_document_name
         FROM field_value_candidates fvc
         LEFT JOIN documents d ON d.id = fvc.source_document_id
         WHERE fvc.instance_id = ? AND fvc.field_path IN (${placeholders})
           ${scopeCandidate.sql}
         ORDER BY fvc.created_at DESC`
      )
      .all(instance.id, ...uniquePaths, ...scopeCandidate.params) as any[]

    // 查每个候选路径对应的 selected 记录（取 instance 级第一条匹配）
    const selectedRow = db
      .prepare(
        `SELECT fvs.selected_candidate_id, fvs.selected_value_json, fvs.field_path
         FROM field_value_selected fvs
         WHERE fvs.instance_id = ? AND fvs.field_path IN (${placeholders})
           ${scopeSelected.sql}
         ORDER BY fvs.updated_at DESC, fvs.selected_at DESC
         LIMIT 1`
      )
      .get(instance.id, ...uniquePaths, ...scopeSelected.params) as
      | { selected_candidate_id: string | null; selected_value_json: string | null; field_path: string }
      | undefined

    // 按 source_document_id 去重：同一文档的多条候选只保留最新一条（避免同文档重复计数）
    // 冲突定义：存在 ≥2 个不同的 source_document_id（非 null）都命中了该字段
    const docCountMap = new Map<string, number>()
    const valueCountMap = new Map<string, number>()
    const latestByDoc = new Map<string, any>()
    for (const r of rows) {
      const docId = r.source_document_id || '__null__'
      const prevTs = latestByDoc.get(docId)?.created_at || ''
      if (r.created_at >= prevTs) {
        latestByDoc.set(docId, r)
      }
      if (r.source_document_id) {
        docCountMap.set(docId, (docCountMap.get(docId) || 0) + 1)
      }
      valueCountMap.set(r.value_json, (valueCountMap.get(r.value_json) || 0) + 1)
    }
    // 过滤掉 null doc（用户手动编辑），只统计有文档来源的
    const distinctSourceCount = [...docCountMap.entries()].filter(([k]) => k !== '__null__').length
    const hasValueConflict = distinctSourceCount >= 2

    // 同上：用兄弟候选回填缺失的 page_width/page_height
    const candidatePageSizeFallback = buildPageSizeFallback(rows)

    const candidates = rows.map((r) => {
      let parsedValue: any
      try {
        parsedValue = JSON.parse(r.value_json)
      } catch {
        parsedValue = r.value_json
      }
      return {
        id: r.id,
        value: parsedValue,
        source_document_id: r.source_document_id || null,
        source_document_name: r.source_document_name || null,
        source_page: r.source_page ?? null,
        source_location: parseSourceLocationWithFallback(
          r.source_bbox_json,
          r.source_page,
          r.source_document_id,
          candidatePageSizeFallback
        ),
        source_text: r.source_text || null,
        confidence: r.confidence ?? null,
        created_by: r.created_by || null,
        created_at: r.created_at,
        occurrence_count: valueCountMap.get(r.value_json) || 1,
      }
    })

    let selectedValue: any = null
    if (selectedRow?.selected_value_json) {
      try {
        selectedValue = JSON.parse(selectedRow.selected_value_json)
      } catch {
        selectedValue = selectedRow.selected_value_json
      }
    }

    return res.json({
      success: true,
      code: 0,
      data: {
        candidates,
        selected_candidate_id: selectedRow?.selected_candidate_id || null,
        selected_value: selectedValue,
        has_value_conflict: hasValueConflict,
        distinct_value_count: distinctSourceCount,
      },
    })
  } catch (err: any) {
    console.error('[GET ehr-field-candidates]', err)
    return res.status(500).json({
      success: false,
      code: 500,
      message: err.message,
    })
  }
})

/**
 * POST /api/v1/patients/:patientId/ehr-field-candidates/select
 *
 * 用户从候选值列表点击"采用此值"，或手工编辑字段值：
 *   1. 候选选择时校验候选存在且属于当前 instance；手工编辑时使用 selected_value
 *   2. UPSERT field_value_selected
 *   3. 仅手工编辑追加一条 created_by='user' 的候选；采用已有候选不新增候选
 *
 * Body:
 *   - field_path (required) — 用户点击时所处的字段路径
 *   - candidate_id (optional when selected_value is provided)
 *   - selected_value (optional) — 手工编辑值
 *   - project_id (optional) — 项目 CRF 模式
 */
router.post('/:patientId/ehr-field-candidates/select', (req: Request, res: Response) => {
  try {
    const patientId = String(req.params.patientId || '')
    const { field_path: rawFieldPath, candidate_id: candidateId, selected_value: selectedValueRaw, project_id: projectIdRaw } =
      req.body || {}
    const projectIdParam = typeof projectIdRaw === 'string' ? projectIdRaw.trim() : ''
    const hasManualValue = Object.prototype.hasOwnProperty.call(req.body || {}, 'selected_value')

    if (!rawFieldPath || (!candidateId && !hasManualValue)) {
      return res.status(400).json({
        success: false,
        code: 400,
        message: '缺少 field_path，或缺少 candidate_id/selected_value',
      })
    }

    const instance = resolveSchemaInstance(patientId, projectIdParam)
    if (!instance) {
      return res.status(404).json({
        success: false,
        code: 404,
        message: '未找到患者对应的 schema instance',
      })
    }

    // 归一化目标路径：与 Python 物化层 _normalize_field_path 对齐 —— 索引段一律剥离，
    // 行的区分完全押在 (section_instance_id, row_instance_id)。
    // 若不对齐，Node 侧写入的 field_path 带 /0/，与 Python 写入的干净路径永远不会
    // 触发 ON CONFLICT，AI→用户 的 selected 覆盖会失效（产生影子记录）。
    const rawPathWithSlash = rawFieldPath.startsWith('/')
      ? rawFieldPath
      : '/' + rawFieldPath.replace(/\./g, '/')
    const targetFieldPath = normalizeIndexedFieldPath(rawPathWithSlash)

    let candidate:
      | {
          id: string
          instance_id: string
          section_instance_id: string | null
          row_instance_id: string | null
          field_path: string
          value_json: string
          value_type: string | null
          source_document_id: string | null
          source_page: number | null
          source_block_id: string | null
          source_bbox_json: string | null
          source_text: string | null
          confidence: number | null
        }
      | undefined

    if (candidateId) {
      // 候选必须属于当前 instance，并拿到它的 value/source 用于 UPSERT 和审计
      candidate = db
        .prepare(
          `SELECT id, instance_id, section_instance_id, row_instance_id, field_path, value_json, value_type,
                  source_document_id, source_page, source_block_id, source_bbox_json,
                  source_text, confidence
           FROM field_value_candidates
           WHERE id = ? AND instance_id = ?`
        )
        .get(candidateId, instance.id) as typeof candidate

      if (!candidate) {
        return res.status(404).json({
          success: false,
          code: 404,
          message: '候选不存在或不属于该患者的 schema instance',
        })
      }

      // 允许：field_path 与候选自身 field_path 在归一化集合里同源即可
      const allowedPaths = new Set(buildSelectableCandidateFieldPaths(rawFieldPath))
      if (!allowedPaths.has(candidate.field_path)) {
        return res.status(409).json({
          success: false,
          code: 409,
          message: '候选的 field_path 与请求不匹配',
          data: {
            candidate_field_path: candidate.field_path,
            requested_field_path: rawFieldPath,
          },
        })
      }
    }

    const selectedValue = hasManualValue ? selectedValueRaw : parseStoredValue(candidate!.value_json)
    const selectedValueJson = JSON.stringify(selectedValue)
    const selectedValueType = hasManualValue ? inferValueType(selectedValue) : candidate!.value_type

    const upsertSelected = db.prepare(`
      INSERT INTO field_value_selected
        (id, instance_id, section_instance_id, row_instance_id, field_path, selected_candidate_id, selected_value_json, selected_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'user')
      ON CONFLICT(instance_id, COALESCE(section_instance_id, '__null__'), COALESCE(row_instance_id, '__null__'), field_path)
      DO UPDATE SET
        selected_candidate_id = excluded.selected_candidate_id,
        selected_value_json   = excluded.selected_value_json,
        selected_by           = 'user',
        updated_at            = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `)

    // 只有手工编辑才新增候选；采用已有候选只更新 selected 指针。
    const insertAuditCandidate = db.prepare(`
      INSERT INTO field_value_candidates
        (id, instance_id, field_path, value_json, value_type,
         source_document_id, source_page, source_block_id, source_bbox_json,
         source_text, confidence, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'user')
    `)

    const selectedId = randomUUID()
    // 用含索引的原始路径解析 scope —— 归一化后无法区分行。
    const selectedPosition = resolveScopeFromPath(instance.id, rawPathWithSlash)
    const selectedCandidateId = candidate?.id || randomUUID()

    if (!selectedPosition.resolved) {
      return res.status(409).json({
        success: false,
        code: 409,
        message: '字段路径中的重复项索引无法定位，请刷新病历夹后重试',
        data: { requested_field_path: rawFieldPath },
      })
    }

    if (candidate && selectedPosition.hasIndices) {
      const sameSection = (candidate.section_instance_id || null) === (selectedPosition.sectionInstanceId || null)
      const sameRow = (candidate.row_instance_id || null) === (selectedPosition.rowInstanceId || null)
      if (!sameSection || !sameRow) {
        return res.status(409).json({
          success: false,
          code: 409,
          message: '候选值不属于当前重复项，已拒绝跨行采用',
          data: {
            requested_field_path: rawFieldPath,
            candidate_section_instance_id: candidate.section_instance_id || null,
            candidate_row_instance_id: candidate.row_instance_id || null,
            target_section_instance_id: selectedPosition.sectionInstanceId || null,
            target_row_instance_id: selectedPosition.rowInstanceId || null,
          },
        })
      }
    }

    const doSelect = db.transaction(() => {
      if (!candidate) {
        insertAuditCandidate.run(
          selectedCandidateId,
          instance.id,
          targetFieldPath,
          selectedValueJson,
          selectedValueType,
          null,
          null,
          null,
          null,
          '用户手动编辑',
          null
        )
      }

      upsertSelected.run(
        selectedId,
        instance.id,
        selectedPosition.sectionInstanceId,
        selectedPosition.rowInstanceId,
        targetFieldPath,
        selectedCandidateId,
        selectedValueJson
      )
    })

    doSelect()

    return res.json({
      success: true,
      code: 0,
      message: candidate ? '已采用此值' : '保存成功',
      data: {
        field_path: targetFieldPath,
        selected_candidate_id: selectedCandidateId,
        source_candidate_id: candidate?.id || null,
        selected_value: selectedValue,
      },
    })
  } catch (err: any) {
    console.error('[POST ehr-field-candidates/select]', err)
    return res.status(500).json({
      success: false,
      code: 500,
      message: err.message,
    })
  }
})

export default router
