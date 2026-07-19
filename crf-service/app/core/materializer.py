"""
物化器 — 将抽取结果写入实例层表

从 documents.extract_result_json (staged) → schema_instances / section_instances /
row_instances / field_value_candidates / field_value_selected

核心逻辑从 metadata-worker/ehr_pipeline.py._materialize_from_staged_extraction 迁移。
"""

from __future__ import annotations

import json
import logging
import sqlite3
import re
from typing import Any, Dict, List, Optional, Tuple

from app.repo.db import CRFRepo, _normalize_field_path

logger = logging.getLogger("crf-service.materializer")


def _schema_node_for_task_path(schema: Dict[str, Any], task_path: List[str]) -> Optional[Dict[str, Any]]:
    node: Any = schema
    for part in task_path:
        if not isinstance(node, dict):
            return None
        props = node.get("properties")
        if isinstance(props, dict) and part in props:
            node = props[part]
            continue
        if node.get("type") == "array" and isinstance(node.get("items"), dict):
            item_props = node["items"].get("properties")
            if isinstance(item_props, dict) and part in item_props:
                node = item_props[part]
                continue
        return None
    return node if isinstance(node, dict) else None


def _is_repeatable_task(schema: Dict[str, Any], task_path: List[str]) -> bool:
    node = _schema_node_for_task_path(schema, task_path)
    return bool(isinstance(node, dict) and node.get("type") == "array")


def _parse_merge_binding(raw: Any) -> Dict[str, str]:
    if not isinstance(raw, str) or not raw.strip():
        return {}
    out: Dict[str, str] = {}
    for part in raw.split(";"):
        if "=" not in part:
            continue
        key, value = part.split("=", 1)
        key = key.strip()
        value = value.strip()
        if key and value:
            out[key] = value
    return out


def _value_from_record(record: Any, dotted_path: str) -> Any:
    if not isinstance(record, dict) or not dotted_path:
        return None
    current: Any = record
    for part in re.split(r"[./]", dotted_path):
        part = part.strip()
        if not part:
            continue
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


def _normalize_anchor_value(value: Any, granularity: Optional[str] = None) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        text = json.dumps(value, ensure_ascii=False, sort_keys=True)
    else:
        text = str(value).strip()
    if granularity == "day" and len(text) >= 10:
        return text[:10]
    return text


def _build_anchor(schema_node: Optional[Dict[str, Any]], record: Any) -> Tuple[Optional[str], Optional[str]]:
    if not isinstance(schema_node, dict) or not isinstance(record, dict):
        return None, None
    binding = _parse_merge_binding(schema_node.get("x-merge-binding"))
    anchor_field = binding.get("anchor")
    group_key_field = binding.get("group_key")
    if not anchor_field and not group_key_field:
        return None, None

    granularity = binding.get("granularity")
    parts: List[Tuple[str, str]] = []
    for label, field in (("anchor", anchor_field), ("group_key", group_key_field)):
        if not field:
            continue
        value = _normalize_anchor_value(_value_from_record(record, field), granularity if label == "anchor" else None)
        if value:
            parts.append((field, value))

    if not parts:
        fallback_field = binding.get("fallback")
        if fallback_field:
            value = _normalize_anchor_value(_value_from_record(record, fallback_field), granularity)
            if value:
                parts.append((fallback_field, value))

    if not parts:
        return None, None
    anchor_key = "|".join(f"{k}={v}" for k, v in parts)
    return anchor_key, anchor_key


class Materializer:
    """将 staged 抽取结果写入实例层关系表。"""

    def __init__(self, repo: Optional[CRFRepo] = None):
        self.repo = repo or CRFRepo()

    def materialize(
        self,
        *,
        conn: sqlite3.Connection,
        patient_id: str,
        document_id: str,
        schema_id: str,
        extract_payload: Dict[str, Any],
        content_list: Optional[List[Dict[str, Any]]] = None,
        instance_type: str = "patient_ehr",
        project_id: Optional[str] = None,
        target_section: Optional[str] = None,
    ) -> str:
        """
        将 documents.extract_result_json 里的 staged 抽取结果写入实例层表。

        逻辑：
        1. 确保 schema_instance 存在
        2. 绑定 instance_documents
        3. 为这次物化创建 extraction_runs（实例层）
        4. 遍历 task_results / audit.fields，把候选值写入 field_value_candidates
        5. 若某字段当前尚无 selected，则自动选中最新候选值

        Returns:
            instance_id
        """
        instance_id = self.repo.ensure_schema_instance(
            conn,
            patient_id,
            schema_id,
            instance_type,
            project_id=project_id,
        )
        self.repo.ensure_instance_document(conn, instance_id, document_id, relation_type="source")

        ts = (target_section or "").strip() or None
        run_id = self.repo.create_extraction_run(
            conn,
            instance_id=instance_id,
            document_id=document_id,
            target_mode="targeted_section" if ts else "full_instance",
            target_path=ts,
            model_name="ehr_extractor_agent",
            prompt_version="staged_materialize_v1",
        )

        try:
            task_results = extract_payload.get("task_results") or []
            if not isinstance(task_results, list):
                task_results = []
            schema_rec = self.repo.get_schema(conn, schema_id)
            schema_content = schema_rec.get("content_json") if schema_rec else {}
            if not isinstance(schema_content, dict):
                schema_content = {}

            # 构建 source_id → 坐标映射（用于溯源高亮）。TextIn position/bbox 为
            # 解析页面图像像素坐标，page_width/page_height 用于前端等比映射到 PDF canvas。
            source_id_to_info: Dict[str, Any] = {}
            if content_list:
                for chunk in content_list:
                    chunk_id = chunk.get("id")
                    bbox = chunk.get("bbox")
                    if chunk_id and bbox:
                        page_w = chunk.get("page_width")
                        page_h = chunk.get("page_height")
                        if page_w and page_h:
                            # 新版格式：归一化坐标 + 原图尺寸
                            source_id_to_info[chunk_id] = {
                                "bbox": bbox,
                                "page_width": page_w,
                                "page_height": page_h,
                                "position": chunk.get("position"),
                                "page_angle": chunk.get("page_angle"),
                            }
                        else:
                            source_id_to_info[chunk_id] = {
                                "bbox": bbox,
                                "position": chunk.get("position"),
                                "page_angle": chunk.get("page_angle"),
                            }

            for task in task_results:
                if not isinstance(task, dict):
                    continue
                task_path = task.get("path") or []
                extracted = task.get("extracted")
                audit = task.get("audit") or {}
                audit_fields = audit.get("fields") if isinstance(audit, dict) else {}
                if not isinstance(task_path, list):
                    continue
                if extracted in (None, {}, []):
                    continue

                section_path = "/" + "/".join(task_path)
                schema_node = _schema_node_for_task_path(schema_content, task_path)
                schema_is_repeatable = bool(isinstance(schema_node, dict) and schema_node.get("type") == "array")
                root_is_repeatable = isinstance(extracted, list) or schema_is_repeatable

                if isinstance(extracted, list):
                    for idx, item in enumerate(extracted):
                        anchor_key, anchor_display = _build_anchor(schema_node, item)
                        existing_section = None
                        existing_section = self.repo.find_section_instance_by_anchor(
                            conn,
                            instance_id=instance_id,
                            section_path=section_path,
                            anchor_key=anchor_key,
                        ) if schema_is_repeatable and anchor_key else None
                        repeat_index = int(existing_section["repeat_index"]) if existing_section else self.repo.next_section_repeat_index(
                            conn,
                            instance_id=instance_id,
                            section_path=section_path,
                        )
                        section_instance_id = self.repo.ensure_section_instance(
                            conn,
                            instance_id=instance_id,
                            section_path=section_path,
                            repeat_index=repeat_index,
                            is_repeatable=True,
                            created_by="ai",
                            anchor_key=anchor_key,
                            anchor_display=anchor_display,
                        )
                        self._persist_node(
                            conn=conn,
                            instance_id=instance_id,
                            section_instance_id=section_instance_id,
                            row_instance_id=None,
                            current_path=task_path + [str(idx)],
                            node=item,
                            audit_fields=audit_fields or {},
                            document_id=document_id,
                            extraction_run_id=run_id,
                            source_id_to_info=source_id_to_info,
                        )
                else:
                    repeat_index = 0
                    existing_section = None
                    anchor_key, anchor_display = _build_anchor(schema_node, extracted)
                    if schema_is_repeatable:
                        existing_section = self.repo.find_section_instance_by_anchor(
                            conn,
                            instance_id=instance_id,
                            section_path=section_path,
                            anchor_key=anchor_key,
                        ) if anchor_key else None
                        if not existing_section:
                            existing_section = self.repo.find_section_instance_by_document(
                            conn,
                            instance_id=instance_id,
                            section_path=section_path,
                            source_document_id=document_id,
                            )
                        repeat_index = int(existing_section["repeat_index"]) if existing_section else self.repo.next_section_repeat_index(
                            conn,
                            instance_id=instance_id,
                            section_path=section_path,
                        )
                    section_instance_id = self.repo.ensure_section_instance(
                        conn,
                        instance_id=instance_id,
                        section_path=section_path,
                        repeat_index=repeat_index,
                        is_repeatable=root_is_repeatable,
                        created_by="ai",
                        anchor_key=anchor_key,
                        anchor_display=anchor_display,
                    )
                    self._persist_node(
                        conn=conn,
                        instance_id=instance_id,
                        section_instance_id=section_instance_id,
                        row_instance_id=None,
                        current_path=task_path,
                        node=extracted,
                        audit_fields=audit_fields or {},
                        document_id=document_id,
                        extraction_run_id=run_id,
                        source_id_to_info=source_id_to_info,
                    )

            self.repo.finalize_extraction_run(conn, run_id, "succeeded", None)
            return instance_id
        except Exception as exc:
            self.repo.finalize_extraction_run(conn, run_id, "failed", str(exc))
            raise

    def _persist_node(
        self,
        *,
        conn: sqlite3.Connection,
        instance_id: str,
        section_instance_id: str,
        row_instance_id: Optional[str],
        current_path: List[str],
        node: Any,
        audit_fields: Dict[str, Any],
        document_id: str,
        extraction_run_id: str,
        source_id_to_info: Dict[str, Any],
        parent_row_id: Optional[str] = None,
    ) -> None:
        """递归遍历抽取结果树，将叶子节点写入 field_value_candidates。"""
        if isinstance(node, dict):
            for key, value in node.items():
                self._persist_node(
                    conn=conn,
                    instance_id=instance_id,
                    section_instance_id=section_instance_id,
                    row_instance_id=row_instance_id,
                    current_path=current_path + [key],
                    node=value,
                    audit_fields=audit_fields,
                    document_id=document_id,
                    extraction_run_id=extraction_run_id,
                    source_id_to_info=source_id_to_info,
                    parent_row_id=parent_row_id,
                )
            return

        if isinstance(node, list):
            group_path = "/" + "/".join(current_path)
            for idx, item in enumerate(node):
                child_row_id = self.repo.ensure_row_instance(
                    conn,
                    instance_id=instance_id,
                    section_instance_id=section_instance_id,
                    group_path=group_path,
                    repeat_index=idx,
                    parent_row_id=parent_row_id,
                    is_repeatable=True,
                    created_by="ai",
                )
                self._persist_node(
                    conn=conn,
                    instance_id=instance_id,
                    section_instance_id=section_instance_id,
                    row_instance_id=child_row_id,
                    current_path=current_path,
                    node=item,
                    audit_fields=audit_fields,
                    document_id=document_id,
                    extraction_run_id=extraction_run_id,
                    source_id_to_info=source_id_to_info,
                    parent_row_id=child_row_id,
                )
            return

        # ── 叶子节点（标量值）──
        full_pointer = "/" + "/".join(current_path)
        field_path = _normalize_field_path(full_pointer)
        audit_entry = audit_fields.get(full_pointer) or audit_fields.get(field_path) or {}
        source_page, source_block_id = self._parse_source_id(
            audit_entry.get("source_id") if isinstance(audit_entry, dict) else None
        )
        source_text = audit_entry.get("raw") if isinstance(audit_entry, dict) else None

        source_bbox = None
        if source_block_id and source_id_to_info:
            source_bbox = source_id_to_info.get(source_block_id)
            if source_bbox is not None:
                source_bbox = json.dumps(source_bbox, ensure_ascii=False)

        candidate_id = self.repo.insert_candidate(
            conn,
            instance_id=instance_id,
            section_instance_id=section_instance_id,
            row_instance_id=row_instance_id,
            field_path=field_path,
            value=node,
            source_document_id=document_id,
            source_page=source_page,
            source_block_id=source_block_id,
            source_bbox=source_bbox,
            source_text=source_text,
            extraction_run_id=extraction_run_id,
            confidence=None,
            created_by="ai",
        )
        self.repo.upsert_selected_if_absent(
            conn,
            instance_id=instance_id,
            section_instance_id=section_instance_id,
            row_instance_id=row_instance_id,
            field_path=field_path,
            candidate_id=candidate_id,
            value=node,
            selected_by="ai",
            overwrite_existing=False,
        )

    @staticmethod
    def _parse_source_id(source_id: Optional[str]) -> Tuple[Optional[int], Optional[str]]:
        if not source_id:
            return None, None
        try:
            if source_id.startswith("p") and "." in source_id:
                page_part, _ = source_id.split(".", 1)
                page_no = int(page_part[1:])
                return page_no, source_id
        except Exception:
            pass
        return None, source_id
