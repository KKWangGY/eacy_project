/**
 * Schema驱动的电子病历Tab组件
 *
 * 数据来源优先级：
 *  1. 外部直接传入 `schema` + `data`（用于科研项目详情页等复用场景）
 *  2. 传入 `patientId` → 调用 getPatientEhrSchemaData(patientId)
 *  3. fallback 到本地 /data/patient_ehr-V2.schema.json
 *
 * 其他特性：
 *  - `readOnly`：true 时保存动作被拦截（仅弹 warning，不真正写库），用于后端接口未就绪的页面
 */
import React, { useState, useEffect, useCallback } from 'react'
import {
  Alert,
  Spin,
  message,
  Space,
  Button,
  Typography
} from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import SchemaForm from '../../../../components/SchemaForm'
import { getPatientEhrSchemaData, updatePatientEhrSchemaData } from '../../../../api/patient'

const { Text } = Typography

function parseDefsToEnums(schema) {
  const enums = {}
  if (schema?.$defs) {
    for (const [enumId, enumDef] of Object.entries(schema.$defs)) {
      if (enumDef.enum) {
        enums[enumId] = {
          id: enumId,
          type: enumDef.type || 'string',
          values: [...enumDef.enum]
        }
      }
    }
  }
  return enums
}

const SchemaEhrTab = ({
  // 数据源 1：直接传入的 schema / data（优先级最高）
  schema: externalSchema = null,
  data: externalData = null,

  // 数据源 2：按 patientId 从 /ehr-schema-data 拉取
  patientId = null,

  // 若当前 tab 挂在科研项目详情页，需要传入 projectId，
  // 这样 SchemaForm 内的靶向上传按钮会把 project_id 一并带给后端，
  // 后端才能选用项目模板 schema + 写入 project_crf 实例（而不是写到病历夹）。
  projectId = null,

  // 外部额外传入的患者数据（若存在则覆盖本地 loadedData）
  patientData = null,

  // 只读模式：保存按钮点击后仅提示，不触发后端写入
  readOnly = false,
  readOnlyHint = '保存功能暂未开放',

  // 事件回调
  onSave,
  onDataChange,

  // 科研项目等场景：传入该患者文档列表，供右侧溯源面板匹配/预览（与 projectConfig.documents 一致）
  documents: sourceDocuments = null,

  // 配置选项
  autoSaveInterval = 30000,
  siderWidth = 220,
  sourcePanelWidth,
  collapsible = true,
  showSourcePanel = true
}) => {
  const [schema, setSchema] = useState(externalSchema)
  const [enums, setEnums] = useState(() => parseDefsToEnums(externalSchema))
  const [loading, setLoading] = useState(!externalSchema)
  const [error, setError] = useState(null)
  const [localPatientData, setLocalPatientData] = useState(patientData ?? externalData)

  const loadSchema = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      // 数据源 1：外部直传
      if (externalSchema) {
        setSchema(externalSchema)
        setEnums(parseDefsToEnums(externalSchema))
        if (!patientData) {
          setLocalPatientData(externalData ?? {})
        }
        return
      }

      let loadedSchema = null
      let loadedData = null

      // 数据源 2：按 patientId 调 API
      if (patientId) {
        const response = await getPatientEhrSchemaData(patientId)
        const schemaCandidate = response?.data?.schema
        const hasSchema =
          schemaCandidate &&
          typeof schemaCandidate === 'object' &&
          Object.keys(schemaCandidate.properties || {}).length > 0

        if (response?.success && hasSchema) {
          loadedSchema = schemaCandidate
          loadedData = response.data.data
        } else {
          const schemaModule = await import('../../../../data/patient_ehr-V2.schema.json')
          loadedSchema = schemaModule.default
          message.warning(response?.message || '后端 Schema 获取失败，已使用本地Schema')
        }
      } else {
        // 数据源 3：本地 fallback
        const schemaModule = await import('../../../../data/patient_ehr-V2.schema.json')
        loadedSchema = schemaModule.default
      }

      setSchema(loadedSchema)
      setEnums(parseDefsToEnums(loadedSchema))

      if (!patientData) {
        setLocalPatientData(loadedData ?? externalData ?? {})
      }
    } catch (err) {
      try {
        const schemaModule = await import('../../../../data/patient_ehr-V2.schema.json')
        const fallbackSchema = schemaModule.default
        setSchema(fallbackSchema)
        setEnums(parseDefsToEnums(fallbackSchema))
        if (!patientData) {
          setLocalPatientData(externalData ?? {})
        }
        message.warning('Schema 请求失败，已回退到本地 Schema')
      } catch (fallbackError) {
        console.error('Schema 加载失败:', err, fallbackError)
        setError(err.message || 'Schema 加载失败')
      }
    } finally {
      setLoading(false)
    }
  }, [externalSchema, externalData, patientData, patientId])

  useEffect(() => {
    loadSchema()
  }, [loadSchema])

  useEffect(() => {
    if (patientData) {
      setLocalPatientData(patientData)
    } else if (externalData && externalSchema) {
      setLocalPatientData(externalData)
    }
  }, [patientData, externalData, externalSchema])

  const handleSave = useCallback(async (data, type) => {
    if (readOnly) {
      message.warning(readOnlyHint)
      return
    }

    if (patientId && !externalSchema) {
      try {
        const res = await updatePatientEhrSchemaData(patientId, data)
        if (!res?.success) {
          throw new Error(res?.message || '保存失败')
        }
      } catch (err) {
        throw err
      }
    }

    if (onSave) {
      await onSave(data, type)
    }

    setLocalPatientData(data)

    if (onDataChange) {
      onDataChange(data)
    }
  }, [patientId, externalSchema, readOnly, readOnlyHint, onSave, onDataChange])

  const handleReset = useCallback(() => {
    if (patientData) {
      setLocalPatientData(patientData)
    } else if (externalData) {
      setLocalPatientData(externalData)
    }
  }, [patientData, externalData])

  if (loading) {
    return (
      <div style={{
        height: 500,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        gap: 16
      }}>
        <Spin size="large" />
        <Text type="secondary">正在加载 Schema 配置...</Text>
      </div>
    )
  }

  if (error) {
    return (
      <Alert
        message="Schema 加载失败"
        description={
          <Space direction="vertical">
            <Text>{error}</Text>
            <Button
              icon={<ReloadOutlined />}
              onClick={loadSchema}
              size="small"
            >
              重新加载
            </Button>
          </Space>
        }
        type="error"
        showIcon
        style={{ margin: 16 }}
      />
    )
  }

  return (
    <div style={{ minHeight: 400 }}>
      <SchemaForm
        schema={schema}
        enums={enums}
        patientData={localPatientData}
        patientId={patientId}
        projectId={projectId}
        projectConfig={
          Array.isArray(sourceDocuments) && sourceDocuments.length > 0
            ? { documents: sourceDocuments }
            : null
        }
        onSave={handleSave}
        onReset={handleReset}
        autoSaveInterval={autoSaveInterval}
        siderWidth={siderWidth}
        sourcePanelWidth={sourcePanelWidth}
        collapsible={collapsible}
        showSourcePanel={showSourcePanel}
        contentAdaptive
        style={{ minHeight: 500, height: 'auto' }}
      />
    </div>
  )
}

export default SchemaEhrTab
