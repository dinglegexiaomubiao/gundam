"""把本地 SQLite 数据库整体迁移到云端 PostgreSQL（Neon）。

用法：
    $env:NEON_DB_URL = "postgresql://user:pass@host/db?sslmode=require"
    python scripts/migrate_cloud.py

脚本只读取本地 SQLite（只读模式），在云端 public schema 中重建同名表结构
并拷贝全部数据，最后逐表校验行数（核心逻辑见 src/cloud.py）。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.cloud import upload_local_db_to_cloud  # noqa: E402


def main() -> int:
    url = os.environ.get("NEON_DB_URL", "").strip()
    if not url:
        print("缺少 NEON_DB_URL 环境变量（PostgreSQL 连接串）", file=sys.stderr)
        return 2
    res = upload_local_db_to_cloud(url)
    counts = res.get("counts") or {}
    for tname, n in counts.items():
        print(f"  {tname}: {n} 行")
    print(res.get("message", ""))
    return 0 if res.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
