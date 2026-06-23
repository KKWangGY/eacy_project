/**
 * 解析存储在 field_value_candidates.source_bbox_json 中的坐标。
 * 兼容 Python 端多次 json.dumps 导致的双重转义，以及裸数组形式的 bbox。
 *
 * 新版格式（含原图尺寸）：
 *   {"bbox":[x1,y1,x2,y2], "position":[x1,y1,...], "page_width":4344, "page_height":5792}
 * 旧版格式（裸数组）：
 *   [x1,y1,x2,y2]
 *
 * 新版格式会额外返回 page_width / page_height，
 * 供前端将 TextIn 页面像素坐标映射到 PDF 页面像素空间。
 */
export function parseSourceLocation(raw: string | null, page: number | null) {
  if (!raw) return null
  try {
    const sourcePage = Number.isFinite(Number(page)) ? Number(page) : 1
    let parsed: any = JSON.parse(raw)
    if (typeof parsed === 'string') {
      try {
        parsed = JSON.parse(parsed)
      } catch {
        // 保留原字符串
      }
    }
    if (Array.isArray(parsed) && parsed.length >= 4) {
      // 旧版格式：裸数组
      return {
        bbox: parsed,
        page: sourcePage,
        position: { x: parsed[0], y: parsed[1] },
      }
    }
    if (typeof parsed === 'object' && parsed !== null && Array.isArray(parsed.bbox) && parsed.bbox.length >= 4) {
      // 新版格式：{bbox, page_width, page_height}
      return {
        bbox: parsed.bbox,
        page: sourcePage,
        position: { x: parsed.bbox[0], y: parsed.bbox[1] },
        page_width: parsed.page_width || null,
        page_height: parsed.page_height || null,
        polygon: Array.isArray(parsed.position) ? parsed.position : null,
        page_angle: parsed.page_angle ?? null,
      }
    }
    return parsed
  } catch {
    return null
  }
}

interface PageSize {
  page_width: number
  page_height: number
}

export interface PageSizeFallback {
  byDocPage: Map<string, PageSize>
}

/**
 * 收集 rows 中已知的 OCR 原图尺寸，按 (source_document_id, source_page) 建立查找表。
 *
 * 用于回填仅存裸 bbox（page_width/page_height 缺失）的老候选数据：
 * 只允许用同一 (doc_id, page) 下其它候选的尺寸，避免把不同扫描件或页面的
 * TextIn 像素坐标映射到错误 PDF 位置。
 */
export function buildPageSizeFallback(rows: Array<any>): PageSizeFallback {
  const byDocPage = new Map<string, PageSize>()
  for (const r of rows) {
    if (!r?.source_bbox_json) continue
    const loc = parseSourceLocation(r.source_bbox_json, r.source_page) as any
    if (
      loc &&
      typeof loc === 'object' &&
      !Array.isArray(loc) &&
      loc.page_width &&
      loc.page_height
    ) {
      const pw = Number(loc.page_width)
      const ph = Number(loc.page_height)
      if (r.source_document_id) {
        const key = `${r.source_document_id}:${r.source_page ?? ''}`
        if (!byDocPage.has(key)) byDocPage.set(key, { page_width: pw, page_height: ph })
      }
    }
  }
  return { byDocPage }
}

/**
 * 解析 source_bbox_json，并在 page_width / page_height 缺失时安全回填。
 *
 * 旧版物化器只写了 {bbox}，前端拿不到原图尺寸会触发启发式缩放。这里仅使用
 * 精确同文档同页的兄弟候选回填，避免跨文档或跨页串用 OCR 原图尺寸。
 */
export function parseSourceLocationWithFallback(
  raw: string | null,
  page: number | null,
  docId: string | null,
  fallback: PageSizeFallback
) {
  const loc = parseSourceLocation(raw, page) as any
  if (!loc || typeof loc !== 'object' || Array.isArray(loc)) return loc
  if (loc.page_width && loc.page_height) return loc
  if (docId) {
    const fb = fallback.byDocPage.get(`${docId}:${page ?? ''}`)
    if (fb) return { ...loc, page_width: fb.page_width, page_height: fb.page_height }
  }
  return loc
}
