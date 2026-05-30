/**
 * Schema表单主组件
 * 组合CategoryTree和FormPanel，提供完整的Schema驱动表单体验
 * 支持三栏布局：左侧目录树 + 中间表单 + 右侧文档溯源
 */
import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import {
  Layout,
  Button,
  Space,
  message,
  Modal,
  Spin,
  Typography,
  Tooltip,
  Badge,
  Empty,
  Tag,
  Divider,
  Tabs,
  Upload
} from 'antd'
import {
  SaveOutlined,
  UndoOutlined,
  CloudSyncOutlined,
  ExclamationCircleOutlined,
  CheckCircleOutlined,
  FileTextOutlined,
  RightOutlined,
  LeftOutlined,
  PushpinOutlined,
  PushpinFilled,
  FileSearchOutlined,
  HistoryOutlined,
  EyeOutlined,
  FilePdfOutlined,
  ClockCircleOutlined,
  UserOutlined,
  EditOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
  RotateRightOutlined,
  ReloadOutlined,
  DatabaseOutlined,
  DragOutlined,
  UploadOutlined
} from '@ant-design/icons'
import { SchemaFormProvider, useSchemaForm } from './SchemaFormContext'
import CategoryTree from './CategoryTree'
import FormPanel from './FormPanel'
import { getDocumentDetail, getDocumentTempUrl, getDocumentPdfStreamUrl, extractEhrDataTargeted, uploadAndArchiveAsync } from '../../api/document'
import { getEhrFieldHistoryV3, getEhrFieldCandidatesV3, selectEhrFieldCandidateV3 } from '../../api/patient'
import PdfPageWithHighlight from '../PdfPageWithHighlight'
import { getProjectCrfFieldHistory, getProjectCrfFieldCandidates, selectProjectCrfFieldCandidate } from '../../api/project'
import { maskSensitiveField } from '../../utils/sensitiveUtils'
import {
  toAuditPath as _toAuditPath,
  toAuditPathWithoutIndex as _toAuditPathWithoutIndex,
  normalizePathKey as _normalizePathKey,
  getNestedValue as _getNestedValue,
  hasNestedKey as _hasNestedKey,
  formatAuditDisplayValue as _formatAuditDisplayValue,
  resolveFieldAudit,
  collectPatientAuditFieldMaps,
} from '../../utils/auditResolver'
import DocumentDetailModal from '../../pages/PatientDetail/tabs/DocumentsTab/components/DocumentDetailModal'
import SplitterHandle from '../Common/SplitterHandle'
import { appThemeToken } from '../../styles/themeTokens'

const { Sider, Content } = Layout
const { Text, Paragraph } = Typography

function _resolveFieldAuditFromExtractionMetadata(data, dotPath) {
  if (!dotPath) return null
  const fieldMaps = collectPatientAuditFieldMaps(data)
  if (fieldMaps.length === 0) return null
  return resolveFieldAudit(fieldMaps, dotPath)
}

function _buildSourceLocationFromAudit(audit) {
  if (!audit || typeof audit !== 'object') return null
  if (audit.source_location) return audit.source_location
  if (Array.isArray(audit.bbox) && audit.bbox.length >= 4) {
    return {
      bbox: audit.bbox,
      page: typeof audit.page_idx === 'number' ? audit.page_idx + 1 : 1,
    }
  }
  return null
}

function useAutoSave(enabled, interval, onSave) {
  const timerRef = useRef(null)
  const { isDirty, draftData } = useSchemaForm()
  useEffect(() => {
    if (!enabled || !isDirty) return
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => { if (onSave) onSave(draftData, 'auto') }, interval)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [enabled, isDirty, draftData, interval, onSave])
}

const Toolbar = ({ onSave, onReset, saving, autoSaveEnabled, onToggleAutoSave }) => {
  const { isDirty } = useSchemaForm()
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', padding: '10px 16px', background: appThemeToken.colorBgContainer, borderBottom: `1px solid ${appThemeToken.colorBorder}`, borderRadius: '8px 8px 0 0' }}>
      <Space>
        <Tooltip title={autoSaveEnabled ? '关闭自动保存' : '开启自动保存'}>
          <Button type={autoSaveEnabled ? 'primary' : 'default'} ghost={autoSaveEnabled} size="small" icon={<CloudSyncOutlined />} onClick={onToggleAutoSave}>自动保存 {autoSaveEnabled ? '开' : '关'}</Button>
        </Tooltip>
        <Button size="small" icon={<UndoOutlined />} onClick={onReset} disabled={!isDirty}>重置</Button>
        <Button type="primary" size="small" icon={<SaveOutlined />} onClick={() => onSave('manual')} loading={saving} disabled={!isDirty}>保存</Button>
      </Space>
    </div>
  )
}

/** 从 8 点 position [x1,y1,x2,y2,x3,y3,x4,y4] 得到包围矩形。
 *
 * 新版 OCR（/parse）：position 为 [0,1] 归一化坐标，pageWidth/pageHeight 为原图像素尺寸。
 *   → 将 [0,1] 坐标还原为原图像素坐标（如 x1=0.11, pageWidth=4344 → 0.11*4344=478px），
 *     返回 [478, 786, 4145, 4938] 形式的原图像素坐标。
 *
 * 旧版 OCR（/pdf_to_markdown）：position 为原图像素坐标，无 pageWidth/pageHeight。
 *   → 若坐标明显为像素（max > 1000），直接返回；
 *     若坐标在 0-1000 范围（已归一化），直接返回。
 */
function _positionToBbox(position, pageWidth, pageHeight) {
  if (!Array.isArray(position) || position.length < 8) return null
  const xs = [position[0], position[2], position[4], position[6]]
  const ys = [position[1], position[3], position[5], position[7]]
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const maxX = Math.max(...xs)
  const maxY = Math.max(...ys)

  // 新版 OCR：检测 position 是否为 [0,1] 归一化坐标（所有值 ≤ 1）
  const allIn01 = xs.every((x) => x >= 0 && x <= 1) && ys.every((y) => y >= 0 && y <= 1)
  const hasPageSize = typeof pageWidth === 'number' && pageWidth > 0 &&
                      typeof pageHeight === 'number' && pageHeight > 0

  if (allIn01 && hasPageSize) {
    // [0,1] 归一化坐标 → 还原为原图像素坐标
    return [
      Math.round(minX * pageWidth),
      Math.round(minY * pageHeight),
      Math.round(maxX * pageWidth),
      Math.round(maxY * pageHeight),
    ]
  }

  // 旧版 OCR：像素坐标（max > 1000）或无 pageSize
  const maxCoord = Math.max(maxX, maxY)
  if (maxCoord > 1000) {
    // 已经是像素坐标，直接返回
    return [minX, minY, maxX, maxY]
  }
  // 已归一化到 0-1000，直接返回
  return [minX, minY, maxX, maxY]
}

/** 将 history 接口的 source_location 转为预览组件用的 activeCoordinates（支持单个或多个区块）。
 * 优先使用 content_list 的 position（8 点），无则使用 bbox（4 点）。
 *
 * 坐标单位说明：
 *   - 新版 Textin 像素坐标：保留 pageWidth/pageHeight，由渲染侧精确等比换算。
 *   - 0~1000 归一化：pageWidth/pageHeight = 1000。
 *   - 旧版原图像素且无页面尺寸：pageWidth/pageHeight = null，由图片 naturalWidth/naturalHeight 换算。
 */
function _sourceLocationToCoordinates(loc) {
  if (!loc) return null

  const toCoord = (item) => {
    if (!item || typeof item !== 'object') return null
    const rawPageWidth = Number(item.page_width || 0)
    const rawPageHeight = Number(item.page_height || 0)
    const hasTextinPageSize = rawPageWidth > 0 && rawPageHeight > 0
    // 优先使用 position（8 点），再回退到 bbox（4 点）
    let bbox = item.bbox
    if ((!bbox || bbox.length < 4) && Array.isArray(item.position) && item.position.length >= 8) {
      bbox = _positionToBbox(
        item.position,
        rawPageWidth,
        rawPageHeight
      )
    }
    if (!Array.isArray(bbox) || bbox.length < 4) return null
    const [rawX1, rawY1, rawX2, rawY2] = bbox.map(Number)
    const x1 = Math.min(rawX1, rawX2)
    const y1 = Math.min(rawY1, rawY2)
    const x2 = Math.max(rawX1, rawX2)
    const y2 = Math.max(rawY1, rawY2)
    const page = item.page != null ? Number(item.page) : 1
    // 根据数值量级自动识别坐标单位：<=1100 视为 0-1000 归一化，否则视为原图像素
    const maxV = Math.max(
      Math.abs(x1), Math.abs(y1), Math.abs(x2), Math.abs(y2)
    )
    const isPixel = maxV > 1100
    console.debug('[_sourceLocationToCoordinates]', { bbox: [x1,y1,x2,y2], maxV, isPixel, page })
    // 保留 TextIn 8 点 polygon（item.polygon 来自后端 parseSourceLocation 的 position 字段）。
    // 用于精确高亮：拍摄/扫描文档存在轻微倾斜时，多边形比轴对齐 bbox 更贴合实际文字轮廓，
    // 避免在 PDF 上产生"红框跑出文档外"的视觉错位。
    const polygon = Array.isArray(item.polygon) && item.polygon.length >= 8
      ? item.polygon.map(Number)
      : null
    return {
      x: x1,
      y: y1,
      width: x2 - x1,
      height: y2 - y1,
      polygon,
      pageWidth: hasTextinPageSize ? rawPageWidth : (isPixel ? null : 1000),
      pageHeight: hasTextinPageSize ? rawPageHeight : (isPixel ? null : 1000),
      pageIdx: Math.max(0, page - 1)
    }
  }

  // 多个区块：loc 为数组
  if (Array.isArray(loc)) {
    const coords = loc.map(toCoord).filter(Boolean)
    return coords.length ? coords : null
  }

  // 单个区块：loc 为对象
  if (typeof loc === 'object') {
    return toCoord(loc)
  }
  return null
}

/**
 * 将文档集合（数组或对象映射）标准化为数组。
 * @param {Array|Object|null|undefined} docs
 * @returns {Array<Object>}
 */
function normalizeDocumentCollection(docs) {
  if (!docs) return []
  if (Array.isArray(docs)) return docs.filter(Boolean).map(normalizeCandidateDocument)
  if (typeof docs === 'object') {
    return Object.entries(docs).map(([id, doc]) => normalizeCandidateDocument({ id, ...(doc || {}) }))
  }
  return []
}

function normalizeDocumentMetadata(metadata) {
  if (!metadata) return {}
  if (typeof metadata === 'string') {
    try {
      return JSON.parse(metadata)
    } catch (_) {
      return {}
    }
  }
  return typeof metadata === 'object' ? metadata : {}
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return value
    }
  }
  return undefined
}

function normalizeCandidateDocument(doc) {
  if (!doc || typeof doc !== 'object') return doc
  const metadata = normalizeDocumentMetadata(doc.metadata)
  const result = normalizeDocumentMetadata(metadata.result)
  const documentType = firstNonEmpty(
    doc.document_type,
    doc.documentType,
    doc.doc_type,
    doc.file_type,
    metadata.documentType,
    metadata.document_type,
    metadata.docType,
    result['文档类型'],
    doc.category
  )
  const documentSubType = firstNonEmpty(
    doc.document_sub_type,
    doc.documentSubType,
    doc.documentSubtype,
    doc.doc_sub_type,
    doc.sub_type,
    metadata.documentSubType,
    metadata.documentSubtype,
    metadata.document_sub_type,
    result['文档子类型'],
    metadata.subType
  )
  return {
    ...doc,
    metadata,
    document_type: documentType,
    document_sub_type: documentSubType,
    documentType,
    documentSubType,
  }
}

/**
 * 统一候选文档来源：优先 extraction metadata，其次回退到外部传入列表。
 * @param {Object} draftData
 * @param {Array|Object|null|undefined} fallbackDocuments
 * @returns {Array<Object>}
 */
function buildCandidateDocuments(draftData, fallbackDocuments) {
  const metadataDocuments = normalizeDocumentCollection(draftData?._extraction_metadata?.documents)
  if (metadataDocuments.length > 0) return metadataDocuments
  return normalizeDocumentCollection(fallbackDocuments)
}

/**
 * 获取文档展示名称。
 * @param {Object} doc
 * @returns {string}
 */
function getDocumentDisplayName(doc) {
  return doc?.file_name || doc?.fileName || doc?.name || `文档_${doc?.id ?? '未知'}`
}

/**
 * 获取文档类型标签（类型|子类型）。
 * @param {Object} doc
 * @returns {string}
 */
function getDocumentTypeLabel(doc) {
  const normalizedDoc = normalizeCandidateDocument(doc)
  const mainType = normalizedDoc?.document_type || '未知类型'
  const subType = normalizedDoc?.document_sub_type || ''
  return subType ? `${mainType} | ${subType}` : String(mainType)
}

/**
 * 格式化文档上传时间。
 * @param {Object} doc
 * @returns {string}
 */
function formatDocumentUploadedAt(doc) {
  const raw = doc?.upload_time || doc?.uploaded_at || doc?.created_at
  if (!raw) return '-'
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return String(raw)
  return d.toLocaleString()
}

const ModificationHistory = ({
  fieldPath,
  rowUid = null,
  patientId,
  projectId,
  refreshKey = 0,
  onViewSource,
  onHistoryLoaded,
  onCandidateApplied,
  isSensitive = false
}) => {
  const [history, setHistory] = useState([])
  const [fieldMeta, setFieldMeta] = useState({
    candidates: [],
    selectedCandidateId: null,
    selectedValue: null,   // 当前选中值（用于审计记录的回退匹配）
    hasValueConflict: false,
    distinctValueCount: 0,
  })
  const [loading, setLoading] = useState(false)
  const [selectingCandidateId, setSelectingCandidateId] = useState(null)
  const [selectRefreshTick, setSelectRefreshTick] = useState(0)

  const subFieldMatch = /\.(\d+)\.(.+)$/.exec(fieldPath)
  const rowMatch = !subFieldMatch ? /\.(\d+)$/.exec(fieldPath) : null
  const arrayIdx = subFieldMatch ? parseInt(subFieldMatch[1], 10) : rowMatch ? parseInt(rowMatch[1], 10) : null
  const subFieldPath = subFieldMatch ? subFieldMatch[2] : null
  /**
   * 规范化字段路径，保持索引层级不丢失，避免可重复行/嵌套字段串历史。
   * @param {string} path
   * @returns {string}
   */
  const toHistoryQueryPath = useCallback((path) => String(path || '').trim(), [])

  useEffect(() => {
    let cancelled = false
    async function fetchHistory() {
      if (!fieldPath) {
        setHistory([])
        if (typeof onHistoryLoaded === 'function') onHistoryLoaded([])
        return
      }
      if (projectId && patientId) {
        const queryPath = toHistoryQueryPath(fieldPath)
        setLoading(true)
        try {
          const res = await getProjectCrfFieldHistory(projectId, patientId, queryPath, rowUid)
          const payload = res?.data || {}
          const candidateRes = await getProjectCrfFieldCandidates(projectId, patientId, queryPath, rowUid)
          const candidatePayload = candidateRes?.data || {}
          const list = !cancelled && payload?.history ? payload.history : []
          if (!cancelled) {
            setHistory(list)
            setFieldMeta({
              candidates: Array.isArray(candidatePayload?.candidates) ? candidatePayload.candidates : [],
              selectedCandidateId: candidatePayload?.selected_candidate_id || null,
              selectedValue: candidatePayload?.selected_value ?? null,
              hasValueConflict: !!candidatePayload?.has_value_conflict,
              distinctValueCount: Number(candidatePayload?.distinct_value_count || 0),
            })
            if (typeof onHistoryLoaded === 'function') onHistoryLoaded(list, payload)
          }
        } catch (e) {
          console.error('Failed to fetch project field history:', e)
          if (!cancelled) {
            setHistory([])
            setFieldMeta({
              candidates: [],
              selectedCandidateId: null,
              hasValueConflict: false,
              distinctValueCount: 0,
            })
            if (typeof onHistoryLoaded === 'function') onHistoryLoaded([])
          }
        } finally {
          if (!cancelled) setLoading(false)
        }
      } else if (patientId) {
        const queryPath = toHistoryQueryPath(fieldPath)
        setLoading(true)
        try {
          const res = await getEhrFieldHistoryV3(patientId, queryPath, rowUid)
          const payload = res?.data || {}
          const candidateRes = await getEhrFieldCandidatesV3(patientId, queryPath, rowUid)
          const candidatePayload = candidateRes?.data || {}
          const list = !cancelled && payload?.history ? payload.history : []
          if (!cancelled) {
            setHistory(list)
            setFieldMeta({
              candidates: Array.isArray(candidatePayload?.candidates) ? candidatePayload.candidates : [],
              selectedCandidateId: candidatePayload?.selected_candidate_id || null,
              selectedValue: candidatePayload?.selected_value ?? null,
              hasValueConflict: !!candidatePayload?.has_value_conflict,
              distinctValueCount: Number(candidatePayload?.distinct_value_count || 0),
            })
            if (typeof onHistoryLoaded === 'function') onHistoryLoaded(list, payload)
          }
        } catch (e) {
          console.error('Failed to fetch field history:', e)
          if (!cancelled) {
            setHistory([])
            setFieldMeta({
              candidates: [],
              selectedCandidateId: null,
              hasValueConflict: false,
              distinctValueCount: 0,
            })
            if (typeof onHistoryLoaded === 'function') onHistoryLoaded([])
          }
        } finally {
          if (!cancelled) setLoading(false)
        }
      } else {
        setHistory([])
        setFieldMeta({
          candidates: [],
          selectedCandidateId: null,
          hasValueConflict: false,
          distinctValueCount: 0,
        })
        if (typeof onHistoryLoaded === 'function') onHistoryLoaded([])
      }
    }
    fetchHistory()
    return () => { cancelled = true }
  }, [patientId, projectId, fieldPath, rowUid, refreshKey, onHistoryLoaded, selectRefreshTick, toHistoryQueryPath])
  
  const extractSubFieldValues = (item) => {
    if (arrayIdx === null) return null
    const oldArr = Array.isArray(item.old_value) ? item.old_value : null
    const newArr = Array.isArray(item.new_value) ? item.new_value : null
    if (subFieldPath) {
      const oldSub = oldArr?.[arrayIdx] != null ? _getNestedValue(oldArr[arrayIdx], subFieldPath) : undefined
      const newSub = newArr?.[arrayIdx] != null ? _getNestedValue(newArr[arrayIdx], subFieldPath) : undefined
      return { oldSub, newSub }
    }
    return { oldSub: oldArr?.[arrayIdx], newSub: newArr?.[arrayIdx] }
  }

  // 格式化值的显示（敏感字段自动脱敏）
  const formatValue = (val) => {
    if (val === null || val === undefined) return '—'
    let str
    if (typeof val === 'object') {
      try {
        str = JSON.stringify(val)
        if (str.length > 50) str = str.substring(0, 50) + '...'
      } catch {
        str = String(val)
      }
    } else {
      str = String(val)
      if (str.length > 50) str = str.substring(0, 50) + '...'
    }
    if (isSensitive && str && str !== '—') {
      return maskSensitiveField(str, fieldPath)
    }
    return str
  }

  const visibleHistory = useMemo(() => history.filter((item) => {
    if (arrayIdx === null) return true
    const sub = extractSubFieldValues(item)
    if (!sub) return true
    const canCompareSubField = sub.oldSub !== undefined || sub.newSub !== undefined
    if (!canCompareSubField) return true
    return formatValue(sub.oldSub) !== formatValue(sub.newSub)
  }), [history, arrayIdx, subFieldPath, fieldPath, isSensitive])
  
  // 判断是否为抽取类操作
  const isExtractAction = (changeType) => ['extract', 'merge', 'merge_append', 'merge_dedupe', 'initial_extract'].includes(changeType)

  /**
   * 统一读取候选值中的真实显示值。
   * @param {Record<string, any>} candidate
   * @returns {any}
   */
  const getCandidateDisplayValue = (candidate) => {
    const raw = candidate?.value
    if (raw && typeof raw === 'object' && Object.prototype.hasOwnProperty.call(raw, 'value')) {
      return raw.value
    }
    return raw
  }

  /**
   * 选择并固化候选值。
   * @param {string} candidateId
   * @returns {Promise<void>}
   */
  const handleSelectCandidate = async (candidateId) => {
    if (!candidateId || !fieldPath) return
    const queryPath = toHistoryQueryPath(fieldPath)
    setSelectingCandidateId(candidateId)
    const prevSelectedId = fieldMeta.selectedCandidateId
    setFieldMeta((meta) => ({ ...meta, selectedCandidateId: candidateId }))
    try {
      const selectedCandidate = (fieldMeta.candidates || []).find((item) => item?.id === candidateId)
      const selectedValue = getCandidateDisplayValue(selectedCandidate)
      if (projectId && patientId) {
        await selectProjectCrfFieldCandidate(projectId, patientId, queryPath, candidateId, selectedValue, rowUid)
      } else if (patientId) {
        await selectEhrFieldCandidateV3(patientId, queryPath, candidateId, selectedValue, rowUid)
      }
      if (typeof onCandidateApplied === 'function' && selectedCandidate) {
        onCandidateApplied(queryPath, selectedValue, rowUid, selectedCandidate)
      }
      message.success('已采用此值')
      setSelectRefreshTick((tick) => tick + 1)
    } catch (error) {
      setFieldMeta((meta) => ({ ...meta, selectedCandidateId: prevSelectedId }))
      const backendMsg = error?.response?.data?.message || error?.message
      message.error(`采用失败: ${backendMsg || '未知错误'}`)
    } finally {
      setSelectingCandidateId(null)
    }
  }
  
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8, padding: '6px 8px', background: appThemeToken.colorFillTertiary, borderRadius: 4 }}>
        <HistoryOutlined style={{ color: appThemeToken.colorPrimary, marginRight: 6 }} />
        <Text strong style={{ fontSize: 12 }}>修改历史</Text>
        {loading ? (
          <Spin size="small" style={{ marginLeft: 8 }} />
        ) : (
          <Badge count={visibleHistory.length} size="small" style={{ marginLeft: 8, backgroundColor: visibleHistory.length > 0 ? appThemeToken.colorPrimary : appThemeToken.colorTextTertiary }} />
        )}
      </div>
      {loading ? (
        <div style={{ textAlign: 'center', padding: 16 }}><Spin size="small" /><div style={{ marginTop: 8, fontSize: 12, color: appThemeToken.colorTextTertiary }}>加载中...</div></div>
      ) : visibleHistory.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 16, color: appThemeToken.colorTextTertiary, fontSize: 12 }}>暂无修改记录</div>
      ) : (
        <div style={{ paddingLeft: 8, maxHeight: 300, overflowY: 'auto' }} className="schema-form-scrollable hover-scrollbar">
          {visibleHistory.map((item, index) => (
            <div key={item.id} style={{ position: 'relative', paddingLeft: 16, paddingBottom: index < visibleHistory.length - 1 ? 12 : 0, borderLeft: index < visibleHistory.length - 1 ? `1px solid ${appThemeToken.colorBorder}` : 'none' }}>
              <div style={{ position: 'absolute', left: -4, top: 4, width: 8, height: 8, borderRadius: '50%', background: isExtractAction(item.change_type) ? appThemeToken.colorPrimary : appThemeToken.colorSuccess, border: `2px solid ${appThemeToken.colorBgContainer}`, boxShadow: '0 0 0 1px ' + (isExtractAction(item.change_type) ? appThemeToken.colorPrimary : appThemeToken.colorSuccess) }} />
              <div style={{ background: appThemeToken.colorBgContainer, padding: '8px 10px', borderRadius: 4, border: `1px solid ${appThemeToken.colorBorder}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    <ClockCircleOutlined style={{ marginRight: 4 }} />
                    {item.created_at ? new Date(item.created_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}
                  </Text>
                  <Text style={{ fontSize: 12, color: appThemeToken.colorTextSecondary }}>
                    <UserOutlined style={{ marginRight: 4 }} />
                    {item.operator_name || (item.operator_type === 'ai' ? 'AI系统' : '未知')}
                  </Text>
                </div>
                <div style={{ marginBottom: 4, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Tag color={isExtractAction(item.change_type) ? 'blue' : 'green'} style={{ fontSize: 12, padding: '0 4px', lineHeight: '16px' }}>
                    {item.change_type_display || item.change_type}
                  </Tag>
                  {item.source_document_id && typeof onViewSource === 'function' && (
                    <Button type="link" size="small" style={{ padding: 0, height: 'auto', fontSize: 12 }} icon={<FileSearchOutlined />} onClick={() => onViewSource(item)}>
                      查看溯源
                    </Button>
                  )}
                </div>
                {(() => {
                  const sub = extractSubFieldValues(item)
                  const displayOld = sub ? sub.oldSub : item.old_value
                  const displayNew = sub ? sub.newSub : item.new_value
                  if (sub && formatValue(displayOld) === formatValue(displayNew)) {
                    return <div style={{ fontSize: 12, color: appThemeToken.colorTextTertiary }}>（此字段未变更）</div>
                  }
                  if (displayOld !== null && displayOld !== undefined) {
                    return (
                      <div style={{ fontSize: 12 }}>
                        <span style={{ color: appThemeToken.colorError, textDecoration: 'line-through' }}>{formatValue(displayOld)}</span>
                        <span style={{ margin: '0 6px', color: appThemeToken.colorTextTertiary }}>→</span>
                        <span style={{ color: appThemeToken.colorSuccess, fontWeight: 500 }}>{formatValue(displayNew)}</span>
                      </div>
                    )
                  }
                  return (
                    <div style={{ fontSize: 12 }}>
                      <span style={{ color: appThemeToken.colorPrimary }}>新值: </span>
                      <span style={{ fontWeight: 500 }}>{formatValue(displayNew)}</span>
                    </div>
                  )
                })()}
                {item.source_document_name && (
                  <div style={{ marginTop: 4, color: appThemeToken.colorTextSecondary, fontSize: 12 }}>
                    <FileTextOutlined style={{ marginRight: 4 }} />
                    来源: {item.source_document_name}
                  </div>
                )}
                {item.remark && (
                  <div style={{ marginTop: 4, color: appThemeToken.colorTextSecondary, fontSize: 12 }}>
                    <EditOutlined style={{ marginRight: 4 }} />
                    备注: {item.remark}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && fieldMeta.candidates.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8, padding: '6px 8px', background: appThemeToken.colorFillTertiary, borderRadius: 4 }}>
            <DatabaseOutlined style={{ color: appThemeToken.colorPrimary, marginRight: 6 }} />
            <Text strong style={{ fontSize: 12 }}>候选值</Text>
            {fieldMeta.hasValueConflict && (
              <Tag color="orange" style={{ marginLeft: 8 }}>
                多值差异 {fieldMeta.distinctValueCount}
              </Tag>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {(() => {
              const candidates = fieldMeta.candidates || []
              const selectedCandidateId = fieldMeta.selectedCandidateId
              const hasSelectedIdInList = selectedCandidateId && candidates.some((item) => item?.id === selectedCandidateId)
              const selectedValueKey = fieldMeta.selectedValue != null ? JSON.stringify(fieldMeta.selectedValue) : null
              const fallbackSelectedCandidateId = !hasSelectedIdInList && selectedValueKey
                ? candidates.find((item) => JSON.stringify(item?.value) === selectedValueKey)?.id
                : null

              return candidates.map((candidate) => {
                const candidateId = candidate?.id
                const isSelected = !!candidateId && (
                  candidateId === selectedCandidateId ||
                  candidateId === fallbackSelectedCandidateId
                )
                return (
                  <div
                    key={candidateId}
                    style={{
                      border: `1px solid ${isSelected ? appThemeToken.colorPrimary : appThemeToken.colorBorder}`,
                      borderRadius: 6,
                      padding: 8,
                      background: isSelected ? appThemeToken.colorPrimaryBg : appThemeToken.colorBgContainer,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <Text style={{ fontSize: 12, fontWeight: 500 }}>{formatValue(getCandidateDisplayValue(candidate))}</Text>
                      <Button
                        type={isSelected ? 'default' : 'primary'}
                        size="small"
                        disabled={isSelected}
                        loading={selectingCandidateId === candidateId}
                        onClick={() => handleSelectCandidate(candidateId)}
                      >
                        {isSelected ? '当前值' : '采用此值'}
                      </Button>
                    </div>
                    <div style={{ marginTop: 6, fontSize: 12, color: appThemeToken.colorTextSecondary }}>
                      <div>来源文档: {candidate?.source_document_id || '—'}</div>
                      <div>页码: {candidate?.source_page ?? '—'}</div>
                      {candidate?.source_text ? <div>原文片段: {candidate.source_text}</div> : null}
                      {candidate?.confidence != null ? <div>置信度: {candidate.confidence}</div> : null}
                    </div>
                  </div>
                )
              })
            })()}
          </div>
        </div>
      )}
    </div>
  )
}

const SourceDocumentPreview = ({ documentInfo, activeCoordinates, panelWidth = 480, loading = false }) => {
  const containerRef = useRef(null)
  const imgRef = useRef(null)
  const [imageLoaded, setImageLoaded] = useState(false)
  const [imageDimensions, setImageDimensions] = useState({ width: 0, height: 0 })
  const [displayDimensions, setDisplayDimensions] = useState({ width: 0, height: 0 })
  const [scale, setScale] = useState(100)
  const [rotation, setRotation] = useState(0)
  const [imgOffset, setImgOffset] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })
  const isPdf = documentInfo?.fileType === 'pdf'
  const effectiveMaxW = Math.max(panelWidth - 32, 200)
  const [pdfPage, setPdfPage] = useState(1)
  const [pdfPageCount, setPdfPageCount] = useState(null)
  const handleImageLoad = useCallback((e) => {
    const { naturalWidth, naturalHeight } = e.target
    setImageDimensions({ width: naturalWidth, height: naturalHeight })
    const displayW = Math.min(naturalWidth, effectiveMaxW)
    const displayH = Math.round(displayW * (naturalHeight / naturalWidth))
    setDisplayDimensions({ width: displayW, height: displayH })
    setImageLoaded(true)
    setScale(100)
  }, [effectiveMaxW])
  useEffect(() => {
    if (!imageLoaded || !imageDimensions.width || !imageDimensions.height) return
    const { width: nw, height: nh } = imageDimensions
    const displayW = Math.min(nw, effectiveMaxW)
    const displayH = Math.round(displayW * (nh / nw))
    setDisplayDimensions({ width: displayW, height: displayH })
  }, [effectiveMaxW, imageLoaded, imageDimensions])
  const handleZoomIn = useCallback(() => setScale(s => Math.min(s + 25, 300)), [])
  const handleZoomOut = useCallback(() => setScale(s => Math.max(s - 25, 25)), [])
  const handleRotate = useCallback(() => setRotation(r => (r + 90) % 360), [])
  const handleReset = useCallback(() => {
    setScale(100)
    setRotation(0)
    setImgOffset({ x: 0, y: 0 })
  }, [])
  // 计算高亮坐标列表（可能为多块）
  const coordsList = Array.isArray(activeCoordinates)
    ? activeCoordinates.filter(Boolean)
    : activeCoordinates
      ? [activeCoordinates]
      : []
  const hasHighlight = coordsList.length > 0
  const highlightLocations = hasHighlight
    ? coordsList.map((c) => ({
        page: (c.pageIdx != null ? c.pageIdx : 0) + 1,
        bbox: [c.x, c.y, c.x + (c.width || 0), c.y + (c.height || 0)],
        // 优先用 8 点 polygon 精确渲染，bbox 仅作回退（旧数据可能没有 polygon）
        polygon: Array.isArray(c.polygon) && c.polygon.length >= 8 ? c.polygon : null,
        page_width: c.pageWidth || null,
        page_height: c.pageHeight || null,
      }))
    : []

  // 文档或高亮源变化时，重置当前页
  useEffect(() => {
    if (isPdf) {
      const initial = highlightLocations[0]?.page || 1
      setPdfPage(initial)
    }
  }, [isPdf, documentInfo?.fileUrl, JSON.stringify(highlightLocations)])

  const locationsForCurrentPage = highlightLocations.filter((loc) => loc.page === pdfPage)

  const handlePdfLoaded = useCallback((total) => {
    if (typeof total === 'number' && total > 0) {
      setPdfPageCount(total)
      setPdfPage((p) => Math.min(Math.max(1, p), total))
    }
  }, [])
  const renderHighlight = (opts = {}) => {
    const { baseWidth = null, baseHeight = null, requireImageLoaded = true, applyTransform = true } = opts
    if (!activeCoordinates || isPdf) {
      return null
    }
    if (requireImageLoaded && !imageLoaded) {
      return null
    }
    const coordsList = Array.isArray(activeCoordinates) ? activeCoordinates : [activeCoordinates]
    if (!coordsList.length) return null
    const { pageWidth, pageHeight } = coordsList[0] || {}
    // 用显示尺寸（displayDimensions）而不是原始尺寸，这样 SVG 才能与实际渲染的图片对齐
    const w0 = baseWidth || displayDimensions.width || imageDimensions.width
    const h0 = baseHeight || displayDimensions.height || imageDimensions.height
    if (!w0 || !h0) {
      return null
    }
    // 从 pageCoordinates (0-1000 归一化 或 原图像素) 映射到 SVG 尺寸：
    //  - 归一化：pageWidth/pageHeight = 1000，直接用
    //  - 原图像素：pageWidth/pageHeight 为空，需要用图片 naturalWidth/naturalHeight 作为底
    const pw = pageWidth || imageDimensions.width || 1000
    const ph = pageHeight || imageDimensions.height || 1000
    const scaleX = w0 / pw
    const scaleY = h0 / ph
    const svgTransform = applyTransform ? `scale(${scale / 100}) rotate(${rotation}deg)` : undefined
    return (
      <svg 
        style={{ 
          position: 'absolute', 
          top: 0, 
          left: 0, 
          width: w0, 
          height: h0, 
          ...(svgTransform ? { transform: svgTransform, transformOrigin: 'center center' } : {}),
          pointerEvents: 'none', 
          zIndex: 10 
        }} 
        viewBox={`0 0 ${w0} ${h0}`}
      >
        {coordsList.map((c, idx) => {
          if (!c) return null
          const { x, y, width: w, height: h } = c
          const rectX = x * scaleX
          const rectY = y * scaleY
          const rectW = w * scaleX
          const rectH = h * scaleY
          return (
            <rect
              key={idx}
              x={rectX}
              y={rectY}
              width={Math.max(rectW, 2)}
              height={Math.max(rectH, 2)}
              fill="none"
              stroke="#ff0000"
              strokeWidth="1"
              rx="0"
            />
          )
        })}
      </svg>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', borderBottom: '1px solid #f0f0f0', background: '#fafafa', flexShrink: 0 }}>
      <div style={{ padding: '4px 8px', background: '#fff', display: 'flex', justifyContent: 'center', gap: 2 }}>
        <Tooltip title="缩小"><Button type="text" size="small" icon={<ZoomOutOutlined />} onClick={handleZoomOut} disabled={scale <= 25} /></Tooltip>
        <Tooltip title="放大"><Button type="text" size="small" icon={<ZoomInOutlined />} onClick={handleZoomIn} disabled={scale >= 300} /></Tooltip>
        <Tooltip title="旋转"><Button type="text" size="small" icon={<RotateRightOutlined />} onClick={handleRotate} /></Tooltip>
        <Tooltip title="重置"><Button type="text" size="small" icon={<ReloadOutlined />} onClick={handleReset} /></Tooltip>
      </div>
      <div
        ref={containerRef}
        style={{
          overflow: 'hidden',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'flex-start',
          background: '#f5f5f5',
          padding: 8,
          cursor: scale > 100 ? (isDragging ? 'grabbing' : 'grab') : 'default',
          userSelect: isDragging ? 'none' : 'auto'
        }}
        onMouseDown={(e) => {
          if (scale <= 100) return
          setIsDragging(true)
          setDragStart({ x: e.clientX - imgOffset.x, y: e.clientY - imgOffset.y })
          e.preventDefault()
        }}
        onMouseMove={(e) => {
          if (!isDragging) return
          setImgOffset({
            x: e.clientX - dragStart.x,
            y: e.clientY - dragStart.y
          })
        }}
        onMouseUp={() => setIsDragging(false)}
        onMouseLeave={() => setIsDragging(false)}
      >
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 120 }}>
            <Spin size="large" tip="加载溯源文档..." />
          </div>
        ) : documentInfo?.fileUrl ? (
        isPdf ? (
          <div style={{ width: '100%', maxWidth: effectiveMaxW }}>
            <div style={{ marginBottom: 6, display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12, color: '#666' }}>
              <Space size={4}>
                <Button
                  size="small"
                  onClick={() => setPdfPage((p) => Math.max(1, p - 1))}
                  disabled={pdfPage <= 1}
                >
                  上一页
                </Button>
                <Button
                  size="small"
                  onClick={() =>
                    setPdfPage((p) =>
                      pdfPageCount ? Math.min(pdfPageCount, p + 1) : p + 1
                    )
                  }
                  disabled={pdfPageCount != null && pdfPage >= pdfPageCount}
                >
                  下一页
                </Button>
              </Space>
              <span>
                第 {pdfPage}
                {pdfPageCount ? ` / ${pdfPageCount}` : ''} 页
              </span>
            </div>
            <div
              style={{
                position: 'relative',
                display: 'inline-block',
                transform: `translate(${imgOffset.x}px, ${imgOffset.y}px) scale(${scale / 100}) rotate(${rotation}deg)`,
                transformOrigin: 'center center',
                transition: isDragging ? 'none' : 'transform 0.2s',
              }}
            >
              <PdfPageWithHighlight
                pdfUrl={documentInfo.fileUrl}
                pageNumber={pdfPage}
                locations={locationsForCurrentPage}
                maxWidth={effectiveMaxW}
                loading={false}
                bboxScale={1000}
                onLoaded={handlePdfLoaded}
              />
            </div>
          </div>
        ) : (
            <div
              style={{
                position: 'relative',
                display: 'inline-block',
                transform: `translate(${imgOffset.x}px, ${imgOffset.y}px) scale(${scale / 100}) rotate(${rotation}deg)`,
                transformOrigin: 'center center',
                transition: isDragging ? 'none' : 'transform 0.2s',
              }}
            >
              <img 
                ref={imgRef}
                src={documentInfo.fileUrl} 
                alt={documentInfo.fileName} 
                style={{ 
                  display: 'block',
                  width: displayDimensions.width || 'auto',
                  height: displayDimensions.height || 'auto',
                  maxWidth: effectiveMaxW,
                  boxShadow: '0 2px 8px rgba(0,0,0,0.1)', 
                  borderRadius: 4, 
                  opacity: imageLoaded ? 1 : 0.3,
                  pointerEvents: 'none',
                  userSelect: 'none'
                }} 
                onLoad={handleImageLoad} 
                draggable={false}
              />
              {renderHighlight({ requireImageLoaded: true, applyTransform: false })}
            </div>
          )
        ) : (
          <div style={{ textAlign: 'center', color: appThemeToken.colorTextTertiary, padding: 24 }}><FileTextOutlined style={{ fontSize: 16, marginBottom: 8 }} /><div style={{ fontSize: 12 }}>暂无文档</div></div>
        )}
      </div>
    </div>
  )
}

const SourcePanel = ({
  collapsed,
  onToggle,
  selectedField,
  width: widthProp,
  activeCoordinates = null,
  patientId = null,
  projectId = null,
  historyRefreshKey = 0,
  onRefreshHistory,
  onCandidateApplied,
  fallbackDocuments = [],
  preferredDocument = null,
  // 是否启用内容自适应布局（患者详情页 Schema 模式会传 true）
  contentAdaptive = false,
}) => {
  const width = widthProp || Math.round(window.innerWidth * 0.25)
  const { draftData } = useSchemaForm()
  const isPinned = true
  const [previewUrl, setPreviewUrl] = useState(null)
  const [previewFileType, setPreviewFileType] = useState(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [docModalOpen, setDocModalOpen] = useState(false)
  const [docModalDoc, setDocModalDoc] = useState(null)
  // 从修改历史中选中的一条记录，用于展示该条对应的文档预览与 bbox（有 source_document_id 即可溯源）
  const [selectedHistoryItem, setSelectedHistoryItem] = useState(null)
  // 标记当前是否处于"自动选中首条 revoke 记录但不触发溯源请求"的抑制状态；
  // 一旦用户主动点击「查看溯源」，即关闭抑制，允许对该记录发起文档请求。
  const [suppressAutoSourceDoc, setSuppressAutoSourceDoc] = useState(false)

  const [floatingWidth, setFloatingWidth] = useState(() => {
    const saved = localStorage.getItem('sourcePanelFloatingWidth')
    return saved ? parseInt(saved, 10) : Math.round(window.innerWidth * 0.3)
  })
  const dragRef = useRef(null)

  // 浮动模式下支持拖拽移动位置
  const [floatingPos, setFloatingPos] = useState(() => {
    const saved = localStorage.getItem('sourcePanelFloatingPos')
    if (saved) {
      try { return JSON.parse(saved) } catch { /* ignore */ }
    }
    return { x: null, y: 0 } // x=null 表示使用默认 right:0 定位
  })
  const [isDragging, setIsDragging] = useState(false)
  const dragOffsetRef = useRef({ x: 0, y: 0 })

  // 拖拽移动面板位置
  const handlePanelDragStart = useCallback((e) => {
    if (isPinned) return
    e.preventDefault()
    setIsDragging(true)
    // 获取面板当前位置
    const panelEl = dragRef.current?.closest?.('[data-source-panel]') || dragRef.current?.parentElement
    if (!panelEl) return
    const rect = panelEl.getBoundingClientRect()
    dragOffsetRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }

    const onMouseMove = (ev) => {
      ev.preventDefault()
      const newX = Math.max(0, Math.min(window.innerWidth - 200, ev.clientX - dragOffsetRef.current.x))
      const newY = Math.max(0, Math.min(window.innerHeight - 100, ev.clientY - dragOffsetRef.current.y))
      setFloatingPos({ x: newX, y: newY })
    }
    const onMouseUp = () => {
      setIsDragging(false)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = 'default'
      document.body.style.userSelect = 'auto'
      setFloatingPos(pos => { localStorage.setItem('sourcePanelFloatingPos', JSON.stringify(pos)); return pos })
    }
    document.body.style.cursor = 'move'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [isPinned])

  // 拖拽调整宽度（从左边缘拖）
  const handleWidthDragStart = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startWidth = floatingWidth
    const startPosX = floatingPos.x !== null ? floatingPos.x : (window.innerWidth - floatingWidth)
    const onMouseMove = (ev) => {
      // 拖左边缘 → 向左拖增宽
      const maxWidth = Math.round(window.innerWidth * 0.75)
      const delta = startX - ev.clientX
      const newWidth = Math.min(Math.max(startWidth + delta, 300), maxWidth)
      setFloatingWidth(newWidth)
      // 同时更新位置，使面板向左扩展
      const newPosX = Math.max(0, startPosX - (newWidth - startWidth))
      setFloatingPos(prev => ({ ...prev, x: newPosX }))
    }
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = 'default'
      document.body.style.userSelect = 'auto'
      setFloatingWidth(w => { localStorage.setItem('sourcePanelFloatingWidth', String(w)); return w })
      setFloatingPos(pos => { localStorage.setItem('sourcePanelFloatingPos', JSON.stringify(pos)); return pos })
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [floatingWidth, floatingPos.x])

  // 计算当前有效面板宽度（固定模式用 width prop，浮动模式用 floatingWidth）
  const effectivePanelWidth = isPinned ? width : floatingWidth

  // 切换字段或患者时清空"从修改历史选中的记录"，避免预览错位
  useEffect(() => {
    setSelectedHistoryItem(null)
  }, [selectedField?.path, patientId])

  // 有 patientId 时：默认展示与字段摘要均由修改历史决定；默认选"第一条"历史记录
  const handleHistoryLoaded = useCallback((historyList) => {
    if (!Array.isArray(historyList) || !patientId) return
    const firstItem = historyList[0] || null
    setSelectedHistoryItem(prev => {
      if (!firstItem) return null
      if (prev && historyList.some(h => h.id === prev.id)) return prev
      return firstItem
    })
    // 如果首条是 revoke，则默认不触发文档溯源请求，直到用户手动点击「查看溯源」
    setSuppressAutoSourceDoc(firstItem?.change_type === 'revoke')
  }, [patientId])

  // 当前字段是否为敏感字段
  const isCurrentFieldSensitive = !!(selectedField?.schema?.['x-sensitive'])
  // 数组行级点击：schema 为对象类型且路径末段是数字索引，说明用户点的是整行而非单个字段
  const isArrayRowClick = !!(
    selectedField?.path &&
    (selectedField.schema?.type === 'object' || selectedField.schema?.properties) &&
    /\.\d+$/.test(selectedField.path)
  )
  // 默认仍优先使用修改历史；科研项目模式下，如果历史缺少文档/定位信息，
  // 再回退到 _extraction_metadata 的字段审计，和电子病历夹的字段来源规则保持一致。

  // 当 displaySource 来自变更历史（new_value 为整个数组）且路径含数组下标+子字段时，
  // 从 new_value[index][subField] 提取该字段的具体值，避免显示整个数组
  const displaySubFieldValue = (() => {
    if (!selectedHistoryItem || !selectedField?.path) return undefined
    const newVal = selectedHistoryItem.new_value
    if (!Array.isArray(newVal) || newVal.length === 0) return undefined
    const mSub = /\.(\d+)\.(.+)$/.exec(selectedField.path)
    const mRow = !mSub ? /\.(\d+)$/.exec(selectedField.path) : null
    if (!mSub && !mRow) return undefined
    const idx = parseInt((mSub || mRow)[1], 10)
    if (mSub) {
      const subPath = mSub[2]
      const elem = newVal[idx]
      if (!elem || typeof elem !== 'object') return undefined
      if (!_hasNestedKey(elem, subPath)) return null
      return _getNestedValue(elem, subPath)
    }
    return newVal[idx] !== undefined ? newVal[idx] : null
  })()

  const candidateDocuments = useMemo(
    () => buildCandidateDocuments(draftData, fallbackDocuments),
    [draftData, fallbackDocuments]
  )
  const metadataAudit = useMemo(() => {
    if (!selectedField?.path || !projectId) return null
    return _resolveFieldAuditFromExtractionMetadata(draftData, selectedField.path)
  }, [draftData, projectId, selectedField?.path])

  const getSchemaSourceRules = useCallback(() => {
    const src = selectedField?.schema?.['x-sources']
    if (!src || typeof src !== 'object') return { primary: [], secondary: [] }
    const normalize = (arr) =>
      (Array.isArray(arr) ? arr : [])
        .map(v => String(v || '').trim().toLowerCase())
        .filter(Boolean)
    return {
      primary: normalize(src.primary),
      secondary: normalize(src.secondary)
    }
  }, [selectedField])

  const docMatchesSourceRule = useCallback((doc, rule) => {
    const content = [
      doc?.file_name,
      doc?.fileName,
      doc?.name,
      doc?.document_type,
      doc?.document_sub_type
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    const r = String(rule || '').trim().toLowerCase()
    if (!content || !r) return false
    if (content.includes(r)) return true
    // 兼容"出院小结/记录"这类组合来源名：拆分后任一片段命中即可
    const tokens = r
      .split(/[\/、,，\s]+/)
      .map(t => t.trim())
      .filter(t => t.length >= 2)
    return tokens.some(t => content.includes(t))
  }, [])

  // 仅保留精确溯源：无 document_id 时不再做文档猜测匹配
  const resolveFallbackDocument = useCallback(() => {
    if (!selectedField || candidateDocuments.length === 0) return null
    const sourceRules = getSchemaSourceRules()

    if (sourceRules.primary.length > 0) {
      for (const doc of candidateDocuments) {
        if (sourceRules.primary.some(rule => docMatchesSourceRule(doc, rule))) {
          return doc
        }
      }
    }
    if (sourceRules.secondary.length > 0) {
      for (const doc of candidateDocuments) {
        if (sourceRules.secondary.some(rule => docMatchesSourceRule(doc, rule))) {
          return doc
        }
      }
    }

    // schema 未命中，回退到原有策略
    if (preferredDocument?.id) {
      const matchedPreferred = candidateDocuments.find(d => String(d.id) === String(preferredDocument.id))
      if (matchedPreferred) return matchedPreferred
    }

    const pathText = String(selectedField.path || selectedField.name || '').toLowerCase()
    const pathTokens = pathText
      .split(/[./_\-\s]+/)
      .map(t => t.trim())
      .filter(Boolean)

    const scored = candidateDocuments.map((doc, idx) => {
      const content = [
        doc.file_name,
        doc.fileName,
        doc.name,
        doc.document_type,
        doc.document_sub_type
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()

      let score = 0
      for (const token of pathTokens) {
        if (token && content.includes(token)) score += 2
      }
      return { doc, score, idx }
    })

    scored.sort((a, b) => (b.score - a.score) || (a.idx - b.idx))
    return scored[0]?.doc || candidateDocuments[0]
  }, [selectedField, candidateDocuments, preferredDocument, getSchemaSourceRules, docMatchesSourceRule])

  const mergedDisplaySource = useMemo(() => {
    if (!selectedHistoryItem && !metadataAudit) return null
    if (!selectedHistoryItem) {
      const metaSourceLocation = _buildSourceLocationFromAudit(metadataAudit)
      return metaSourceLocation
        ? { ...metadataAudit, source_location: metaSourceLocation }
        : metadataAudit
    }

    if (!metadataAudit) return selectedHistoryItem

    const merged = {
      ...metadataAudit,
      ...selectedHistoryItem,
      source_document_id:
        selectedHistoryItem.source_document_id ||
        metadataAudit.source_document_id ||
        metadataAudit.document_id ||
        null,
      document_id:
        selectedHistoryItem.document_id ||
        metadataAudit.document_id ||
        selectedHistoryItem.source_document_id ||
        null,
      document_type: selectedHistoryItem.document_type || metadataAudit.document_type,
      raw: selectedHistoryItem.raw || metadataAudit.raw,
      page_idx:
        typeof selectedHistoryItem.page_idx === 'number'
          ? selectedHistoryItem.page_idx
          : metadataAudit.page_idx,
      bbox:
        selectedHistoryItem.bbox ||
        metadataAudit.bbox,
      trace_level:
        selectedHistoryItem.trace_level ||
        metadataAudit.trace_level,
    }

    if (!merged.source_location) {
      merged.source_location = _buildSourceLocationFromAudit(metadataAudit)
    }
    return merged
  }, [selectedHistoryItem, metadataAudit])

  const metadataCoordinates = useMemo(() => {
    const metaSourceLocation = _buildSourceLocationFromAudit(metadataAudit)
    return metaSourceLocation ? _sourceLocationToCoordinates(metaSourceLocation) : null
  }, [metadataAudit])

  const isHistorySourceSuppressed = !!(
    selectedHistoryItem &&
    selectedHistoryItem.change_type === 'revoke' &&
    suppressAutoSourceDoc
  )
  const historySourceDocId = isHistorySourceSuppressed
    ? null
    : (selectedHistoryItem?.source_document_id ?? null)

  const metadataSourceDocId = metadataAudit?.source_document_id || metadataAudit?.document_id || null
  const sourceDocId = isHistorySourceSuppressed
    ? null
    : (historySourceDocId || metadataSourceDocId || null)
  const fallbackDoc = !sourceDocId ? resolveFallbackDocument() : null
  const effectiveCoordinates = selectedHistoryItem
    ? (_sourceLocationToCoordinates(mergedDisplaySource?.source_location) || metadataCoordinates)
    : metadataCoordinates
  const displaySource = mergedDisplaySource
  const sourcePageIdx = Array.isArray(effectiveCoordinates)
    ? (effectiveCoordinates[0]?.pageIdx ?? 0)
    : (effectiveCoordinates?.pageIdx ?? 0)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setPreviewUrl(null)
      setPreviewFileType(null)
      if (!sourceDocId) return
      setPreviewLoading(true)
      try {
        // 先请求文档详情获取 file_type，避免为 PDF 请求 temp-url（会走 OSS）；PDF 仅用 pdf-stream 同源接口
        const detailRes = await getDocumentDetail(sourceDocId, {
          include_content: false,
          include_versions: false,
          include_patients: false,
          include_extracted: false
        })
        if (cancelled) return
        const ft = (detailRes?.data?.file_type || '').toLowerCase()
        setPreviewFileType(ft || null)
        if (ft === 'pdf') {
          setPreviewUrl(null)
        } else {
          const res = await getDocumentTempUrl(sourceDocId, 3600)
          if (cancelled) return
          const url = res?.data?.url || res?.data?.temp_url || res?.data?.data?.url
          setPreviewUrl(url || null)
        }
      } catch (e) {
        if (!cancelled) {
          setPreviewFileType(null)
          setPreviewUrl(null)
        }
      } finally {
        if (!cancelled) setPreviewLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [sourceDocId])

  if (collapsed) {
    return (
      <div style={{ width: 32, height: '100%', background: '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 12 }}>
        <Tooltip title="展开溯源面板" placement="left"><Button type="text" size="small" icon={<LeftOutlined />} onClick={onToggle} /></Tooltip>
        <div style={{ writingMode: 'vertical-rl', color: '#666', fontSize: 12, marginTop: 16 }}>文档溯源</div>
      </div>
    )
  }
  const floatingLeft = floatingPos.x !== null ? floatingPos.x : (window.innerWidth - floatingWidth)
  const floatingTop = floatingPos.y || 0
  const panelStyle = isPinned
    ? (
        contentAdaptive
          // 患者详情 Schema 模式：右侧溯源区块随页面滚动，滚到顶部后吸附在视口顶部，始终可见
          ? {
              width,
              background: '#fff',
              display: 'flex',
              flexDirection: 'column',
              position: 'sticky',
              top: 56,                 // 与 Schema 左侧树的 sticky 顶部对齐
              alignSelf: 'flex-start',
              maxHeight: 'calc(100vh - 56px)',
              overflow: 'hidden',
              zIndex: 1,
            }
          // 其他场景保持原有"占满父容器高度"的固定布局
          : {
              width,
              height: '100%',
              background: '#fff',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }
      )
    : {
        position: 'fixed',
        left: floatingLeft,
        top: floatingTop,
        width: floatingWidth,
        height: `calc(100vh - ${floatingTop}px)`,
        background: '#fff',
        borderRadius: '8px 0 0 8px',
        boxShadow: isDragging ? '0 8px 32px rgba(0, 0, 0, 0.25)' : '-4px 0 20px rgba(0, 0, 0, 0.12)',
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        transition: isDragging ? 'none' : 'box-shadow 0.3s ease'
      }
  const previewFileUrl = previewUrl && previewFileType === 'pdf'
    ? `${previewUrl}${previewUrl.includes('#') ? '&' : '#'}page=${Math.max(0, sourcePageIdx) + 1}`
    : previewUrl
  // 只要是 PDF 且有 sourceDocId，就统一走同源 pdf-stream 接口，便于 PDF.js 渲染
  const usePdfStream = previewFileType === 'pdf' && sourceDocId
  const previewDocument = {
    fileName:
      displaySource?.document_type ?? displaySource?.source_document_name ??
      (sourceDocId ? `文档 ${String(sourceDocId).slice(0, 8)}` : '文档预览'),
    fileType: previewFileType || 'image',
    fileUrl: usePdfStream ? getDocumentPdfStreamUrl(sourceDocId) : (previewFileUrl || null)
  }
  const sourceDocumentName =
    displaySource?.source_document_name ||
    displaySource?.document_name ||
    displaySource?.file_name ||
    displaySource?.fileName ||
    (sourceDocId && fallbackDoc ? formatDocumentName(fallbackDoc) : '')
  return (
    <div style={panelStyle} data-source-panel>
      <div style={{ height: 41, padding: '0 12px', borderBottom: '1px solid #f0f0f0', background: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', minWidth: 0, flex: 1, marginRight: 8 }}>
          <Space size={6} style={{ minWidth: 0 }}>
            <FileTextOutlined style={{ color: '#1890ff' }} />
            <Text strong style={{ fontSize: 14, flexShrink: 0 }}>文档溯源</Text>
            {sourceDocumentName ? (
              <Tooltip title={sourceDocumentName}>
                <Text
                  type="secondary"
                  style={{
                    fontSize: 12,
                    maxWidth: 180,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    display: 'inline-block'
                  }}
                >
                  {sourceDocumentName}
                </Text>
              </Tooltip>
            ) : null}
          </Space>
        </div>
        <Space size={4} style={{ flexShrink: 0 }}>
          {sourceDocId && (
            <Tooltip title="查看原文档">
              <Button
                type="text"
                size="small"
                icon={<EyeOutlined />}
                loading={previewLoading}
                style={HEADER_ICON_BUTTON_STYLE}
                onClick={() => {
                  setDocModalDoc({
                    id: sourceDocId,
                    fileName: previewDocument.fileName
                  })
                  setDocModalOpen(true)
                }}
              />
            </Tooltip>
          )}
          <Tooltip title="收起面板">
            <Button
              type="text"
              size="small"
              aria-label="收起文档溯源面板"
              icon={<RightOutlined />}
              onClick={onToggle}
              style={HEADER_ICON_BUTTON_STYLE}
            />
          </Tooltip>
        </Space>
      </div>
      <div className="schema-form-scrollable hover-scrollbar scroll-edge-hint" style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
        <SourceDocumentPreview documentInfo={previewDocument} activeCoordinates={effectiveCoordinates} panelWidth={effectivePanelWidth} loading={previewLoading} />
        <div style={{ padding: 12 }}>
          {selectedField ? (
            <>
              <ModificationHistory
                fieldPath={selectedField.path}
                rowUid={selectedField.rowUid}
                patientId={patientId}
                projectId={projectId}
                refreshKey={historyRefreshKey}
                onCandidateApplied={(appliedPath, appliedValue, appliedRowUid, appliedCandidate) => {
                  if (appliedCandidate?.source_document_id) {
                    setSuppressAutoSourceDoc(false)
                    setSelectedHistoryItem({
                      id: appliedCandidate.id,
                      field_path: appliedPath,
                      matched_field_path: appliedCandidate.field_path || appliedPath,
                      new_value: appliedValue,
                      change_type: appliedCandidate.created_by === 'ai' ? 'extract' : 'manual_edit',
                      change_type_display: appliedCandidate.created_by === 'ai' ? 'AI 抽取' : '手动修改',
                      operator_type: appliedCandidate.created_by || null,
                      operator_name: appliedCandidate.created_by === 'ai' ? 'AI系统' : '用户',
                      source_document_id: appliedCandidate.source_document_id || null,
                      source_document_name: appliedCandidate.source_document_name || null,
                      source_page: appliedCandidate.source_page ?? null,
                      source_location: appliedCandidate.source_location || null,
                      source_text: appliedCandidate.source_text || null,
                      confidence: appliedCandidate.confidence ?? null,
                      created_at: appliedCandidate.created_at || null,
                    })
                  }
                  onCandidateApplied?.(appliedPath, appliedValue, appliedRowUid, appliedCandidate)
                }}
                // 用户主动点击「查看溯源」时，允许对当前记录发起文档请求（包括 revoke 记录）
                onViewSource={
                  patientId
                    ? (item) => {
                        setSuppressAutoSourceDoc(false)
                        setSelectedHistoryItem(item)
                      }
                    : undefined
                }
                onHistoryLoaded={patientId ? handleHistoryLoaded : undefined}
                isSensitive={isCurrentFieldSensitive}
              />
            </>
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<Text type="secondary" style={{ fontSize: 12 }}>点击表单中的字段卡片<br />查看数据来源</Text>} />
          )}
        </div>
      </div>
      {docModalDoc && (
        <DocumentDetailModal
          visible={docModalOpen}
          document={docModalDoc}
          onClose={() => {
            setDocModalOpen(false)
            setDocModalDoc(null)
          }}
        />
      )}
    </div>
  )
}

const RIGHT_PANEL_WIDTH_KEY = 'schemaFormRightPanelWidth'
const LEFT_PANEL_WIDTH_KEY = 'schemaFormLeftPanelWidth'
const LEGACY_MIDDLE_PANEL_WIDTH_KEY = 'schemaFormMiddlePanelWidth'
const DEFAULT_LEFT_PANEL_WIDTH = 240
const MIN_RIGHT_PANEL_WIDTH = 240
const MIN_LEFT_PANEL_WIDTH = 180
const FALLBACK_VIEWPORT_WIDTH = 1440
/**
 * 获取当前视口宽度（用于动态计算分栏宽度边界）。
 * @returns {number}
 */
const getViewportWidth = () => (typeof window !== 'undefined' ? window.innerWidth : FALLBACK_VIEWPORT_WIDTH)
/**
 * 读取本地存储，失败时返回 null（兼容隐私模式或受限环境）。
 * @param {string} key
 * @returns {string|null}
 */
const safeStorageGet = (key) => {
  if (typeof window === 'undefined') return null
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
/**
 * 写入本地存储，失败时静默忽略，避免交互中断。
 * @param {string} key
 * @param {string} value
 */
const safeStorageSet = (key, value) => {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(key, value)
  } catch {
    // ignore storage write errors
  }
}
/**
 * 删除本地存储键，失败时静默忽略。
 * @param {string} key
 */
const safeStorageRemove = (key) => {
  if (typeof window === 'undefined') return
  try {
    localStorage.removeItem(key)
  } catch {
    // ignore storage remove errors
  }
}
/**
 * 计算右侧溯源栏默认宽度。
 * @returns {number}
 */
const getDefaultRightPanelWidth = () => Math.round(getViewportWidth() * 0.25)
/**
 * 计算左栏最大宽度（随视口动态变化）。
 * @returns {number}
 */
const getMaxLeftPanelWidth = () => Math.round(getViewportWidth() * 0.38)
/**
 * 计算右栏最大宽度（随视口动态变化）。
 * @returns {number}
 */
const getMaxRightPanelWidth = () => Math.round(getViewportWidth() * 0.4)
/**
 * 约束左栏宽度到合法区间。
 * @param {number} width
 * @returns {number}
 */
const clampLeftPanelWidth = (width) => Math.min(getMaxLeftPanelWidth(), Math.max(MIN_LEFT_PANEL_WIDTH, width))
/**
 * 约束右栏宽度到合法区间。
 * @param {number} width
 * @returns {number}
 */
const clampRightPanelWidth = (width) => Math.min(getMaxRightPanelWidth(), Math.max(MIN_RIGHT_PANEL_WIDTH, width))
const HEADER_ICON_BUTTON_STYLE = {
  width: 24,
  minWidth: 24,
  height: 24,
  padding: 0,
  borderRadius: 6,
  border: '1px solid #d9e1ea',
  color: '#5f6b7a'
}
const COLUMN_RESIZE_BAR_STYLE = {
  width: 6,
  flexShrink: 0,
  cursor: 'col-resize',
  background: 'transparent',
  alignSelf: 'stretch'
}
/**
 * 三栏主容器统一分隔线样式（通过绝对定位覆盖全高）。
 * @type {import('react').CSSProperties}
 */
const DIVIDER_LINE_STYLE = {
  position: 'absolute',
  top: 0,
  bottom: 0,
  width: 1,
  background: '#f0f0f0',
  pointerEvents: 'none',
  zIndex: 4
}
const SchemaFormInner = ({ onSave, onReset, onDataChange, onFieldCandidateSolidified, externalHistoryRefreshKey = 0, autoSaveInterval = 30000, siderWidth = 220, sourcePanelWidth, collapsible = true, showSourcePanel = true, projectMode = false, projectConfig = null, projectId = null, patientId = null, contentAdaptive = false, leftHeader = null, collapsedTitle = '目录', beforeUploadActions = null }) => {
  const { state, actions, draftData, patientData, isDirty } = useSchemaForm()
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [rightCollapsed, setRightCollapsed] = useState(true)
  const [saving, setSaving] = useState(false)
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(true)
  const [selectedField, setSelectedField] = useState(null)
  const [activeCoordinates, setActiveCoordinates] = useState(null)
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false)
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0) // 用于触发修改历史刷新
  const leaveResolveRef = useRef(null)
  const pendingPathRef = useRef(null)
  const [leftPanelWidth, setLeftPanelWidth] = useState(() => {
    const saved = safeStorageGet(LEFT_PANEL_WIDTH_KEY)
    if (saved) {
      const n = parseInt(saved, 10)
      if (!Number.isNaN(n)) return clampLeftPanelWidth(n)
    }
    return clampLeftPanelWidth(siderWidth || DEFAULT_LEFT_PANEL_WIDTH)
  })
  // 右侧文档溯源面板宽度（可拖拽调整）
  const [rightPanelWidth, setRightPanelWidth] = useState(() => {
    const saved = safeStorageGet(RIGHT_PANEL_WIDTH_KEY)
    if (saved) {
      const n = parseInt(saved, 10)
      if (!Number.isNaN(n)) return clampRightPanelWidth(n)
    }
    return clampRightPanelWidth(sourcePanelWidth ?? getDefaultRightPanelWidth())
  })
  const rightPanelResizeStart = useRef({ x: 0, w: 0 })
  const rightPanelLastWidthRef = useRef(rightPanelWidth)
  const leftPanelLastWidthRef = useRef(leftPanelWidth)
  const leftPanelResizeStart = useRef({ x: 0, w: 0 })
  const [selectedExtractDocId, setSelectedExtractDocId] = useState(null)
  const [extractConfirming, setExtractConfirming] = useState(false)
  const [uploadExtractModalOpen, setUploadExtractModalOpen] = useState(false)
  const [uploadExtractTab, setUploadExtractTab] = useState('existing') // 'existing' | 'upload'
  const uploadFileInputRef = useRef(null)
  const [isLeftPanelResizing, setIsLeftPanelResizing] = useState(false)
  const [isRightPanelResizing, setIsRightPanelResizing] = useState(false)
  const mergedHistoryRefreshKey = historyRefreshKey + Number(externalHistoryRefreshKey || 0)
  const handleLeftPanelResizeStart = useCallback((e) => {
    if (leftCollapsed) return
    e.preventDefault()
    setIsLeftPanelResizing(true)
    leftPanelResizeStart.current = { x: e.clientX, w: leftPanelWidth }
    const onMouseMove = (ev) => {
      const delta = ev.clientX - leftPanelResizeStart.current.x
      const newW = clampLeftPanelWidth(leftPanelResizeStart.current.w + delta)
      leftPanelLastWidthRef.current = newW
      setLeftPanelWidth(newW)
    }
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setIsLeftPanelResizing(false)
      safeStorageSet(LEFT_PANEL_WIDTH_KEY, String(leftPanelLastWidthRef.current))
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [leftCollapsed, leftPanelWidth])
  const handleRightPanelResizeStart = useCallback((e) => {
    e.preventDefault()
    setIsRightPanelResizing(true)
    rightPanelResizeStart.current = { x: e.clientX, w: rightPanelWidth }
    const onMouseMove = (ev) => {
      const delta = ev.clientX - rightPanelResizeStart.current.x
      const newW = clampRightPanelWidth(rightPanelResizeStart.current.w - delta)
      rightPanelLastWidthRef.current = newW
      setRightPanelWidth(newW)
    }
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setIsRightPanelResizing(false)
      safeStorageSet(RIGHT_PANEL_WIDTH_KEY, String(rightPanelLastWidthRef.current))
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [rightPanelWidth])
  const { documents: projectDocuments = [], selectedDocument = null, onDocumentSelect, onUploadDocument, onAddRepeatableInstance, repeatableNamingPattern = '{formName}_{index}' } = projectConfig || {}
  // CRF 服务 _parse_form_path 用 " / " 分隔路径（如 "治疗情况 / 手术治疗"）
  const targetSection = useMemo(() => {
    if (!state?.selectedPath) return null
    const parts = state.selectedPath.split('.')
    return parts.slice(0, Math.min(parts.length, 2)).join(' / ')
  }, [state?.selectedPath])
  const extractCandidateDocuments = useMemo(
    () => buildCandidateDocuments(draftData, projectDocuments),
    [draftData, projectDocuments]
  )
  const selectedExtractDocument = useMemo(
    () => extractCandidateDocuments.find((doc) => String(doc?.id) === String(selectedExtractDocId)) || null,
    [extractCandidateDocuments, selectedExtractDocId]
  )
  const handleOpenUploadExtractModal = useCallback((tab = 'existing') => {
    setUploadExtractTab(tab)
    setUploadExtractModalOpen(true)
  }, [])
  const handleCloseUploadExtractModal = useCallback(() => {
    setUploadExtractModalOpen(false)
  }, [])
  const handleConfirmExtract = useCallback(async () => {
    if (!patientId) {
      message.warning('缺少患者信息，暂无法执行文档抽取')
      return
    }
    if (!targetSection) {
      message.warning('请先在左侧选择目标字段组')
      return
    }
    if (!selectedExtractDocument) {
      message.warning('请先选择一个现有文档')
      return
    }
    setExtractConfirming(true)
    try {
      const response = await extractEhrDataTargeted(
        String(selectedExtractDocument.id),
        patientId,
        targetSection,
        projectId ? { projectId, instanceType: 'project_crf' } : {}
      )
      if (response.success) {
        message.success('文档抽取任务已提交，请稍候...')
        setUploadExtractModalOpen(false)
        onDataChange && onDataChange(draftData)
      } else {
        message.error(response.message || '抽取失败')
      }
    } catch (err) {
      message.error('抽取失败: ' + (err.message || '未知错误'))
    } finally {
      setExtractConfirming(false)
    }
  }, [patientId, projectId, targetSection, selectedExtractDocument])
  const handleUploadExtractFile = useCallback(async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = '' // reset input so same file can be re-selected

    const supportedTypes = ['application/pdf', 'image/jpg', 'image/jpeg', 'image/png']
    if (!supportedTypes.includes(file.type)) {
      message.error('不支持的文件格式，请上传 PDF、JPG、JPEG 或 PNG 文件')
      return
    }
    if (file.size > 50 * 1024 * 1024) {
      message.error('文件超过 50MB 限制')
      return
    }
    if (!patientId) {
      message.error('缺少患者信息，无法上传')
      return
    }
    if (!targetSection) {
      message.error('请先在左侧目录中选择目标字段组，再进行文档抽取')
      return
    }

    message.loading({ content: '正在上传文件并触发 OCR 流水线...', key: 'uploadExtract' })
      const uploadResult = await uploadAndArchiveAsync(file, patientId, {
        targetSection,
        projectId,
        autoMergeEhr: true,
        parserType: 'textin',
      })
      if (!uploadResult?.success) {
        message.error({ content: uploadResult?.message || '文件上传失败', key: 'uploadExtract' })
        return
      }
      const docId = uploadResult.data?.document_id || uploadResult.data?.id
      if (!docId) {
        message.error({ content: '上传响应中缺少文档 ID', key: 'uploadExtract' })
        return
      }
      // 轮询 OCR 完成状态（最多 60s），再触发 EHR 抽取
      message.loading({ content: '等待 OCR 解析完成...', key: 'uploadExtract' })
      let ocrDone = false
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 2000))
        try {
          const detail = await getDocumentDetail(docId)
          const doc = detail?.data
          if (
            doc &&
            (doc.status === 'ocr_succeeded' || doc.status === 'archived' || doc.raw_text || doc.ocr_payload)
          ) {
            ocrDone = true
            break
          }
        } catch (_) { /* 继续轮询 */ }
      }
      if (!ocrDone) {
        message.error({ content: 'OCR 解析超时，请稍后重试', key: 'uploadExtract' })
        return
      }
      message.loading({ content: '上传成功，正在提交抽取任务...', key: 'uploadExtract' })
      const extractResult = await extractEhrDataTargeted(
        String(docId),
        patientId,
        targetSection,
        projectId ? { projectId, instanceType: 'project_crf' } : {}
      )
      if (extractResult.success) {
        message.success({ content: '文件上传成功，抽取任务已提交，请稍候...', key: 'uploadExtract' })
        setUploadExtractModalOpen(false)
        onDataChange && onDataChange(draftData)
      } else {
        message.error({ content: extractResult.message || '抽取任务提交失败', key: 'uploadExtract' })
      }
  }, [patientId, projectId, targetSection])
  const handleSave = useCallback(async (type = 'manual') => {
    if (!isDirty && type === 'manual') { message.info('没有需要保存的修改'); return }
    setSaving(true)
    try {
      if (onSave) await onSave(draftData, type)
      actions.markSaved()
      setHistoryRefreshKey(k => k + 1) // 保存成功后触发历史刷新
      if (type === 'manual') message.success('保存成功')
      else message.info('自动保存成功', 1)
    } catch (error) { message.error('保存失败: ' + (error.message || '未知错误')) }
    finally { setSaving(false) }
  }, [isDirty, draftData, onSave, actions])
  const handleReset = useCallback(() => {
    Modal.confirm({ title: '确认重置', icon: <ExclamationCircleOutlined />, content: '重置后将丢失所有未保存的修改，确定要重置吗？', okText: '确定重置', cancelText: '取消', okButtonProps: { danger: true }, onOk: () => { actions.setPatientData(patientData); if (onReset) onReset(); message.success('已重置为原始数据') } })
  }, [patientData, actions, onReset])
  // 切换左侧目录前确认：有未保存修改时弹窗，返回 Promise<boolean>
  const onBeforeSelect = useCallback((nextPath) => {
    if (!isDirty) return Promise.resolve(true)
    pendingPathRef.current = nextPath
    setLeaveConfirmOpen(true)
    return new Promise((resolve) => {
      leaveResolveRef.current = resolve
    })
  }, [isDirty])
  // 清空其他表单前确认：有未保存修改时同「切换表单」逻辑（保存/不保存/取消）
  const onBeforeClearForm = useCallback(() => {
    if (!isDirty) return Promise.resolve(true)
    setLeaveConfirmOpen(true)
    return new Promise((resolve) => {
      leaveResolveRef.current = resolve
    })
  }, [isDirty])
  const handleLeaveConfirmSave = useCallback(async () => {
    setSaving(true)
    try {
      if (onSave) await onSave(draftData, 'manual')
      actions.markSaved()
      setHistoryRefreshKey(k => k + 1) // 保存成功后触发历史刷新
      message.success('保存成功')
      leaveResolveRef.current?.(true)
      leaveResolveRef.current = null
      setLeaveConfirmOpen(false)
      pendingPathRef.current = null
    } catch (error) {
      message.error('保存失败: ' + (error.message || '未知错误'))
    } finally {
      setSaving(false)
    }
  }, [draftData, onSave, actions])
  const handleLeaveConfirmDiscard = useCallback(() => {
    actions.setPatientData(patientData)
    leaveResolveRef.current?.(true)
    leaveResolveRef.current = null
    setLeaveConfirmOpen(false)
    pendingPathRef.current = null
  }, [patientData, actions])
  const handleLeaveConfirmCancel = useCallback(() => {
    leaveResolveRef.current?.(false)
    leaveResolveRef.current = null
    setLeaveConfirmOpen(false)
    pendingPathRef.current = null
  }, [])
  /** 删除可重复记录后立即调接口保存（无需再点保存） */
  const persistDataAfterChange = useCallback(async (data) => {
    setSaving(true)
    try {
      if (onSave) await onSave(data, 'manual')
      actions.setPatientData(data)
    } finally {
      setSaving(false)
    }
  }, [onSave, actions])
  /**
   * 处理中间表单字段选择与溯源图标点击。
   *
   * @param {string} path 字段路径。
   * @param {Record<string, any>} schema 字段 schema。
   * @param {string} [name] 字段名称。
   * @param {{ forceOpen?: boolean, trigger?: string }} [options] 触发选项。
   * @returns {void}
   */
  const handleFieldSourceClick = useCallback((path, schema, name, options = {}) => {
    /**
     * 根据字段路径回溯重复行 row_uid。
     * @param {Record<string, any>} sourceData
     * @param {string} sourcePath
     * @returns {string|null}
     */
    const resolveRowUidByPath = (sourceData, sourcePath) => {
      const parts = String(sourcePath || '').split('.').filter(Boolean)
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
    }
    const inferredRowUid = String(options?.rowUid || '').trim() || resolveRowUidByPath(draftData, path)
    setSelectedField({ path, schema, name, rowUid: inferredRowUid || null })
    // 溯源完全由 ehr-v2/history 接口驱动，不再使用抽取 audit 的 bbox 定位；高亮仅在用户从修改历史选择一条后由 source_location.position 提供
    setActiveCoordinates(null)
    if (options.forceOpen && rightCollapsed) setRightCollapsed(false)
  }, [draftData, rightCollapsed])
  /**
   * 候选值固化成功后，将值同步回当前表单草稿与已保存快照，避免中间栏展示滞后。
   *
   * @param {string} fieldPath 字段路径。
   * @param {any} value 固化后的字段值。
   * @returns {void}
   */
  const handleCandidateApplied = useCallback((fieldPath, value, rowUid = null) => {
    if (!fieldPath) return
    actions.applyPersistedFieldValue(fieldPath, value, rowUid)
    setHistoryRefreshKey((tick) => tick + 1)
    if (!isDirty && projectMode && typeof onFieldCandidateSolidified === 'function') {
      Promise.resolve(onFieldCandidateSolidified({ fieldPath, value })).catch((error) => {
        console.error('[SchemaForm] onFieldCandidateSolidified failed:', error)
      })
    }
  }, [actions, isDirty, onFieldCandidateSolidified, projectMode])
  const leftColumnWidth = leftCollapsed ? 52 : leftPanelWidth
  const leftDividerOffset = leftColumnWidth + (leftCollapsed ? 0 : COLUMN_RESIZE_BAR_STYLE.width)
  const rightDividerOffset = rightCollapsed ? 32 : rightPanelWidth
  useAutoSave(autoSaveEnabled, autoSaveInterval, handleSave)
  useEffect(() => {
    // 清理历史遗留的中间栏固定宽，确保中间栏始终按剩余空间自适应。
    safeStorageRemove(LEGACY_MIDDLE_PANEL_WIDTH_KEY)
  }, [])
  useEffect(() => {
    const handleBeforeUnload = (e) => { if (isDirty) { e.preventDefault(); e.returnValue = '' } }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [isDirty])
  return (
    <div style={{
      height: contentAdaptive ? 'auto' : '100%',
      minHeight: contentAdaptive ? 500 : undefined,
      display: 'flex',
      flexDirection: 'column',
      background: '#fff',
      borderRadius: 0,
      overflow: contentAdaptive ? 'visible' : 'hidden'
    }}>
      {/* Toolbar moved to CategoryTree bottom */}
      <Modal
        title="当前修改尚未保存"
        open={leaveConfirmOpen}
        onCancel={handleLeaveConfirmCancel}
        footer={[
          <Button key="cancel" onClick={handleLeaveConfirmCancel}>取消</Button>,
          <Button key="discard" onClick={handleLeaveConfirmDiscard}>不保存</Button>,
          <Button key="save" type="primary" loading={saving} onClick={handleLeaveConfirmSave} icon={<SaveOutlined />}>保存</Button>
        ]}
      >
        <p>当前修改尚未保存。请选择：保存、不保存离开，或取消。</p>
      </Modal>
      <Modal
        title="文档抽取"
        open={uploadExtractModalOpen}
        onCancel={handleCloseUploadExtractModal}
        footer={null}
        width={720}
      >
        <div style={{ marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Text type="secondary">当前字段组：</Text>
          <Tag color={targetSection ? 'blue' : 'default'}>{targetSection || '未选择'}</Tag>
          <Text type="secondary">患者ID：{patientId || '-'}</Text>
          {projectId && <Text type="secondary">项目ID：{projectId}</Text>}
        </div>
        <Tabs
          activeKey={uploadExtractTab}
          onChange={(key) => {
            setUploadExtractTab(key)
            if (key === 'upload') {
              // Trigger file input click for upload tab
              uploadFileInputRef.current?.click()
            }
          }}
          items={[
            {
              key: 'existing',
              label: '从现有文档抽取',
              children: (
                <>
                  {!targetSection && (
                    <div style={{ marginBottom: 12, padding: '8px 12px', borderRadius: 6, background: '#fffbe6', border: '1px solid #ffe58f', color: '#ad6800' }}>
                      请先在左侧目录中选择目标表单，再进行文档抽取。
                    </div>
                  )}
                  {extractCandidateDocuments.length === 0 ? (
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description="该患者暂无关联文档"
                      style={{ margin: '28px 0' }}
                    />
                  ) : (
                    <div className="schema-form-scrollable hover-scrollbar" style={{ maxHeight: 300, overflowY: 'auto', border: '1px solid #f0f0f0', borderRadius: 8 }}>
                      {extractCandidateDocuments.map((doc) => {
                        const docId = String(doc?.id ?? '')
                        const active = String(selectedExtractDocId) === docId
                        return (
                          <button
                            key={docId || `${getDocumentDisplayName(doc)}_${formatDocumentUploadedAt(doc)}`}
                            type="button"
                            onClick={() => setSelectedExtractDocId(docId)}
                            style={{
                              width: '100%',
                              textAlign: 'left',
                              border: 'none',
                              borderBottom: '1px solid #f5f5f5',
                              background: active ? '#e6f7ff' : '#fff',
                              padding: '10px 12px',
                              cursor: 'pointer'
                            }}
                          >
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                              <Text strong style={{ color: active ? '#1677ff' : '#1f1f1f' }}>{getDocumentDisplayName(doc)}</Text>
                              <Text type="secondary" style={{ whiteSpace: 'nowrap' }}>{formatDocumentUploadedAt(doc)}</Text>
                            </div>
                            <Text type="secondary" style={{ fontSize: 12 }}>{getDocumentTypeLabel(doc)}</Text>
                          </button>
                        )
                      })}
                    </div>
                  )}
                  <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
                    <Button
                      type="primary"
                      disabled={extractConfirming || !patientId || !targetSection || !selectedExtractDocument}
                      loading={extractConfirming}
                      onClick={handleConfirmExtract}
                    >
                      确认抽取
                    </Button>
                  </div>
                </>
              )
            },
            {
              key: 'upload',
              label: '上传新文档并抽取',
              children: (
                <div style={{ padding: '16px 0', textAlign: 'center' }}>
                  <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
                    点击下方按钮选择文件上传，上传完成后将自动进行文档抽取
                  </Text>
                  <Button
                    type="primary"
                    icon={<UploadOutlined />}
                    onClick={() => uploadFileInputRef.current?.click()}
                    style={{ marginBottom: 8 }}
                  >
                    选择文件
                  </Button>
                  <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                    支持 PDF、JPG、JPEG、PNG，单个文件最大 50MB
                  </Text>
                  <input
                    ref={uploadFileInputRef}
                    type="file"
                    style={{ display: 'none' }}
                    accept=".pdf,.jpg,.jpeg,.png"
                    onChange={handleUploadExtractFile}
                  />
                </div>
              )
            }
          ]}
        />
      </Modal>
      <div style={{ flex: contentAdaptive ? 'none' : 1, minHeight: contentAdaptive ? 500 : 0, display: 'flex', overflow: contentAdaptive ? 'visible' : 'hidden', background: '#fff', position: 'relative', alignItems: contentAdaptive ? 'flex-start' : 'stretch' }}>
        <div style={{ ...DIVIDER_LINE_STYLE, left: leftDividerOffset }} />
        {showSourcePanel && <div style={{ ...DIVIDER_LINE_STYLE, left: `calc(100% - ${rightDividerOffset}px)` }} />}
        <div style={{
          width: leftColumnWidth,
          transition: 'width 0.2s',
          overflow: 'hidden',
          padding: 0,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          ...(contentAdaptive ? { position: 'sticky', top: 56, alignSelf: 'flex-start', zIndex: 2 } : {})
        }}>
          <div style={{
            height: contentAdaptive ? 'auto' : '100%',
            minHeight: contentAdaptive ? 0 : 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            flex: contentAdaptive ? 'none' : 1
          }}>
            {contentAdaptive && leftHeader && !leftCollapsed && <div style={{ flexShrink: 0, padding: '0 8px' }}>{leftHeader}</div>}
            <div style={{ flex: contentAdaptive ? 'none' : 1, minHeight: contentAdaptive ? 0 : 0, overflowX: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <CategoryTree
                defaultExpandAll
                style={{ height: contentAdaptive ? 'auto' : '100%' }}
                onBeforeSelect={onBeforeSelect}
                onBeforeClearForm={onBeforeClearForm}
                onPersistAfterChange={persistDataAfterChange}
                projectMode={projectMode}
                projectDocuments={projectDocuments}
                selectedDocument={selectedDocument}
                onDocumentSelect={onDocumentSelect}
                onUploadDocument={onUploadDocument}
                onAddRepeatableInstance={onAddRepeatableInstance}
                repeatableNamingPattern={repeatableNamingPattern}
                patientId={patientId}
                collapsed={leftCollapsed}
                onToggleCollapse={() => setLeftCollapsed(!leftCollapsed)}
                collapsible={collapsible}
                collapsedTitle={collapsedTitle}
              />
            </div>
          </div>
        </div>
        {!leftCollapsed && (
          <SplitterHandle
            axis="vertical"
            thickness={COLUMN_RESIZE_BAR_STYLE.width}
            isActive={isLeftPanelResizing}
            showOnHover
            onMouseDown={handleLeftPanelResizeStart}
            style={{ alignSelf: 'stretch' }}
            ariaLabel="拖动调整目录栏宽度"
          />
        )}
        <div
          style={{
            flex: 1,
            overflow: contentAdaptive ? 'visible' : 'hidden',
            minWidth: 0
          }}
        >
          <FormPanel
            style={{ height: contentAdaptive ? 'auto' : '100%' }}
            onFieldSelect={handleFieldSourceClick}
            toolbarProps={{
              onSave: handleSave,
              onReset: handleReset,
              saving,
              autoSaveEnabled,
              onToggleAutoSave: () => setAutoSaveEnabled(!autoSaveEnabled),
              isDirty
            }}
            onUploadDocument={() => handleOpenUploadExtractModal('existing')}
            beforeUploadActions={beforeUploadActions}
          />
        </div>
        {showSourcePanel && (
          <>
            {!rightCollapsed && (
              <SplitterHandle
                axis="vertical"
                thickness={COLUMN_RESIZE_BAR_STYLE.width}
                isActive={isRightPanelResizing}
                showOnHover
                onMouseDown={handleRightPanelResizeStart}
                style={{ alignSelf: 'stretch', marginLeft: 2 }}
                ariaLabel="拖动调整文档溯源面板宽度"
              />
            )}
            <SourcePanel
              collapsed={rightCollapsed}
              onToggle={() => setRightCollapsed(!rightCollapsed)}
              selectedField={selectedField}
              width={rightPanelWidth}
              activeCoordinates={activeCoordinates}
              patientId={patientId}
              projectId={projectId}
              historyRefreshKey={mergedHistoryRefreshKey}
              onRefreshHistory={() => setHistoryRefreshKey(k => k + 1)}
              onCandidateApplied={handleCandidateApplied}
              fallbackDocuments={projectDocuments}
              preferredDocument={selectedDocument}
              contentAdaptive={contentAdaptive}
            />
          </>
        )}
      </div>
    </div>
  )
}

const SchemaForm = ({ schema, enums = {}, patientData, patientId, projectId, onSave, onReset, onDataChange, onFieldCandidateSolidified, externalHistoryRefreshKey = 0, loading = false, autoSaveInterval = 30000, siderWidth = 220, sourcePanelWidth, collapsible = true, showSourcePanel = true, projectMode = false, projectConfig = null, contentAdaptive = false, leftHeader = null, collapsedTitle = '目录', style, onUploadDocument = null, beforeUploadActions = null }) => {
  const resolvedPatientId = patientId || patientData?.id || patientData?.patient_id || null
  
  if (loading) return <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', ...style }}><Spin tip="加载中..." size="large" /></div>
  if (!schema) return <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#999', ...style }}>请提供Schema配置</div>
  return (
    <div style={{ height: contentAdaptive ? 'auto' : '100%', ...style }}>
      <SchemaFormProvider schema={schema} enums={enums} patientData={patientData}>
        <SchemaFormInner onSave={onSave} onReset={onReset} onDataChange={onDataChange} onFieldCandidateSolidified={onFieldCandidateSolidified} externalHistoryRefreshKey={externalHistoryRefreshKey} autoSaveInterval={autoSaveInterval} siderWidth={siderWidth} sourcePanelWidth={sourcePanelWidth} collapsible={collapsible} showSourcePanel={showSourcePanel} projectMode={projectMode} projectConfig={projectConfig} projectId={projectId} patientId={resolvedPatientId} contentAdaptive={contentAdaptive} leftHeader={leftHeader} collapsedTitle={collapsedTitle} beforeUploadActions={beforeUploadActions} />
      </SchemaFormProvider>
    </div>
  )
}

export default SchemaForm
