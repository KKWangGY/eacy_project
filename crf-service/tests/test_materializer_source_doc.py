"""
测试：Materializer 必须按"每份文档独立归属"写入候选值，
而不是让同一批 task_results 在每个文档下都重复落库。

对应审计项：
- P1: node_materialize 批量物化时源文档归属错位
- P2: upsert_selected_if_absent 的 AI→AI 覆盖语义
"""
from __future__ import annotations

import json

import pytest

from app.core.materializer import Materializer


def _collect_candidates(conn) -> list[dict]:
    rows = conn.execute(
        "SELECT source_document_id, field_path, value_json, created_by FROM field_value_candidates"
    ).fetchall()
    return [dict(r) for r in rows]


def _collect_selected(conn) -> list[dict]:
    rows = conn.execute(
        "SELECT field_path, selected_value_json, selected_by FROM field_value_selected"
    ).fetchall()
    return [dict(r) for r in rows]


def test_per_doc_payload_does_not_cross_contaminate(repo, seed_basic):
    """
    场景：批量抽取 2 份文档，每份各自产出不同字段。
    预期：doc_a 的候选仅关联到 doc_a，doc_b 的候选仅关联到 doc_b。
    回归场景：之前 nodes.py 会把合并后的完整 task_results 传给每份文档，
    导致每个字段产生 N 份重复 candidate + source_document_id 混淆。
    """
    materializer = Materializer(repo)

    payload_doc_a = {
        "task_results": [
            {
                "path": ["基本信息"],
                "extracted": {"姓名": "张三"},
                "audit": {"fields": {}},
            }
        ]
    }
    payload_doc_b = {
        "task_results": [
            {
                "path": ["出院信息"],
                "extracted": {"出院诊断": "高血压"},
                "audit": {"fields": {}},
            }
        ]
    }

    with repo.connect() as conn:
        instance_id = materializer.materialize(
            conn=conn,
            patient_id=seed_basic["patient_id"],
            document_id="doc_a",
            schema_id=seed_basic["schema_id"],
            extract_payload=payload_doc_a,
        )
        materializer.materialize(
            conn=conn,
            patient_id=seed_basic["patient_id"],
            document_id="doc_b",
            schema_id=seed_basic["schema_id"],
            extract_payload=payload_doc_b,
        )
        conn.commit()

        candidates = _collect_candidates(conn)

    assert instance_id
    assert len(candidates) == 2, f"预期 2 条候选，实际 {len(candidates)}：{candidates}"

    by_doc = {c["source_document_id"]: c for c in candidates}
    assert by_doc["doc_a"]["field_path"] == "/基本信息/姓名"
    assert json.loads(by_doc["doc_a"]["value_json"]) == "张三"
    assert by_doc["doc_b"]["field_path"] == "/出院信息/出院诊断"
    assert json.loads(by_doc["doc_b"]["value_json"]) == "高血压"


def test_project_crf_requires_project_id(repo, seed_basic):
    """
    场景：科研 CRF 抽取没有传 project_id。
    预期：物化层拒绝创建空 project_id 的 project_crf 实例，避免跨项目混写。
    """
    materializer = Materializer(repo)
    payload = {
        "task_results": [
            {
                "path": ["基本信息"],
                "extracted": {"姓名": "张三"},
                "audit": {"fields": {}},
            }
        ]
    }

    with repo.connect() as conn:
        with pytest.raises(ValueError, match="project_id"):
            materializer.materialize(
                conn=conn,
                patient_id=seed_basic["patient_id"],
                document_id="doc_a",
                schema_id=seed_basic["schema_id"],
                extract_payload=payload,
                instance_type="project_crf",
            )


def test_ai_overwrites_previous_ai_but_keeps_user_edits(repo, seed_basic):
    """
    场景：
      1. 第一次 AI 抽取：姓名=张三
      2. 用户手动把姓名改成 李四（selected_by=user）
      3. 重新 AI 抽取：姓名=王五
    预期：
      - field_value_candidates 保留三条历史（两条 AI + 用户编辑不进 candidate 表）
      - field_value_selected 保持 李四，不被王五覆盖
    """
    materializer = Materializer(repo)

    # 第一次 AI 抽取
    payload_v1 = {
        "task_results": [{
            "path": ["基本信息"],
            "extracted": {"姓名": "张三"},
            "audit": {"fields": {}},
        }]
    }
    with repo.connect() as conn:
        materializer.materialize(
            conn=conn,
            patient_id=seed_basic["patient_id"],
            document_id="doc_a",
            schema_id=seed_basic["schema_id"],
            extract_payload=payload_v1,
        )
        conn.commit()

    with repo.connect() as conn:
        selected = _collect_selected(conn)
    assert len(selected) == 1
    assert json.loads(selected[0]["selected_value_json"]) == "张三"
    assert selected[0]["selected_by"] == "ai"

    # 用户手动编辑
    with repo.connect() as conn:
        conn.execute(
            """
            UPDATE field_value_selected
            SET selected_value_json = ?, selected_by = 'user', updated_at = '2099-01-01T00:00:00Z'
            WHERE field_path = '/基本信息/姓名'
            """,
            (json.dumps("李四", ensure_ascii=False),),
        )
        conn.commit()

    # 第二次 AI 抽取（不同值）
    payload_v2 = {
        "task_results": [{
            "path": ["基本信息"],
            "extracted": {"姓名": "王五"},
            "audit": {"fields": {}},
        }]
    }
    with repo.connect() as conn:
        materializer.materialize(
            conn=conn,
            patient_id=seed_basic["patient_id"],
            document_id="doc_a",
            schema_id=seed_basic["schema_id"],
            extract_payload=payload_v2,
        )
        conn.commit()

    with repo.connect() as conn:
        selected = _collect_selected(conn)
        candidates = _collect_candidates(conn)

    assert len(selected) == 1, "selected 应仍为 1 条（同一字段路径）"
    assert json.loads(selected[0]["selected_value_json"]) == "李四", \
        "用户编辑不应被 AI 覆盖"
    assert selected[0]["selected_by"] == "user"

    assert len(candidates) == 2, "candidate 应保留两次 AI 抽取的历史值"


def test_ai_second_extraction_overwrites_previous_ai(repo, seed_basic):
    """
    场景：连续两次 AI 抽取，同一字段值变化。
    预期：selected 被更新为新值（不是老值顽固留着）。
    """
    materializer = Materializer(repo)
    with repo.connect() as conn:
        materializer.materialize(
            conn=conn,
            patient_id=seed_basic["patient_id"],
            document_id="doc_a",
            schema_id=seed_basic["schema_id"],
            extract_payload={"task_results": [{
                "path": ["基本信息"],
                "extracted": {"姓名": "旧名字"},
                "audit": {"fields": {}},
            }]},
        )
        conn.commit()

    with repo.connect() as conn:
        materializer.materialize(
            conn=conn,
            patient_id=seed_basic["patient_id"],
            document_id="doc_a",
            schema_id=seed_basic["schema_id"],
            extract_payload={"task_results": [{
                "path": ["基本信息"],
                "extracted": {"姓名": "新名字"},
                "audit": {"fields": {}},
            }]},
        )
        conn.commit()

    with repo.connect() as conn:
        selected = _collect_selected(conn)
    assert len(selected) == 1
    assert json.loads(selected[0]["selected_value_json"]) == "新名字", \
        "同为 AI 身份时新值应覆盖旧值"
    assert selected[0]["selected_by"] == "ai"


def test_schema_instance_name_defaults_by_instance_type(repo, seed_basic):
    """
    场景：materialize 时 instance_type 不同，新建的 schema_instances.name 应合理。
    回归：此前硬编码为"电子病历夹"，导致 project_crf 下也叫"电子病历夹"。
    """
    materializer = Materializer(repo)
    # 再创建一个患者，避免与默认的 patient_ehr instance 冲突
    with repo.connect() as conn:
        conn.execute(
            "INSERT INTO patients (id, name, pinyin, identifier) VALUES ('pat2', '李四', 'ls', 'TEST-002')"
        )
        conn.commit()

    with repo.connect() as conn:
        ehr_id = materializer.materialize(
            conn=conn,
            patient_id="pat1",
            document_id="doc_a",
            schema_id=seed_basic["schema_id"],
            extract_payload={"task_results": [{
                "path": ["x"], "extracted": {"y": 1}, "audit": {"fields": {}},
            }]},
            instance_type="patient_ehr",
        )
        crf_id = materializer.materialize(
            conn=conn,
            patient_id="pat2",
            document_id="doc_a",
            schema_id=seed_basic["schema_id"],
            extract_payload={"task_results": [{
                "path": ["x"], "extracted": {"y": 1}, "audit": {"fields": {}},
            }]},
            instance_type="project_crf",
        )
        conn.commit()

        names = dict(conn.execute(
            "SELECT id, name FROM schema_instances"
        ).fetchall())

    assert names[ehr_id] == "电子病历夹"
    assert names[crf_id] != "电子病历夹", \
        f"project_crf 不应继续使用'电子病历夹'，当前: {names[crf_id]}"
    assert names[crf_id], "project_crf 应有一个合理的默认名，不能为空"


def test_instance_documents_has_unique_constraint(repo, seed_basic):
    """
    P5 回归：表 DDL 中声明了 UNIQUE(instance_id, document_id, relation_type)，
    多次 ensure_instance_document 不会留下重复行。
    """
    with repo.connect() as conn:
        # 提前创建 instance
        instance_id = repo.ensure_schema_instance(
            conn,
            patient_id=seed_basic["patient_id"],
            schema_id=seed_basic["schema_id"],
            instance_type="patient_ehr",
        )
        for _ in range(3):
            repo.ensure_instance_document(conn, instance_id, "doc_a")
        conn.commit()

        rows = conn.execute(
            "SELECT COUNT(*) FROM instance_documents WHERE instance_id = ? AND document_id = ?",
            (instance_id, "doc_a"),
        ).fetchone()

    assert rows[0] == 1, f"instance_documents 应保持唯一，实际 {rows[0]} 条"
