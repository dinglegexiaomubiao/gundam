"""极简健壮的 HTTP JSON 客户端（仅标准库）。

实现：
- http.client 连接复用（每个线程一条 keep-alive 连接，避免重复 TLS 握手）；
- 全局最小请求间隔（节流）；
- 403/429 视为限流：关闭连接、冷却后重试；
- 其他错误指数退避重试。
"""
from __future__ import annotations

import http.client
import json
import random
import ssl
import threading
import time
import urllib.parse
from pathlib import Path

from . import config


_request_lock = threading.Lock()
_last_request_time = 0.0
_thread_local = threading.local()
_rate_limit_hit = False
_rate_limit_lock = threading.Lock()


class RateLimitAbort(RuntimeError):
    """连续触发限流，主动终止整个抓取任务，避免加剧封禁。"""


def _throttle() -> None:
    """全局节流：保证任意两次请求开始时间间隔 >= MIN_REQUEST_INTERVAL。"""
    global _last_request_time
    with _request_lock:
        now = time.monotonic()
        wait = config.MIN_REQUEST_INTERVAL - (now - _last_request_time)
        if wait > 0:
            time.sleep(wait)
        time.sleep(random.uniform(0, config.JITTER_MAX))
        _last_request_time = time.monotonic()


def _get_conn() -> http.client.HTTPSConnection:
    conn = getattr(_thread_local, "conn", None)
    if conn is None:
        ctx = ssl.create_default_context()
        conn = http.client.HTTPSConnection(
            "soshage.com",
            timeout=config.TIMEOUT_SEC,
            context=ctx,
        )
        _thread_local.conn = conn
    return conn


def _close_conn() -> None:
    conn = getattr(_thread_local, "conn", None)
    if conn is not None:
        try:
            conn.close()
        except Exception:
            pass
        _thread_local.conn = None


def http_get_json(path: str, params: dict | None = None):
    """GET 站点 JSON API 并解析为 Python 对象（带节流、限流冷却与重试）。"""
    if _is_rate_limited():
        raise RateLimitAbort("上次已触发限流，任务终止")
    url = "/ggetapi/" + config.LANG + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    headers = {
        "User-Agent": config.USER_AGENT,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Accept-Encoding": "identity",
        "Connection": "keep-alive",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
    }
    last_err: Exception | None = None
    for attempt in range(config.MAX_RETRIES + 1):
        _throttle()
        try:
            conn = _get_conn()
            conn.request("GET", url, headers=headers)
            resp = conn.getresponse()
            raw = resp.read()
            if resp.status == 200:
                return json.loads(raw.decode("utf-8"))
            if resp.status in (403, 429):  # 限流：关闭连接 + 冷却
                _close_conn()
                _mark_rate_limited()
                raise RateLimitAbort(f"HTTP {resp.status} (rate limited)")
            last_err = RuntimeError(
                f"HTTP {resp.status} for GET {url}: {raw[:200]!r}"
            )
            if resp.status >= 500 and attempt < config.MAX_RETRIES:
                time.sleep(config.RETRY_BACKOFF[attempt])
                continue
            break
        except (http.client.HTTPException, OSError, ValueError) as exc:
            _close_conn()
            last_err = exc
            if attempt < config.MAX_RETRIES:
                time.sleep(config.RETRY_BACKOFF[attempt])
    raise RuntimeError(
        f"GET {url} failed after {config.MAX_RETRIES} retries: {last_err}"
    )


def _mark_rate_limited() -> None:
    global _rate_limit_hit
    with _rate_limit_lock:
        _rate_limit_hit = True


def _is_rate_limited() -> bool:
    with _rate_limit_lock:
        return _rate_limit_hit


def atomic_write_json(path: Path, obj) -> Path:
    """写 JSON 到临时文件后原子替换，避免中断产生半个文件。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False)
    tmp.replace(path)
    return path
