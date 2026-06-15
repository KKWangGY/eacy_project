export interface PageSize {
  page_width: number
  page_height: number
}

export interface PageSizeFallback {
  byDocPage: Map<string, PageSize>
}

/**
 * 解析存储在 field_value_candidates.source_bbox_json 中的坐标。
 * 兼容 Python 端多次 json.dumps 导致的双重转义，以及裸数组形式的 bbox。
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

/**
 * 收集 rows 中已知的 OCR 原图尺寸，仅按 (source_document_id, source_page) 建立查找表。
 *
 * 裸 bbox 的坐标单位来自对应文档的 OCR 图像像素空间；不同文档即使出现在同一字段的
 * 候选列表里，也可能有不同分辨率或页面比例，不能用任意其它文档的尺寸兜底。
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
      if (!Number.isFinite(pw) || !Number.isFinite(ph) || pw <= 0 || ph <= 0) continue
      if (r.source_document_id) {
        const key = `${r.source_document_id}:${r.source_page ?? ''}`
        if (!byDocPage.has(key)) byDocPage.set(key, { page_width: pw, page_height: ph })
      }
    }
  }
  return { byDocPage }
}

/**
 * 解析 source_bbox_json，并在 page_width / page_height 缺失时用同文档同页尺寸回填。
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
