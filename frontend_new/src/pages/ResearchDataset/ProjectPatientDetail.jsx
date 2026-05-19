import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Row,
  Col,
  Breadcrumb,
  Card,
  Typography,
  Button,
  Space,
  Tag,
  Modal,
  Form,
  Input,
  Checkbox,
  Spin,
  Alert,
  Radio,
} from 'antd'
import {
  PlayCircleOutlined,
  PauseCircleOutlined,
  DownloadOutlined,
  RobotOutlined,
  SendOutlined,
  ClearOutlined,
  LoadingOutlined,
} from '@ant-design/icons'

import ProjectSchemaEhrTab from '../PatientDetail/tabs/SchemaEhrTab/ProjectSchemaEhrTab'
import { getProjectTemplate } from '../../api/crfTemplate'
import { resolveTemplateAssets } from '../../utils/templateAssetResolver'
import { appThemeToken } from '../../styles/themeTokens'
import { normalizeTemplateFieldGroups } from './config/datasetContract'
import { deriveTemplateFieldGroupsFromSchema } from './adapters/datasetAdapter'

// 导入数据 Hook
import useProjectPatientData from './hooks/useProjectPatientData'
import {
  updateProjectPatientCrfFields,
  startCrfExtraction,
  getCrfExtractionProgress,
} from '@/api/project'
import { message } from 'antd'
import { toAuditPath } from '../../utils/auditResolver'

const { Text } = Typography

/**
 * 深拷贝任意 JSON 兼容数据。
 * @param {any} value
 * @returns {any}
 */
const cloneJsonValue = (value) => {
  if (value === undefined) return undefined
  try {
    return JSON.parse(JSON.stringify(value))
  } catch (_error) {
    return value
  }
}

/**
 * 将 schema/db 字段路径标准化为段数组。
 * @param {string} rawPath
 * @returns {string[]}
 */
const normalizeSchemaPath = (rawPath) => String(rawPath || '')
  .replace(/\[\*\]/g, '')
  .split('/')
  .map((part) => part.trim())
  .filter(Boolean)

/**
 * 将任意字段路径归一化为点分段数组。
 * @param {string} rawPath
 * @returns {string[]}
 */
const normalizeFieldPathSegments = (rawPath) => String(rawPath || '')
  .replace(/\[\*\]/g, '')
  .replace(/\[(\d+)\]/g, '/$1')
  .split(/[/.]/)
  .map((part) => part.trim())
  .filter(Boolean)

/**
 * 将任意字段路径归一化为点分路径。
 * @param {string} rawPath
 * @returns {string}
 */
const normalizeFieldPathToDot = (rawPath) => normalizeFieldPathSegments(rawPath).join('.')

const isInternalSchemaFormKey = (key) => String(key || '').startsWith('_')

const getValueAtDotPath = (data, dotPath) => {
  const parts = String(dotPath || '').split('.').filter(Boolean)
  let cursor = data
  for (const part of parts) {
    if (cursor === null || cursor === undefined) return undefined
    if (Array.isArray(cursor) && /^\d+$/.test(part)) {
      cursor = cursor[Number(part)]
      continue
    }
    if (typeof cursor !== 'object') return undefined
    cursor = cursor[part]
  }
  return cursor
}

const flattenEditableLeafValues = (data) => {
  const leaves = []
  const visit = (value, pathParts) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...pathParts, String(index)]))
      if (value.length === 0 && pathParts.length > 0) {
        leaves.push({ path: pathParts.join('.'), value })
      }
      return
    }

    if (value && typeof value === 'object') {
      const entries = Object.entries(value).filter(([key]) => !isInternalSchemaFormKey(key))
      if (entries.length === 0 && pathParts.length > 0) {
        leaves.push({ path: pathParts.join('.'), value })
      }
      entries.forEach(([key, child]) => visit(child, [...pathParts, key]))
      return
    }

    if (pathParts.length > 0) {
      leaves.push({ path: pathParts.join('.'), value })
    }
  }
  visit(data || {}, [])
  return leaves
}

const buildProjectCrfFieldUpdates = (draftData, originalData, isValueEqual) => {
  return flattenEditableLeafValues(draftData)
    .filter(({ path, value }) => !isValueEqual(value === undefined ? null : value, getValueAtDotPath(originalData, path)))
    .map(({ path, value }) => ({
      field_path: `/${path.split('.').filter(Boolean).join('/')}`,
      value: value === undefined ? null : value,
    }))
}

/**
 * 构造科研 CRF 字段在 SchemaForm 中使用的 canonical 点分路径。
 * @param {string} groupId
 * @param {string} fieldKey
 * @param {Record<string, any>} fieldData
 * @returns {string}
 */
const buildProjectFieldCanonicalPath = (groupId, fieldKey, fieldData = null) => {
  const normalizedGroup = normalizeFieldPathToDot(groupId)
  const candidatePath = normalizeFieldPathToDot(
    fieldData?.field_path
    || fieldData?.db_field
    || fieldKey
    || '',
  )
  if (!candidatePath) return ''
  if (!normalizedGroup) return candidatePath
  if (candidatePath === normalizedGroup || candidatePath.startsWith(`${normalizedGroup}.`)) {
    return candidatePath
  }
  return `${normalizedGroup}.${candidatePath}`
}

/**
 * 合并字段审计信息，优先保留更完整的溯源信息。
 * @param {Record<string, any>} fieldMap
 * @param {string} key
 * @param {Record<string, any>} incoming
 * @returns {void}
 */
const mergeAuditFieldEntry = (fieldMap, key, incoming) => {
  if (!key || !incoming || typeof incoming !== 'object') return
  const existing = fieldMap[key]
  if (!existing || typeof existing !== 'object') {
    fieldMap[key] = incoming
    return
  }
  const incomingHasSource =
    incoming.document_id
    || incoming.source_document_id
    || incoming.bbox
    || incoming.raw
    || incoming.source_id
  const existingHasSource =
    existing.document_id
    || existing.source_document_id
    || existing.bbox
    || existing.raw
    || existing.source_id
  if (!existingHasSource && incomingHasSource) {
    fieldMap[key] = { ...existing, ...incoming }
  }
}

/**
 * 按 schema 结构将字段值写入目标数据树，支持数组节点自动展开。
 * @param {any} existingValue
 * @param {Object|null} schemaNode
 * @param {string[]} parts
 * @param {any} value
 * @returns {any}
 */
function buildValueBySchema(existingValue, schemaNode, parts, value) {
  if (!schemaNode || typeof schemaNode !== 'object') {
    return cloneJsonValue(value)
  }

  if (parts.length === 0) {
    return cloneJsonValue(value)
  }

  if (schemaNode.type === 'array' && schemaNode.items) {
    const currentArray = Array.isArray(existingValue) ? [...existingValue] : []
    if (Array.isArray(value)) {
      value.forEach((itemValue, index) => {
        currentArray[index] = buildValueBySchema(currentArray[index], schemaNode.items, parts, itemValue)
      })
      return currentArray
    }
    currentArray[0] = buildValueBySchema(currentArray[0], schemaNode.items, parts, value)
    return currentArray
  }

  if (schemaNode.type === 'object' && schemaNode.properties) {
    const [head, ...rest] = parts
    const childSchema = schemaNode.properties?.[head]
    if (!childSchema) {
      return existingValue && typeof existingValue === 'object' ? existingValue : {}
    }
    const nextValue = existingValue && typeof existingValue === 'object' && !Array.isArray(existingValue)
      ? { ...existingValue }
      : {}
    nextValue[head] = buildValueBySchema(nextValue[head], childSchema, rest, value)
    return nextValue
  }

  return cloneJsonValue(value)
}

/**
 * 将 groups 中的字段值按 schema 路径重建回嵌套 patientData。
 * @param {Object} baseData
 * @param {Object|null} schemaRoot
 * @param {Object} groups
 * @returns {Object}
 */
function mergeGroupValuesIntoData(baseData, schemaRoot, groups) {
  const nextData = cloneJsonValue(baseData) || {}
  if (!schemaRoot || typeof schemaRoot !== 'object' || !groups || typeof groups !== 'object') {
    return nextData
  }

  // 直接遍历 groups 并构建嵌套结构
  for (const [groupId, groupData] of Object.entries(groups)) {
    const fields = groupData?.fields
    if (!fields || typeof fields !== 'object') continue

    // 确保 groupId 这一层存在
    if (!nextData[groupId] || typeof nextData[groupId] !== 'object') {
      nextData[groupId] = {}
    }

    for (const [fieldKey, fieldData] of Object.entries(fields)) {
      if (fieldKey.startsWith('_') || !fieldData || typeof fieldData !== 'object') continue
      if (fieldData.value === undefined) continue

      // 从 fieldKey 构建路径: "人口学情况/身份信息/患者姓名" -> ["人口学情况", "身份信息", "患者姓名"]
      const parts = fieldKey.split('/').map(p => p.trim()).filter(Boolean)
      if (parts.length === 0) continue

      // 从 groupId 这一层开始构建嵌套结构
      let current = nextData[groupId]
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i]
        if (!current[part] || typeof current[part] !== 'object') {
          current[part] = {}
        }
        current = current[part]
      }

      // 设置最终值
      const lastPart = parts[parts.length - 1]
      current[lastPart] = fieldData.value
    }
  }

  return nextData
}

/**
 * 按字段路径从 group.fields 中读取值（优先精确命中，其次后缀命中）。
 *
 * @param {Record<string, any>} fields 字段字典。
 * @param {string} fieldPath 模板字段路径。
 * @param {string} groupName 字段组名称（用于去前缀）。
 * @returns {any}
 */
function readGroupFieldValueByPath(fields, fieldPath, groupName = '') {
  if (!fields || typeof fields !== 'object') return undefined
  const normalizePath = (raw) => String(raw || '')
    .normalize('NFKC')
    .replace(/\s*\/\s*/g, '/')
    .trim()
  const normalizedFieldPath = normalizePath(fieldPath)
  const normalizedGroupName = normalizePath(groupName)
  const pathSegments = normalizedFieldPath.split('/').filter(Boolean)
  const candidates = [normalizedFieldPath]
  if (normalizedGroupName && normalizedFieldPath.startsWith(`${normalizedGroupName}/`)) {
    candidates.push(normalizedFieldPath.slice(normalizedGroupName.length + 1))
  }
  if (pathSegments.length > 1) {
    candidates.push(pathSegments.slice(1).join('/'))
    for (let i = 2; i < pathSegments.length; i += 1) {
      candidates.push(pathSegments.slice(i).join('/'))
    }
  }
  const uniqueCandidates = [...new Set(candidates.filter(Boolean))]
  const fieldEntries = Object.entries(fields)
  for (const candidatePath of uniqueCandidates) {
    const directEntry = fieldEntries.find(([rawKey]) => normalizePath(rawKey) === candidatePath)
    if (!directEntry) continue
    const rawFieldValue = directEntry[1]
    if (rawFieldValue && typeof rawFieldValue === 'object' && Object.prototype.hasOwnProperty.call(rawFieldValue, 'value')) {
      return rawFieldValue.value
    }
    return rawFieldValue
  }
  for (const candidatePath of uniqueCandidates) {
    const suffixMatches = fieldEntries.filter(([rawKey]) => {
      const normalizedRawKey = normalizePath(rawKey)
      return candidatePath.endsWith(`/${normalizedRawKey}`) || normalizedRawKey.endsWith(`/${candidatePath}`)
    })
    if (suffixMatches.length === 0) continue
    suffixMatches.sort((a, b) => String(b[0]).length - String(a[0]).length)
    const rawFieldValue = suffixMatches[0][1]
    if (rawFieldValue && typeof rawFieldValue === 'object' && Object.prototype.hasOwnProperty.call(rawFieldValue, 'value')) {
      return rawFieldValue.value
    }
    return rawFieldValue
  }

  /**
   * 按 segments 递归读取对象/数组中的嵌套值。
   * - 对象：按属性名继续读取；
   * - 数组：对每个元素继续读取，并返回等长数组（自动过滤 undefined 项）。
   *
   * @param {any} value 容器值。
   * @param {string[]} segments 剩余路径段。
   * @returns {any}
   */
  const readValueBySegments = (value, segments) => {
    if (segments.length === 0) return value
    if (value === null || value === undefined) return undefined
    const [head, ...rest] = segments
    if (Array.isArray(value)) {
      const mapped = value
        .map((item) => readValueBySegments(item, segments))
        .filter((item) => item !== undefined)
      return mapped.length > 0 ? mapped : undefined
    }
    if (typeof value === 'object') {
      return readValueBySegments(value?.[head], rest)
    }
    return undefined
  }

  // 容器前缀命中：fields 仅存父级 key（如“诊断记录”）时，继续按剩余路径下钻读取。
  for (const candidatePath of uniqueCandidates) {
    const prefixMatches = fieldEntries
      .map(([rawKey, rawValue]) => ({
        normalizedRawKey: normalizePath(rawKey),
        rawValue,
      }))
      .filter((entry) => entry.normalizedRawKey && candidatePath.startsWith(`${entry.normalizedRawKey}/`))
    if (prefixMatches.length === 0) continue
    prefixMatches.sort((a, b) => b.normalizedRawKey.length - a.normalizedRawKey.length)
    const bestMatch = prefixMatches[0]
    const baseValue = bestMatch.rawValue && typeof bestMatch.rawValue === 'object' && Object.prototype.hasOwnProperty.call(bestMatch.rawValue, 'value')
      ? bestMatch.rawValue.value
      : bestMatch.rawValue
    const restPath = candidatePath.slice(bestMatch.normalizedRawKey.length + 1)
    const restSegments = restPath.split('/').filter(Boolean)
    const nestedValue = readValueBySegments(baseValue, restSegments)
    if (nestedValue !== undefined) return nestedValue
    // 兼容路径中重复了组名/容器名的场景（如 "诊断记录/入院日期" 实际存储在数组元素的 "入院日期"）。
    for (let offset = 1; offset < restSegments.length; offset += 1) {
      const shiftedValue = readValueBySegments(baseValue, restSegments.slice(offset))
      if (shiftedValue !== undefined) return shiftedValue
    }
  }

  return undefined
}

/**
 * 按路径读取 schema 节点。
 *
 * @param {Object|null} schemaRoot schema 根节点。
 * @param {string[]} parts 路径段。
 * @returns {Object|null}
 */
function getSchemaNodeByParts(schemaRoot, parts) {
  let current = schemaRoot
  for (const part of parts) {
    if (!current || typeof current !== 'object') return null
    if (current.type === 'object' && current.properties?.[part]) {
      current = current.properties[part]
      continue
    }
    if (current.type === 'array' && current.items) {
      current = current.items
      if (current.type === 'object' && current.properties?.[part]) {
        current = current.properties[part]
        continue
      }
    }
    return null
  }
  return current && typeof current === 'object' ? current : null
}

/**
 * 判断写入值与 schema 节点类型是否兼容，防止把数组误写到对象节点。
 *
 * @param {Object|null} schemaNode schema 节点。
 * @param {any} value 待写入值。
 * @returns {boolean}
 */
function isSchemaValueCompatible(schemaNode, value) {
  if (!schemaNode || typeof schemaNode !== 'object') return true
  if (schemaNode.type === 'object') {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  }
  if (schemaNode.type === 'array') {
    return Array.isArray(value)
  }
  return true
}

/**
 * 判断值是否“真正有内容”，用于避免把 `[undefined, undefined]` 当成已填充数据。
 *
 * @param {any} value 待判断值。
 * @returns {boolean}
 */
function hasEffectiveValue(value) {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value !== ''
  if (Array.isArray(value)) {
    if (value.length === 0) return false
    return value.some((item) => hasEffectiveValue(item))
  }
  if (typeof value === 'object') {
    const entries = Object.values(value)
    if (entries.length === 0) return false
    return entries.some((item) => hasEffectiveValue(item))
  }
  return true
}

/**
 * 判断某个 schema 路径上是否已经存在可重复表单数组。
 * 后端已经从 section_instances 按 repeat_index 重建了 crf_data.data；这些数组是权威结构，
 * 不能再被兼容用的 groups.fields 扁平/数组字段二次合并污染。
 * @param {Object|null} schemaRoot
 * @param {Object} data
 * @param {string[]} parts
 * @returns {boolean}
 */
function hasExistingRepeatableArrayAtOrAbove(schemaRoot, data, parts) {
  if (!schemaRoot || typeof schemaRoot !== 'object' || !Array.isArray(parts) || parts.length === 0) return false

  let schemaNode = schemaRoot
  let valueNode = data
  for (const part of parts) {
    if (!schemaNode || typeof schemaNode !== 'object') return false
    if (schemaNode.type === 'array') {
      return Array.isArray(valueNode) && hasEffectiveValue(valueNode)
    }
    if (schemaNode.type !== 'object' || !schemaNode.properties?.[part]) return false
    schemaNode = schemaNode.properties[part]
    valueNode = valueNode?.[part]
  }

  return schemaNode?.type === 'array' && Array.isArray(valueNode) && hasEffectiveValue(valueNode)
}

/**
 * 解析最合适的 schema 写入路径，兼容“字段仅存局部路径”与“组名前缀缺失”场景。
 *
 * @param {Object|null} schemaRoot schema 根节点。
 * @param {string[]} rawParts 原始路径段。
 * @param {string} groupName 字段组名称（如 `诊断记录 / 诊断记录`）。
 * @param {any} value 待写入值。
 * @returns {string[] | null}
 */
function resolveSchemaWriteParts(schemaRoot, rawParts, groupName, value) {
  if (!Array.isArray(rawParts) || rawParts.length === 0) return null
  const groupNameParts = normalizeSchemaPath(String(groupName || '').replace(/\s*\/\s*/g, '/'))
  const candidates = []
  const pushCandidate = (parts) => {
    if (!Array.isArray(parts) || parts.length === 0) return
    const normalized = parts.map((segment) => String(segment || '').trim()).filter(Boolean)
    if (normalized.length === 0) return
    candidates.push(normalized)
  }

  pushCandidate(rawParts)
  if (groupNameParts.length > 0) {
    pushCandidate([...groupNameParts, ...rawParts])
    if (rawParts.length === 1 && groupNameParts[groupNameParts.length - 1] === rawParts[0]) {
      pushCandidate(groupNameParts)
    }
  }
  for (let i = 1; i < rawParts.length; i += 1) {
    pushCandidate(rawParts.slice(i))
  }

  const uniqueCandidates = []
  const seen = new Set()
  candidates.forEach((parts) => {
    const key = parts.join('/')
    if (seen.has(key)) return
    seen.add(key)
    uniqueCandidates.push(parts)
  })

  for (const parts of uniqueCandidates) {
    const targetSchemaNode = getSchemaNodeByParts(schemaRoot, parts)
    if (!targetSchemaNode) continue
    if (!isSchemaValueCompatible(targetSchemaNode, value)) continue
    return parts
  }
  return null
}

/**
 * 基于模板 group 定义，将 groups 中字段值重建回 schema 数据树。
 *
 * @param {Object} baseData 现有 data 根节点。
 * @param {Object|null} schemaRoot schema 根节点。
 * @param {Object} groups CRF groups 字典。
 * @param {Array<{key:string,name:string,dbFields:string[]}>} templateGroups 模板组列表。
 * @returns {Object}
 */
function mergeGroupValuesIntoDataByTemplate(baseData, schemaRoot, groups, templateGroups) {
  const nextData = cloneJsonValue(baseData) || {}
  if (!schemaRoot || typeof schemaRoot !== 'object') return nextData
  const safeGroups = groups && typeof groups === 'object' ? groups : {}
  const safeTemplateGroups = Array.isArray(templateGroups) ? templateGroups : []
  const consumedGroupIds = new Set()

  safeTemplateGroups.forEach((templateGroup) => {
    const groupId = String(templateGroup?.key || '')
    if (!groupId) return
    const groupNode = safeGroups?.[groupId]
    if (!groupNode || typeof groupNode !== 'object') return
    consumedGroupIds.add(groupId)
    const groupFields = groupNode?.fields && typeof groupNode.fields === 'object' ? groupNode.fields : {}
    // 第一阶段：优先按 group.fields 的原始 key 写入，保留容器字段（尤其数组对象）的完整结构。
    Object.entries(groupFields).forEach(([rawFieldPath, rawFieldData]) => {
      if (String(rawFieldPath || '').startsWith('_')) return
      if (!rawFieldData || typeof rawFieldData !== 'object') return
      if (rawFieldData.value === undefined) return
      const parts = normalizeSchemaPath(rawFieldPath)
      const resolvedParts = resolveSchemaWriteParts(
        schemaRoot,
        parts,
        templateGroup?.name || groupNode?.group_name || '',
        rawFieldData.value,
      )
      if (!resolvedParts) return
      if (hasExistingRepeatableArrayAtOrAbove(schemaRoot, nextData, resolvedParts)) return
      const existingValue = readValueBySchema(nextData, schemaRoot, resolvedParts)
      // 已有非空结构时不覆盖，防止重复写入时破坏既有对象。
      if (hasEffectiveValue(existingValue)) return
      const mergedValue = buildValueBySchema(nextData, schemaRoot, resolvedParts, rawFieldData.value)
      if (mergedValue !== undefined) Object.assign(nextData, mergedValue)
    })

    // 第二阶段：按模板 db_fields 补齐漏掉的叶子字段。
    const dbFields = Array.isArray(templateGroup?.dbFields) ? templateGroup.dbFields : []
    dbFields.forEach((dbFieldPath) => {
      const normalizedPath = String(dbFieldPath || '').trim()
      if (!normalizedPath) return
      const parts = normalizeSchemaPath(normalizedPath)
      if (parts.length === 0) return
      const existingValue = readValueBySchema(nextData, schemaRoot, parts)
      if (hasEffectiveValue(existingValue)) return
      if (hasExistingRepeatableArrayAtOrAbove(schemaRoot, nextData, parts)) return
      const fieldValue = readGroupFieldValueByPath(groupFields, normalizedPath, templateGroup?.name || groupNode?.group_name || '')
      if (fieldValue === undefined) return
      const mergedValue = buildValueBySchema(nextData, schemaRoot, parts, fieldValue)
      if (mergedValue !== undefined) Object.assign(nextData, mergedValue)
    })
  })

  // 兜底：对未被模板映射覆盖的 group，按 fieldKey 直接写入 schema 路径（不再以 groupId 作为根）。
  Object.entries(safeGroups).forEach(([groupId, groupNode]) => {
    if (consumedGroupIds.has(groupId)) return
    const fields = groupNode?.fields && typeof groupNode.fields === 'object' ? groupNode.fields : {}
    Object.entries(fields).forEach(([fieldKey, fieldData]) => {
      if (String(fieldKey || '').startsWith('_')) return
      if (!fieldData || typeof fieldData !== 'object') return
      if (fieldData.value === undefined) return
      const parts = normalizeSchemaPath(fieldKey)
      const resolvedParts = resolveSchemaWriteParts(
        schemaRoot,
        parts,
        groupNode?.group_name || '',
        fieldData.value,
      )
      if (!resolvedParts) return
      if (hasExistingRepeatableArrayAtOrAbove(schemaRoot, nextData, resolvedParts)) return
      const mergedValue = buildValueBySchema(nextData, schemaRoot, resolvedParts, fieldData.value)
      if (mergedValue !== undefined) Object.assign(nextData, mergedValue)
    })
  })

  return nextData
}

/**
 * 按 schema 路径读取 draftData 中的值，支持数组节点返回叶子数组。
 * @param {any} data
 * @param {Object|null} schemaNode
 * @param {string[]} parts
 * @returns {any}
 */
function readValueBySchema(data, schemaNode, parts) {
  if (!schemaNode || typeof schemaNode !== 'object') return undefined
  if (parts.length === 0) return data

  if (schemaNode.type === 'array' && schemaNode.items) {
    if (!Array.isArray(data)) return undefined
    return data.map((item) => readValueBySchema(item, schemaNode.items, parts))
  }

  if (schemaNode.type === 'object' && schemaNode.properties) {
    const [head, ...rest] = parts
    const childSchema = schemaNode.properties?.[head]
    if (!childSchema) return undefined
    return readValueBySchema(data?.[head], childSchema, rest)
  }

  return data
}

/**
 * 在不依赖 schema 的情况下按路径段读取值（用于 diff 兜底）。
 * @param {any} data
 * @param {string[]} parts
 * @returns {any}
 */
function readValueByLoosePath(data, parts) {
  if (!Array.isArray(parts) || parts.length === 0) return data
  let cursor = data
  for (const part of parts) {
    if (cursor === null || cursor === undefined) return undefined
    if (Array.isArray(cursor) && /^\d+$/.test(part)) {
      cursor = cursor[Number(part)]
      continue
    }
    if (typeof cursor !== 'object') return undefined
    cursor = cursor[part]
  }
  return cursor
}

const ProjectPatientDetail = () => {
  const { projectId, patientId } = useParams()
  const navigate = useNavigate()
  
  // 使用 Hook 获取真实数据
  const {
    loading,
    projectLoading,
    projectError,
    patientError,
    patientInfo,
    projectInfo,
    crfData,
    documents,
    fieldGroups: projectTemplateGroups,
    ehrFieldGroups,
    refresh,
  } = useProjectPatientData(projectId, patientId)

  const projectName =
    projectInfo?.project_name ||
    projectInfo?.projectName ||
    projectInfo?.name ||
    '未知项目'
  const resolvedProjectPatientId = patientInfo?.patientId || patientId || null
  /**
   * 患者姓名脱敏展示：
   * 两字：王*；三字：王*宁；四字及以上：王**宁。
   * @param {string} name
   * @returns {string}
   */
  const maskPatientDisplayName = useCallback((name) => {
    const raw = String(name || '')
    if (!raw) return ''
    const chars = [...raw]
    const len = chars.length
    if (len <= 1) return raw
    if (len === 2) return `${chars[0]}*`
    if (len === 3) return `${chars[0]}*${chars[2]}`
    return `${chars[0]}${'*'.repeat(len - 2)}${chars[len - 1]}`
  }, [])
  
  // 状态管理
  const [extractionModalVisible, setExtractionModalVisible] = useState(false)
  const [extractionModalGroups, setExtractionModalGroups] = useState([])
  const [extractionModalMode, setExtractionModalMode] = useState('incremental')
  const [isExtracting, setIsExtracting] = useState(false)
  const [aiAssistantVisible, setAiAssistantVisible] = useState(false)
  const [aiChatHistory, setAiChatHistory] = useState([])
  const [aiInput, setAiInput] = useState('')
  const [aiModalPosition, setAiModalPosition] = useState({ x: 20, y: 80 })
  const [isDragging, setIsDragging] = useState(false)
  const [schemaHistoryRefreshTick, setSchemaHistoryRefreshTick] = useState(0)

  const [projectSchema, setProjectSchema] = useState(null)
  const [projectTemplateFieldGroups, setProjectTemplateFieldGroups] = useState([])

  useEffect(() => {
    let cancelled = false

    const loadProjectSchema = async () => {
      if (!projectId) {
        setProjectSchema(null)
        return
      }
      try {
        const response = await getProjectTemplate(projectId)
        const template = response?.data
        const { schema } = resolveTemplateAssets(template)
        const normalizedGroups = normalizeTemplateFieldGroups(
          template?.field_groups
            || template?.template_info?.field_groups
            || template?.layout_config?.field_groups
            || [],
        )
        const normalizedTemplateGroups = (normalizedGroups.length > 0
          ? normalizedGroups
          : deriveTemplateFieldGroupsFromSchema(schema)
        ).map((group) => ({
          key: group.group_id,
          name: group.group_name,
          dbFields: Array.isArray(group.db_fields) ? group.db_fields : [],
        }))
        if (!cancelled) {
          setProjectSchema(schema && typeof schema === 'object' ? schema : null)
          setProjectTemplateFieldGroups(normalizedTemplateGroups)
        }
      } catch (error) {
        console.error('获取项目模板 schema 失败:', error)
        if (!cancelled) {
          setProjectSchema(null)
          setProjectTemplateFieldGroups([])
        }
      }
    }

    loadProjectSchema()
    return () => {
      cancelled = true
    }
  }, [projectId])

  // 将 crf_data 的 _task_results 和 groups 转换为 SchemaForm 期望的 _extraction_metadata 格式
  const schemaData = useMemo(() => {
    const baseData = cloneJsonValue(crfData?.data || {}) || {}
    const taskResults = crfData?._task_results || []
    const documents = crfData?._documents || {}
    const groups = crfData?.groups || {}
    const normalizedHookTemplateGroups = (Array.isArray(projectTemplateGroups) ? projectTemplateGroups : []).map((group) => ({
      key: String(group?.key || ''),
      name: String(group?.name || ''),
      dbFields: Array.isArray(group?.dbFields) ? group.dbFields : [],
    }))
    const effectiveTemplateGroups = projectTemplateFieldGroups.length > 0
      ? projectTemplateFieldGroups
      : normalizedHookTemplateGroups
    const data = mergeGroupValuesIntoDataByTemplate(baseData, projectSchema, groups, effectiveTemplateGroups)

    // 合并所有溯源信息到统一的 _extraction_metadata
    const allFields = {}

    // 1. 从 _task_results 中提取 audit.fields，并统一为 canonical 点分路径
    for (const task of taskResults) {
      const auditFields = task?.audit?.fields
      if (auditFields && typeof auditFields === 'object') {
        for (const [rawKey, auditValue] of Object.entries(auditFields)) {
          const canonicalPath = normalizeFieldPathToDot(rawKey)
          if (!canonicalPath || !auditValue || typeof auditValue !== 'object') continue
          mergeAuditFieldEntry(allFields, canonicalPath, auditValue)
          // 兼容历史审计键格式（用于复用通用 auditResolver 匹配）
          mergeAuditFieldEntry(allFields, toAuditPath(canonicalPath), auditValue)
        }
      }
    }

    // 2. 从 groups 中提取字段级别的溯源信息
    // groups 结构: { group_id: { fields: { field_key: { document_id, bbox, raw, source_id, page_idx, ... } } } }
    for (const [groupId, groupData] of Object.entries(groups)) {
      const fields = groupData?.fields
      if (fields && typeof fields === 'object') {
        for (const [fieldKey, fieldData] of Object.entries(fields)) {
          if (fieldData?.document_id || fieldData?.bbox || fieldData?.raw || fieldData?.source_id || fieldData?.document_type) {
            const canonicalPath = buildProjectFieldCanonicalPath(groupId, fieldKey, fieldData)
            if (!canonicalPath) continue
            const nextAudit = {
              document_id: fieldData.document_id,
              document_type: fieldData.document_type,
              raw: fieldData.raw,
              source_id: fieldData.source_id,
              bbox: fieldData.bbox,
              page_idx: fieldData.page_idx,
              value: fieldData.value,
            }
            mergeAuditFieldEntry(allFields, canonicalPath, nextAudit)
            // 兼容历史审计键格式（用于复用通用 auditResolver 匹配）
            mergeAuditFieldEntry(allFields, toAuditPath(canonicalPath), nextAudit)
          }
        }
      }
    }

    // 构造 SchemaForm 期望的 _extraction_metadata 结构
    return {
      ...data,
      _extraction_metadata: {
        audit: { fields: allFields },
        documents,
        extracted_at: crfData?._extracted_at,
        edited_at: crfData?._edited_at,
        edited_by: crfData?._edited_by,
        stats: crfData?._stats
      },
    }
  }, [crfData, projectSchema, projectTemplateFieldGroups, projectTemplateGroups])

  const getSchemaFieldPath = (fieldKey, field) => {
    const raw = field?.field_path || field?.db_field || fieldKey
    if (!raw) return raw
    return raw
      .replace(/\[\*\]/g, '')
      .split('/')
      .filter(Boolean)
      .join('.')
  }

  const getSchemaFieldValue = useCallback((data, fieldKey, field) => {
    const raw = field?.field_path || field?.db_field || fieldKey
    if (!raw) return undefined
    const parts = normalizeSchemaPath(raw)
    if (parts.length === 0) return undefined
    const schemaResolved = readValueBySchema(data, projectSchema, parts)
    if (schemaResolved !== undefined) return schemaResolved
    return readValueByLoosePath(data, parts)
  }, [projectSchema])

  const normalizeValue = (value) => (value === undefined ? null : value)

  const isValueEqual = (a, b) => {
    const left = normalizeValue(a)
    const right = normalizeValue(b)
    if (left === right) return true
    if (typeof left !== typeof right) return false
    if (typeof left === 'object') {
      return JSON.stringify(left) === JSON.stringify(right)
    }
    return false
  }

  /**
   * 从字段路径解析所属重复行的 row_uid。
   * @param {Record<string, any>} sourceData
   * @param {string} fieldPath
   * @returns {string|null}
   */
  const resolveRowUidByPath = useCallback((sourceData, fieldPath) => {
    const parts = String(fieldPath || '').split('.').filter(Boolean)
    if (parts.length === 0) return null
    let node = sourceData
    let matchedRowUid = null
    for (const part of parts) {
      if (/^\d+$/.test(part)) {
        const index = Number(part)
        if (!Array.isArray(node) || node[index] == null) break
        const rowItem = node[index]
        if (rowItem && typeof rowItem === 'object' && rowItem._row_uid) {
          matchedRowUid = String(rowItem._row_uid)
        }
        node = rowItem
        continue
      }
      if (!node || typeof node !== 'object') break
      node = node[part]
    }
    return matchedRowUid
  }, [])

  // 使用 ref 存储最新的 crfData 和 schemaData，避免 handleProjectSchemaSave 的依赖循环
  const crfDataRef = useRef(crfData)
  const schemaDataRef = useRef(schemaData)

  useEffect(() => {
    crfDataRef.current = crfData
  }, [crfData])

  useEffect(() => {
    schemaDataRef.current = schemaData
  }, [schemaData])

  /**
   * 保存科研项目 CRF 编辑结果。
   * 该页面仅允许通过 `updateProjectPatientCrfFields` 写入项目域数据，
   * 避免引入患者旧版 `/patients/{id}/ehr` 写路径形成旁路。
   * @param {Record<string, any>} draftData
   * @returns {Promise<void>}
   */
  const handleProjectSchemaSave = useCallback(async (draftData) => {
    console.log('[handleProjectSchemaSave] 🔥 函数被调用！', {
      hasProjectId: !!projectId,
      hasPatientId: !!resolvedProjectPatientId,
      draftDataKeys: draftData ? Object.keys(draftData) : []
    })

    if (!projectId || !resolvedProjectPatientId) {
      message.warning('保存失败：未找到患者信息')
      return
    }

    const currentCrfData = crfDataRef.current
    const currentSchemaData = schemaDataRef.current

    console.log('[handleProjectSchemaSave] 数据状态:', {
      hasCrfData: !!currentCrfData,
      hasSchemaData: !!currentSchemaData,
      crfDataKeys: currentCrfData ? Object.keys(currentCrfData) : [],
      crfDataGroupsKeys: currentCrfData?.groups ? Object.keys(currentCrfData.groups) : [],
      crfDataDataKeys: currentCrfData?.data ? Object.keys(currentCrfData.data) : [],
      crfDataStructure: {
        hasGroups: !!currentCrfData?.groups,
        hasData: !!currentCrfData?.data,
        hasTaskResults: !!currentCrfData?._task_results,
        groupsType: typeof currentCrfData?.groups,
        dataType: typeof currentCrfData?.data
      }
    })

    // 按实际 SchemaForm 草稿的叶子路径生成 delta。
    // 这样不会把可重复表单整列数组写到错误字段，也不会依赖模板 db_fields 与 UI 路径完全一致。
    const updates = buildProjectCrfFieldUpdates(draftData, currentSchemaData, isValueEqual)

    if (updates.length === 0) {
      message.info('没有需要保存的修改')
      return
    }

    try {
      const res = await updateProjectPatientCrfFields(projectId, resolvedProjectPatientId, {
        fields: updates,
      })

      if (res.success) {
        const changedFields = Number(res?.data?.changed_fields ?? updates.length)
        message.success(`保存成功：已更新 ${changedFields} 个字段`)
        if (typeof refresh === 'function') {
          await refresh()
        }
        setSchemaHistoryRefreshTick((tick) => tick + 1)
      } else {
        message.error(res.message || '保存失败')
      }
    } catch (e) {
      console.error('[handleProjectSchemaSave] 保存异常:', e)
      message.error(e?.message || '保存失败')
    }
  }, [projectId, resolvedProjectPatientId, refresh, isValueEqual])

  /**
   * 候选值固化后强制刷新科研患者详情，确保前后端状态一致。
   * @returns {Promise<void>}
   */
  const handleFieldCandidateSolidified = useCallback(async () => {
    if (typeof refresh === 'function') {
      await refresh()
    }
    setSchemaHistoryRefreshTick((tick) => tick + 1)
  }, [refresh])

  // 初始化AI聊天历史
  useEffect(() => {
    setAiChatHistory([
      {
        type: 'ai',
        content: `您好！我是项目AI助手。目前正在查看患者 ${patientInfo?.name || '未知患者'} 在项目中的数据。有什么可以帮助您的吗？`,
        timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      }
    ])
  }, [patientInfo?.name])

  const handleSendAiMessage = () => {
    if (!aiInput.trim()) return
    
    const newMessage = {
      type: 'user',
      content: aiInput,
      timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    }
    
    setAiChatHistory([...aiChatHistory, newMessage])
    setAiInput('')
    
    // 模拟AI回复
    setTimeout(() => {
      const aiReply = {
        type: 'ai',
        content: '我正在分析患者的项目数据，请稍等...',
        timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      }
      setAiChatHistory(prev => [...prev, aiReply])
    }, 1000)
  }

  const handleClearChat = () => {
    setAiChatHistory([])
  }

  // 加载状态
  const shouldShowBlockingLoading = (loading || projectLoading) && !patientInfo?.patientId
  if (shouldShowBlockingLoading) {
    return (
      <div className="page-container fade-in" style={{ 
        display: 'flex', 
        justifyContent: 'center', 
        alignItems: 'center', 
        minHeight: 400 
      }}>
        <Spin 
          indicator={<LoadingOutlined style={{ fontSize: 16 }} spin />}
          tip="正在加载患者数据..."
        />
      </div>
    )
  }

  const handleOpenExtractionModal = () => {
    setExtractionModalGroups([])
    setExtractionModalMode('incremental')
    setExtractionModalVisible(true)
  }

  const handleSubmitTargetedExtraction = async () => {
    if (extractionModalGroups.length === 0) {
      message.warning('请至少选择一个字段组')
      return
    }
    setExtractionModalVisible(false)
    setIsExtracting(true)
    try {
      const response = await startCrfExtraction(
        projectId,
        [resolvedProjectPatientId || patientId],
        extractionModalMode,
        extractionModalGroups
      )
      if (response.success) {
        message.success('专项抽取任务已启动')
        const taskId = response.data.task_id
        const poll = async () => {
          try {
            const res = await getCrfExtractionProgress(projectId, taskId)
            const progress = res.data || res
            if (['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(progress.status)) {
              setIsExtracting(false)
              if (progress.status === 'completed' || progress.status === 'completed_with_errors') {
                message.success('专项抽取完成')
              } else {
                message.warning(`抽取${progress.status === 'failed' ? '失败' : '已取消'}`)
              }
              refresh()
              return
            }
            setTimeout(poll, 2000)
          } catch {
            setIsExtracting(false)
          }
        }
        poll()
      } else {
        message.error(response.message || '启动专项抽取失败')
        setIsExtracting(false)
      }
    } catch (error) {
      console.error('专项抽取失败:', error)
      message.error('启动专项抽取失败')
      setIsExtracting(false)
    }
  }

  return (
    <div className="page-container fade-in">
      {/* 患者项目统计 */}
      <Card 
        size="small" 
        style={{ marginBottom: 16 }}
        styles={{ body: { padding: 0 } }}
        title={
          <Breadcrumb
            items={[
              {
                title: (
                  <Button
                    type="link"
                    size="small"
                    style={{ padding: 0, height: 'auto' }}
                    onClick={() => navigate(`/research/projects/${projectId}`)}
                  >
                    {projectName}
                  </Button>
                )
              },
              {
                title: `${maskPatientDisplayName(patientInfo.name)} (${patientInfo.subjectId || patientInfo.patientCode || patientInfo.patientId})`
              }
            ]}
          />
        }
      >
        {(projectError || patientError) && (
          <div style={{ padding: 12 }}>
            <Alert
              type="error"
              showIcon
              message="项目/患者数据加载失败"
              description={
                <div>
                  {projectError && (
                    <div>项目详情失败：{projectError}</div>
                  )}
                  {patientError && (
                    <div>患者详情失败：{patientError}</div>
                  )}
                  <div style={{ marginTop: 8, opacity: 0.8 }}>
                    Debug: projectId={projectId}，patientId={patientId}
                  </div>
                </div>
              }
            />
          </div>
        )}
        <div style={{ borderTop: `1px solid ${appThemeToken.colorBorder}` }}>
          <ProjectSchemaEhrTab
            projectId={projectId}
            projectName={projectName}
            schemaData={projectSchema}
            patientData={schemaData}
            patientId={resolvedProjectPatientId}
            projectDocuments={documents}
            onSave={handleProjectSchemaSave}
            onFieldCandidateSolidified={handleFieldCandidateSolidified}
            externalHistoryRefreshKey={schemaHistoryRefreshTick}
          />
        </div>
      </Card>

      {/* 专项抽取配置弹窗 */}
      <Modal
        title="专项抽取配置"
        open={extractionModalVisible}
        onCancel={() => setExtractionModalVisible(false)}
        footer={[
          <Button key="cancel" onClick={() => setExtractionModalVisible(false)}>
            取消
          </Button>,
          <Button
            key="start"
            type="primary"
            style={{ backgroundColor: appThemeToken.colorPrimary, borderColor: appThemeToken.colorPrimary }}
            disabled={extractionModalGroups.length === 0 || isExtracting}
            onClick={handleSubmitTargetedExtraction}
          >
            开始抽取
          </Button>
        ]}
        width={600}
      >
        <Alert
          message="专项抽取任务"
          description={`患者: ${patientInfo.name} (${patientInfo.subjectId || patientInfo.patientCode || patientInfo.patientId}) | 已选字段组: ${extractionModalGroups.length} 个`}
          type="info"
          style={{ marginBottom: 16 }}
        />
        
        <Form layout="vertical">
          <Form.Item label="选择字段组">
            <div style={{ marginBottom: 8 }}>
              <Space>
                <Button
                  size="small"
                  type="link"
                  style={{ padding: 0 }}
                  onClick={() => setExtractionModalGroups(ehrFieldGroups.map(g => g.key))}
                >
                  全选
                </Button>
                <Button
                  size="small"
                  type="link"
                  style={{ padding: 0 }}
                  onClick={() => setExtractionModalGroups(
                    ehrFieldGroups.filter(g => g.status !== 'completed').map(g => g.key)
                  )}
                >
                  选择未完成
                </Button>
                <Button
                  size="small"
                  type="link"
                  style={{ padding: 0 }}
                  onClick={() => setExtractionModalGroups([])}
                >
                  清空
                </Button>
              </Space>
            </div>
            <Checkbox.Group
              style={{ width: '100%' }}
              value={extractionModalGroups}
              onChange={setExtractionModalGroups}
            >
              <Row>
                {ehrFieldGroups.map(group => (
                  <Col span={24} key={group.key} style={{ marginBottom: 8 }}>
                    <Checkbox value={group.key}>
                      <Space>
                        <Text>{group.name}</Text>
                        {group.status === 'completed' && (
                          <Tag color="green" size="small">已完成</Tag>
                        )}
                        {group.status === 'partial' && (
                          <Tag color="orange" size="small">部分完成</Tag>
                        )}
                        <Text type="secondary">({group.completeness}%)</Text>
                      </Space>
                    </Checkbox>
                  </Col>
                ))}
              </Row>
            </Checkbox.Group>
          </Form.Item>
          
          <Form.Item label="抽取模式">
            <Radio.Group value={extractionModalMode} onChange={e => setExtractionModalMode(e.target.value)}>
              <Radio value="incremental">增量抽取 - 仅补抽选中组内缺失字段</Radio>
              <Radio value="full">全量抽取 - 重新抽取选中组内所有字段</Radio>
            </Radio.Group>
          </Form.Item>
        </Form>
      </Modal>

      {/* AI助手可拖动悬浮窗 */}
      <Modal
        title={
          <div 
            style={{ 
              cursor: isDragging ? 'grabbing' : 'grab',
              userSelect: 'none',
              padding: '4px 0'
            }}
            onMouseDown={(e) => {
              e.preventDefault()
              setIsDragging(true)
              
              const startX = e.clientX
              const startY = e.clientY
              const startPosX = aiModalPosition.x
              const startPosY = aiModalPosition.y

              const handleMouseMove = (moveEvent) => {
                const deltaX = moveEvent.clientX - startX
                const deltaY = moveEvent.clientY - startY
                
                const newX = startPosX + deltaX
                const newY = startPosY + deltaY
                
                const maxX = window.innerWidth - 450
                const maxY = window.innerHeight - 400
                
                const boundedX = Math.max(0, Math.min(newX, maxX))
                const boundedY = Math.max(0, Math.min(newY, maxY))
                
                setAiModalPosition({ x: boundedX, y: boundedY })
              }

              const handleMouseUp = () => {
                setIsDragging(false)
                document.removeEventListener('mousemove', handleMouseMove)
                document.removeEventListener('mouseup', handleMouseUp)
              }

              document.addEventListener('mousemove', handleMouseMove)
              document.addEventListener('mouseup', handleMouseUp)
            }}
          >
            <Space>
              <RobotOutlined style={{ color: appThemeToken.colorPrimary }} />
              <Text strong>项目AI助手</Text>
              <Tag size="small">{projectName}</Tag>
            </Space>
          </div>
        }
        open={aiAssistantVisible}
        onCancel={() => setAiAssistantVisible(false)}
        footer={null}
        width={450}
        style={{ 
          position: 'fixed',
          top: aiModalPosition.y,
          left: aiModalPosition.x,
          margin: 0,
          paddingBottom: 0
        }}
        mask={false}
        getContainer={false}
      >
        {/* 聊天历史 */}
        <div style={{ height: 300, overflowY: 'auto', marginBottom: 16, border: `1px solid ${appThemeToken.colorBorder}`, borderRadius: 4, padding: 12 }}>
          {aiChatHistory.map((message, index) => (
            <div key={index} style={{ marginBottom: 12 }}>
              <div style={{
                display: 'flex',
                justifyContent: message.type === 'user' ? 'flex-end' : 'flex-start'
              }}>
                <div style={{
                  maxWidth: '80%',
                  padding: '8px 12px',
                  borderRadius: 8,
                  background: message.type === 'user' ? appThemeToken.colorPrimary : appThemeToken.colorFillTertiary,
                  color: message.type === 'user' ? 'white' : 'rgba(0,0,0,0.88)'
                }}>
                  <div style={{ fontSize: 12 }}>
                    {message.type === 'user' ? '💬 您' : '🤖 AI'}
                  </div>
                  <div style={{ fontSize: 14, marginTop: 4 }}>
                    {message.content}
                  </div>
                  <div style={{ 
                    fontSize: 12, 
                    marginTop: 4, 
                    opacity: 0.7,
                    textAlign: 'right'
                  }}>
                    {message.timestamp}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* 输入区域 */}
        <div>
          <Input.Group compact>
            <Input
              value={aiInput}
              onChange={(e) => setAiInput(e.target.value)}
              placeholder="输入项目相关问题..."
              onPressEnter={handleSendAiMessage}
              style={{ width: 'calc(100% - 80px)' }}
            />
            <Button 
              type="primary" 
              icon={<SendOutlined />}
              onClick={handleSendAiMessage}
              style={{ width: 60 }}
            />
            <Button 
              icon={<ClearOutlined />}
              onClick={handleClearChat}
              style={{ width: 20 }}
            />
          </Input.Group>
          
          <div style={{ marginTop: 12 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>💡 快速提问:</Text>
            <div style={{ marginTop: 4 }}>
              <Space size="small" wrap>
                <Button 
                  type="link" 
                  size="small" 
                  style={{ padding: '2px 6px', height: 'auto', fontSize: 12 }}
                  onClick={() => setAiInput('数据完善建议')}
                >
                  数据完善建议
                </Button>
                <Button 
                  type="link" 
                  size="small" 
                  style={{ padding: '2px 6px', height: 'auto', fontSize: 12 }}
                  onClick={() => setAiInput('质量检查报告')}
                >
                  质量检查报告
                </Button>
                <Button 
                  type="link" 
                  size="small" 
                  style={{ padding: '2px 6px', height: 'auto', fontSize: 12 }}
                  onClick={() => setAiInput('抽取优化建议')}
                >
                  抽取优化建议
                </Button>
              </Space>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  )
}

export default ProjectPatientDetail
