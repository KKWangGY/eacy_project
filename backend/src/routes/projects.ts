import { Router, Request, Response } from 'express'
import { randomUUID } from 'crypto'
import db from '../db.js'
import { crfServiceSubmitBatch } from '../services/crfServiceClient.js'

const router = Router()

function nowIso() {
  return new Date().toISOString()
}

const ALLOWED_STATUS = new Set(['draft', 'active', 'paused', 'completed'])

// 抽取任务兜底超时：DB 里 started_at 超过此阈值仍然在 pending/running，
// 认为 Celery/Worker 已经挂掉或被清理，强制判定为 failed，避免前端无限期显示"运行中"。
// 与 crf-service 中 EXTRACTION_SOFT_TIME_LIMIT_SEC 保持一致（20 分钟）。
const EXTRACTION_STALE_TIMEOUT_MS = 20 * 60 * 1000
const EXTRACTION_STALE_ERROR = '任务执行超过 20 分钟未完成，已自动标记为失败'

function parseJsonObject(raw: unknown): Record<string, any> {
  if (!raw) return {}
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, any>
  if (typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function parseStoredValue(raw: string) {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
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

function parseJsonArray(raw: unknown): any[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  if (typeof raw !== 'string') return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function normalizeStringList(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  return [...new Set(values.map((item) => String(item ?? '').trim()).filter(Boolean))]
}

function normalizeSourceList(value: unknown): string[] {
  if (value == null) return []
  if (typeof value === 'string') return value.trim() ? [value.trim()] : []
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item ?? '').trim()).filter(Boolean)
}

function pickSchemaAsset(content: Record<string, any>) {
  const candidates = [
    content.schema_json,
    content.schema,
    content.layout_config?.schema_json,
    content.layout_config?.schema,
    content,
  ]
  for (const candidate of candidates) {
    const parsed = parseJsonObject(candidate)
    if (Object.keys(parsed).length > 0) return parsed
  }
  return {}
}

function pickTemplateFieldGroups(content: Record<string, any>, derivedGroups: any[]) {
  const candidates = [
    content.field_groups,
    content.template_info?.field_groups,
    content.layout_config?.field_groups,
  ]
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate
  }
  return derivedGroups
}

function deriveFieldGroupsFromSchema(schema: Record<string, any>) {
  const rootProps = schema?.properties
  if (!rootProps || typeof rootProps !== 'object' || Array.isArray(rootProps)) {
    return { fieldGroups: [], fieldMap: {} as Record<string, string> }
  }

  const fieldGroups: any[] = []
  const fieldMap: Record<string, string> = {}

  const collectLeafFields = (
    target: Record<string, any> | null | undefined,
    path: string[],
    labels: string[]
  ) => {
    if (!target || typeof target !== 'object') return
    const targetType = target.type
    if (targetType === 'array' && target.items && typeof target.items === 'object' && !Array.isArray(target.items)) {
      collectLeafFields(target.items as Record<string, any>, path, labels)
      return
    }
    const props = target.properties
    if (!props || typeof props !== 'object' || Array.isArray(props)) {
      if (path.length > 0) {
        const fieldPath = path.join('/')
        const label = labels[labels.length - 1] || path[path.length - 1]
        fieldMap[fieldPath] = label
      }
      return
    }
    for (const [childKey, childSchema] of Object.entries(props)) {
      if (!childSchema || typeof childSchema !== 'object' || Array.isArray(childSchema)) continue
      const childObj = childSchema as Record<string, any>
      const childTitle = String(childObj.title || childKey)
      collectLeafFields(childObj, [...path, childKey], [...labels, childTitle])
    }
  }

  let groupIndex = 0
  for (const [groupKey, groupSchema] of Object.entries(rootProps)) {
    if (!groupSchema || typeof groupSchema !== 'object' || Array.isArray(groupSchema)) continue
    const groupObj = groupSchema as Record<string, any>
    const groupTitle = String(groupObj.title || groupKey)
    const target = groupObj.type === 'array' && groupObj.items && typeof groupObj.items === 'object' && !Array.isArray(groupObj.items)
      ? (groupObj.items as Record<string, any>)
      : groupObj
    const groupFieldsBefore = Object.keys(fieldMap).length
    collectLeafFields(target, [groupKey], [groupTitle])
    const dbFields = Object.keys(fieldMap).slice(groupFieldsBefore)
    const sources = groupObj['x-sources'] && typeof groupObj['x-sources'] === 'object' && !Array.isArray(groupObj['x-sources'])
      ? {
          primary: normalizeSourceList((groupObj['x-sources'] as Record<string, any>).primary),
          secondary: normalizeSourceList((groupObj['x-sources'] as Record<string, any>).secondary),
        }
      : { primary: [], secondary: [] }

    fieldGroups.push({
      group_id: groupKey,
      group_name: groupTitle,
      order: groupIndex++,
      is_repeatable: groupObj.type === 'array',
      db_fields: dbFields,
      field_count: dbFields.length,
      sources,
    })
  }

  return { fieldGroups, fieldMap }
}

function parseFormPathFromGroupId(groupId: string): string | null {
  const raw = String(groupId || '').trim()
  if (!raw) return null
  if (raw.includes(' / ')) return raw
  const slashParts = raw.split('/').map((part) => part.trim()).filter(Boolean)
  if (slashParts.length >= 2) return `${slashParts[0]} / ${slashParts[1]}`
  const dotParts = raw.split('.').map((part) => part.trim()).filter(Boolean)
  if (dotParts.length >= 2) return `${dotParts[0]} / ${dotParts[1]}`
  return raw
}

function buildTargetSectionMap(schema: Record<string, any> | null | undefined, fieldGroups: any[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const group of fieldGroups || []) {
    const groupId = String(group?.group_id || '').trim()
    if (!groupId) continue
    const formPath = parseFormPathFromGroupId(groupId)
    if (formPath) map[groupId] = formPath
    const groupName = String(group?.group_name || '').trim()
    if (groupName && formPath) map[groupName] = formPath
  }

  const rootProps = schema?.properties
  if (rootProps && typeof rootProps === 'object' && !Array.isArray(rootProps)) {
    for (const [folderKey, folderSchema] of Object.entries(rootProps)) {
      if (!folderSchema || typeof folderSchema !== 'object' || Array.isArray(folderSchema)) continue
      const folderObj = folderSchema as Record<string, any>
      const folderTitle = String(folderObj.title || folderKey).trim()
      const childProps = folderObj.properties
      if (childProps && typeof childProps === 'object' && !Array.isArray(childProps)) {
        const childKeys = Object.keys(childProps).filter((key) => {
          const childSchema = (childProps as Record<string, any>)[key]
          return childSchema && typeof childSchema === 'object' && !Array.isArray(childSchema)
        })
        if (childKeys.length === 1) {
          const onlyGroupKey = childKeys[0]
          const onlyGroupSchema = (childProps as Record<string, any>)[onlyGroupKey]
          const onlyGroupTitle = String(onlyGroupSchema?.title || onlyGroupKey).trim()
          const onlyFormName = `${folderKey} / ${onlyGroupKey}`
          map[folderKey] = onlyFormName
          if (folderTitle) map[folderTitle] = onlyFormName
          if (folderTitle && onlyGroupTitle) map[`${folderTitle} / ${onlyGroupTitle}`] = onlyFormName
        }
        for (const [groupKey, groupSchema] of Object.entries(childProps)) {
          if (!groupSchema || typeof groupSchema !== 'object' || Array.isArray(groupSchema)) continue
          const groupObj = groupSchema as Record<string, any>
          const groupTitle = String(groupObj.title || groupKey).trim()
          const formName = `${folderKey} / ${groupKey}`
          map[`${folderKey}/${groupKey}`] = formName
          map[`${folderKey}.${groupKey}`] = formName
          map[formName] = formName
          if (folderTitle && groupTitle) map[`${folderTitle} / ${groupTitle}`] = formName
        }
      } else {
        const formName = String(folderKey).trim()
        if (formName) {
          map[formName] = formName
          if (folderTitle) map[folderTitle] = formName
        }
      }
    }
  }

  return map
}

function resolveTargetSections(rawGroups: string[], schema: Record<string, any> | null | undefined, fieldGroups: any[]) {
  const sectionMap = buildTargetSectionMap(schema, fieldGroups)
  const targetSections: string[] = []
  const unresolved: string[] = []
  for (const group of rawGroups) {
    const section = sectionMap[group] || parseFormPathFromGroupId(group)
    if (section) targetSections.push(section)
    else unresolved.push(group)
  }
  return {
    targetSections: [...new Set(targetSections)],
    unresolved,
  }
}

function getProjectTemplateMeta(schemaId: string | null | undefined) {
  if (!schemaId) {
    return {
      schemaRow: null,
      schemaJson: null,
      fieldGroups: [],
      fieldMap: {},
    }
  }
  const schemaRow = db
    .prepare(`SELECT id, name, code, version, content_json FROM schemas WHERE id = ?`)
    .get(schemaId) as { id: string; name: string; code: string; version: string; content_json: string } | undefined
  if (!schemaRow) {
    return {
      schemaRow: null,
      schemaJson: null,
      fieldGroups: [],
      fieldMap: {},
    }
  }
  const contentJson = parseJsonObject(schemaRow.content_json)
  const schemaJson = pickSchemaAsset(contentJson)
  const { fieldGroups: derivedFieldGroups, fieldMap } = deriveFieldGroupsFromSchema(schemaJson)
  const fieldGroups = pickTemplateFieldGroups(contentJson, derivedFieldGroups)
  return { schemaRow, schemaJson, fieldGroups, fieldMap }
}

function decodeSelectedValue(raw: unknown) {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function normalizeBbox(raw: unknown) {
  if (!raw) return null
  let parsed: any = raw
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
      if (typeof parsed === 'string') {
        parsed = JSON.parse(parsed)
      }
    } catch {
      return null
    }
  }
  return parsed
}

function isMeaningfulCrfValue(value: any) {
  return value !== null && value !== undefined && value !== ''
}

function buildFieldPayload(row: any, value: any, fieldName: string) {
  return {
    value,
    field_name: fieldName,
    source: row.source_document_id ? 'AI抽取' : null,
    confidence: row.confidence,
    document_id: row.source_document_id,
    document_name: row.source_document_name,
    document_type: row.source_document_type,
    raw: row.source_text,
    bbox: normalizeBbox(row.source_bbox_json),
    page_idx: row.source_page,
    source_id: row.candidate_id,
  }
}

function ensureProjectCrfGroup(groups: Record<string, any>, groupId: string, fieldMap: Record<string, string> = {}) {
  if (!groups[groupId]) {
    groups[groupId] = {
      group_name: fieldMap[groupId] || groupId,
      fields: {},
    }
  }
  return groups[groupId]
}

function buildProjectCrfData(
  patientId: string,
  schemaId: string | null | undefined,
  projectId: string | null | undefined,
  fieldMap: Record<string, string> = {}
) {
  const empty = { groups: {}, _extracted_at: null, _extraction_mode: null, _change_logs: [], _task_results: [], _documents: {} }
  if (!schemaId || !projectId) {
    return { crfData: empty, crfCompleteness: '0', instanceId: null }
  }

  const instance = db.prepare(`
    SELECT si.id
    FROM schema_instances si
    WHERE si.patient_id = ? AND si.schema_id = ? AND si.project_id = ? AND si.instance_type = 'project_crf'
    ORDER BY si.updated_at DESC
    LIMIT 1
  `).get(patientId, schemaId, projectId) as { id: string } | undefined

  if (!instance?.id) {
    return { crfData: empty, instanceId: null }
  }

  // 构建嵌套 data 结构（与 ehrData.ts 保持一致，支持可重复 section 数组）
  const draftData: any = {}
  const selectedRows = db.prepare(`
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
      fvs.field_path
  `).all(instance.id) as any[]

  for (const row of selectedRows) {
    const path = row.field_path
    const parts = String(path || '').split('/').filter((p: string) => p !== '')
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

  // 构建 flat groups 结构（向后兼容，含溯源信息）
  const rows = db.prepare(`
    SELECT
      fvs.field_path,
      fvs.selected_value_json,
      fvs.section_instance_id,
      fvs.row_instance_id,
      si.section_path,
      si.repeat_index AS section_repeat_index,
      si.is_repeatable AS section_is_repeatable,
      ri.group_path,
      ri.repeat_index AS row_repeat_index,
      fvc.id AS candidate_id,
      fvc.source_document_id,
      fvc.source_page,
      fvc.source_bbox_json,
      fvc.source_text,
      fvc.confidence,
      d.file_name AS source_document_name,
      d.document_sub_type AS source_document_type
    FROM field_value_selected fvs
    LEFT JOIN section_instances si ON si.id = fvs.section_instance_id
    LEFT JOIN row_instances ri ON ri.id = fvs.row_instance_id
    LEFT JOIN field_value_candidates fvc ON fvc.id = fvs.selected_candidate_id
    LEFT JOIN documents d ON d.id = fvc.source_document_id
    WHERE fvs.instance_id = ?
    ORDER BY
      COALESCE(si.section_path, ''),
      COALESCE(si.repeat_index, 0),
      COALESCE(ri.group_path, ''),
      COALESCE(ri.repeat_index, 0),
      fvs.field_path
  `).all(instance.id) as any[]

  const groups: Record<string, any> = {}
  const repeatRecordMaps: Record<string, Map<string, any>> = {}
  let totalFields = 0
  let filledFields = 0

  for (const row of rows) {
    const rawPath = String(row.field_path || '')
    const parts = rawPath.split('/').filter(Boolean)
    if (parts.length === 0) continue
    const groupId = parts[0]
    const fieldId = parts.slice(1).join('/')
    const group = ensureProjectCrfGroup(groups, groupId, fieldMap)
    const value = decodeSelectedValue(row.selected_value_json)
    const leafKey = parts[parts.length - 1]
    const fieldName = fieldMap[rawPath] || fieldMap[fieldId] || leafKey
    const fieldPayload = buildFieldPayload(row, value, fieldName)
    group.fields[fieldId] = fieldPayload

    const hasRepeatableSection =
      !!row.section_instance_id &&
      typeof row.section_path === 'string' &&
      !!row.section_path &&
      Number(row.section_is_repeatable || 0) === 1
    const hasRepeatableRow = !!row.row_instance_id && typeof row.group_path === 'string' && row.group_path
    if (hasRepeatableSection || hasRepeatableRow) {
      const recordIndex = Number(hasRepeatableRow ? row.row_repeat_index : row.section_repeat_index || 0)
      const recordScope = hasRepeatableRow ? String(row.group_path) : String(row.section_path)
      const recordKey = `${recordScope}#${Number.isFinite(recordIndex) ? recordIndex : 0}`
      if (!repeatRecordMaps[groupId]) repeatRecordMaps[groupId] = new Map()
      if (!repeatRecordMaps[groupId].has(recordKey)) {
        repeatRecordMaps[groupId].set(recordKey, {
          __repeat_index: Number.isFinite(recordIndex) ? recordIndex : 0,
          __repeat_scope: recordScope,
          fields: {},
        })
      }
      const record = repeatRecordMaps[groupId].get(recordKey)
      const scopedParts = hasRepeatableRow
        ? parts.slice(String(row.group_path).split('/').filter(Boolean).length)
        : parts.slice(String(row.section_path).split('/').filter(Boolean).length)
      const scopedFieldId = scopedParts.length > 0 ? scopedParts.join('/') : fieldId
      record.fields[scopedFieldId] = fieldPayload
      record.fields[fieldId] = fieldPayload

      if (recordScope && recordScope !== groupId) {
        const scopedGroup = ensureProjectCrfGroup(groups, recordScope, fieldMap)
        scopedGroup.is_repeatable = true
        scopedGroup.fields[scopedFieldId] = fieldPayload
        if (!repeatRecordMaps[recordScope]) repeatRecordMaps[recordScope] = new Map()
        if (!repeatRecordMaps[recordScope].has(recordKey)) {
          repeatRecordMaps[recordScope].set(recordKey, {
            __repeat_index: Number.isFinite(recordIndex) ? recordIndex : 0,
            __repeat_scope: recordScope,
            fields: {},
          })
        }
        const scopedGroupRecord = repeatRecordMaps[recordScope].get(recordKey)
        scopedGroupRecord.fields[scopedFieldId] = fieldPayload
      }
    }
    totalFields += 1
    if (isMeaningfulCrfValue(value)) {
      filledFields += 1
    }
  }

  for (const [groupId, recordMap] of Object.entries(repeatRecordMaps)) {
    if (!groups[groupId]) continue
    groups[groupId].is_repeatable = true
    groups[groupId].records = [...recordMap.values()]
      .sort((a, b) => Number(a.__repeat_index || 0) - Number(b.__repeat_index || 0))
  }

  const lastRun = db.prepare(`
    SELECT finished_at
    FROM extraction_runs
    WHERE instance_id = ? AND status = 'succeeded'
    ORDER BY finished_at DESC
    LIMIT 1
  `).get(instance.id) as { finished_at: string } | undefined

  return {
    crfData: {
      data: draftData,
      groups,
      _extracted_at: lastRun?.finished_at || null,
      _extraction_mode: 'full',
      _change_logs: [],
      _task_results: [],
      _documents: {},
    },
    crfCompleteness: totalFields > 0 ? String(Math.round((filledFields / totalFields) * 100)) : '0',
    instanceId: instance.id,
  }
}

function getLatestProjectExtractionTask(projectId: string) {
  return db.prepare(`
    SELECT *
    FROM project_extraction_tasks
    WHERE project_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(projectId) as any
}

function getActiveProjectExtractionTasks(projectId: string, limit = 20) {
  return db.prepare(`
    SELECT *
    FROM project_extraction_tasks
    WHERE project_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(projectId, limit) as any[]
}

function findActiveTaskForPatients(projectId: string, patientIds: string[]) {
  const targetSet = new Set(normalizeStringList(patientIds))
  if (targetSet.size === 0) return null

  for (const row of getActiveProjectExtractionTasks(projectId)) {
    const task = persistProjectTaskSummary(summarizeProjectTask(row))
    if (!task || !['pending', 'running'].includes(task.status)) continue
    const activePatients = normalizeStringList(task.patient_ids)
    if (activePatients.some((patientId) => targetSet.has(patientId))) {
      return task
    }
  }
  return null
}

function getProjectCrfHistoryStats(patientId: string, schemaId: string | null | undefined, projectId: string | null | undefined) {
  const empty = { hasExtractionHistory: false, extractionRunCount: 0, candidateCount: 0, selectedValueCount: 0 }
  if (!patientId || !schemaId || !projectId) return empty

  const instance = db.prepare(`
    SELECT id
    FROM schema_instances
    WHERE patient_id = ? AND schema_id = ? AND project_id = ? AND instance_type = 'project_crf'
    LIMIT 1
  `).get(patientId, schemaId, projectId) as { id: string } | undefined

  if (!instance?.id) return empty

  const runRow = db.prepare(`SELECT COUNT(*) AS c FROM extraction_runs WHERE instance_id = ?`).get(instance.id) as { c: number } | undefined
  const candidateRow = db.prepare(`SELECT COUNT(*) AS c FROM field_value_candidates WHERE instance_id = ?`).get(instance.id) as { c: number } | undefined
  const selectedRow = db.prepare(`SELECT COUNT(*) AS c FROM field_value_selected WHERE instance_id = ?`).get(instance.id) as { c: number } | undefined
  const extractionRunCount = Number(runRow?.c || 0)
  const candidateCount = Number(candidateRow?.c || 0)
  const selectedValueCount = Number(selectedRow?.c || 0)

  return {
    hasExtractionHistory: extractionRunCount > 0 || candidateCount > 0 || selectedValueCount > 0,
    extractionRunCount,
    candidateCount,
    selectedValueCount,
  }
}

function clearProjectCrfHistoryForPatients(projectId: string, schemaId: string, patientIds: string[]) {
  const normalizedPatientIds = normalizeStringList(patientIds)
  if (!projectId || !schemaId || normalizedPatientIds.length === 0) {
    return { cleared_patient_count: 0, cleared_instance_count: 0 }
  }

  const placeholders = normalizedPatientIds.map(() => '?').join(',')
  const instances = db.prepare(`
    SELECT id, patient_id
    FROM schema_instances
    WHERE project_id = ?
      AND schema_id = ?
      AND instance_type = 'project_crf'
      AND patient_id IN (${placeholders})
  `).all(projectId, schemaId, ...normalizedPatientIds) as Array<{ id: string; patient_id: string }>

  const instanceIds = normalizeStringList(instances.map((item) => item.id))
  if (instanceIds.length === 0) {
    return { cleared_patient_count: 0, cleared_instance_count: 0 }
  }

  const instancePlaceholders = instanceIds.map(() => '?').join(',')
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM field_value_selected WHERE instance_id IN (${instancePlaceholders})`).run(...instanceIds)
    db.prepare(`DELETE FROM field_value_candidates WHERE instance_id IN (${instancePlaceholders})`).run(...instanceIds)
    db.prepare(`DELETE FROM extraction_runs WHERE instance_id IN (${instancePlaceholders})`).run(...instanceIds)
    db.prepare(`DELETE FROM instance_documents WHERE instance_id IN (${instancePlaceholders})`).run(...instanceIds)
    db.prepare(`DELETE FROM row_instances WHERE instance_id IN (${instancePlaceholders})`).run(...instanceIds)
    db.prepare(`DELETE FROM section_instances WHERE instance_id IN (${instancePlaceholders})`).run(...instanceIds)
    db.prepare(`DELETE FROM schema_instances WHERE id IN (${instancePlaceholders})`).run(...instanceIds)
  })
  tx()

  return {
    cleared_patient_count: new Set(instances.map((item) => item.patient_id)).size,
    cleared_instance_count: instanceIds.length,
  }
}

/**
 * 判断本次项目 CRF 抽取是否应先清空历史。
 *
 * 只有明确的全量重抽才允许清空整份 CRF；增量抽取和专项字段组抽取都必须保留
 * 其它字段的候选、已选值和用户编辑，避免任务提交前造成不可恢复的数据丢失。
 */
function shouldClearProjectCrfHistory(mode: string, targetGroups: string[]) {
  return mode === 'full' && targetGroups.length === 0
}

function summarizeProjectTask(taskRow: any) {
  if (!taskRow) return null
  const jobIds = normalizeStringList(parseJsonArray(taskRow.job_ids_json))
  const patientIds = normalizeStringList(parseJsonArray(taskRow.patient_ids_json))
  const documentIds = normalizeStringList(parseJsonArray(taskRow.document_ids_json))
  const targetGroups = normalizeStringList(parseJsonArray(taskRow.target_groups_json))
  const summary = parseJsonObject(taskRow.summary_json)

  const jobStatusRows = jobIds.length > 0
    ? (db.prepare(`
        SELECT id, patient_id, document_id, status, last_error, started_at, completed_at, updated_at
        FROM ehr_extraction_jobs
        WHERE id IN (${jobIds.map(() => '?').join(',')})
      `).all(...jobIds) as any[])
    : []

  let pending = 0
  let running = 0
  let completed = 0
  let failed = 0
  const errors: any[] = []

  for (const job of jobStatusRows) {
    if (job.status === 'pending') pending += 1
    else if (job.status === 'running') running += 1
    else if (job.status === 'completed') completed += 1
    else if (job.status === 'failed') {
      failed += 1
      errors.push({
        job_id: job.id,
        patient_id: job.patient_id,
        document_id: job.document_id,
        message: job.last_error || '抽取失败',
      })
    }
  }

  const total = jobIds.length
  let status = String(taskRow.status || 'pending')
  if (status !== 'cancelled' && total > 0) {
    if (failed === total) {
      status = 'failed'
    } else if (completed + failed === total) {
      status = failed > 0 ? 'completed_with_errors' : 'completed'
    } else if (running > 0) {
      status = 'running'
    } else if (pending > 0) {
      status = 'pending'
    }
  } else if (status !== 'cancelled' && total === 0) {
    status = summary.submitted_job_count > 0 ? 'running' : 'idle'
  }

  // 兜底超时：状态仍然 pending/running，但 started_at 已经过去 20 分钟，
  // 说明 Celery worker 已经挂掉或 broker 出问题，强制判定为失败
  if (['pending', 'running'].includes(status)) {
    const startedAtMs = Date.parse(taskRow.started_at || taskRow.created_at || '')
    if (Number.isFinite(startedAtMs) && Date.now() - startedAtMs > EXTRACTION_STALE_TIMEOUT_MS) {
      status = 'failed'
      // 把所有 pending/running 的 job 一起标为 failed，避免下次还被当成"在跑"
      if (jobIds.length > 0) {
        const staleAt = nowIso()
        try {
          db.prepare(`
            UPDATE ehr_extraction_jobs
            SET status = 'failed',
                last_error = ?,
                completed_at = ?,
                updated_at = ?
            WHERE id IN (${jobIds.map(() => '?').join(',')})
              AND status IN ('pending', 'running')
          `).run(EXTRACTION_STALE_ERROR, staleAt, staleAt, ...jobIds)
        } catch (err) {
          console.warn('[summarizeProjectTask] 标记僵尸 job 失败:', err)
        }
      }
      failed = Math.max(failed, total - completed)
      pending = 0
      running = 0
      if (errors.length === 0) {
        errors.push({ job_id: null, patient_id: null, document_id: null, message: EXTRACTION_STALE_ERROR })
      }
    }
  }

  const progress = total > 0 ? Math.round(((completed + failed) / total) * 100) : 0

  return {
    task_id: taskRow.id,
    project_id: taskRow.project_id,
    schema_id: taskRow.schema_id,
    status,
    mode: taskRow.mode || 'incremental',
    target_groups: targetGroups,
    patient_ids: patientIds,
    document_ids: documentIds,
    job_ids: jobIds,
    total,
    completed,
    failed,
    running,
    pending,
    success_count: total > 0 ? Math.max(0, patientIds.length - errors.length) : 0,
    error_count: failed,
    progress,
    started_at: taskRow.started_at || taskRow.created_at,
    finished_at: taskRow.finished_at || null,
    summary: {
      ...summary,
      submitted_job_count: total,
      submitted_patient_count: patientIds.length,
      submitted_document_count: documentIds.length,
    },
    errors,
  }
}

function persistProjectTaskSummary(task: any) {
  if (!task?.task_id) return task
  db.prepare(`
    UPDATE project_extraction_tasks
    SET
      status = ?,
      summary_json = ?,
      finished_at = CASE
        WHEN ? IN ('completed', 'completed_with_errors', 'failed', 'cancelled') THEN COALESCE(finished_at, ?)
        ELSE finished_at
      END,
      updated_at = ?
    WHERE id = ?
  `).run(
    task.status,
    JSON.stringify(task.summary || {}),
    task.status,
    nowIso(),
    nowIso(),
    task.task_id
  )
  return task
}

/**
 * GET /api/v1/projects
 * 项目列表（与前端科研数据集列表字段对齐）
 */
router.get('/', (req: Request, res: Response) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1)
    const pageSize = Math.min(200, Math.max(1, Number(req.query.page_size) || 100))
    const offset = (page - 1) * pageSize
    const status = req.query.status != null ? String(req.query.status).trim() : ''
    const search = req.query.search != null ? String(req.query.search).trim() : ''

    let sql = `
      SELECT p.*, s.name AS schema_name,
        (SELECT COUNT(*) FROM project_patients pp WHERE pp.project_id = p.id) AS actual_patient_count
      FROM projects p
      LEFT JOIN schemas s ON s.id = p.schema_id
      WHERE 1=1
    `
    const params: string[] = []
    if (status) {
      sql += ` AND p.status = ?`
      params.push(status)
    }
    if (search) {
      sql += ` AND p.project_name LIKE ?`
      params.push(`%${search}%`)
    }
    sql += ` ORDER BY p.updated_at DESC LIMIT ? OFFSET ?`
    params.push(String(pageSize), String(offset))

    const rows = db.prepare(sql).all(...params) as any[]

    let countSql = `SELECT COUNT(*) AS c FROM projects p WHERE 1=1`
    const countParams: string[] = []
    if (status) {
      countSql += ` AND p.status = ?`
      countParams.push(status)
    }
    if (search) {
      countSql += ` AND p.project_name LIKE ?`
      countParams.push(`%${search}%`)
    }
    const totalRow = db.prepare(countSql).get(...countParams) as { c: number }

    const data = rows.map((p) => ({
      id: p.id,
      project_code: typeof p.id === 'string' && p.id.length >= 8 ? p.id.substring(0, 8) : p.id,
      project_name: p.project_name,
      description: p.description ?? '',
      status: p.status,
      schema_id: p.schema_id,
      crf_template_id: p.schema_id,
      template_scope_config: {
        template_id: p.schema_id,
        template_name: p.schema_name || 'CRF 模板',
      },
      actual_patient_count: p.actual_patient_count ?? 0,
      principal_investigator_name: p.principal_investigator_name ?? null,
      principal_investigator_id: null,
      created_at: p.created_at,
      updated_at: p.updated_at,
      avg_completeness: 0,
    }))

    return res.json({
      success: true,
      code: 0,
      message: 'ok',
      data,
      pagination: {
        total: totalRow?.c ?? 0,
        page,
        page_size: pageSize,
      },
    })
  } catch (err: any) {
    console.error('[GET /projects]', err)
    if (String(err?.message || '').includes('no such table: projects')) {
      return res.json({
        success: true,
        code: 0,
        message: 'projects 表尚未创建，返回空列表',
        data: [],
        pagination: { total: 0, page: 1, page_size: 100 },
      })
    }
    return res.status(500).json({
      success: false,
      code: 500,
      message: err?.message || '服务器错误',
      data: null,
    })
  }
})

/**
 * POST /api/v1/projects
 * 新建科研项目，写入 projects；可选同时写入 project_patients（受试者）
 *
 * Body:
 * - project_name (必填)
 * - schema_id 或 crf_template_id (必填，对应 schemas.id)
 * - description (可选)
 * - principal_investigator_name (可选)
 * - principal_investigator_id (可选，暂无用户表时写入 name 列作占位)
 * - status (可选，默认 draft)
 * - patient_ids (可选，患者 id 字符串数组)
 * - selected_patients (可选，与前端向导兼容：{ id }[] 或 id[]）
 */
router.post('/', (req: Request, res: Response) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const project_name = String((body as any).project_name ?? '').trim()
    if (!project_name) {
      return res.status(400).json({
        success: false,
        code: 400,
        message: '缺少必填字段：project_name',
        data: null,
      })
    }

    const b = body as Record<string, unknown>
    const schemaIdRaw = b.schema_id ?? b.crf_template_id
    const schema_id =
      schemaIdRaw != null && schemaIdRaw !== '' ? String(schemaIdRaw).trim() : ''
    if (!schema_id) {
      return res.status(400).json({
        success: false,
        code: 400,
        message: '缺少必填字段：schema_id 或 crf_template_id（对应 schemas 表主键）',
        data: null,
      })
    }

    const schemaRow = db.prepare(`SELECT id FROM schemas WHERE id = ?`).get(schema_id) as { id: string } | undefined
    if (!schemaRow) {
      return res.status(400).json({
        success: false,
        code: 400,
        message: '指定的 schema / CRF 模板不存在',
        data: null,
      })
    }

    const description =
      b.description != null && String(b.description).trim() !== '' ? String(b.description) : null

    let principal_investigator_name: string | null = null
    if (b.principal_investigator_name != null && String(b.principal_investigator_name).trim() !== '') {
      principal_investigator_name = String(b.principal_investigator_name).trim()
    } else if (b.principal_investigator_id != null && String(b.principal_investigator_id).trim() !== '') {
      principal_investigator_name = String(b.principal_investigator_id).trim()
    }

    let status = b.status != null ? String(b.status).trim() : 'draft'
    if (!ALLOWED_STATUS.has(status)) {
      status = 'draft'
    }

    const rawPatients = b.patient_ids ?? b.selected_patients
    const patient_ids: string[] = []
    if (Array.isArray(rawPatients)) {
      for (const item of rawPatients) {
        if (typeof item === 'string' && item.trim()) {
          patient_ids.push(item.trim())
        } else if (item && typeof item === 'object' && 'id' in item && String((item as any).id).trim()) {
          patient_ids.push(String((item as any).id).trim())
        }
      }
    }
    const uniquePatientIds = [...new Set(patient_ids)]

    const stmtPatient = db.prepare(`SELECT id FROM patients WHERE id = ?`)
    for (const pid of uniquePatientIds) {
      if (!stmtPatient.get(pid)) {
        return res.status(400).json({
          success: false,
          code: 400,
          message: `患者不存在：${pid}`,
          data: null,
        })
      }
    }

    const id = randomUUID()
    const ts = nowIso()

    const insertProject = db.prepare(`
      INSERT INTO projects (id, project_name, description, principal_investigator_name, schema_id, status, created_at, updated_at)
      VALUES (@id, @project_name, @description, @principal_investigator_name, @schema_id, @status, @created_at, @updated_at)
    `)
    const insertEnrollment = db.prepare(`
      INSERT INTO project_patients (id, project_id, patient_id, enrolled_at, subject_label, metadata)
      VALUES (@id, @project_id, @patient_id, @enrolled_at, NULL, '{}')
    `)

    const run = db.transaction(() => {
      insertProject.run({
        id,
        project_name,
        description,
        principal_investigator_name,
        schema_id,
        status,
        created_at: ts,
        updated_at: ts,
      })
      for (const patient_id of uniquePatientIds) {
        insertEnrollment.run({
          id: randomUUID(),
          project_id: id,
          patient_id,
          enrolled_at: ts,
        })
      }
    })
    run()

    const row = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as Record<string, unknown>
    const enrolled = db
      .prepare(`SELECT COUNT(*) AS c FROM project_patients WHERE project_id = ?`)
      .get(id) as { c: number }

    return res.status(201).json({
      success: true,
      code: 0,
      message: '项目已创建',
      data: {
        ...row,
        enrolled_patient_count: enrolled?.c ?? 0,
      },
    })
  } catch (err: any) {
    console.error('[POST /projects]', err)
    const msg = err?.message || '创建项目失败'
    if (String(msg).includes('no such table: projects')) {
      return res.status(503).json({
        success: false,
        code: 503,
        message: '数据库缺少 projects 表，请升级 schema 或执行 backend 增量迁移后重启',
        data: null,
      })
    }
    return res.status(500).json({
      success: false,
      code: 500,
      message: msg,
      data: null,
    })
  }
})

function paramId(v: string | string[] | undefined): string {
  const x = Array.isArray(v) ? v[0] : v
  return String(x ?? '').trim()
}

function normalizeProjectFieldPath(rawPath: string): string {
  let fieldPath = String(rawPath || '').trim()
  if (!fieldPath) return '/'
  if (!fieldPath.startsWith('/')) {
    fieldPath = '/' + fieldPath.replace(/\./g, '/')
  }
  return fieldPath.replace(/\/+/g, '/')
}

function stripProjectFieldPathIndices(rawPath: string): string {
  return '/' + normalizeProjectFieldPath(rawPath)
    .split('/')
    .filter(Boolean)
    .filter((segment) => !/^\d+$/.test(segment))
    .join('/')
}

function resolveProjectFieldScope(instanceId: string, rawPath: string): {
  sectionInstanceId: string | null
  rowInstanceId: string | null
  hasIndices: boolean
  resolved: boolean
} {
  const segments = normalizeProjectFieldPath(rawPath).split('/').filter(Boolean)
  const hasIndices = segments.some((segment) => /^\d+$/.test(segment))
  if (!hasIndices) {
    return { sectionInstanceId: null, rowInstanceId: null, hasIndices: false, resolved: true }
  }

  let sectionInstanceId: string | null = null
  let rowInstanceId: string | null = null
  let parentSectionId: string | null = null
  let parentRowId: string | null = null
  const cumulative: string[] = []

  for (const segment of segments) {
    if (!/^\d+$/.test(segment)) {
      cumulative.push(segment)
      continue
    }

    const repeatIndex = Number(segment)
    const groupPath = '/' + cumulative.join('/')
    const row = db.prepare(`
      SELECT id FROM row_instances
      WHERE instance_id = ? AND group_path = ? AND repeat_index = ?
        AND COALESCE(parent_row_id, '__null__') = COALESCE(?, '__null__')
      LIMIT 1
    `).get(instanceId, groupPath, repeatIndex, parentRowId) as { id: string } | undefined

    if (row) {
      parentRowId = row.id
      rowInstanceId = row.id
      continue
    }

    const sectionPath = '/' + cumulative.filter((part) => !/^\d+$/.test(part)).join('/')
    const section = db.prepare(`
      SELECT id FROM section_instances
      WHERE instance_id = ? AND section_path = ? AND repeat_index = ?
        AND COALESCE(parent_section_id, '__null__') = COALESCE(?, '__null__')
      LIMIT 1
    `).get(instanceId, sectionPath, repeatIndex, parentSectionId) as { id: string } | undefined

    if (section) {
      parentSectionId = section.id
      sectionInstanceId = section.id
      cumulative.push(segment)
      continue
    }

    return { sectionInstanceId, rowInstanceId, hasIndices: true, resolved: false }
  }

  return { sectionInstanceId, rowInstanceId, hasIndices: true, resolved: true }
}

/**
 * PATCH /api/v1/projects/:projectId
 * 更新科研项目基础信息。
 */
router.patch('/:projectId', (req: Request, res: Response) => {
  try {
    const projectId = paramId(req.params.projectId)
    if (!projectId) {
      return res.status(400).json({ success: false, code: 400, message: '缺少 projectId', data: null })
    }

    const current = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId) as any
    if (!current) {
      return res.status(404).json({ success: false, code: 404, message: '项目不存在', data: null })
    }

    const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {}
    const sets: string[] = []
    const values: unknown[] = []

    if (Object.prototype.hasOwnProperty.call(body, 'project_name')) {
      const projectName = String(body.project_name ?? '').trim()
      if (!projectName) {
        return res.status(400).json({ success: false, code: 400, message: '项目名称不能为空', data: null })
      }
      sets.push('project_name = ?')
      values.push(projectName)
    }

    if (Object.prototype.hasOwnProperty.call(body, 'description')) {
      const description = body.description == null ? null : String(body.description)
      sets.push('description = ?')
      values.push(description)
    }

    if (Object.prototype.hasOwnProperty.call(body, 'principal_investigator_name')) {
      const principalInvestigatorName =
        body.principal_investigator_name == null || String(body.principal_investigator_name).trim() === ''
          ? null
          : String(body.principal_investigator_name).trim()
      sets.push('principal_investigator_name = ?')
      values.push(principalInvestigatorName)
    }

    if (Object.prototype.hasOwnProperty.call(body, 'status')) {
      const status = String(body.status ?? '').trim()
      if (!ALLOWED_STATUS.has(status)) {
        return res.status(400).json({ success: false, code: 400, message: '项目状态不合法', data: null })
      }
      sets.push('status = ?')
      values.push(status)
    }

    if (sets.length === 0) {
      return res.json({ success: true, code: 0, message: '无变更', data: current })
    }

    sets.push('updated_at = ?')
    values.push(nowIso(), projectId)
    db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...values)

    const row = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId)
    return res.json({ success: true, code: 0, message: '项目已更新', data: row })
  } catch (err: any) {
    console.error('[PATCH /projects/:projectId]', err)
    return res.status(500).json({ success: false, code: 500, message: err?.message || '服务器错误', data: null })
  }
})

/**
 * DELETE /api/v1/projects/:projectId
 */
router.delete('/:projectId', (req: Request, res: Response) => {
  try {
    const projectId = paramId(req.params.projectId)
    if (!projectId) {
      return res.status(400).json({ success: false, code: 400, message: '缺少 projectId', data: null })
    }

    const result = db.prepare(`DELETE FROM projects WHERE id = ?`).run(projectId)
    if (result.changes === 0) {
      return res.status(404).json({ success: false, code: 404, message: '项目不存在', data: null })
    }

    return res.json({ success: true, code: 0, message: '项目已删除', data: { id: projectId } })
  } catch (err: any) {
    console.error('[DELETE /projects/:projectId]', err)
    return res.status(500).json({ success: false, code: 500, message: err?.message || '服务器错误', data: null })
  }
})

/**
 * GET /api/v1/projects/:projectId/patients
 */
router.get('/:projectId/patients', (req: Request, res: Response) => {
  try {
    const projectId = paramId(req.params.projectId)
    if (!projectId) {
      return res.status(400).json({ success: false, code: 400, message: '缺少 projectId', data: null })
    }
    const proj = db.prepare(`SELECT id FROM projects WHERE id = ?`).get(projectId) as { id: string } | undefined
    if (!proj) {
      return res.status(404).json({ success: false, code: 404, message: '项目不存在', data: null })
    }

    const page = Math.max(1, Number(req.query.page) || 1)
    const pageSize = Math.min(200, Math.max(1, Number(req.query.page_size) || 20))
    const offset = (page - 1) * pageSize

    const rows = db
      .prepare(
        `
      SELECT pp.id AS enrollment_id, pp.patient_id, pp.enrolled_at, pp.subject_label,
             p.name AS patient_name, p.metadata
      FROM project_patients pp
      JOIN patients p ON p.id = pp.patient_id
      WHERE pp.project_id = ?
      ORDER BY pp.enrolled_at DESC
      LIMIT ? OFFSET ?
    `
      )
      .all(projectId, pageSize, offset) as any[]

    const totalRow = db
      .prepare(`SELECT COUNT(*) AS c FROM project_patients WHERE project_id = ?`)
      .get(projectId) as { c: number }

    const projectRow = db.prepare(`SELECT schema_id FROM projects WHERE id = ?`).get(projectId) as { schema_id: string } | undefined
    const projectSchemaId = projectRow?.schema_id || null
    const { fieldMap } = getProjectTemplateMeta(projectSchemaId)

    const data = rows.map((r) => {
      let meta: any = {}
      try {
        meta = JSON.parse(r.metadata || '{}')
      } catch {
        meta = {}
      }
      const subject_id = r.subject_label || (typeof r.patient_id === 'string' ? r.patient_id.substring(0, 8) : '')

      const { crfData, crfCompleteness } = buildProjectCrfData(r.patient_id, projectSchemaId, projectId, fieldMap)
      const historyStats = getProjectCrfHistoryStats(r.patient_id, projectSchemaId, projectId)

      return {
        id: r.enrollment_id,
        patient_id: r.patient_id,
        patient_name: r.patient_name || '未知患者',
        patient_gender: meta['患者性别'] || null,
        patient_age: meta['患者年龄'] || null,
        patient_birth_date: meta['出生日期'] || null,
        subject_id,
        group_name: null,
        status: 'enrolled',
        enrollment_date: r.enrolled_at,
        crf_data: crfData,
        crf_completeness: crfCompleteness,
        has_extraction_history: historyStats.hasExtractionHistory,
        extraction_history: historyStats,
      }
    })

    return res.json({
      success: true,
      code: 0,
      message: 'ok',
      data,
      pagination: {
        total: totalRow?.c ?? 0,
        page,
        page_size: pageSize,
      },
    })
  } catch (err: any) {
    console.error('[GET /projects/:projectId/patients]', err)
    return res.status(500).json({
      success: false,
      code: 500,
      message: err?.message || '服务器错误',
      data: null,
    })
  }
})

/**
 * POST /api/v1/projects/:projectId/patients
 * Body: { patient_ids: string[] } 或 { patient_id: string }
 */
router.post('/:projectId/patients', (req: Request, res: Response) => {
  try {
    const projectId = paramId(req.params.projectId)
    if (!projectId) {
      return res.status(400).json({ success: false, code: 400, message: '缺少 projectId', data: null })
    }
    const proj = db.prepare(`SELECT id FROM projects WHERE id = ?`).get(projectId) as { id: string } | undefined
    if (!proj) {
      return res.status(404).json({ success: false, code: 404, message: '项目不存在', data: null })
    }

    const b = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
    const raw: string[] = []
    if (Array.isArray(b.patient_ids)) {
      for (const x of b.patient_ids) {
        if (typeof x === 'string' && x.trim()) raw.push(x.trim())
      }
    } else if (b.patient_id != null && String(b.patient_id).trim()) {
      raw.push(String(b.patient_id).trim())
    }
    const patient_ids = [...new Set(raw)]
    if (patient_ids.length === 0) {
      return res.status(400).json({
        success: false,
        code: 400,
        message: '缺少 patient_id 或 patient_ids',
        data: null,
      })
    }

    const stmtCheck = db.prepare(`SELECT id FROM patients WHERE id = ?`)
    for (const pid of patient_ids) {
      if (!stmtCheck.get(pid)) {
        return res.status(400).json({
          success: false,
          code: 400,
          message: `患者不存在：${pid}`,
          data: null,
        })
      }
    }

    const ts = nowIso()
    const insert = db.prepare(`
      INSERT OR IGNORE INTO project_patients (id, project_id, patient_id, enrolled_at, subject_label, metadata)
      VALUES (@id, @project_id, @patient_id, @enrolled_at, NULL, '{}')
    `)
    const updateProj = db.prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`)

    let added = 0
    let skipped = 0
    const run = db.transaction(() => {
      for (const patient_id of patient_ids) {
        const r = insert.run({
          id: randomUUID(),
          project_id: projectId,
          patient_id,
          enrolled_at: ts,
        })
        if (r.changes > 0) added += 1
        else skipped += 1
      }
      updateProj.run(ts, projectId)
    })
    run()

    const total = (db.prepare(`SELECT COUNT(*) AS c FROM project_patients WHERE project_id = ?`).get(projectId) as any)
      ?.c ?? 0

    return res.status(201).json({
      success: true,
      code: 0,
      message: skipped > 0 ? `已添加 ${added} 人，${skipped} 人已在项目中` : `已添加 ${added} 人`,
      data: { added, skipped, total_enrolled: total, patient_ids },
    })
  } catch (err: any) {
    console.error('[POST /projects/:projectId/patients]', err)
    return res.status(500).json({
      success: false,
      code: 500,
      message: err?.message || '服务器错误',
      data: null,
    })
  }
})

/**
 * DELETE /api/v1/projects/:projectId/patients/:patientId
 */
router.delete('/:projectId/patients/:patientId', (req: Request, res: Response) => {
  try {
    const projectId = paramId(req.params.projectId)
    const patientId = paramId(req.params.patientId)
    if (!projectId || !patientId) {
      return res.status(400).json({ success: false, code: 400, message: '缺少参数', data: null })
    }
    const r = db
      .prepare(`DELETE FROM project_patients WHERE project_id = ? AND patient_id = ?`)
      .run(projectId, patientId)
    db.prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`).run(nowIso(), projectId)
    if (r.changes === 0) {
      return res.status(404).json({ success: false, code: 404, message: '未找到该入组记录', data: null })
    }
    return res.json({ success: true, code: 0, message: '已移出项目', data: null })
  } catch (err: any) {
    console.error('[DELETE /projects/.../patients/...]', err)
    return res.status(500).json({
      success: false,
      code: 500,
      message: err?.message || '服务器错误',
      data: null,
    })
  }
})

/**
 * GET /api/v1/projects/:projectId/patients/:patientId
 */
router.get('/:projectId/patients/:patientId', (req: Request, res: Response) => {
  try {
    const projectId = paramId(req.params.projectId)
    const patientId = paramId(req.params.patientId)
    if (!projectId || !patientId) {
      return res.status(400).json({ success: false, code: 400, message: '缺少参数', data: null })
    }

    const project = db.prepare(`
      SELECT p.id, p.project_name, p.schema_id, s.name AS schema_name
      FROM projects p
      LEFT JOIN schemas s ON s.id = p.schema_id
      WHERE p.id = ?
    `).get(projectId) as any
    if (!project) {
      return res.status(404).json({ success: false, code: 404, message: '项目不存在', data: null })
    }

    const row = db.prepare(`
      SELECT
        pp.id AS enrollment_id,
        pp.project_id,
        pp.patient_id,
        pp.enrolled_at,
        pp.subject_label,
        p.name AS patient_name,
        p.metadata AS patient_metadata
      FROM project_patients pp
      JOIN patients p ON p.id = pp.patient_id
      WHERE pp.project_id = ? AND pp.patient_id = ?
      LIMIT 1
    `).get(projectId, patientId) as any

    if (!row) {
      return res.status(404).json({ success: false, code: 404, message: '项目中未找到该患者', data: null })
    }

    const meta = parseJsonObject(row.patient_metadata)
    const { fieldMap } = getProjectTemplateMeta(project.schema_id)
    const { crfData, crfCompleteness, instanceId } = buildProjectCrfData(patientId, project.schema_id, projectId, fieldMap)

    const documents = db.prepare(`
      SELECT
        d.id,
        d.file_name,
        d.file_type,
        d.document_type,
        d.document_sub_type,
        d.doc_type,
        d.doc_title,
        d.effective_at,
        d.metadata,
        d.status,
        d.uploaded_at,
        d.created_at,
        d.updated_at,
        d.extract_status
      FROM documents d
      WHERE d.patient_id = ? AND d.status != 'deleted'
      ORDER BY d.created_at DESC
    `).all(patientId).map((doc: any) => {
      const docMeta = parseJsonObject(doc.metadata)
      const metaResult = parseJsonObject(docMeta.result)
      const documentType = doc.document_type || doc.doc_type || docMeta.documentType || docMeta.document_type || metaResult['文档类型'] || doc.file_type || null
      const documentSubType = doc.document_sub_type || docMeta.documentSubType || docMeta.documentSubtype || docMeta.document_sub_type || metaResult['文档子类型'] || null
      return {
        ...doc,
        metadata: docMeta,
        document_type: documentType,
        document_sub_type: documentSubType,
        documentType,
        documentSubType,
      }
    }) as any[]

    return res.json({
      success: true,
      code: 0,
      message: 'ok',
      data: {
        id: row.enrollment_id,
        project_id: projectId,
        patient_id: patientId,
        patient_name: row.patient_name || '未知患者',
        patient_gender: meta['患者性别'] || null,
        patient_age: meta['患者年龄'] || null,
        patient_birth_date: meta['出生日期'] || null,
        patient_phone: meta['联系电话'] || null,
        patient_code: typeof patientId === 'string' ? patientId.slice(0, 8) : patientId,
        patient_diagnosis: Array.isArray(meta['诊断']) ? meta['诊断'] : [],
        subject_id: row.subject_label || (typeof patientId === 'string' ? patientId.slice(0, 8) : ''),
        group_name: null,
        status: 'enrolled',
        enrollment_date: row.enrolled_at,
        document_count: documents.length,
        schema_instance_id: instanceId,
        crf_data: crfData,
        crf_completeness: Number(crfCompleteness) || 0,
        documents,
      },
    })
  } catch (err: any) {
    console.error('[GET /projects/:projectId/patients/:patientId]', err)
    return res.status(500).json({
      success: false,
      code: 500,
      message: err?.message || '服务器错误',
      data: null,
    })
  }
})

/**
 * PATCH /api/v1/projects/:projectId/patients/:patientId/crf/fields
 * 保存项目 CRF 字段值（手动编辑结果）
 * Body: { fields: [{ group_id, field_key, value }] }
 */
router.patch('/:projectId/patients/:patientId/crf/fields', (req: Request, res: Response) => {
  try {
    const projectId = paramId(req.params.projectId)
    const patientId = paramId(req.params.patientId)
    if (!projectId || !patientId) {
      return res.status(400).json({ success: false, code: 400, message: '缺少 projectId 或 patientId', data: null })
    }

    const project = db.prepare(`SELECT id, schema_id FROM projects WHERE id = ?`).get(projectId) as any
    if (!project) {
      return res.status(404).json({ success: false, code: 404, message: '项目不存在', data: null })
    }
    if (!project.schema_id) {
      return res.status(400).json({ success: false, code: 400, message: '项目未绑定 CRF 模板', data: null })
    }

    const enrollment = db.prepare(`
      SELECT 1 FROM project_patients WHERE project_id = ? AND patient_id = ?
    `).get(projectId, patientId) as any
    if (!enrollment) {
      return res.status(404).json({ success: false, code: 404, message: '患者未入组该项目', data: null })
    }

    const body = req.body
    const fields = Array.isArray(body?.fields) ? body.fields : []
    if (fields.length === 0) {
      return res.json({ success: true, code: 0, message: '没有需要保存的字段', data: { changed_fields: 0 } })
    }

    // 查找或创建 project_crf schema_instance
    let instance = db.prepare(`
      SELECT id FROM schema_instances
      WHERE patient_id = ? AND schema_id = ? AND project_id = ? AND instance_type = 'project_crf'
      ORDER BY updated_at DESC LIMIT 1
    `).get(patientId, project.schema_id, projectId) as { id: string } | undefined

    let instanceId: string
    if (!instance) {
      instanceId = randomUUID()
      db.prepare(`
        INSERT INTO schema_instances (id, patient_id, schema_id, project_id, name, instance_type, status)
        VALUES (?, ?, ?, ?, ?, 'project_crf', 'draft')
      `).run(instanceId, patientId, project.schema_id, projectId, `${project.schema_id} / ${projectId} / ${patientId}`)
    } else {
      instanceId = instance.id
    }

    const upsertSelected = db.prepare(`
      INSERT INTO field_value_selected
        (id, instance_id, section_instance_id, row_instance_id, field_path,
         selected_candidate_id, selected_value_json, selected_by)
      VALUES (?, ?, NULL, NULL, ?, ?, ?, 'user')
      ON CONFLICT(instance_id, COALESCE(section_instance_id, '__null__'), COALESCE(row_instance_id, '__null__'), field_path)
      DO UPDATE SET
        selected_candidate_id = excluded.selected_candidate_id,
        selected_value_json  = excluded.selected_value_json,
        selected_by          = 'user',
        updated_at           = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `)

    const upsertScopedSelected = db.prepare(`
      INSERT INTO field_value_selected
        (id, instance_id, section_instance_id, row_instance_id, field_path,
         selected_candidate_id, selected_value_json, selected_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'user')
      ON CONFLICT(instance_id, COALESCE(section_instance_id, '__null__'), COALESCE(row_instance_id, '__null__'), field_path)
      DO UPDATE SET
        selected_candidate_id = excluded.selected_candidate_id,
        selected_value_json  = excluded.selected_value_json,
        selected_by          = 'user',
        updated_at           = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `)

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

    const updatedAt = new Date().toISOString()
    let changedCount = 0

    const saveAll = db.transaction(() => {
      for (const field of fields) {
        const explicitFieldPath = String(field?.field_path || field?.path || '').trim()
        const groupId = String(field?.group_id || '').trim()
        const fieldKey = String(field?.field_key || '').trim()
        if (!explicitFieldPath && (!groupId || !fieldKey)) continue

        const requestedFieldPath = explicitFieldPath || `${groupId}/${fieldKey}`
        const fieldPath = stripProjectFieldPathIndices(requestedFieldPath)
        const scope = resolveProjectFieldScope(instanceId, requestedFieldPath)
        if (!scope.resolved) continue
        const rawValue = field?.value
        const valueJson = rawValue === null || rawValue === undefined
          ? 'null'
          : JSON.stringify(rawValue)
        const valueType = Array.isArray(rawValue) ? 'array'
          : typeof rawValue === 'number' ? 'number'
          : typeof rawValue === 'object' ? 'object'
          : 'string'

        // 检查旧值是否相同
        const existing = db.prepare(`
          SELECT selected_value_json FROM field_value_selected
          WHERE instance_id = ?
            AND COALESCE(section_instance_id, '__null__') = COALESCE(?, '__null__')
            AND COALESCE(row_instance_id, '__null__') = COALESCE(?, '__null__')
            AND field_path = ?
        `).get(instanceId, scope.sectionInstanceId, scope.rowInstanceId, fieldPath) as { selected_value_json: string } | undefined
        if (existing && existing.selected_value_json === valueJson) {
          continue
        }

        // 写入候选值
        const candidateId = randomUUID()
        if (scope.sectionInstanceId || scope.rowInstanceId) {
          insertScopedCandidate.run(
            candidateId,
            instanceId,
            scope.sectionInstanceId,
            scope.rowInstanceId,
            fieldPath,
            valueJson,
            valueType,
            '用户手动编辑',
            null
          )
        } else {
          insertCandidate.run(
            candidateId,
            instanceId,
            fieldPath,
            valueJson,
            valueType,
            '用户手动编辑',
            null
          )
        }

        // 写入选中值
        if (scope.sectionInstanceId || scope.rowInstanceId) {
          upsertScopedSelected.run(
            randomUUID(),
            instanceId,
            scope.sectionInstanceId,
            scope.rowInstanceId,
            fieldPath,
            candidateId,
            valueJson
          )
        } else {
          upsertSelected.run(randomUUID(), instanceId, fieldPath, candidateId, valueJson)
        }
        changedCount++
      }

      // 更新时间戳
      db.prepare(`
        UPDATE schema_instances SET updated_at = ? WHERE id = ?
      `).run(updatedAt, instanceId)
    })

    saveAll()

    return res.json({
      success: true,
      code: 0,
      message: '保存成功',
      data: { changed_fields: changedCount, total_fields: fields.length },
    })
  } catch (err: any) {
    console.error('[PATCH crf/fields]', err)
    return res.status(500).json({ success: false, code: 500, message: err?.message || '服务器错误', data: null })
  }
})

/**
 * GET /api/v1/projects/:projectId
 */
router.get('/:projectId', (req: Request, res: Response) => {
  try {
    const projectId = paramId(req.params.projectId)
    if (!projectId) {
      return res.status(400).json({ success: false, code: 400, message: '缺少 projectId', data: null })
    }
    const row = db
      .prepare(
        `
      SELECT p.*, s.name AS schema_name,
        (SELECT COUNT(*) FROM project_patients pp WHERE pp.project_id = p.id) AS actual_patient_count
      FROM projects p
      LEFT JOIN schemas s ON s.id = p.schema_id
      WHERE p.id = ?
    `
      )
      .get(projectId) as any
    if (!row) {
      return res.status(404).json({ success: false, code: 404, message: '项目不存在', data: null })
    }

    const { schemaRow, schemaJson, fieldGroups, fieldMap } = getProjectTemplateMeta(row.schema_id)

    return res.json({
      success: true,
      code: 0,
      message: 'ok',
      data: {
        id: row.id,
        project_name: row.project_name,
        description: row.description ?? '',
        status: row.status,
        schema_id: row.schema_id,
        expected_patient_count: null,
        actual_patient_count: row.actual_patient_count ?? 0,
        avg_completeness: 0,
        updated_at: row.updated_at,
        created_at: row.created_at,
        principal_investigator_name: row.principal_investigator_name,
        template_scope_config: {
          template_id: row.schema_id,
          template_name: row.schema_name || 'CRF 模板',
          schema_version: schemaRow?.version || null,
        },
        template_info: {
          template_id: row.schema_id,
          template_name: row.schema_name || 'CRF 模板',
          field_groups: fieldGroups,
          db_field_mapping: {
            enabled: true,
            field_map: fieldMap,
          },
        },
        schema_json: schemaJson,
      },
    })
  } catch (err: any) {
    console.error('[GET /projects/:projectId]', err)
    return res.status(500).json({
      success: false,
      code: 500,
      message: err?.message || '服务器错误',
      data: null,
    })
  }
})

/**
 * GET /api/v1/projects/:projectId/template/designer
 * 获取项目模板快照（designer + schema），供 ProjectTemplateDesigner 页面渲染。
 * 快照存储于 schemas 表的 content_json（顶层 designer/schema 字段）。
 */
router.get('/:projectId/template/designer', (req: Request, res: Response) => {
  try {
    const projectId = paramId(req.params.projectId)
    if (!projectId) {
      return res.status(400).json({ success: false, code: 400, message: '缺少 projectId', data: null })
    }
    const proj = db.prepare(`SELECT id, schema_id FROM projects WHERE id = ?`).get(projectId) as { id: string; schema_id: string } | undefined
    if (!proj) {
      return res.status(404).json({ success: false, code: 404, message: '项目不存在', data: null })
    }
    if (!proj.schema_id) {
      return res.status(400).json({ success: false, code: 400, message: '项目未关联 CRF 模板', data: null })
    }
    const schemaRow = db.prepare(`SELECT id, name, code, version, content_json FROM schemas WHERE id = ?`).get(proj.schema_id) as { id: string; name: string; code: string; version: string; content_json: string } | undefined
    if (!schemaRow) {
      return res.status(404).json({ success: false, code: 404, message: '关联的 CRF 模板不存在', data: null })
    }
    const content = parseJsonObject(schemaRow.content_json)
    // content_json 可能直接就是 JSON Schema（顶层有 $schema/properties），
    // 也可能包裹了 designer/schema 字段。统一处理：
    const nestedDesigner = content.designer ?? null
    const nestedSchema = content.schema ?? content.schema_json ?? null
    return res.json({
      success: true,
      code: 0,
      data: {
        template_id: schemaRow.id,
        template_name: schemaRow.name,
        schema_version: schemaRow.version,
        // 有嵌套结构时用嵌套值；否则 content_json 整体就是 schema
        designer: nestedDesigner,
        schema: nestedSchema ?? (Object.keys(content).length > 0 ? content : null),
        schema_json: nestedSchema ?? (Object.keys(content).length > 0 ? content : null),
      },
    })
  } catch (err: any) {
    return res.status(500).json({ success: false, code: 500, message: err?.message, data: null })
  }
})

/**
 * PUT /api/v1/projects/:projectId/template/designer
 * 保存项目模板快照（designer + schema），写入 schemas.content_json。
 */
router.put('/:projectId/template/designer', (req: Request, res: Response) => {
  try {
    const projectId = paramId(req.params.projectId)
    if (!projectId) {
      return res.status(400).json({ success: false, code: 400, message: '缺少 projectId', data: null })
    }
    const proj = db.prepare(`SELECT id, schema_id FROM projects WHERE id = ?`).get(projectId) as { id: string; schema_id: string } | undefined
    if (!proj) {
      return res.status(404).json({ success: false, code: 404, message: '项目不存在', data: null })
    }
    if (!proj.schema_id) {
      return res.status(400).json({ success: false, code: 400, message: '项目未关联 CRF 模板', data: null })
    }
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
    const designer = body.designer
    const schema = body.schema ?? body.schema_json
    const schemaRow = db.prepare(`SELECT content_json FROM schemas WHERE id = ?`).get(proj.schema_id) as { content_json: string } | undefined
    if (!schemaRow) {
      return res.status(404).json({ success: false, code: 404, message: '关联的 CRF 模板不存在', data: null })
    }
    const existing = parseJsonObject(schemaRow.content_json)
    const updated = {
      ...existing,
      designer: designer !== undefined ? designer : existing.designer,
      schema: schema !== undefined ? schema : existing.schema,
      schema_json: schema !== undefined ? schema : existing.schema_json,
    }
    db.prepare(`UPDATE schemas SET content_json = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(updated), nowIso(), proj.schema_id)
    return res.json({ success: true, code: 0, message: '保存成功', data: null })
  } catch (err: any) {
    return res.status(500).json({ success: false, code: 500, message: err?.message, data: null })
  }
})

/**
 * POST /api/v1/projects/:projectId/crf/extraction
 * POST /api/v1/projects/:projectId/crf/extraction/start  （前端别名）
 * 启动项目的 CRF 抽取任务
 */
async function handleCrfExtraction(req: Request, res: Response) {
  try {
    const projectId = paramId(req.params.projectId)
    if (!projectId) {
      return res.status(400).json({ success: false, code: 400, message: '缺少 projectId', data: null })
    }

    const proj = db.prepare(`SELECT id, schema_id FROM projects WHERE id = ?`).get(projectId) as { id: string, schema_id: string } | undefined
    if (!proj) {
      return res.status(404).json({ success: false, code: 404, message: '项目不存在', data: null })
    }
    if (!proj.schema_id) {
      return res.status(400).json({ success: false, code: 400, message: '项目未绑定 CRF 模板/schema', data: null })
    }

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, any>
    const mode = String(body.mode || 'incremental').trim().toLowerCase() || 'incremental'
    const targetGroups = normalizeStringList(body.target_groups)
    const { schemaJson, fieldGroups } = getProjectTemplateMeta(proj.schema_id)
    const { targetSections, unresolved } = resolveTargetSections(targetGroups, schemaJson, fieldGroups)
    if (targetGroups.length > 0 && targetSections.length === 0) {
      return res.status(400).json({
        success: false,
        code: 400,
        message: '未找到可抽取的目标字段组',
        data: { target_groups: targetGroups, unresolved_target_groups: unresolved },
      })
    }
    let targetPatients: string[] = []

    if (Array.isArray(body.patient_ids) && body.patient_ids.length > 0) {
      targetPatients = normalizeStringList(body.patient_ids)
    } else {
      const rows = db.prepare(`SELECT patient_id FROM project_patients WHERE project_id = ?`).all(projectId) as any[]
      targetPatients = normalizeStringList(rows.map((r) => r.patient_id))
    }

    if (targetPatients.length === 0) {
      return res.status(400).json({ success: false, code: 400, message: '该项目下无可用的患者进行抽取', data: null })
    }

    const conflictingTask = findActiveTaskForPatients(projectId, targetPatients)
    if (conflictingTask) {
      const conflictingPatients = normalizeStringList(conflictingTask.patient_ids)
        .filter((patientId) => targetPatients.includes(patientId))
      return res.status(409).json({
        success: false,
        code: 40901,
        message: '该患者已有正在进行的抽取任务',
        data: {
          has_active_task: true,
          active_task: conflictingTask,
          conflicting_patient_ids: conflictingPatients,
        },
      })
    }

    const stmtDocs = db.prepare(`
      SELECT id
      FROM documents
      WHERE patient_id = ? AND status != 'deleted' AND status IN ('ocr_succeeded', 'archived')
      ORDER BY created_at ASC
    `)
    const taskId = randomUUID()
    const startedAt = nowIso()
    const submittedJobIds: string[] = []
    const submittedDocumentIds: string[] = []
    const submittedPatientIds: string[] = []
    const skippedPatients: any[] = []
    let clearedHistory = { cleared_patient_count: 0, cleared_instance_count: 0 }

    for (const patientId of targetPatients) {
      const docRows = stmtDocs.all(patientId) as any[]
      const docIds = normalizeStringList(docRows.map((r) => r.id))

      if (docIds.length === 0) {
        skippedPatients.push({ patient_id: patientId, reason: 'no_documents' })
        continue
      }

      if (shouldClearProjectCrfHistory(mode, targetGroups)) {
        const patientClearResult = clearProjectCrfHistoryForPatients(projectId, proj.schema_id, [patientId])
        clearedHistory = {
          cleared_patient_count: clearedHistory.cleared_patient_count + patientClearResult.cleared_patient_count,
          cleared_instance_count: clearedHistory.cleared_instance_count + patientClearResult.cleared_instance_count,
        }
      }

      const sectionsToSubmit = targetSections.length > 0 ? targetSections : [null]
      const jobIds: string[] = []

      for (const targetSection of sectionsToSubmit) {
        const payload: Record<string, any> = {
          patient_id: patientId,
          schema_id: proj.schema_id,
          project_id: projectId,
          document_ids: docIds,
          instance_type: 'project_crf',
        }
        if (targetSection) payload.target_section = targetSection

        let response: Awaited<ReturnType<typeof crfServiceSubmitBatch>>
        try {
          response = await crfServiceSubmitBatch(payload)
        } catch (error: any) {
          return res.status(502).json({
            success: false,
            code: 502,
            message: `CRF 服务不可用：${error?.message || '提交失败'}`,
            data: { target_section: targetSection, project_id: projectId, patient_id: patientId },
          })
        }

        if (!response.ok) {
          const errorText = await response.text()
          return res.status(response.status).json({
            success: false,
            code: response.status,
            message: errorText || '提交科研抽取任务失败',
            data: { target_section: targetSection, project_id: projectId, patient_id: patientId },
          })
        }

        const result = await response.json()
        const jobs = Array.isArray(result?.jobs) ? result.jobs : []
        jobIds.push(...normalizeStringList(jobs.map((job: any) => job?.job_id)))
      }

      if (jobIds.length === 0) {
        skippedPatients.push({ patient_id: patientId, reason: 'no_new_jobs' })
        continue
      }

      submittedPatientIds.push(patientId)
      submittedJobIds.push(...jobIds)
      submittedDocumentIds.push(...docIds)
    }

    db.prepare(`
      INSERT INTO project_extraction_tasks (
        id, project_id, schema_id, status, mode, target_groups_json, patient_ids_json,
        job_ids_json, document_ids_json, summary_json, started_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      taskId,
      projectId,
      proj.schema_id,
      submittedJobIds.length > 0 ? 'running' : 'completed',
      mode,
      JSON.stringify(targetGroups),
      JSON.stringify(submittedPatientIds),
      JSON.stringify(submittedJobIds),
      JSON.stringify(submittedDocumentIds),
      JSON.stringify({
        requested_patient_count: targetPatients.length,
        submitted_patient_count: submittedPatientIds.length,
        submitted_document_count: submittedDocumentIds.length,
        target_sections: targetSections,
        unresolved_target_groups: unresolved,
        cleared_history: clearedHistory,
        skipped_patients: skippedPatients,
      }),
      startedAt,
      startedAt,
      startedAt
    )

    const task = persistProjectTaskSummary(summarizeProjectTask(getLatestProjectExtractionTask(projectId)))

    return res.json({
      success: true,
      code: 0,
      message: submittedJobIds.length > 0
        ? `已为 ${submittedPatientIds.length} 位患者提交抽取任务`
        : '没有找到可提交的新抽取任务',
      data: {
        task_id: task?.task_id || taskId,
        has_active_task: !!task && ['pending', 'running'].includes(task.status),
        submitted_patient_count: submittedPatientIds.length,
        submitted_document_count: submittedDocumentIds.length,
        cleared_history: clearedHistory,
        skipped_patients: skippedPatients,
        active_task: task,
      },
    })
  } catch (err: any) {
    console.error('[POST /projects/:projectId/crf/extraction]', err)
    return res.status(500).json({ success: false, code: 500, message: err?.message || '服务器错误', data: null })
  }
}

router.post('/:projectId/crf/extraction', handleCrfExtraction)
router.post('/:projectId/crf/extraction/start', handleCrfExtraction)

/**
 * GET /api/v1/projects/:projectId/crf/extraction/progress
 * 动态计算整个项目的抽取进度（基于当前 projects 关联的患者及其文档的 ehr_extraction_jobs）
 */
router.get('/:projectId/crf/extraction/progress', (req: Request, res: Response) => {
  try {
    const projectId = paramId(req.params.projectId)
    const proj = db.prepare(`SELECT id FROM projects WHERE id = ?`).get(projectId) as { id: string } | undefined
    if (!proj) {
      return res.status(404).json({ success: false, code: 404, message: '项目不存在', data: null })
    }
    const taskId = String(req.query.task_id || '').trim()
    const taskRow = taskId
      ? (db.prepare(`SELECT * FROM project_extraction_tasks WHERE id = ? AND project_id = ?`).get(taskId, projectId) as any)
      : getLatestProjectExtractionTask(projectId)
    if (!taskRow) {
      return res.json({
        success: true,
        code: 0,
        data: {
          task_id: null,
          status: 'idle',
          total: 0,
          completed: 0,
          failed: 0,
          running: 0,
          pending: 0,
          progress: 0,
          success_count: 0,
          error_count: 0,
          errors: [],
        },
      })
    }

    return res.json({
      success: true,
      code: 0,
      data: persistProjectTaskSummary(summarizeProjectTask(taskRow)),
    })
  } catch (err: any) {
     console.error('[GET /projects/:projectId/crf/extraction/progress]', err)
     return res.status(500).json({ success: false, code: 500, message: err?.message, data: null })
  }
})

/**
 * GET /api/v1/projects/:projectId/crf/extraction/active
 * 查询是否有正在进行的活跃抽取
 */
router.get('/:projectId/crf/extraction/active', (req: Request, res: Response) => {
  try {
    const projectId = paramId(req.params.projectId)
    const proj = db.prepare(`SELECT id FROM projects WHERE id = ?`).get(projectId) as { id: string } | undefined
    if (!proj) {
      return res.status(404).json({ success: false, code: 404, message: '项目不存在', data: null })
    }
    const task = persistProjectTaskSummary(summarizeProjectTask(getLatestProjectExtractionTask(projectId)))
    return res.json({
      success: true,
      code: 0,
      data: {
        has_active_task: !!task && ['pending', 'running'].includes(task.status),
        task_id: task?.task_id || null,
        status: task?.status || 'idle',
        active_task: task,
      },
    })
  } catch (err: any) {
     console.error('[GET /projects/:projectId/crf/extraction/active]', err)
     return res.status(500).json({ success: false, code: 500, message: err?.message, data: null })
  }
})

/**
 * GET /api/v1/projects/:projectId/crf/extraction/tasks
 * 获取项目的历史抽取任务列表
 */
router.get('/:projectId/crf/extraction/tasks', (req: Request, res: Response) => {
  try {
    const projectId = paramId(req.params.projectId)
    if (!projectId) {
      return res.status(400).json({ success: false, code: 400, message: '缺少 projectId', data: null })
    }
    const proj = db.prepare(`SELECT id FROM projects WHERE id = ?`).get(projectId) as { id: string } | undefined
    if (!proj) {
      return res.status(404).json({ success: false, code: 404, message: '项目不存在', data: null })
    }
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '10'), 10), 1), 100)
    const tasks = db.prepare(`
      SELECT id, project_id, schema_id, status, mode, target_groups_json,
             started_at, finished_at, cancelled_at, created_at, updated_at
      FROM project_extraction_tasks
      WHERE project_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(projectId, limit) as any[]

    return res.json({ success: true, code: 0, data: { tasks } })
  } catch (err: any) {
    return res.status(500).json({ success: false, code: 500, message: err?.message, data: null })
  }
})

router.delete('/:projectId/crf/extraction', (req: Request, res: Response) => {
  try {
    const projectId = paramId(req.params.projectId)
    if (!projectId) {
      return res.status(400).json({ success: false, code: 400, message: '缺少 projectId', data: null })
    }
    const task = persistProjectTaskSummary(summarizeProjectTask(getLatestProjectExtractionTask(projectId)))
    if (!task || !['pending', 'running'].includes(task.status)) {
      return res.json({ success: true, code: 0, message: '当前无进行中的抽取任务', data: null })
    }

    const cancelledAt = nowIso()
    if (task.job_ids.length > 0) {
      db.prepare(`
        UPDATE ehr_extraction_jobs
        SET status = 'failed', last_error = ?, completed_at = ?, updated_at = ?
        WHERE id IN (${task.job_ids.map(() => '?').join(',')})
          AND status IN ('pending', 'running')
      `).run('任务被用户取消', cancelledAt, cancelledAt, ...task.job_ids)
    }
    db.prepare(`
      UPDATE project_extraction_tasks
      SET status = 'cancelled', cancelled_at = ?, finished_at = ?, updated_at = ?
      WHERE id = ?
    `).run(cancelledAt, cancelledAt, cancelledAt, task.task_id)

    return res.json({
      success: true,
      code: 0,
      message: '抽取任务已取消',
      data: {
        task_id: task.task_id,
        status: 'cancelled',
      },
    })
  } catch (err: any) {
    console.error('[DELETE /projects/:projectId/crf/extraction]', err)
    return res.status(500).json({ success: false, code: 500, message: err?.message || '服务器错误', data: null })
  }
})

router.post('/:projectId/crf/extraction/reset', (req: Request, res: Response) => {
  try {
    const projectId = paramId(req.params.projectId)
    if (!projectId) {
      return res.status(400).json({ success: false, code: 400, message: '缺少 projectId', data: null })
    }
    const latest = getLatestProjectExtractionTask(projectId)
    if (!latest) {
      return res.json({ success: true, code: 0, message: '当前无抽取任务可重置', data: null })
    }

    const task = persistProjectTaskSummary(summarizeProjectTask(latest))
    const resetAt = nowIso()
    if (task?.job_ids?.length > 0) {
      db.prepare(`
        UPDATE ehr_extraction_jobs
        SET status = 'failed', last_error = ?, completed_at = ?, updated_at = ?
        WHERE id IN (${task.job_ids.map(() => '?').join(',')})
          AND status IN ('pending', 'running')
      `).run('任务已被重置', resetAt, resetAt, ...task.job_ids)
    }
    db.prepare(`
      UPDATE project_extraction_tasks
      SET status = 'cancelled', cancelled_at = COALESCE(cancelled_at, ?), finished_at = COALESCE(finished_at, ?), updated_at = ?
      WHERE id = ?
    `).run(resetAt, resetAt, resetAt, latest.id)

    return res.json({
      success: true,
      code: 0,
      message: '项目抽取状态已重置',
      data: {
        task_id: latest.id,
        status: 'cancelled',
      },
    })
  } catch (err: any) {
    console.error('[POST /projects/:projectId/crf/extraction/reset]', err)
    return res.status(500).json({ success: false, code: 500, message: err?.message || '服务器错误', data: null })
  }
})

export default router
