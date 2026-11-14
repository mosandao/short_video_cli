#!/usr/bin/env python3
"""
常驻 ASR 转录服务（本地）

- OpenAI 兼容接口:
    POST /v1/audio/transcriptions   (multipart: file, language, model, response_format)
    GET  /health
- uvicorn 多 worker: 每个 worker 进程各加载一份模型 → N 路真并发（默认 4）
- 生命周期「谁启动谁负责关闭」: 本服务不会自我退出，由拉起方在任务结束后
  杀整个进程组（负 pid）。被杀时若有其他程序正在用，它们会探测到失联、
  自行重启服务并重试任务。

用法:
    python3 asr_server.py [--model <path>] [--port 8300] [--workers 4]
"""

import argparse
import os
import shutil
import sys
import tempfile
import threading
import time

# uvicorn worker 以 spawn 方式按模块名重导入本文件，确保可导入
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

MODEL_PATH = os.environ.get("ASR_MODEL_PATH", "/Users/yiyi/.omlx/models/Qwen3-ASR-0.6B-8bit")

_model_lock = threading.Lock()


def get_model():
    """当前进程的模型单例（每个 uvicorn worker 各一份，进程隔离即并发安全）

    uvicorn 会对 app 模块做两次导入（配置探测 + 实际服务），模块级全局变量
    会被重置，因此把模型实例挂在 builtins 上跨导入去重，避免双份模型占内存。
    """
    import builtins

    cached = getattr(builtins, "_asr_model_instance", None)
    if cached is not None and cached[0] == MODEL_PATH:
        return cached[1]

    from mlx_audio.stt.utils import load_model

    t0 = time.time()
    model = load_model(MODEL_PATH)
    builtins._asr_model_instance = (MODEL_PATH, model)
    print(
        f"[asr-server] pid={os.getpid()} 模型加载完成 "
        f"({time.time() - t0:.1f}s): {MODEL_PATH}",
        flush=True,
    )
    return model


if __name__ != "__main__":
    # worker 进程按模块导入 → 加载完模型才开始监听，/health 通即模型就绪。
    # 直接运行时（__main__，即 supervisor 进程）不加载。
    get_model()

from fastapi import FastAPI, Form, UploadFile
from fastapi.responses import JSONResponse

from mlx_audio.stt.generate import generate_transcription

app = FastAPI()

# 同一 worker 内 MLX 非线程安全，串行；跨 worker 天然并发
_generate_lock = threading.Lock()


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_PATH, "pid": os.getpid()}


@app.post("/v1/audio/transcriptions")
def transcribe(
    file: UploadFile,
    language: str = Form("zh"),
    model: str = Form(""),  # 兼容 OpenAI 字段，服务端固定用已加载的模型
    response_format: str = Form("json"),
):
    suffix = os.path.splitext(file.filename or "")[1] or ".m4a"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        shutil.copyfileobj(file.file, tmp)
        audio_path = tmp.name

    try:
        with _generate_lock:
            segments = generate_transcription(
                model=get_model(),
                audio=audio_path,
                output_path=audio_path + ".out",  # 产物写入临时路径，只用返回值
                format="json",
                language=language,
            )
        text = (getattr(segments, "text", "") or "").strip()
        return {"text": text, "language": language}
    except Exception as e:  # noqa: BLE001 - 转成 API 错误返回，不让 worker 崩掉
        return JSONResponse(status_code=500, content={"error": str(e)})
    finally:
        for p in (audio_path, audio_path + ".out.json"):
            try:
                os.unlink(p)
            except OSError:
                pass


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="本地常驻 ASR 转录服务")
    parser.add_argument("--model", default=MODEL_PATH, help="转录模型路径")
    parser.add_argument("--port", type=int, default=8300)
    parser.add_argument("--workers", type=int, default=4, help="并发 worker 数（各持一份模型）")
    args = parser.parse_args()

    # 子 worker 通过环境变量拿到模型路径
    os.environ["ASR_MODEL_PATH"] = args.model

    import uvicorn

    uvicorn.run(
        "asr_server:app",
        host="127.0.0.1",
        port=args.port,
        workers=args.workers,
        log_level="warning",
    )
