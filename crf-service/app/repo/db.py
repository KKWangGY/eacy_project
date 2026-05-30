"""
CRF 抽取服务数据库访问层

封装对 SQLite (eacy.db) 的读写操作，统一管理连接和事务。
物化阶段相关的写入操作（field_value_candidates / field_value_selected 等）也在此处。
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from app.config import settings


# ═══════════════════════════════════════════════════════════════════════════════
# 工具函数
# ═══════════════════════════════════════════════════════════════════════════════

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def _json_dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def _json_loads_maybe(value: Any, default: Any = None) -> Any:
    if value is None:
        return default
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, (bytes, bytearray)):
        value = value.decode("utf-8", errors="ignore")
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return default
        try:
            return json.loads(s)
        except Exception:
            return default
    return default


def _guess_value_type(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return type(value).__name__


def _best_normalized_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, (str, int, float, bool)):
        return str(value).strip()
    return None


def _normalize_field_path(full_pointer: str) -> str:
    """把 /A/0/B/1/C 归一化成 /A/B/C。"""
    if not full_pointer:
        return "/"
    parts = [p for p in full_pointer.split("/") if p]
    norm = [p for p in parts if not p.isdigit()]
    return "/" + "/".join(norm)


# ═══════════════════════════════════════════════════════════════════════════════
# CRFRepo — 数据库仓储
# ═══════════════════════════════════════════════════════════════════════════════

class CRFRepo:
    """封装 CRF 抽取服务所需的所有数据库操作。"""

    def __init__(self, db_path: Optional[Path] = None):
        self.db_path = db_path or settings.DB_PATH

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        self._ensure_project_instance_columns(conn)
        return conn

    def _ensure_project_instance_columns(self, conn: sqlite3.Connection) -> None:
        try:
            conn.execute(
                "ALTER TABLE schema_instances ADD COLUMN project_id TEXT NULL REFERENCES projects(id) ON DELETE CASCADE"
            )
        except sqlite3.OperationalError:
            pass
        try:
            conn.execute("CREATE INDEX IF NOT EXISTS idx_si_project ON schema_instances(project_id)")
        except sqlite3.OperationalError:
            pass
        try:
            conn.execute(
                """
                UPDATE schema_instances
                SET project_id = (
                  SELECT p.id
                  FROM projects p
                  JOIN project_patients pp ON pp.project_id = p.id
                  WHERE p.schema_id = schema_instances.schema_id
                    AND pp.patient_id = schema_instances.patient_id
                  LIMIT 1
                )
                WHERE instance_type = 'project_crf'
                  AND project_id IS NULL
                  AND 1 = (
                    SELECT COUNT(*)
                    FROM projects p
                    JOIN project_patients pp ON pp.project_id = p.id
                    WHERE p.schema_id = schema_instances.schema_id
                      AND pp.patient_id = schema_instances.patient_id
                  )
                """
            )
            conn.commit()
        except sqlite3.OperationalError:
            pass

    # ─── Schema 读取 ────────────────────────────────────────────────────────

    def get_schema_by_id(self, conn: sqlite3.Connection, schema_id: str) -> Optional[Dict[str, Any]]:
        row = conn.execute(
            "SELECT id, name, code, version, content_json FROM schemas WHERE id = ? LIMIT 1",
            (schema_id,),
        ).fetchone()
        if not row:
            return None
        return {
            "id": row["id"],
            "name": row["name"],
            "code": row["code"],
            "version": row["version"],
            "content_json": _json_loads_maybe(row["content_json"], default={}),
        }

    def get_schema_by_code(self, conn: sqlite3.Connection, schema_code: str) -> Optional[Dict[str, Any]]:
        row = conn.execute(
            """
            SELECT id, name, code, version, content_json
            FROM schemas
            WHERE code = ? AND is_active = 1
            ORDER BY version DESC
            LIMIT 1
            """,
            (schema_code,),
        ).fetchone()
        if not row:
            return None
        return {
            "id": row["id"],
            "name": row["name"],
            "code": row["code"],
            "version": row["version"],
            "content_json": _json_loads_maybe(row["content_json"], default={}),
        }

    def get_schema(self, conn: sqlite3.Connection, schema_id_or_code: str) -> Optional[Dict[str, Any]]:
        """先按 id 查，再按 code 查。"""
        rec = self.get_schema_by_id(conn, schema_id_or_code)
        if rec:
            return rec
        return self.get_schema_by_code(conn, schema_id_or_code)

    # ─── 文档读取 ──────────────────────────────────────────────────────────

    def get_document(self, conn: sqlite3.Connection, document_id: str) -> Optional[Dict[str, Any]]:
        row = conn.execute(
            """
            SELECT id, patient_id, file_name, mime_type, doc_type, doc_title,
                   document_type, document_sub_type,
                   status, raw_text, ocr_payload, metadata,
                   extract_status, extract_result_json,
                   extract_started_at, extract_completed_at, extract_error_message
            FROM documents
            WHERE id = ?
            """,
            (document_id,),
        ).fetchone()
        if not row:
            return None
        rec = dict(row)
        rec["ocr_payload"] = _json_loads_maybe(rec.get("ocr_payload"), default=None)
        rec["extract_result_json"] = _json_loads_maybe(rec.get("extract_result_json"), default=None)
        rec["metadata"] = _json_loads_maybe(rec.get("metadata"), default={})
        return rec

    def get_documents_by_patient(self, conn: sqlite3.Connection, patient_id: str) -> List[Dict[str, Any]]:
        rows = conn.execute(
            """
            SELECT id,
                   COALESCE(NULLIF(TRIM(doc_type), ''), NULLIF(TRIM(document_type), '')) AS doc_type,
                   document_sub_type AS doc_sub_type,
                   metadata
            FROM documents
            WHERE patient_id = ?
            ORDER BY datetime(COALESCE(updated_at, created_at, uploaded_at)) DESC
            """,
            (patient_id,),
        ).fetchall()
        return [dict(r) for r in rows]

    # ─── 抽取状态管理 ──────────────────────────────────────────────────────

    def mark_extract_running(self, conn: sqlite3.Connection, document_id: str, task_id: str) -> None:
        conn.execute(
            """
            UPDATE documents
            SET extract_status = 'running',
                extract_task_id = ?,
                extract_started_at = ?,
                extract_completed_at = NULL,
                extract_error_message = NULL
            WHERE id = ?
            """,
            (task_id, _now_iso(), document_id),
        )

    def mark_extract_success(self, conn: sqlite3.Connection, document_id: str, task_id: str, payload: Dict[str, Any]) -> None:
        conn.execute(
            """
            UPDATE documents
            SET extract_status = 'completed',
                extract_task_id = ?,
                extract_result_json = ?,
                extract_completed_at = ?,
                extract_error_message = NULL
            WHERE id = ?
            """,
            (task_id, _json_dumps(payload), _now_iso(), document_id),
        )

    def mark_extract_failed(self, conn: sqlite3.Connection, document_id: str, task_id: str, error: str) -> None:
        conn.execute(
            """
            UPDATE documents
            SET extract_status = 'failed',
                extract_task_id = ?,
                extract_completed_at = ?,
                extract_error_message = ?
            WHERE id = ?
            """,
            (task_id, _now_iso(), error[:4000], document_id),
        )

    # ─── Job 管理 ─────────────────────────────────────────────────────────

    def create_job(
        self,
        conn: sqlite3.Connection,
        document_id: str,
        schema_id: str,
        job_type: str = "extract",
        patient_id: Optional[str] = None,
    ) -> Optional[str]:
        """
        创建抽取 job。幂等策略（P3 修复）：
        同一 (document_id, schema_id, job_type) 若已有 pending/running job，
        直接返回该 job_id，不新建重复任务。这样前端重复点"开始抽取"不会堆出僵尸 job。
        """
        existing = conn.execute(
            """
            SELECT id FROM ehr_extraction_jobs
            WHERE document_id = ? AND schema_id = ? AND job_type = ?
              AND status IN ('pending', 'running')
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (document_id, schema_id, job_type),
        ).fetchone()
        if existing:
            return existing["id"]

        job_id = _new_id("job")
        try:
            conn.execute(
                """
                INSERT INTO ehr_extraction_jobs
                    (id, document_id, patient_id, schema_id, job_type, status,
                     attempt_count, max_attempts, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 'pending', 0, 3, ?, ?)
                """,
                (job_id, document_id, patient_id, schema_id, job_type, _now_iso(), _now_iso()),
            )
            return job_id
        except sqlite3.IntegrityError:
            return None

    def get_job(self, conn: sqlite3.Connection, job_id: str) -> Optional[Dict[str, Any]]:
        row = conn.execute("SELECT * FROM ehr_extraction_jobs WHERE id = ?", (job_id,)).fetchone()
        return dict(row) if row else None

    def claim_job(self, conn: sqlite3.Connection, job_id: str) -> bool:
        cur = conn.execute(
            """
            UPDATE ehr_extraction_jobs
            SET status = 'running',
                attempt_count = attempt_count + 1,
                started_at = ?,
                updated_at = ?
            WHERE id = ? AND status = 'pending'
            """,
            (_now_iso(), _now_iso(), job_id),
        )
        return cur.rowcount > 0

    def complete_job(self, conn: sqlite3.Connection, job_id: str, extraction_run_id: Optional[str] = None) -> None:
        conn.execute(
            """
            UPDATE ehr_extraction_jobs
            SET status = 'completed',
                completed_at = ?,
                result_extraction_run_id = COALESCE(?, result_extraction_run_id),
                last_error = NULL,
                updated_at = ?
            WHERE id = ?
            """,
            (_now_iso(), extraction_run_id, _now_iso(), job_id),
        )

    def fail_job(self, conn: sqlite3.Connection, job_id: str, error: str) -> None:
        conn.execute(
            """
            UPDATE ehr_extraction_jobs
            SET status = 'failed',
                last_error = ?,
                completed_at = ?,
                updated_at = ?
            WHERE id = ?
            """,
            (error[:4000], _now_iso(), _now_iso(), job_id),
        )

    # ─── 僵尸 running sweep ─────────────────────────────────────────────────
    #
    # 场景：Celery worker 被 SIGKILL / 进程崩溃 / 宿主断电时，正在跑的 job 没有
    # 机会回写状态，DB 里留下 status='running' 的僵尸行。之后新任务提交时这些
    # 僵尸不会自然恢复——只能靠定时 sweep 或下一次启动扫描清理。这里选择"启动
    # 扫描"作为轻量兜底，判定阈值 = settings.EXTRACTION_STALE_MINUTES（默认 15 分钟）。
    #
    # 幂等、单事务；同时把关联 documents.extract_status 回退到 pending，
    # materialize_status 同样处理（否则前端文档列表会永远停在 running 态）。
    # 不触碰 documents.materialize_status = 'completed' 的行，避免回退成功物化的文档。
    def sweep_stale_running_jobs(
        self,
        conn: sqlite3.Connection,
        stale_minutes: int,
        reason: str = "启动扫描：上次运行期间 worker 崩溃/被杀留下的僵尸 running",
    ) -> Dict[str, Any]:
        """
        把 started_at 早于 now - stale_minutes 的 running jobs 置为 cancelled。

        Returns:
            {
                "cancelled_job_ids": [...],
                "cancelled_job_count": N,
                "reverted_document_ids": [...],
                "reverted_document_count": M,
                "threshold_iso": "...",
            }
        """
        cutoff_iso = (
            datetime.now(timezone.utc) - timedelta(minutes=stale_minutes)
        ).isoformat()

        stale_rows = conn.execute(
            """
            SELECT id, document_id, started_at, patient_id
            FROM ehr_extraction_jobs
            WHERE status = 'running'
              AND (started_at IS NULL OR started_at < ?)
            """,
            (cutoff_iso,),
        ).fetchall()

        if not stale_rows:
            return {
                "cancelled_job_ids": [],
                "cancelled_job_count": 0,
                "reverted_document_ids": [],
                "reverted_document_count": 0,
                "threshold_iso": cutoff_iso,
            }

        cancelled_ids = [row["id"] for row in stale_rows]
        document_ids = [row["document_id"] for row in stale_rows if row["document_id"]]

        now_iso = _now_iso()
        placeholders = ",".join("?" for _ in cancelled_ids)
        conn.execute(
            f"""
            UPDATE ehr_extraction_jobs
            SET status       = 'cancelled',
                completed_at = ?,
                last_error   = COALESCE(last_error || ' | ', '') || ?,
                updated_at   = ?
            WHERE id IN ({placeholders})
            """,
            (now_iso, reason, now_iso, *cancelled_ids),
        )

        reverted_docs: List[str] = []
        if document_ids:
            doc_placeholders = ",".join("?" for _ in document_ids)
            cur = conn.execute(
                f"""
                SELECT id FROM documents
                WHERE id IN ({doc_placeholders})
                  AND (extract_status = 'running' OR materialize_status = 'running')
                """,
                document_ids,
            )
            reverted_docs = [r["id"] for r in cur.fetchall()]

            if reverted_docs:
                rev_placeholders = ",".join("?" for _ in reverted_docs)
                conn.execute(
                    f"""
                    UPDATE documents
                    SET extract_status = CASE
                            WHEN extract_status = 'running' THEN 'pending'
                            ELSE extract_status
                         END,
                        materialize_status = CASE
                            WHEN materialize_status = 'running' THEN 'pending'
                            ELSE materialize_status
                         END,
                        updated_at = ?
                    WHERE id IN ({rev_placeholders})
                    """,
                    (now_iso, *reverted_docs),
                )

        return {
            "cancelled_job_ids": cancelled_ids,
            "cancelled_job_count": len(cancelled_ids),
            "reverted_document_ids": reverted_docs,
            "reverted_document_count": len(reverted_docs),
            "threshold_iso": cutoff_iso,
        }

    # ─── 物化层写入 ────────────────────────────────────────────────────────

    # instance_type → 新建 instance 时使用的默认 name。
    _DEFAULT_INSTANCE_NAME = {
        "patient_ehr": "电子病历夹",
        "project_crf": "科研 CRF",
    }

    def ensure_schema_instance(
        self,
        conn: sqlite3.Connection,
        patient_id: str,
        schema_id: str,
        instance_type: str = "patient_ehr",
        instance_name: Optional[str] = None,
        project_id: Optional[str] = None,
    ) -> str:
        """
        如实例已存在则返回现有 id，否则创建新实例。

        instance_name 的取值优先级：
          1. 显式传入的 instance_name（调用方通常从 schema.name 或 project.name 派生）
          2. _DEFAULT_INSTANCE_NAME 中按 instance_type 的默认值
          3. schemas.name（再从 DB 取一次）
          4. instance_type 原值兜底
        """
        project_id = (project_id or "").strip() or None
        if instance_type == "project_crf":
            if not project_id:
                raise ValueError("project_crf schema instance requires project_id")
            row = conn.execute(
                """
                SELECT id FROM schema_instances
                WHERE patient_id = ? AND schema_id = ? AND project_id = ? AND instance_type = ?
                LIMIT 1
                """,
                (patient_id, schema_id, project_id, instance_type),
            ).fetchone()
        else:
            row = conn.execute(
                """
                SELECT id FROM schema_instances
                WHERE patient_id = ? AND schema_id = ? AND instance_type = ?
                LIMIT 1
                """,
                (patient_id, schema_id, instance_type),
            ).fetchone()
        if row:
            return row["id"]

        resolved_name = (instance_name or "").strip()
        if not resolved_name:
            resolved_name = self._DEFAULT_INSTANCE_NAME.get(instance_type, "").strip()
        if not resolved_name:
            schema_row = conn.execute(
                "SELECT name FROM schemas WHERE id = ? LIMIT 1", (schema_id,)
            ).fetchone()
            if schema_row and schema_row["name"]:
                resolved_name = str(schema_row["name"]).strip()
        if not resolved_name:
            resolved_name = instance_type

        new_id = _new_id("si")
        conn.execute(
            """
            INSERT INTO schema_instances (id, patient_id, schema_id, project_id, instance_type, name, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)
            """,
            (new_id, patient_id, schema_id, project_id, instance_type, resolved_name, _now_iso(), _now_iso()),
        )
        return new_id

    def ensure_instance_document(self, conn: sqlite3.Connection, instance_id: str, document_id: str, relation_type: str = "source") -> None:
        conn.execute(
            "INSERT OR IGNORE INTO instance_documents (id, instance_id, document_id, relation_type, created_at) VALUES (?, ?, ?, ?, ?)",
            (_new_id("idoc"), instance_id, document_id, relation_type, _now_iso()),
        )

    def create_extraction_run(
        self, conn: sqlite3.Connection, *,
        instance_id: str, document_id: str,
        target_mode: str, target_path: Optional[str],
        model_name: Optional[str], prompt_version: Optional[str],
    ) -> str:
        run_id = _new_id("er")
        conn.execute(
            """
            INSERT INTO extraction_runs (id, instance_id, document_id, target_mode, target_path, status, model_name, prompt_version, started_at, created_at)
            VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)
            """,
            (run_id, instance_id, document_id, target_mode, target_path, model_name, prompt_version, _now_iso(), _now_iso()),
        )
        return run_id

    def finalize_extraction_run(self, conn: sqlite3.Connection, run_id: str, status: str, error: Optional[str] = None) -> None:
        conn.execute(
            "UPDATE extraction_runs SET status = ?, finished_at = ?, error_message = ? WHERE id = ?",
            (status, _now_iso(), error[:4000] if error else None, run_id),
        )

    def ensure_section_instance(
        self, conn: sqlite3.Connection, *,
        instance_id: str, section_path: str, repeat_index: int, is_repeatable: bool,
        created_by: str = "ai", parent_section_id: Optional[str] = None,
        anchor_key: Optional[str] = None, anchor_display: Optional[str] = None,
    ) -> str:
        if parent_section_id is None:
            row = conn.execute(
                "SELECT id FROM section_instances WHERE instance_id = ? AND section_path = ? AND repeat_index = ? AND parent_section_id IS NULL LIMIT 1",
                (instance_id, section_path, repeat_index),
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT id FROM section_instances WHERE instance_id = ? AND section_path = ? AND repeat_index = ? AND parent_section_id = ? LIMIT 1",
                (instance_id, section_path, repeat_index, parent_section_id),
            ).fetchone()
        if row:
            if anchor_key or anchor_display:
                conn.execute(
                    """
                    UPDATE section_instances
                    SET anchor_key = COALESCE(?, anchor_key),
                        anchor_display = COALESCE(?, anchor_display),
                        updated_at = ?
                    WHERE id = ?
                    """,
                    (anchor_key, anchor_display, _now_iso(), row["id"]),
                )
            return row["id"]
        section_id = _new_id("sec")
        conn.execute(
            """
            INSERT INTO section_instances (id, instance_id, section_path, parent_section_id, repeat_index,
                anchor_key, anchor_display, is_repeatable, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (section_id, instance_id, section_path, parent_section_id, repeat_index,
             anchor_key, anchor_display, 1 if is_repeatable else 0, created_by, _now_iso(), _now_iso()),
        )
        return section_id

    def find_section_instance_by_anchor(
        self, conn: sqlite3.Connection, *,
        instance_id: str, section_path: str, anchor_key: str,
    ) -> Optional[Dict[str, Any]]:
        row = conn.execute(
            """
            SELECT id, repeat_index
            FROM section_instances
            WHERE instance_id = ?
              AND section_path = ?
              AND anchor_key = ?
            ORDER BY repeat_index ASC
            LIMIT 1
            """,
            (instance_id, section_path, anchor_key),
        ).fetchone()
        return dict(row) if row else None

    def find_section_instance_by_document(
        self, conn: sqlite3.Connection, *,
        instance_id: str, section_path: str, source_document_id: str,
    ) -> Optional[Dict[str, Any]]:
        row = conn.execute(
            """
            SELECT si.id, si.repeat_index
            FROM section_instances si
            JOIN field_value_candidates fvc ON fvc.section_instance_id = si.id
            WHERE si.instance_id = ?
              AND si.section_path = ?
              AND fvc.source_document_id = ?
            ORDER BY si.repeat_index ASC
            LIMIT 1
            """,
            (instance_id, section_path, source_document_id),
        ).fetchone()
        return dict(row) if row else None

    def next_section_repeat_index(
        self, conn: sqlite3.Connection, *,
        instance_id: str, section_path: str,
    ) -> int:
        row = conn.execute(
            """
            SELECT COALESCE(MAX(repeat_index), -1) + 1 AS next_idx
            FROM section_instances
            WHERE instance_id = ? AND section_path = ?
            """,
            (instance_id, section_path),
        ).fetchone()
        return int(row["next_idx"] if row else 0)

    def ensure_row_instance(
        self, conn: sqlite3.Connection, *,
        instance_id: str, section_instance_id: str, group_path: str, repeat_index: int,
        is_repeatable: bool = True, created_by: str = "ai", parent_row_id: Optional[str] = None,
    ) -> str:
        if parent_row_id is None:
            row = conn.execute(
                "SELECT id FROM row_instances WHERE section_instance_id = ? AND group_path = ? AND repeat_index = ? AND parent_row_id IS NULL LIMIT 1",
                (section_instance_id, group_path, repeat_index),
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT id FROM row_instances WHERE section_instance_id = ? AND group_path = ? AND repeat_index = ? AND parent_row_id = ? LIMIT 1",
                (section_instance_id, group_path, repeat_index, parent_row_id),
            ).fetchone()
        if row:
            return row["id"]
        row_id = _new_id("row")
        conn.execute(
            """
            INSERT INTO row_instances (id, instance_id, section_instance_id, group_path, parent_row_id, repeat_index,
                anchor_key, anchor_display, is_repeatable, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)
            """,
            (row_id, instance_id, section_instance_id, group_path, parent_row_id, repeat_index,
             1 if is_repeatable else 0, created_by, _now_iso(), _now_iso()),
        )
        return row_id

    def insert_candidate(
        self, conn: sqlite3.Connection, *,
        instance_id: str, section_instance_id: Optional[str], row_instance_id: Optional[str],
        field_path: str, value: Any, source_document_id: Optional[str],
        source_page: Optional[int], source_block_id: Optional[str],
        source_bbox: Optional[Any], source_text: Optional[str],
        extraction_run_id: Optional[str], confidence: Optional[float],
        created_by: str = "ai",
    ) -> str:
        candidate_id = _new_id("fvc")
        conn.execute(
            """
            INSERT INTO field_value_candidates (
                id, instance_id, section_instance_id, row_instance_id, field_path,
                value_json, value_type, normalized_value_text,
                source_document_id, source_page, source_block_id, source_bbox_json, source_text,
                extraction_run_id, confidence, created_by, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                candidate_id, instance_id, section_instance_id, row_instance_id, field_path,
                _json_dumps(value), _guess_value_type(value), _best_normalized_text(value),
                source_document_id, source_page, source_block_id,
                _json_dumps(source_bbox) if source_bbox is not None else None,
                source_text, extraction_run_id, confidence, created_by, _now_iso(),
            ),
        )
        return candidate_id

    def upsert_selected_if_absent(
        self, conn: sqlite3.Connection, *,
        instance_id: str, section_instance_id: Optional[str], row_instance_id: Optional[str],
        field_path: str, candidate_id: Optional[str], value: Any,
        selected_by: str = "ai", overwrite_existing: bool = False,
    ) -> None:
        """
        写入 / 覆盖当前选定值。

        覆盖规则（按字段级选中来源）：
          - 若目标记录不存在 → 新建。
          - 若已存在且 selected_by='user'（用户手动编辑过） → 除非 overwrite_existing=True
            （如强制重建），否则保留用户编辑，不被 AI 结果覆盖。
          - 若已存在且 selected_by!='user'（ai/system） → 总是用新值覆盖。
            （修复 P2：之前默认不覆盖导致新一轮 AI 抽取无法更新旧 AI 候选。）
        """
        row = conn.execute(
            """
            SELECT id, selected_by FROM field_value_selected
            WHERE instance_id = ?
              AND COALESCE(section_instance_id, '__null__') = COALESCE(?, '__null__')
              AND COALESCE(row_instance_id, '__null__') = COALESCE(?, '__null__')
              AND field_path = ?
            LIMIT 1
            """,
            (instance_id, section_instance_id, row_instance_id, field_path),
        ).fetchone()
        if row:
            existing_by = (row["selected_by"] or "").lower()
            if existing_by == "user" and not overwrite_existing:
                return
            conn.execute(
                """
                UPDATE field_value_selected
                SET selected_candidate_id = ?, selected_value_json = ?, selected_by = ?, selected_at = ?, updated_at = ?
                WHERE id = ?
                """,
                (candidate_id, _json_dumps(value), selected_by, _now_iso(), _now_iso(), row["id"]),
            )
            return
        conn.execute(
            """
            INSERT INTO field_value_selected (
                id, instance_id, section_instance_id, row_instance_id, field_path,
                selected_candidate_id, selected_value_json, selected_by, selected_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                _new_id("fvs"), instance_id, section_instance_id, row_instance_id, field_path,
                candidate_id, _json_dumps(value), selected_by, _now_iso(), _now_iso(),
            ),
        )
