"""项目路径与抓取配置。"""
from __future__ import annotations

import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = PROJECT_ROOT / ".env"


def _load_env_file() -> None:
    """读取项目根目录 .env（被 git 忽略），已存在的环境变量优先。"""
    try:
        if not ENV_FILE.exists():
            return
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value
    except OSError:
        pass


_load_env_file()

DATA_DIR = PROJECT_ROOT / "data"
RAW_DIR = DATA_DIR / "raw" / "zh-CN"
META_DIR = DATA_DIR / "meta"
DB_PATH = DATA_DIR / "db" / "gundam.db"
MANIFEST_PATH = META_DIR / "manifest.json"

LANG = "zh-CN"
API_BASE = f"https://soshage.com/ggetapi/{LANG}"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
TIMEOUT_SEC = 30
MAX_WORKERS = 1                # 最保守：单线程串行
MAX_RETRIES = 5
RETRY_BACKOFF = (3, 6, 12, 24, 48)
MIN_REQUEST_INTERVAL = 1.8     # 全局最小请求间隔（秒），约 0.5 请求/秒
JITTER_MAX = 0.4               # 请求间隔随机抖动上限（秒），避免固定节奏
BATCH_SIZE = 200               # 每批次抓取数量
BATCH_PAUSE = 120              # 批次间暂停（秒），让限流窗口计数回落
