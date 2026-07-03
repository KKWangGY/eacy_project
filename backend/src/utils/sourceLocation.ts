/**
 * 解析存储在 field_value_candidates.source_bbox_json 中的坐标。
 * 兼容 Python 端多次 json.dumps 导致的双重转义，以及裸数组形式的 bbox。
 *
 * 新版格式（含原图尺寸）：
 *   {"bbox":[x1,y1,x2,y2], "position":[x1,y1,...], "page_width":4344, "page_height":5792}
 * 旧版格式（裸数组）：
 *   [x1,y1,x2,y2]
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
      return {
        bbox: parsed,
        page: sourcePage,
        position: { x: parsed[0], y: parsed[1] },
      }
    }
    if (typeof parsed === 'object' && parsed !== null && Array.isArray(parsed.bbox) && parsed.bbox.length >= 4) {
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

interface PageSizeFallback {
  byDocPage: Map<string, PageSize>
}

/**
 * 收集 rows 中已知的 OCR 原图尺寸，按 (source_document_id, source_page) 建立查找表。
 *
 * 用于回填仅存裸 bbox（page_width/page_height 缺失）的老候选数据：
 * 只有同一文档同一页下的其它候选才能提供尺寸，避免把其它 PDF 的 OCR 尺寸
 * 套用到当前证据，造成高亮位置跨文档偏移。
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
 * 解析 source_bbox_json，并在 page_width / page_height 缺失时回填。
 *
 * 修复：旧版物化器只写了 {bbox}，前端 toRect 拿不到原图尺寸会触发坏的回退启发式
 * （把当前 bbox 的 maxX 当作图像宽度），导致 PDF 红框位置/尺寸明显偏移。
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
