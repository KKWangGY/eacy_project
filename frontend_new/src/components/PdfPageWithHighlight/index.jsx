/**
 * PdfPageWithHighlight
 * 用 PDF.js 渲染 PDF 单页并在其上绘制 bbox 高亮框。
 * 用于文档溯源面板：当有 source_location（page + bbox）时，显示指定页并高亮区域。
 *
 * bbox 坐标系约定：
 * - bboxScale="page"：bbox 直接为 PDF 点坐标，与 PDF 页宽高一致
 * - bboxScale=1000（默认）：bbox 为 0-1000 归一化坐标
 * - bbox 为原图像素坐标（如 Textin OCR 返回值）：按 PDF 页面填充整个嵌入
 *   图像（宽高比相同）的关系，直接以 PDF 页面尺寸为基准等比缩放映射
 */
import React, { useEffect, useRef, useState } from 'react'
import { Spin } from 'antd'
import * as pdfjsLib from 'pdfjs-dist'
import { appThemeToken } from '../../styles/themeTokens'
// Vite: 使用 ?url 使 worker 被正确打包并得到可用 URL
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
if (typeof window !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker
}

const DEFAULT_BBOX_SCALE = 1000

/** 判断 bbox / polygon 是否为 OCR /parse 返回的 0~1 归一化坐标。 */
function isUnitCoordinateArray(values) {
  return Array.isArray(values) &&
    values.length > 0 &&
    values.every((value) => Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1)
}

export function PdfPageWithHighlight({
  pdfUrl,
  pageNumber = null,
  bbox,
  locations,
  maxWidth = 480,
  loading: externalLoading = false,
  bboxScale = DEFAULT_BBOX_SCALE,
  onLoaded,
}) {
  const canvasRef = useRef(null)
  const containerRef = useRef(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 })
  const [pagePoints, setPagePoints] = useState({ width: 0, height: 0 })

  // 支持单个 bbox 或 locations 数组（多个区块）
  // 每个 location 可能同时携带 polygon（8 点，TextIn position 原始多边形）和 bbox（4 点轴对齐回退）。
  const hasBbox = Array.isArray(bbox) && bbox.length >= 4
  const hasLocations = Array.isArray(locations) && locations.length > 0
  const isValidLoc = (loc) =>
    loc && (
      (Array.isArray(loc.polygon) && loc.polygon.length >= 8) ||
      (Array.isArray(loc.bbox) && loc.bbox.length >= 4)
    )
  const list = hasLocations
    ? locations.filter(isValidLoc)
    : hasBbox
      ? [{ bbox, page: pageNumber }]
      : []

  const targetPage = pageNumber != null ? Number(pageNumber) : (list[0] && list[0].page != null ? Number(list[0].page) : 1)
  const pageIndex = Math.max(1, Math.floor(targetPage))
  const visibleList = list.filter((loc) => loc.page == null || Number(loc.page) === pageIndex)

  useEffect(() => {
    if (!pdfUrl) {
      setLoading(false)
      setError('未提供 PDF 地址')
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)

    const load = async () => {
      try {
        // 先不依赖 canvasRef：getDocument 可能较慢，worker 在某些环境会失败，用 disableWorker 降级
        const loadingTask = pdfjsLib.getDocument({
          url: pdfUrl,
          disableWorker: false,
          isEvalSupported: false,
        })
        const pdf = await loadingTask.promise
        if (cancelled) return
        if (typeof onLoaded === 'function') {
          try {
            onLoaded(pdf.numPages || 1)
          } catch {
            // ignore callback errors
          }
        }
        const page = await pdf.getPage(pageIndex)
        if (cancelled) return
        const viewport1 = page.getViewport({ scale: 1 })
        const scale = 1.5
        const viewport = page.getViewport({ scale })
        // 下一帧再取 canvas，确保已挂载
        const canvas = canvasRef.current
        if (!canvas || cancelled) return
        const ctx = canvas.getContext('2d')
        canvas.height = viewport.height
        canvas.width = viewport.width
        setViewportSize({ width: viewport.width, height: viewport.height })
        setPagePoints({ width: viewport1.width, height: viewport1.height })
        await page.render({
          canvasContext: ctx,
          viewport,
        }).promise
        if (cancelled) return
        setLoading(false)
      } catch (e) {
        if (!cancelled) {
          setError(e?.message || 'PDF 加载失败')
          setLoading(false)
        }
      }
    }
    load()
    return () => { cancelled = true }
  }, [pdfUrl, pageIndex])

  if (error) {
    return (
      <div style={{ padding: 12, background: 'rgba(255, 77, 79, 0.1)', borderRadius: 4, color: appThemeToken.colorError, fontSize: 12 }}>
        {error}
      </div>
    )
  }

  const refW = viewportSize.width || 1
  const refH = viewportSize.height || 1
  const usePageScale = bboxScale === 'page'
  const pw = pagePoints.width || refW
  const ph = pagePoints.height || refH
  const showSpinner = externalLoading || loading

  /**
   * 将 bbox 映射到 PDF canvas 像素坐标。
   *
   * 情况 1：bbox 为 PDF 页面点坐标（bboxScale="page"）
   *   → 直接按 PDF 页尺寸映射
   *
   * 情况 2：bbox 为原图像素坐标（来自 OCR）
   *   - 若 item.page_width/page_height（原图尺寸）已知：
   *     按 PDF页尺寸 / 原图尺寸 的比例映射
   *   - 否则（未传原图尺寸）自动检测：
   *     若 max(bbox) > max(PDF_page)，判定为原图像素坐标，
   *     用 PDF 页尺寸作为参考（假设 PDF 填充了同宽高比原图）
   */
  const toRect = (item) => {
    const [rawX1, rawY1, rawX2, rawY2] = item.bbox.map(Number)
    const x1 = Math.min(rawX1, rawX2)
    const y1 = Math.min(rawY1, rawY2)
    const x2 = Math.max(rawX1, rawX2)
    const y2 = Math.max(rawY1, rawY2)
    const w = x2 - x1
    const h = y2 - y1

    // 情况 1：PDF 点坐标
    if (usePageScale && pw > 0 && ph > 0) {
      return {
        left: (x1 / pw) * refW,
        top: (y1 / ph) * refH,
        width: (w / pw) * refW,
        height: (h / ph) * refH,
      }
    }

    // 情况 2：原图像素坐标
    if (pw > 0 && ph > 0) {
      // 有原图尺寸 → 用 PDF/原图 比例精确换算
      const origW = item.page_width
      const origH = item.page_height
      if (origW > 0 && origH > 0) {
        if (isUnitCoordinateArray([rawX1, rawY1, rawX2, rawY2])) {
          return {
            left: x1 * refW,
            top: y1 * refH,
            width: w * refW,
            height: h * refH,
          }
        }
        return {
          left: (x1 / origW) * refW,
          top: (y1 / origH) * refH,
          width: (w / origW) * refW,
          height: (h / origH) * refH,
        }
      }
      // 无原图尺寸 → 自动检测（bbox 超 PDF 页 → 原图像素）
      const maxBbox = Math.max(Math.abs(x1), Math.abs(y1), Math.abs(x2), Math.abs(y2))
      const maxPage = Math.max(pw, ph)
      if (maxBbox > maxPage * 1.1) {
        // bbox 明显超出 PDF 页范围：旧 OCR 像素坐标但缺少原图尺寸。
        // 以 PDF 页宽高比推断一个能容纳 bbox 的原图尺寸，避免按 PDF 点数缩放导致红框跑到页外。
        const pageAspect = pw / ph
        const maxX = Math.max(Math.abs(x1), Math.abs(x2), 1)
        const maxY = Math.max(Math.abs(y1), Math.abs(y2), 1)
        let inferredW = maxX
        let inferredH = inferredW / pageAspect
        if (inferredH < maxY) {
          inferredH = maxY
          inferredW = inferredH * pageAspect
        }
        return {
          left: (x1 / inferredW) * refW,
          top: (y1 / inferredH) * refH,
          width: (w / inferredW) * refW,
          height: (h / inferredH) * refH,
        }
      }
      // bbox 在页范围内，视为已归一化到 PDF 页
      return {
        left: (x1 / pw) * refW,
        top: (y1 / ph) * refH,
        width: (w / pw) * refW,
        height: (h / ph) * refH,
      }
    }

    // 回退：使用 bboxScale 约定的 0-bboxScale 归一化
    const scale = refW / Number(bboxScale)
    const scaleY = refH / Number(bboxScale)
    return {
      left: x1 * scale,
      top: y1 * scaleY,
      width: w * scale,
      height: h * scaleY,
    }
  }

  /**
   * 将 TextIn 8 点 position 多边形映射到 PDF canvas 像素坐标。
   * 使用与 toRect 相同的缩放逻辑，但对 4 个角点逐点映射，保持多边形形状。
   *
   * 输入: item.polygon = [x1,y1,x2,y2,x3,y3,x4,y4] (顺时针: 左上/右上/右下/左下)
   * 输出: 4 个 {x, y} 点（canvas 像素坐标），用于 SVG <polygon> points
   *
   * 优势：当原文档被拍摄/扫描时存在轻微倾斜，多边形与文字行的实际倾斜方向一致，
   * 不会像轴对齐 bbox 那样在倾斜方向上"溢出"实际文字范围。
   */
  const toPolygonPoints = (item) => {
    if (!Array.isArray(item.polygon) || item.polygon.length < 8) return null
    const raw = item.polygon.map(Number)
    const pts = [
      { x: raw[0], y: raw[1] },
      { x: raw[2], y: raw[3] },
      { x: raw[4], y: raw[5] },
      { x: raw[6], y: raw[7] },
    ]

    // 情况 1：PDF 点坐标
    if (usePageScale && pw > 0 && ph > 0) {
      return pts.map((p) => ({ x: (p.x / pw) * refW, y: (p.y / ph) * refH }))
    }

    // 情况 2：原图像素坐标
    if (pw > 0 && ph > 0) {
      const origW = item.page_width
      const origH = item.page_height
      if (origW > 0 && origH > 0) {
        if (isUnitCoordinateArray(raw)) {
          return pts.map((p) => ({ x: p.x * refW, y: p.y * refH }))
        }
        return pts.map((p) => ({ x: (p.x / origW) * refW, y: (p.y / origH) * refH }))
      }
      // 自动检测：bbox 明显超 PDF 页 → 推断原图尺寸
      const xs = pts.map((p) => Math.abs(p.x))
      const ys = pts.map((p) => Math.abs(p.y))
      const maxBbox = Math.max(...xs, ...ys)
      const maxPage = Math.max(pw, ph)
      if (maxBbox > maxPage * 1.1) {
        const pageAspect = pw / ph
        const maxX = Math.max(...xs, 1)
        const maxY = Math.max(...ys, 1)
        let inferredW = maxX
        let inferredH = inferredW / pageAspect
        if (inferredH < maxY) {
          inferredH = maxY
          inferredW = inferredH * pageAspect
        }
        return pts.map((p) => ({ x: (p.x / inferredW) * refW, y: (p.y / inferredH) * refH }))
      }
      return pts.map((p) => ({ x: (p.x / pw) * refW, y: (p.y / ph) * refH }))
    }

    // 回退：bboxScale 归一化
    const scale = refW / Number(bboxScale)
    const scaleY = refH / Number(bboxScale)
    return pts.map((p) => ({ x: p.x * scale, y: p.y * scaleY }))
  }

  // 始终只渲染一个 canvas（同一 ref），避免 loading 时未挂载导致 effect 拿不到 ref 而卡死
  return (
    <div ref={containerRef} style={{ position: 'relative', display: 'inline-block', maxWidth: maxWidth || '100%' }}>
      <canvas
        ref={canvasRef}
        style={{
          display: 'block',
          maxWidth: '100%',
          height: 'auto',
          borderRadius: 4,
          boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
          opacity: showSpinner ? 0 : 1,
        }}
      />
      {showSpinner && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: appThemeToken.colorFillTertiary, borderRadius: 4 }}>
          <Spin tip="加载 PDF 页..." />
        </div>
      )}
      {!showSpinner && viewportSize.width > 0 && list.length > 0 && (
        <svg
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
          }}
          viewBox={`0 0 ${refW} ${refH}`}
          preserveAspectRatio="none"
        >
          {visibleList.map((item, idx) => {
            // 优先用 8 点 polygon（贴合实际文字倾斜），否则回退到轴对齐 rect
            const polyPts = toPolygonPoints(item)
            if (polyPts) {
              const pointsAttr = polyPts.map((p) => `${p.x},${p.y}`).join(' ')
              console.debug('[PdfPageWithHighlight]', {
                mode: 'polygon',
                polygon: item.polygon,
                pagePoints: { pw, ph },
                canvasPx: { refW, refH },
                points: polyPts,
              })
              return (
                <polygon
                  key={idx}
                  points={pointsAttr}
                  fill="none"
                  stroke={appThemeToken.colorError}
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                />
              )
            }
            const rect = toRect(item)
            console.debug('[PdfPageWithHighlight]', {
              mode: 'bbox',
              bbox: item.bbox,
              pagePoints: { pw, ph },
              canvasPx: { refW, refH },
              rect,
            })
            return (
              <rect
                key={idx}
                x={rect.left}
                y={rect.top}
                width={Math.max(rect.width, 2)}
                height={Math.max(rect.height, 2)}
                fill="none"
                stroke={appThemeToken.colorError}
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            )
          })}
        </svg>
      )}
    </div>
  )
}

export default PdfPageWithHighlight
