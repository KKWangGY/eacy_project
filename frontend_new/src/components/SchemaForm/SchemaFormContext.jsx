/**
 * Schema表单上下文
 * 管理Schema、患者数据、编辑状态等全局状态
 */
import React, { createContext, useContext, useReducer, useCallback, useMemo } from 'react'

// 初始状态
const initialState = {
  // Schema相关
  schema: null,
  enums: {},
  
  // 数据相关
  patientData: null,
  draftData: null, // 草稿数据（暂存）
  
  // UI状态
  selectedPath: null, // 当前选中的路径，如 "基本信息.人口学情况.身份信息"
  expandedKeys: [],
  
  // 编辑状态
  editingFieldId: null,
  editingValue: null,
  
  // 保存状态
  isDirty: false,
  lastSavedAt: null,
  autoSaveEnabled: true
}

// Action类型
const ActionTypes = {
  SET_SCHEMA: 'SET_SCHEMA',
  SET_PATIENT_DATA: 'SET_PATIENT_DATA',
  SET_DRAFT_DATA: 'SET_DRAFT_DATA',
  UPDATE_FIELD_VALUE: 'UPDATE_FIELD_VALUE',
  APPLY_PERSISTED_FIELD_VALUE: 'APPLY_PERSISTED_FIELD_VALUE',
  SET_SELECTED_PATH: 'SET_SELECTED_PATH',
  SET_EXPANDED_KEYS: 'SET_EXPANDED_KEYS',
  SET_EDITING_FIELD: 'SET_EDITING_FIELD',
  CLEAR_EDITING: 'CLEAR_EDITING',
  MARK_SAVED: 'MARK_SAVED',
  MARK_DIRTY: 'MARK_DIRTY',
  ADD_REPEATABLE_ITEM: 'ADD_REPEATABLE_ITEM',
  REMOVE_REPEATABLE_ITEM: 'REMOVE_REPEATABLE_ITEM'
}

// Reducer
function schemaFormReducer(state, action) {
  switch (action.type) {
    case ActionTypes.SET_SCHEMA:
      return {
        ...state,
        schema: action.payload.schema,
        enums: action.payload.enums || {}
      }
    
    case ActionTypes.SET_PATIENT_DATA:
      return {
        ...state,
        patientData: action.payload,
        draftData: JSON.parse(JSON.stringify(action.payload)), // 深拷贝作为草稿
        isDirty: false
      }
    
    case ActionTypes.SET_DRAFT_DATA:
      return {
        ...state,
        draftData: action.payload,
        isDirty: true
      }
    
    case ActionTypes.UPDATE_FIELD_VALUE: {
      const { path, value } = action.payload
      const newDraftData = JSON.parse(JSON.stringify(state.draftData || {}))
      setNestedValue(newDraftData, path, value)
      return {
        ...state,
        draftData: newDraftData,
        isDirty: true
      }
    }

    case ActionTypes.APPLY_PERSISTED_FIELD_VALUE: {
      const { path, value, rowUid } = action.payload
      const newDraftData = JSON.parse(JSON.stringify(state.draftData || {}))
      const newPatientData = JSON.parse(JSON.stringify(state.patientData || {}))
      setNestedValue(newDraftData, path, value)
      setNestedValue(newPatientData, path, value)
      applyRowUidForPath(newDraftData, path, rowUid)
      applyRowUidForPath(newPatientData, path, rowUid)
      return {
        ...state,
        patientData: newPatientData,
        draftData: newDraftData,
        isDirty: JSON.stringify(newDraftData) !== JSON.stringify(newPatientData)
      }
    }
    
    case ActionTypes.SET_SELECTED_PATH:
      return {
        ...state,
        selectedPath: action.payload
      }
    
    case ActionTypes.SET_EXPANDED_KEYS:
      return {
        ...state,
        expandedKeys: action.payload
      }
    
    case ActionTypes.SET_EDITING_FIELD:
      return {
        ...state,
        editingFieldId: action.payload.fieldId,
        editingValue: action.payload.value
      }
    
    case ActionTypes.CLEAR_EDITING:
      return {
        ...state,
        editingFieldId: null,
        editingValue: null
      }
    
    case ActionTypes.MARK_SAVED:
      return {
        ...state,
        patientData: JSON.parse(JSON.stringify(state.draftData)),
        isDirty: false,
        lastSavedAt: new Date().toISOString()
      }
    
    case ActionTypes.MARK_DIRTY:
      return {
        ...state,
        isDirty: true
      }
    
    case ActionTypes.ADD_REPEATABLE_ITEM: {
      const { path, template } = action.payload
      const newDraftData = JSON.parse(JSON.stringify(state.draftData || {}))
      const arr = getNestedValue(newDraftData, path) || []
      arr.push(template || {})
      setNestedValue(newDraftData, path, arr)
      return {
        ...state,
        draftData: newDraftData,
        isDirty: true
      }
    }
    
    case ActionTypes.REMOVE_REPEATABLE_ITEM: {
      const { path, index } = action.payload
      const newDraftData = JSON.parse(JSON.stringify(state.draftData || {}))
      const arr = getNestedValue(newDraftData, path) || []
      arr.splice(index, 1)
      setNestedValue(newDraftData, path, arr)
      return {
        ...state,
        draftData: newDraftData,
        isDirty: true
      }
    }
    
    default:
      return state
  }
}

// 工具函数：获取嵌套值
function getNestedValue(obj, path) {
  if (!path) return obj
  const keys = path.split('.')
  let result = obj
  for (const key of keys) {
    if (result == null) return undefined
    // 处理数组索引
    if (/^\d+$/.test(key)) {
      result = result[parseInt(key, 10)]
    } else {
      result = result[key]
    }
  }
  return result
}

// 工具函数：设置嵌套值
function setNestedValue(obj, path, value) {
  if (!path) return
  const keys = path.split('.')
  let current = obj
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]
    const nextKey = keys[i + 1]
    const isNextArray = /^\d+$/.test(nextKey)
    
    if (/^\d+$/.test(key)) {
      const idx = parseInt(key, 10)
      if (current[idx] == null) {
        current[idx] = isNextArray ? [] : {}
      }
      current = current[idx]
    } else {
      if (current[key] == null) {
        current[key] = isNextArray ? [] : {}
      }
      current = current[key]
    }
  }
  
  const lastKey = keys[keys.length - 1]
  if (/^\d+$/.test(lastKey)) {
    current[parseInt(lastKey, 10)] = value
  } else {
    current[lastKey] = value
  }
}

/**
 * 为候选值所在的可重复行补齐稳定 row uid。
 *
 * @param {Record<string, any>} obj 表单数据。
 * @param {string} path 字段路径。
 * @param {string | null | undefined} rowUid 可重复行 uid。
 * @returns {void}
 */
function applyRowUidForPath(obj, path, rowUid) {
  const normalizedRowUid = String(rowUid || '').trim()
  if (!obj || !path || !normalizedRowUid) return
  const keys = String(path).split('.').filter(Boolean)
  let current = obj
  for (const key of keys) {
    if (/^\d+$/.test(key)) {
      const index = parseInt(key, 10)
      if (!Array.isArray(current) || !current[index] || typeof current[index] !== 'object') return
      current[index]._row_uid = current[index]._row_uid || normalizedRowUid
      current = current[index]
      continue
    }
    if (!current || typeof current !== 'object') return
    current = current[key]
  }
}

// 创建Context
const SchemaFormContext = createContext(null)

// Provider组件
export function SchemaFormProvider({ children, schema, patientData, enums }) {
  const [state, dispatch] = useReducer(schemaFormReducer, {
    ...initialState,
    schema,
    enums: enums || {},
    patientData,
    draftData: patientData ? JSON.parse(JSON.stringify(patientData)) : null
  })
  
  // 监听 schema 变化
  React.useEffect(() => {
    if (schema !== state.schema) {
      dispatch({ 
        type: ActionTypes.SET_SCHEMA, 
        payload: { schema, enums: enums || {} } 
      })
    }
  }, [schema, enums])
  
  // 监听 patientData 变化（仅在外部数据真正变化时更新）
  const patientDataRef = React.useRef(patientData)
  React.useEffect(() => {
    const currentJSON = JSON.stringify(patientData)
    const prevJSON = JSON.stringify(patientDataRef.current)
    
    if (currentJSON !== prevJSON) {
      patientDataRef.current = patientData
      dispatch({ 
        type: ActionTypes.SET_PATIENT_DATA, 
        payload: patientData 
      })
    }
  }, [patientData])

  // Actions
  const actions = useMemo(() => ({
    setSchema: (schema, enums) => dispatch({ 
      type: ActionTypes.SET_SCHEMA, 
      payload: { schema, enums } 
    }),
    
    setPatientData: (data) => dispatch({ 
      type: ActionTypes.SET_PATIENT_DATA, 
      payload: data 
    }),
    
    updateFieldValue: (path, value) => dispatch({
      type: ActionTypes.UPDATE_FIELD_VALUE,
      payload: { path, value }
    }),

    applyPersistedFieldValue: (path, value, rowUid = null) => dispatch({
      type: ActionTypes.APPLY_PERSISTED_FIELD_VALUE,
      payload: { path, value, rowUid }
    }),
    
    setSelectedPath: (path) => dispatch({
      type: ActionTypes.SET_SELECTED_PATH,
      payload: path
    }),
    
    setExpandedKeys: (keys) => dispatch({
      type: ActionTypes.SET_EXPANDED_KEYS,
      payload: keys
    }),
    
    setEditingField: (fieldId, value) => dispatch({
      type: ActionTypes.SET_EDITING_FIELD,
      payload: { fieldId, value }
    }),
    
    clearEditing: () => dispatch({ type: ActionTypes.CLEAR_EDITING }),
    
    markSaved: () => dispatch({ type: ActionTypes.MARK_SAVED }),
    
    addRepeatableItem: (path, template) => dispatch({
      type: ActionTypes.ADD_REPEATABLE_ITEM,
      payload: { path, template }
    }),
    
    removeRepeatableItem: (path, index) => dispatch({
      type: ActionTypes.REMOVE_REPEATABLE_ITEM,
      payload: { path, index }
    }),
    
    getFieldValue: (path) => getNestedValue(state.draftData, path),
    getOriginalValue: (path) => getNestedValue(state.patientData, path)
  }), [state.draftData, state.patientData])

  const contextValue = useMemo(() => ({
    state,
    actions,
    schema: state.schema,
    enums: state.enums,
    draftData: state.draftData,
    patientData: state.patientData,
    selectedPath: state.selectedPath,
    isDirty: state.isDirty
  }), [state, actions])

  return (
    <SchemaFormContext.Provider value={contextValue}>
      {children}
    </SchemaFormContext.Provider>
  )
}

// Hook
export function useSchemaForm() {
  const context = useContext(SchemaFormContext)
  if (!context) {
    throw new Error('useSchemaForm must be used within a SchemaFormProvider')
  }
  return context
}

/**
 * 按 x-property-order 遍历 schema properties，保留 CSV/设计器原始顺序
 * （PostgreSQL JSONB 会重排 object key，x-property-order 数组记录了正确顺序）
 */
export function orderedPropertyEntries(properties, parentNode) {
  if (!properties || typeof properties !== 'object') return []
  const order = parentNode && parentNode['x-property-order']
  if (Array.isArray(order) && order.length > 0) {
    const seen = new Set()
    const out = []
    for (const k of order) {
      if (Object.prototype.hasOwnProperty.call(properties, k) && !seen.has(k)) {
        out.push([k, properties[k]])
        seen.add(k)
      }
    }
    for (const k of Object.keys(properties)) {
      if (!seen.has(k)) {
        out.push([k, properties[k]])
        seen.add(k)
      }
    }
    return out
  }
  return Object.entries(properties)
}

// 工具函数导出
export { getNestedValue, setNestedValue }

export default SchemaFormContext
