"""
CRF 抽取服务 — FastAPI 入口

提供 REST API + SSE 进度流：
  POST /api/extract         — 提交抽取任务
  GET  /api/extract/{id}    — 查询任务状态
  GET  /api/extract/{id}/progress — SSE 实时进度
  GET  /health              — 健康检查
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Dict, List, Optional

import redis
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.config import settings
from app.repo.db import CRFRepo
from app.tasks import run_extraction_task, run_ocr_task, run_metadata_task
from celery import chain

# ── 日志 ──────────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=getattr(logging, settings.LOG_LEVEL, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("crf-service")

# ── Lifespan：启动时回收僵尸 running，关闭时不做额外清理 ─────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """
    启动钩子：扫描 `ehr_extraction_jobs` 里 status='running' 且 started_at 早于
    `settings.EXTRACTION_STALE_MINUTES` 分钟的记录，判定为上次 worker 崩溃/被 kill
    留下的僵尸，自动置为 cancelled，并回退关联 documents.extract_status。

    这解决了 P14 的一个具体子问题：Celery worker 非正常退出后 running 状态不会自愈。
    --reload 场景下每次热重载也会跑一次，幂等（阈值外的 running 不会被动）。
    """
    try:
        repo = CRFRepo()
        conn = repo.connect()
        try:
            summary = repo.sweep_stale_running_jobs(
                conn, stale_minutes=settings.EXTRACTION_STALE_MINUTES
            )
            conn.commit()
        finally:
            conn.close()
        if summary["cancelled_job_count"] > 0:
            logger.warning(
                "[startup] 回收僵尸 running 任务：cancel %d 个 job（阈值 %d 分钟，cutoff=%s），"
                "回退 %d 个 document 状态",
                summary["cancelled_job_count"],
                settings.EXTRACTION_STALE_MINUTES,
                summary["threshold_iso"],
                summary["reverted_document_count"],
            )
            logger.info("[startup] cancelled job ids: %s", summary["cancelled_job_ids"])
        else:
            logger.info(
                "[startup] 无僵尸 running 任务需要回收（阈值 %d 分钟）",
                settings.EXTRACTION_STALE_MINUTES,
            )
    except Exception as exc:  # noqa: BLE001
        # sweep 失败绝不阻断服务启动
        logger.exception("[startup] 僵尸任务回收异常（忽略，不影响服务启动）: %s", exc)

    yield
    # 关闭阶段暂无清理逻辑


# ── FastAPI App ──────────────────────────────────────────────────────────────

app = FastAPI(
    title="CRF 抽取服务",
    description="独立的 CRF / EHR 结构化抽取服务，基于 LangGraph + Celery + FastAPI",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── 请求 / 响应模型 ─────────────────────────────────────────────────────────

class ExtractRequest(BaseModel):
    patient_id: str = Field(..., description="患者 ID")
    schema_id: str = Field(..., description="Schema ID 或 code")
    project_id: Optional[str] = Field(
        default=None,
        description="科研项目 ID；instance_type=project_crf 时用于隔离同一患者在不同项目中的 CRF 实例",
    )
    document_ids: Optional[List[str]] = Field(
        default=None,
        description="可选：指定文档 ID 列表。不指定则按患者名下文档自动匹配",
    )
    instance_type: str = Field(
        default="patient_ehr",
        description="实例类型：patient_ehr（病历夹）或 project_crf（科研项目）",
    )
    target_section: Optional[str] = Field(
        default=None,
        description=(
            "可选：靶向 section 名（形如 '基本信息 / 人口学情况'）。"
            "若提供则进入靶向模式：仅对该 section 子 schema 抽取，"
            "忽略 x-sources 子类型匹配，document_ids 原样作为该 section 的唯一文档源。"
        ),
    )


class ExtractResponse(BaseModel):
    success: bool
    job_id: str
    message: str
    celery_task_id: Optional[str] = None


class JobStatusResponse(BaseModel):
    success: bool
    job_id: str
    status: str
    result: Optional[Dict[str, Any]] = None


def _validate_project_crf_request(conn, *, patient_id: str, schema_id: str, project_id: Optional[str]) -> None:
    """校验科研 CRF 抽取必须绑定到明确且已入组的项目。"""
    clean_project_id = (project_id or "").strip()
    if not clean_project_id:
        raise HTTPException(status_code=400, detail="project_crf 抽取必须指定 project_id")

    project = conn.execute(
        "SELECT id, schema_id FROM projects WHERE id = ? LIMIT 1",
        (clean_project_id,),
    ).fetchone()
    if not project:
        raise HTTPException(status_code=400, detail=f"项目不存在: {clean_project_id}")
    if project["schema_id"] != schema_id:
        raise HTTPException(status_code=400, detail="project_id 与 schema_id 不匹配")

    enrollment = conn.execute(
        "SELECT 1 FROM project_patients WHERE project_id = ? AND patient_id = ? LIMIT 1",
        (clean_project_id, patient_id),
    ).fetchone()
    if not enrollment:
        raise HTTPException(status_code=403, detail="患者未入组该项目，无法写入科研 CRF")


# ── 健康检查 ─────────────────────────────────────────────────────────────────

@app.get("/health")
async def health_check():
    """健康检查：验证 DB 和 Redis 可达。"""
    checks = {"db": False, "redis": False}

    try:
        repo = CRFRepo()
        with repo.connect() as conn:
            conn.execute("SELECT 1").fetchone()
        checks["db"] = True
    except Exception as exc:
        logger.warning("DB 健康检查失败: %s", exc)

    try:
        r = redis.from_url(settings.REDIS_URL, decode_responses=True)
        r.ping()
        checks["redis"] = True
    except Exception as exc:
        logger.warning("Redis 健康检查失败: %s", exc)

    healthy = all(checks.values())
    return {"status": "healthy" if healthy else "degraded", "checks": checks}


# ── 提交抽取任务 ─────────────────────────────────────────────────────────────

@app.post("/api/extract", response_model=ExtractResponse)
async def submit_extraction(req: ExtractRequest):
    """
    提交 CRF 抽取任务。

    - 在 ehr_extraction_jobs 表创建 job 记录
    - 派发 Celery 异步任务
    - 返回 job_id 供查询进度
    """
    repo = CRFRepo()

    # 验证 schema 存在
    with repo.connect() as conn:
        schema_rec = repo.get_schema(conn, req.schema_id)
        if not schema_rec:
            raise HTTPException(status_code=400, detail=f"Schema 不存在: {req.schema_id}")
        actual_schema_id = schema_rec["id"]
        if req.instance_type == "project_crf":
            _validate_project_crf_request(
                conn,
                patient_id=req.patient_id,
                schema_id=actual_schema_id,
                project_id=req.project_id,
            )

        # 创建 job
        job_id = repo.create_job(
            conn,
            document_id=req.document_ids[0] if req.document_ids else "",
            schema_id=actual_schema_id,
            job_type="extract",
            patient_id=req.patient_id,
        )
        conn.commit()

    if not job_id:
        raise HTTPException(status_code=500, detail="创建 job 失败")

    # 派发 Celery task
    celery_result = run_extraction_task.delay(
        job_id=job_id,
        patient_id=req.patient_id,
        schema_id=actual_schema_id,
        document_ids=req.document_ids,
        instance_type=req.instance_type,
        project_id=req.project_id,
        target_section=req.target_section,
    )

    logger.info(
        "[API] 已提交抽取任务 job=%s celery=%s patient=%s schema=%s",
        job_id, celery_result.id, req.patient_id, actual_schema_id,
    )

    return ExtractResponse(
        success=True,
        job_id=job_id,
        message="抽取任务已提交",
        celery_task_id=celery_result.id,
    )


# ── 查询任务状态 ─────────────────────────────────────────────────────────────

@app.get("/api/extract/{job_id}", response_model=JobStatusResponse)
async def get_extraction_status(job_id: str):
    """查询抽取任务的当前状态和结果。"""
    repo = CRFRepo()
    with repo.connect() as conn:
        job = repo.get_job(conn, job_id)

    if not job:
        raise HTTPException(status_code=404, detail=f"Job 不存在: {job_id}")

    return JobStatusResponse(
        success=True,
        job_id=job_id,
        status=job.get("status", "unknown"),
        result=dict(job) if job.get("status") == "completed" else None,
    )


# ── SSE 实时进度 ─────────────────────────────────────────────────────────────

@app.get("/api/extract/{job_id}/progress")
async def extraction_progress_sse(job_id: str):
    """
    SSE (Server-Sent Events) 端点：实时推送抽取进度。

    前端通过 EventSource 连接此接口：
      const es = new EventSource('/api/extract/{job_id}/progress')
      es.onmessage = (e) => console.log(JSON.parse(e.data))
    """
    async def event_generator():
        r = redis.from_url(settings.REDIS_URL, decode_responses=True)
        pubsub = r.pubsub()
        channel = f"{settings.PROGRESS_CHANNEL_PREFIX}{job_id}"
        pubsub.subscribe(channel)

        try:
            # 先推送当前状态
            repo = CRFRepo()
            with repo.connect() as conn:
                job = repo.get_job(conn, job_id)
            if job:
                yield f"data: {json.dumps({'status': job.get('status', 'unknown'), 'node': 'init'}, ensure_ascii=False)}\n\n"
                # 终态立即结束，避免前端 EventSource 挂着空等 10 分钟才超时
                if job.get("status") in ("completed", "failed", "cancelled"):
                    return

            # 监听 Redis pub/sub
            timeout_count = 0
            max_timeout = 600  # 最多等 10 分钟
            while timeout_count < max_timeout:
                message = pubsub.get_message(timeout=1.0)
                if message and message["type"] == "message":
                    yield f"data: {message['data']}\n\n"
                    timeout_count = 0
                    # 终止条件
                    try:
                        data = json.loads(message["data"])
                        if data.get("status") in ("completed", "failed", "cancelled"):
                            break
                    except Exception:
                        pass
                else:
                    timeout_count += 1
                    # 每 15 秒发心跳
                    if timeout_count % 15 == 0:
                        yield f": heartbeat\n\n"
                await asyncio.sleep(0.1)
        finally:
            pubsub.unsubscribe(channel)
            pubsub.close()

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ── 批量提交（归档触发） ──────────────────────────────────────────────────────

class BatchExtractRequest(BaseModel):
    patient_id: str
    schema_id: str
    project_id: Optional[str] = Field(
        default=None,
        description="科研项目 ID；instance_type=project_crf 时用于项目级实例隔离",
    )
    document_ids: List[str] = Field(..., description="归档的文档 ID 列表")
    instance_type: str = "patient_ehr"
    target_section: Optional[str] = Field(
        default=None,
        description=(
            "可选：靶向 section 名。若提供则进入靶向模式（绕过 x-sources 子类型匹配）"
        ),
    )
    target_sections: Optional[List[str]] = Field(
        default=None,
        description="可选：多个靶向 section 名。用于科研专项抽取一次提交多个字段组",
    )


@app.post("/api/extract/batch")
async def submit_batch_extraction(req: BatchExtractRequest):
    """
    批量提交抽取任务 — 供归档 commit 调用。
    创建一个合并的 Celery task，将所有 document_ids 一起发送给 pipeline。
    这样 filter_units 可以把不同类型的文档匹配到各自的 schema 表单上。
    """
    repo = CRFRepo()
    jobs = []

    with repo.connect() as conn:
        schema_rec = repo.get_schema(conn, req.schema_id)
        if not schema_rec:
            raise HTTPException(status_code=400, detail=f"Schema 不存在: {req.schema_id}")
        actual_schema_id = schema_rec["id"]
        if req.instance_type == "project_crf":
            _validate_project_crf_request(
                conn,
                patient_id=req.patient_id,
                schema_id=actual_schema_id,
                project_id=req.project_id,
            )

        for doc_id in req.document_ids:
            job_type = f"extract:target:{req.target_section}" if req.target_section else "extract"
            job_id = repo.create_job(
                conn,
                document_id=doc_id,
                schema_id=actual_schema_id,
                job_type=job_type,
                patient_id=req.patient_id,
            )
            if job_id:
                jobs.append({"document_id": doc_id, "job_id": job_id})
        conn.commit()

    if not jobs:
        return {
            "success": True,
            "message": "所有文档已有活跃任务，无需重复提交",
            "jobs": [],
        }

    # 派发一个合并的 Celery task，包含所有文档 ID
    # 这样 pipeline 的 filter_units 能把不同类型的文档各自匹配到对应的 schema 表单
    all_doc_ids = [j["document_id"] for j in jobs]
    primary_job_id = jobs[0]["job_id"]  # 用第一个 job_id 作为 task 追踪 ID

    run_extraction_task.delay(
        job_id=primary_job_id,
        patient_id=req.patient_id,
        schema_id=actual_schema_id,
        document_ids=all_doc_ids,
        instance_type=req.instance_type,
        project_id=req.project_id,
        target_section=req.target_section,
        target_sections=req.target_sections,
    )

    return {
        "success": True,
        "message": f"已提交合并抽取任务，共 {len(all_doc_ids)} 个文档",
        "jobs": jobs,
    }


# ── 流水线 API ───────────────────────────────────────────────────────────────

class PipelineProcessRequest(BaseModel):
    document_id: str = Field(..., description="文档 ID")
    tasks: List[str] = Field(
        ...,
        description="要执行的任务流水线，例如 ['ocr', 'meta']"
    )

@app.post("/api/pipeline/process")
async def process_document_pipeline(req: PipelineProcessRequest):
    """
    调度通用的文档处理任务组合（如 ocr -> meta）
    """
    if not req.tasks:
        raise HTTPException(status_code=400, detail="必须指定要执行的任务 (tasks 列表不能为空)")

    # 验证文档是否存在 (通过 CRFRepo 的连接池)
    repo = CRFRepo()
    with repo.connect() as conn:
        doc = conn.execute("SELECT id FROM documents WHERE id = ?", (req.document_id,)).fetchone()
        if not doc:
            raise HTTPException(status_code=404, detail=f"文档不存在: {req.document_id}")

    celery_sigs = []
    for t in req.tasks:
        if t == "ocr":
            celery_sigs.append(run_ocr_task.s(req.document_id))
        elif t == "meta":
            # 注意: 如果它是链中的第二个任务，它会接收前一个任务的返回值作为第一个参数。
            # run_metadata_task(self, document_id: str, *args) 它的签名支持被塞入前面的结果.
            # 为了链式调用正常，s(req.document_id) 被展开时是 args=(prev_result, req.document_id) 或者传 dict?
            # Celery 的 s(arg) 把 arg 作为签名的参数，前驱骤的结果会放在最前面： (prev_result, arg)
            # 在 tasks.py 我们定义了 run_metadata_task(self, document_id, *args, **kwargs)。
            # 这样前一步的结果会赋给 document_id, req.document_id 则会在 args[0]。
            # 因此，只有当它是单一任务时才传单参数，在 chain 时传的参数可能导致错位。
            # 简单起见，对于 metadata_task, 无论如何我们都在 tasks.py 使用它自己的内部 doc_id，
            # 这里的 .s() 可以写为 .si()（变成 immutable signature，忽略前面的结果传导）。
            # 因为 ocr 和 metadata_task 都自己拿 document_id 运行，没必要传递结果。
            celery_sigs.append(run_metadata_task.si(req.document_id))
        else:
            raise HTTPException(status_code=400, detail=f"不支持的任务类型: {t}")

    # 将第一个任务也变成 .si (忽略任何前面的东西) 以保持格式一致
    for i in range(len(celery_sigs)):
        if req.tasks[i] == "ocr":
            celery_sigs[i] = run_ocr_task.si(req.document_id)

    if len(celery_sigs) == 1:
        result = celery_sigs[0].apply_async()
    else:
        # 使用 chain 调度
        workflow = chain(*celery_sigs)
        result = workflow.apply_async()

    return {
        "success": True,
        "document_id": req.document_id,
        "message": f"流水线已派发: {req.tasks}",
        "celery_task_id": result.id,
    }


# ── 启动入口 ─────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=settings.CRF_SERVICE_PORT,
        reload=True,
    )
