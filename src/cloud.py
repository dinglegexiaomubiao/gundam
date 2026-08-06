"""云端 PostgreSQL 数据源（Neon）。

本地数据库缺失时的兜底链：本地 SQLite -> 云端恢复 -> 爬取。
云端连接串通过环境变量 NEON_DB_URL 提供，不写入代码或仓库。
"""
from __future__ import annotations

import os
import pickle
import subprocess
import sqlite3
import sys
import time
from pathlib import Path

from . import config
from .db import SCHEMA

# 表顺序：父表在前（外键依赖），恢复 / 迁移时按此顺序写入。
TABLE_ORDER = [
    "tag",
    "faction",
    "series",
    "meta",
    "character",
    "unit",
    "supporter",
    "story_event",
    "tower_event",
    "stage",
    "character_ability",
    "character_skill",
    "unit_ability",
    "unit_skill",
    "unit_weapon",
    "supporter_growth",
    "supporter_skill",
    "story_event_boss",
    "tower_stage",
    "stage_map_npc",
    "stage_map_npc_character",
]


def get_cloud_url() -> str:
    return os.environ.get("NEON_DB_URL", "").strip()


def direct_cloud_url(url: str | None = None) -> str:
    """Neon 池化地址 -> 直连地址（同集群同账号，批量读写快得多）。

    pooler 形如 ep-xxx-pooler.<region>.aws.neon.tech，
    直连形如 ep-xxx.<region>.aws.neon.tech，去掉 "-pooler" 即可。
    """
    url = (url or get_cloud_url()).strip()
    if "-pooler." in url:
        return url.replace("-pooler.", ".", 1)
    return url


def _connect_pg(url: str, statement_timeout_ms: int | None = None):
    import psycopg  # 延迟导入：未装驱动时不影响其他命令

    conn = psycopg.connect(url, connect_timeout=20)
    if statement_timeout_ms:
        conn.execute(f"SET statement_timeout = {int(statement_timeout_ms)}")
    return conn


def cloud_available(url: str | None = None) -> bool:
    """云端是否存在 public 表（视为有数据可恢复）。"""
    url = direct_cloud_url(url)
    if not url:
        return False
    try:
        with _connect_pg(url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT COUNT(*) FROM information_schema.tables "
                    "WHERE table_schema = 'public'"
                )
                return cur.fetchone()[0] > 0
    except Exception as exc:  # noqa: BLE001
        print(f"云端连接失败：{exc}")
        return False


def restore_local_db_from_cloud(url: str | None = None,
                                db_path: Path | None = None) -> bool:
    """从云端 PostgreSQL 重建本地 SQLite 数据库。成功返回 True。

    批量读取走 Neon 直连地址（比池化快）。带断点续传：已恢复的表
    不会重复下载，失败的表在下一轮重试（最多 3 轮）；每张表由
    独立子进程拉取并带 180 秒硬超时（超时直接杀掉子进程），
    避免网络停流时无限挂起。
    """
    url = direct_cloud_url(url)
    if not url:
        print("未设置 NEON_DB_URL，无法从云端恢复")
        return False
    db_path = Path(db_path or config.DB_PATH)
    tmp = db_path.with_name(db_path.name + ".tmp")
    TABLE_TIMEOUT = 180  # 单表读取硬超时（秒）
    pkl = tmp.with_name(tmp.name + ".tbl.pkl")
    project_root = Path(__file__).resolve().parent.parent

    def fetch_table(tname: str) -> tuple[list, list]:
        """子进程拉取单表到 pickle 文件，父进程硬超时控制。"""
        if pkl.exists():
            pkl.unlink()
        env = {**os.environ, "NEON_FETCH_URL": url}
        try:
            proc = subprocess.run(
                [sys.executable, "-m", "src.cloud", "fetch-table",
                 tname, str(pkl)],
                timeout=TABLE_TIMEOUT,
                capture_output=True,
                text=True,
                env=env,
                cwd=str(project_root),
            )
        except subprocess.TimeoutExpired as exc:
            raise TimeoutError(
                f"表 {tname} 读取超时（>{TABLE_TIMEOUT}s）"
            ) from exc
        if proc.returncode != 0:
            detail = (proc.stderr or proc.stdout or "").strip()[-300:]
            raise RuntimeError(detail or f"表 {tname} 子进程异常退出")
        with open(pkl, "rb") as f:
            cols, rows = pickle.load(f)
        pkl.unlink(missing_ok=True)
        return cols, rows

    try:
        with _connect_pg(url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT table_name FROM information_schema.tables "
                    "WHERE table_schema = 'public'"
                )
                cloud_tables = {r[0] for r in cur.fetchall()}
        missing = [t for t in TABLE_ORDER if t not in cloud_tables]
        if missing:
            print(f"云端缺少表 {missing}，放弃恢复")
            return False
        db_path.parent.mkdir(parents=True, exist_ok=True)
        if tmp.exists():
            tmp.unlink()
        lite = sqlite3.connect(tmp)
        lite.executescript(SCHEMA)
        lite.execute("PRAGMA foreign_keys = OFF")
        done: set[str] = set()
        round_no = 0
        try:
            while round_no < 3:
                round_no += 1
                pending = [t for t in TABLE_ORDER if t not in done]
                if not pending:
                    break
                for tname in pending:
                    t0 = time.perf_counter()
                    lite.execute(f'DELETE FROM "{tname}"')
                    try:
                        cols, rows = fetch_table(tname)
                    except Exception as exc:  # noqa: BLE001
                        print(
                            f"  第 {round_no} 轮：表 {tname} 恢复失败："
                            f"{exc}"
                        )
                        continue
                    ph = ", ".join("?" for _ in cols)
                    cols_sql = ", ".join(f'"{c}"' for c in cols)
                    insert = (
                        f'INSERT INTO "{tname}" ({cols_sql}) '
                        f"VALUES ({ph})"
                    )
                    n = len(rows)
                    lite.executemany(insert, [tuple(r) for r in rows])
                    done.add(tname)
                    print(
                        f"  {tname}: {n} 行 "
                        f"({time.perf_counter() - t0:.1f}s)"
                    )
            pending = [t for t in TABLE_ORDER if t not in done]
            if pending:
                print(f"云端恢复失败：以下表未恢复 {pending}")
                try:
                    tmp.unlink()
                except OSError:
                    pass
                return False
            lite.commit()
        finally:
            lite.close()
        if tmp.stat().st_size == 0:
            tmp.unlink()
            return False
        os.replace(tmp, db_path)
        print(f"已从云端恢复本地数据库 -> {db_path}")
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"云端恢复失败：{exc}")
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass
        if pkl.exists():
            try:
                pkl.unlink()
            except OSError:
                pass
        return False


def _fetch_table_cli(tname: str, outfile: Path) -> int:
    """子进程入口：连接云端拉取单表，序列化 (列名, 行) 到文件。"""
    url = os.environ.get("NEON_FETCH_URL", "").strip()
    if not url:
        print("缺少 NEON_FETCH_URL", file=sys.stderr)
        return 2
    with _connect_pg(url, statement_timeout_ms=300_000) as conn:
        with conn.cursor() as cur:
            cur.execute(f'SELECT * FROM "{tname}"')
            cols = [d.name for d in cur.description]
            rows = cur.fetchall()
    with open(outfile, "wb") as f:
        pickle.dump((cols, [tuple(r) for r in rows]), f)
    return 0


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(prog="python -m src.cloud")
    sub = parser.add_subparsers(dest="cmd", required=True)
    fp = sub.add_parser("fetch-table")
    fp.add_argument("table")
    fp.add_argument("outfile")
    args = parser.parse_args()
    if args.cmd == "fetch-table":
        raise SystemExit(_fetch_table_cli(args.table, Path(args.outfile)))
