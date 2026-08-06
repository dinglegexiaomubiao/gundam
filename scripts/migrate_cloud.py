"""把本地 SQLite 数据库整体迁移到云端 PostgreSQL（Neon）。

用法：
    $env:NEON_DB_URL = "postgresql://user:pass@host/db?sslmode=require"
    python scripts/migrate_cloud.py

脚本只读取本地 SQLite（只读模式），在云端 public schema 中重建同名表结构
并拷贝全部数据，最后逐表校验行数。结构转换规则：
    INTEGER            -> BIGINT
    REAL/FLOAT/DOUBLE  -> DOUBLE PRECISION
    TEXT/CHAR/CLOB     -> TEXT
    BLOB               -> BYTEA
所有标识符统一加双引号（desc / condition 等为 PostgreSQL 保留字）。
"""
from __future__ import annotations

import os
import re
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import psycopg  # noqa: E402

from src import config  # noqa: E402
from src.cloud import TABLE_ORDER, direct_cloud_url  # noqa: E402


def _map_type(t: str) -> str:
    t = t.upper()
    if "INT" in t:
        return "BIGINT"
    if t.startswith(("REAL", "FLOA", "DOUB")):
        return "DOUBLE PRECISION"
    if "BLOB" in t:
        return "BYTEA"
    return "TEXT"


def _split_top(s: str) -> list[str]:
    """按顶层逗号拆分 CREATE TABLE 的字段/约束列表。"""
    parts: list[str] = []
    depth = 0
    cur: list[str] = []
    for ch in s:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append("".join(cur).strip())
            cur = []
        else:
            cur.append(ch)
    if cur:
        parts.append("".join(cur).strip())
    return parts


def _quote_ids(ids: str) -> str:
    return ", ".join(f'"{x.strip()}"' for x in ids.split(",") if x.strip())


def _translate_ddl(sqlite_sql: str) -> str:
    m = re.match(r"CREATE\s+TABLE\s+(\w+)\s*\((.*)\)\s*$", sqlite_sql.strip(), re.S | re.I)
    if not m:
        raise ValueError(f"无法解析建表语句: {sqlite_sql[:80]}")
    tname = m.group(1)
    body = m.group(2)
    cols: list[str] = []
    for chunk in _split_top(body):
        upper = chunk.upper()
        if upper.startswith("UNIQUE"):
            um = re.match(r"UNIQUE\s*\((.+)\)", chunk, re.S | re.I)
            if not um:
                raise ValueError(f"UNIQUE 解析失败: {chunk}")
            cols.append(f"UNIQUE ({_quote_ids(um.group(1))})")
        elif upper.startswith("FOREIGN KEY"):
            fm = re.match(
                r"FOREIGN\s+KEY\s*\((.+)\)\s*REFERENCES\s+(\w+)\s*\((.+)\)",
                chunk, re.S | re.I,
            )
            if not fm:
                raise ValueError(f"FOREIGN KEY 解析失败: {chunk}")
            cols.append(
                f"FOREIGN KEY ({_quote_ids(fm.group(1))}) "
                f'REFERENCES "{fm.group(2)}" ({_quote_ids(fm.group(3))})'
            )
        else:
            cm = re.match(r"^([A-Za-z_][\w]*)\s+(\S+)\s*(.*)$", chunk, re.S)
            if not cm:
                raise ValueError(f"字段定义解析失败: {chunk}")
            cname, ctype, rest = cm.group(1), cm.group(2), cm.group(3).strip()
            rest = re.sub(r"PRIMARY\s+KEY", "PRIMARY KEY", rest, flags=re.I)
            rest = rest.replace("AUTOINCREMENT", " ").strip()
            cols.append(f'"{cname}" {_map_type(ctype)} {rest}'.rstrip())
    return f'CREATE TABLE "{tname}" (\n  ' + ",\n  ".join(cols) + "\n)"


def _translate_index(idx_sql: str) -> str:
    m = re.match(
        r"CREATE\s+(?:UNIQUE\s+)?INDEX\s+(\w+)\s+ON\s+(\w+)\s*\((.+)\)",
        idx_sql.strip(), re.S | re.I,
    )
    if not m:
        raise ValueError(f"索引解析失败: {idx_sql[:80]}")
    return f'CREATE INDEX "{m.group(1)}" ON "{m.group(2)}" ({_quote_ids(m.group(3))})'


def main() -> int:
    url = os.environ.get("NEON_DB_URL", "").strip()
    if not url:
        print("缺少 NEON_DB_URL 环境变量（PostgreSQL 连接串）", file=sys.stderr)
        return 2

    sqlite_path = config.DB_PATH
    if not sqlite_path.exists():
        print(f"本地数据库不存在: {sqlite_path}", file=sys.stderr)
        return 2

    print(f"本地 SQLite: {sqlite_path} ({sqlite_path.stat().st_size / 1024 / 1024:.1f} MB)")

    con = sqlite3.connect(f"file:{sqlite_path}?mode=ro", uri=True)
    tables: dict[str, str] = {}
    indexes: list[str] = []
    for typ, name, sql in con.execute(
        "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid"
    ):
        if typ == "table":
            if name == "sqlite_sequence":
                continue
            tables[name] = sql
        elif typ == "index" and not name.startswith("sqlite_autoindex"):
            indexes.append(sql)

    missing = [t for t in TABLE_ORDER if t not in tables]
    if missing:
        print(f"本地缺少表: {missing}", file=sys.stderr)
        return 2
    print(f"待迁移表: {len(TABLE_ORDER)} 张，索引: {len(indexes)} 个")

    with psycopg.connect(direct_cloud_url(url), connect_timeout=30) as conn:
        conn.autocommit = False
        with conn.cursor() as cur:
            # 反向删除旧表（幂等）
            for tname in reversed(TABLE_ORDER):
                cur.execute(f'DROP TABLE IF EXISTS "{tname}" CASCADE')
            # 建表 + 索引
            for tname in TABLE_ORDER:
                ddl = _translate_ddl(tables[tname])
                cur.execute(ddl)
            for idx in indexes:
                cur.execute(_translate_index(idx))
        conn.commit()
        print("云端建表完成。")

        # 按依赖顺序导数据，每张表单独提交
        with conn.cursor() as cur:
            for tname in TABLE_ORDER:
                rows = con.execute(f'SELECT * FROM "{tname}"')
                desc = [d[0] for d in rows.description]
                placeholders = ", ".join(["%s"] * len(desc))
                cols_sql = ", ".join(f'"{c}"' for c in desc)
                insert = f'INSERT INTO "{tname}" ({cols_sql}) VALUES ({placeholders})'
                batch: list[tuple] = []
                n = 0
                for row in rows:
                    batch.append(tuple(row))
                    if len(batch) >= 2000:
                        cur.executemany(insert, batch)
                        batch = []
                    n += 1
                if batch:
                    cur.executemany(insert, batch)
                conn.commit()
                print(f"  {tname}: {n} 行")
        con.close()

        # 校验行数
        print("\n校验结果：")
        ok = True
        with conn.cursor() as cur:
            for tname in TABLE_ORDER:
                cur.execute(f'SELECT COUNT(*) FROM "{tname}"')
                cloud = cur.fetchone()[0]
                # 重新统计本地
                con2 = sqlite3.connect(f"file:{sqlite_path}?mode=ro", uri=True)
                local = con2.execute(f'SELECT COUNT(*) FROM "{tname}"').fetchone()[0]
                con2.close()
                mark = "OK" if local == cloud else "MISMATCH"
                if local != cloud:
                    ok = False
                print(f"  {tname}: 本地 {local} / 云端 {cloud}  {mark}")
        print("\n迁移", "成功" if ok else "存在不一致！")
        return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
