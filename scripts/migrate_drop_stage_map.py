"""丢弃 stage.map 列并回收空间（幂等）。

背景：stage.map 存的是整份关卡地图 JSON（含 npcs），实测平均 273KB、最大 1.4MB，
占整个数据库约 84%；而关卡详情接口只用到 stage_map_npc / stage_map_npc_character
两张派生表（npcs 在 build 时已抽取入库），前端从不读这一列。

本脚本做的事：
  1. 若 stage 表仍有 map 列 -> ALTER TABLE stage DROP COLUMN map；
  2. VACUUM 回收空间（198MB -> 约 32MB）。

幂等：已无 map 列时只做一次 VACUUM 检查，不重复改动。
原始 JSON（data/raw/zh-CN/stage/*.json）保留，随时可跑 build 重建；
回滚只需把 data/backup/ 里的快照复制回 data/db/gundam.db。
"""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))

from src import config  # noqa: E402


def _stage_columns(conn) -> list[str]:
    return [r[1] for r in conn.execute("PRAGMA table_info(stage)")]


def main() -> int:
    if not config.DB_PATH.exists():
        print(f"本地数据库不存在：{config.DB_PATH}")
        return 1
    before = config.DB_PATH.stat().st_size / 1048576

    conn = sqlite3.connect(config.DB_PATH)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        cols = _stage_columns(conn)
        if not cols:
            print("stage 表不存在，先跑 build_db() 再执行本脚本")
            return 1
        if "map" not in cols:
            print("stage.map 已不存在，无需迁移")
        else:
            n = conn.execute("SELECT COUNT(*) FROM stage").fetchone()[0]
            kept = conn.execute(
                "SELECT COUNT(*) FROM stage_map_npc"
            ).fetchone()[0]
            print(f"stage {n} 行，stage_map_npc 保留 {kept} 行（敌方数据不丢）")
            conn.execute("ALTER TABLE stage DROP COLUMN map")
            conn.commit()
            print("已丢弃 stage.map 列")

        print("VACUUM 回收空间…（大库需要几十秒）")
        conn.execute("VACUUM")
    finally:
        conn.close()

    after = config.DB_PATH.stat().st_size / 1048576
    print(
        f"完成：{before:.1f} MB -> {after:.1f} MB"
        f"（省 {before - after:.1f} MB）"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
