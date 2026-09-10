"""云端 PostgreSQL 数据源（Neon）。

本地数据库缺失时的兜底链：本地 SQLite -> 云端恢复 -> 爬取。
云端连接串通过环境变量 NEON_DB_URL 提供，不写入代码或仓库。
"""
from __future__ import annotations

import os
import pickle
import re
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
    # 机体 → 原作驾驶员映射（含人工修正 signal='manual'），随同步一起上云
    "unit_pilot",
    # 组队：用户保存的队伍（team）+ 全局评分参数（team_config），随同步一起上云
    "team",
    "team_config",
]


def get_cloud_url() -> str:
    return os.environ.get("NEON_DB_URL", "").strip()


# 记录最近一次云端操作失败原因，供 UI 展示友好提示
last_cloud_error: str = ""


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
    m = re.match(
        r"CREATE\s+TABLE\s+(\w+)\s*\((.*)\)\s*$", sqlite_sql.strip(), re.S | re.I
    )
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


def _local_schema() -> tuple[dict[str, str], list[str]]:
    """读取本地 SQLite 的表定义与索引。"""
    con = sqlite3.connect(f"file:{config.DB_PATH}?mode=ro", uri=True)
    try:
        tables: dict[str, str] = {}
        indexes: list[str] = []
        for typ, name, sql in con.execute(
            "SELECT type, name, sql FROM sqlite_master "
            "WHERE sql IS NOT NULL ORDER BY rowid"
        ):
            if typ == "table":
                if name != "sqlite_sequence":
                    tables[name] = sql
            elif typ == "index" and not name.startswith("sqlite_autoindex"):
                m = re.match(
                    r"CREATE\s+(?:UNIQUE\s+)?INDEX\s+\w+\s+ON\s+(\w+)",
                    sql.strip(), re.I,
                )
                if m and m.group(1) in TABLE_ORDER:
                    indexes.append(sql)
    finally:
        con.close()
    return tables, indexes


def _local_counts() -> dict[str, int] | None:
    """各表行数；数据库缺失或损坏返回 None。"""
    if not config.DB_PATH.exists():
        return None
    try:
        con = sqlite3.connect(f"file:{config.DB_PATH}?mode=ro", uri=True)
        try:
            return {
                t: con.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
                for t in TABLE_ORDER
            }
        finally:
            con.close()
    except sqlite3.Error:
        return None


def upload_local_db_to_cloud(url: str | None = None) -> dict:
    """把本地 SQLite 全量重建到云端（覆盖），逐表校验行数后返回结果。"""
    url = direct_cloud_url(url)
    if not url:
        return {"ok": False, "message": "未设置 NEON_DB_URL"}
    if not config.DB_PATH.exists():
        return {"ok": False, "message": f"本地数据库不存在: {config.DB_PATH}"}
    tables, indexes = _local_schema()
    missing = [t for t in TABLE_ORDER if t not in tables]
    if missing:
        return {"ok": False, "message": f"本地缺少表: {missing}"}
    import psycopg  # 延迟导入

    counts: dict[str, int] = {}
    try:
        with psycopg.connect(url, connect_timeout=30) as conn:
            conn.autocommit = False
            with conn.cursor() as cur:
                for tname in reversed(TABLE_ORDER):
                    cur.execute(f'DROP TABLE IF EXISTS "{tname}" CASCADE')
                for tname in TABLE_ORDER:
                    cur.execute(_translate_ddl(tables[tname]))
                for idx in indexes:
                    cur.execute(_translate_index(idx))
            conn.commit()
            con = sqlite3.connect(f"file:{config.DB_PATH}?mode=ro", uri=True)
            try:
                with conn.cursor() as cur:
                    for tname in TABLE_ORDER:
                        rows = con.execute(f'SELECT * FROM "{tname}"')
                        desc = [d[0] for d in rows.description]
                        ph = ", ".join(["%s"] * len(desc))
                        cols_sql = ", ".join(f'"{c}"' for c in desc)
                        insert = (
                            f'INSERT INTO "{tname}" ({cols_sql}) '
                            f"VALUES ({ph})"
                        )
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
                        counts[tname] = n
                conn.commit()
            finally:
                con.close()
            mism: list[tuple] = []
            with conn.cursor() as cur:
                for tname in TABLE_ORDER:
                    cur.execute(f'SELECT COUNT(*) FROM "{tname}"')
                    cloud = cur.fetchone()[0]
                    if cloud != counts.get(tname, 0):
                        mism.append((tname, counts.get(tname, 0), cloud))
        if mism:
            return {
                "ok": False,
                "message": f"上传后校验不一致: {mism}",
                "counts": counts,
            }
        return {"ok": True, "message": "已上传到服务器并校验一致", "counts": counts}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "message": _friendly_cloud_error(exc), "counts": counts}


def cloud_diff(url: str | None = None) -> dict:
    """对比本地与云端的各表行数、构建时间与本地完整性。"""
    url = direct_cloud_url(url)
    if not url:
        return {"ok": False, "error": "未配置 NEON_DB_URL"}
    local_counts = _local_counts()
    local_built = None
    local_check = None
    if local_counts is not None:
        try:
            con = sqlite3.connect(f"file:{config.DB_PATH}?mode=ro", uri=True)
            try:
                row = con.execute(
                    "SELECT value FROM meta WHERE key='built_at'"
                ).fetchone()
                local_built = row[0] if row else None
                local_check = con.execute("PRAGMA quick_check").fetchone()[0]
            finally:
                con.close()
        except sqlite3.Error:
            local_check = "error"
    cloud_counts: dict[str, int] | None = None
    cloud_built = None
    cloud_error = None
    try:
        with _connect_pg(url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT table_name FROM information_schema.tables "
                    "WHERE table_schema = 'public'"
                )
                cloud_tables = {r[0] for r in cur.fetchall()}
                cloud_counts = {}
                for t in TABLE_ORDER:
                    if t in cloud_tables:
                        cur.execute(f'SELECT COUNT(*) FROM "{t}"')
                        cloud_counts[t] = cur.fetchone()[0]
                    else:
                        cloud_counts[t] = -1
                if "meta" in cloud_tables:
                    cur.execute(
                        "SELECT value FROM meta WHERE key = 'built_at'"
                    )
                    crow = cur.fetchone()
                    cloud_built = crow[0] if crow else None
    except Exception as exc:  # noqa: BLE001
        cloud_error = _friendly_cloud_error(exc)
    if cloud_counts is None:
        return {"ok": False, "error": f"无法连接云端：{cloud_error}"}
    rows = []
    total_local = total_cloud = 0
    identical = True
    for t in TABLE_ORDER:
        loc = local_counts.get(t) if local_counts is not None else None
        clo = cloud_counts.get(t, -1)
        same = loc is not None and clo >= 0 and loc == clo
        if not same:
            identical = False
        if loc is not None:
            total_local += loc
        if clo >= 0:
            total_cloud += clo
        rows.append({
            "table": t,
            "local": loc,
            "cloud": None if clo < 0 else clo,
            "same": same,
        })
    return {
        "ok": True,
        "local_exists": local_counts is not None,
        "local_built_at": local_built,
        "local_quick_check": local_check,
        "cloud_exists": all(r["cloud"] is not None for r in rows),
        "cloud_built_at": cloud_built,
        "tables": rows,
        "identical": identical,
        "total_local": total_local,
        "total_cloud": total_cloud,
    }


def _ensure_cloud_weapon_columns(conn) -> None:
    """云端 unit_weapon 补齐 lv9 / 多伤害集合列（幂等）。"""
    for col, ctype in (
        ("power_lv9", "BIGINT"), ("en_lv9", "BIGINT"),
        ("hit_lv9", "BIGINT"), ("crit_lv9", "BIGINT"),
        ("weapon_attrs", "TEXT"),
    ):
        conn.execute(
            f'ALTER TABLE "unit_weapon" ADD COLUMN IF NOT EXISTS "{col}" {ctype}'
        )


def _row_to_dict(cur, row) -> dict:
    return {d.name: row[i] for i, d in enumerate(cur.description)}


def _unit_local(unit_id: int):
    """读取本地单机体：unit / weapons / abilities。"""
    con = sqlite3.connect(f"file:{config.DB_PATH}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        u = con.execute("SELECT * FROM unit WHERE id = ?", (unit_id,)).fetchone()
        if not u:
            return None
        u = dict(u)
        u["weapons"] = [
            dict(w) for w in con.execute(
                "SELECT * FROM unit_weapon WHERE unit_id = ? ORDER BY sort",
                (unit_id,),
            ).fetchall()
        ]
        u["abilities"] = [
            dict(a) for a in con.execute(
                "SELECT * FROM unit_ability WHERE unit_id = ? ORDER BY sort",
                (unit_id,),
            ).fetchall()
        ]
        return u
    finally:
        con.close()


def unit_sync_diff(unit_id: int) -> dict:
    """对比本地与云端单机体的差异（机体行 / 武器 / 能力）。"""
    local = _unit_local(unit_id)
    if not local:
        return {"ok": False, "error": "本地不存在该机体"}
    try:
        with _connect_pg(direct_cloud_url()) as conn:
            _ensure_cloud_weapon_columns(conn)
            conn.commit()
            with conn.cursor() as cur:
                cur.execute('SELECT * FROM "unit" WHERE id = %s', (unit_id,))
                urow = cur.fetchone()
                cu = _row_to_dict(cur, urow) if urow else None
                cur.execute(
                    'SELECT * FROM "unit_weapon" WHERE unit_id = %s ORDER BY sort',
                    (unit_id,),
                )
                cw = {r["weapon_id"]: r for r in (_row_to_dict(cur, x) for x in cur.fetchall())}
                cur.execute(
                    'SELECT * FROM "unit_ability" WHERE unit_id = %s ORDER BY sort',
                    (unit_id,),
                )
                ca = {r["ability_id"]: r for r in (_row_to_dict(cur, x) for x in cur.fetchall())}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"云端连接失败：{_friendly_cloud_error(exc)}"}
    if not cu:
        return {"ok": False, "error": "云端不存在该机体（可先做全量上传）"}

    diff: list[dict] = []
    skip_unit = {"id", "raw_path", "weapons", "abilities"}
    for k, v in local.items():
        if k in skip_unit:
            continue
        cv = cu.get(k)
        if str(cv) != str(v):
            diff.append({"section": "机体", "field": k, "old": cv, "new": v})
    skip_w = {"id", "unit_id", "sort", "raw_path"}
    for wid, w in enumerate(local["weapons"]):
        cw_row = cw.get(w["weapon_id"])
        if cw_row is None:
            diff.append({"section": "武器", "field": w["name"], "old": "云端缺失", "new": "存在"})
            continue
        for k, v in w.items():
            if k in skip_w:
                continue
            if str(cw_row.get(k)) != str(v):
                diff.append({"section": "武器", "field": f"{w['name']}·{k}", "old": cw_row.get(k), "new": v})
    local_aids = [a["ability_id"] for a in local["abilities"]]
    cloud_aids = list(ca.keys())
    if set(local_aids) != set(cloud_aids):
        diff.append({
            "section": "能力", "field": "列表",
            "old": f"云端 {len(cloud_aids)} 个", "new": f"本地 {len(local_aids)} 个",
        })
    else:
        for a in local["abilities"]:
            crow = ca.get(a["ability_id"])
            if crow and (str(crow.get("name")) != str(a.get("name"))
                         or str(crow.get("traits")) != str(a.get("traits"))):
                diff.append({
                    "section": "能力", "field": a.get("name") or str(a["ability_id"]),
                    "old": "内容不同", "new": "以本地为准",
                })
    return {"ok": True, "identical": not diff, "diff": diff}


def unit_sync_push(unit_id: int) -> dict:
    """把本地单机体全量写入云端（该机体 unit / weapons / abilities 覆盖）。"""
    local = _unit_local(unit_id)
    if not local:
        return {"ok": False, "error": "本地不存在该机体"}
    import psycopg  # noqa: F401

    try:
        with _connect_pg(direct_cloud_url()) as conn:
            _ensure_cloud_weapon_columns(conn)
            with conn.cursor() as cur:
                # unit 行 UPSERT
                unit_cols = [c for c in local if c not in ("weapons", "abilities")]
                ucols_sql = ", ".join(f'"{c}"' for c in unit_cols)
                uph = ", ".join(["%s"] * len(unit_cols))
                update_sql = ", ".join(
                    f'"{c}" = EXCLUDED."{c}"' for c in unit_cols if c != "id"
                )
                cur.execute(
                    f'INSERT INTO "unit" ({ucols_sql}) VALUES ({uph}) '
                    f'ON CONFLICT ("id") DO UPDATE SET {update_sql}',
                    [local[c] for c in unit_cols],
                )
                # 武器 UPSERT
                if local["weapons"]:
                    w_cols = [c for c in local["weapons"][0] if c != "sort"]
                    wcols_sql = ", ".join(f'"{c}"' for c in w_cols)
                    wph = ", ".join(["%s"] * len(w_cols))
                    wupd = ", ".join(
                        f'"{c}" = EXCLUDED."{c}"'
                        for c in w_cols if c not in ("weapon_id", "id")
                    )
                    for w in local["weapons"]:
                        cur.execute(
                            f'INSERT INTO "unit_weapon" ({wcols_sql}) VALUES ({wph}) '
                            f'ON CONFLICT ("unit_id", "weapon_id") DO UPDATE SET {wupd}',
                            [w[c] for c in w_cols],
                        )
                # 能力整体替换
                cur.execute('DELETE FROM "unit_ability" WHERE unit_id = %s', (unit_id,))
                for i, a in enumerate(local["abilities"]):
                    cur.execute(
                        'INSERT INTO "unit_ability" '
                        '(id, unit_id, ability_id, sort, name, "desc", ability_type, traits) '
                        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
                        (a["id"], unit_id, a["ability_id"], i + 1, a.get("name"),
                         a.get("desc"), a.get("ability_type"), a.get("traits")),
                    )
            conn.commit()
        return {"ok": True, "message": "该机体已同步到服务器"}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"同步失败：{exc}"}


def restore_unit_locally(unit: dict) -> None:
    """把单机体快照整行写回本地库（爬取重建后保留编辑用）。"""
    con = sqlite3.connect(config.DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA foreign_keys=ON")
    def cols_sql(keys):
        return ", ".join(f'"{c}"' for c in keys)

    def ph(n):
        return ", ".join("?" * n)

    try:
        con.execute("BEGIN")
        con.execute("DELETE FROM unit_ability WHERE unit_id = ?", (unit["id"],))
        con.execute("DELETE FROM unit_weapon WHERE unit_id = ?", (unit["id"],))
        con.execute("DELETE FROM unit WHERE id = ?", (unit["id"],))
        cols = [c for c in unit if c not in ("weapons", "abilities")]
        con.execute(
            f'INSERT INTO "unit" ({cols_sql(cols)}) VALUES ({ph(len(cols))})',
            [unit[c] for c in cols],
        )
        for w in unit.get("weapons") or []:
            wcols = [c for c in w if c != "sort"]
            con.execute(
                f'INSERT INTO "unit_weapon" ({cols_sql(wcols)}) '
                f'VALUES ({ph(len(wcols))})',
                [w[c] for c in wcols],
            )
        for i, a in enumerate(unit.get("abilities") or []):
            acols = [c for c in a if c != "sort"]
            con.execute(
                f'INSERT INTO "unit_ability" ({cols_sql(acols)}) '
                f'VALUES ({ph(len(acols))})',
                [a[c] for c in acols],
            )
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()


def _character_local(char_id: int):
    """读取本地单驾驶员：character / skills / abilities。"""
    con = sqlite3.connect(f"file:{config.DB_PATH}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        c = con.execute("SELECT * FROM character WHERE id = ?", (char_id,)).fetchone()
        if not c:
            return None
        c = dict(c)
        c["skills"] = [
            dict(r) for r in con.execute(
                "SELECT * FROM character_skill WHERE character_id = ? ORDER BY sort",
                (char_id,),
            ).fetchall()
        ]
        c["abilities"] = [
            dict(r) for r in con.execute(
                "SELECT * FROM character_ability WHERE character_id = ? ORDER BY sort",
                (char_id,),
            ).fetchall()
        ]
        return c
    finally:
        con.close()


def restore_character_locally(snap: dict) -> None:
    """把单驾驶员快照整行写回本地库（爬取重建后保留编辑用）。"""
    con = sqlite3.connect(config.DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA foreign_keys=ON")

    def cols_sql(keys):
        return ", ".join(f'"{c}"' for c in keys)

    def ph(n):
        return ", ".join("?" * n)

    try:
        con.execute("BEGIN")
        con.execute("DELETE FROM character_ability WHERE character_id = ?",
                    (snap["id"],))
        con.execute("DELETE FROM character_skill WHERE character_id = ?",
                    (snap["id"],))
        con.execute("DELETE FROM character WHERE id = ?", (snap["id"],))
        cols = [c for c in snap if c not in ("skills", "abilities")]
        con.execute(
            f'INSERT INTO "character" ({cols_sql(cols)}) VALUES ({ph(len(cols))})',
            [snap[c] for c in cols],
        )
        for sk in snap.get("skills") or []:
            skcols = [c for c in sk if c != "sort"]
            con.execute(
                f'INSERT INTO "character_skill" ({cols_sql(skcols)}) '
                f'VALUES ({ph(len(skcols))})',
                [sk[c] for c in skcols],
            )
        for a in snap.get("abilities") or []:
            acols = [c for c in a if c != "sort"]
            con.execute(
                f'INSERT INTO "character_ability" ({cols_sql(acols)}) '
                f'VALUES ({ph(len(acols))})',
                [a[c] for c in acols],
            )
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()


def character_sync_diff(char_id: int) -> dict:
    """对比本地与云端单驾驶员的差异（主行 / 技能 / 能力）。"""
    local = _character_local(char_id)
    if not local:
        return {"ok": False, "error": "本地不存在该驾驶员"}
    try:
        with _connect_pg(direct_cloud_url()) as conn:
            with conn.cursor() as cur:
                cur.execute('SELECT * FROM "character" WHERE id = %s', (char_id,))
                urow = cur.fetchone()
                cc = _row_to_dict(cur, urow) if urow else None
                cur.execute(
                    'SELECT * FROM "character_skill" WHERE character_id = %s '
                    "ORDER BY sort",
                    (char_id,),
                )
                ck = {r["character_skill_id"]: r
                      for r in (_row_to_dict(cur, x) for x in cur.fetchall())}
                cur.execute(
                    'SELECT * FROM "character_ability" WHERE character_id = %s '
                    "ORDER BY sort",
                    (char_id,),
                )
                ca = {r["ability_id"]: r
                      for r in (_row_to_dict(cur, x) for x in cur.fetchall())}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"云端连接失败：{_friendly_cloud_error(exc)}"}
    if not cc:
        return {"ok": False, "error": "云端不存在该驾驶员（可先做全量上传）"}

    diff: list[dict] = []
    skip_char = {"id", "raw_path", "skills", "abilities"}
    for k, v in local.items():
        if k in skip_char:
            continue
        cv = cc.get(k)
        if str(cv) != str(v):
            diff.append({"section": "驾驶员", "field": k, "old": cv, "new": v})
    skip_s = {"id", "character_id", "sort"}
    for sk in local["skills"]:
        csk = ck.get(sk.get("character_skill_id"))
        if csk is None:
            diff.append({"section": "技能", "field": sk.get("name") or sk.get("character_skill_id"),
                         "old": "云端缺失", "new": "存在"})
            continue
        for k, v in sk.items():
            if k in skip_s:
                continue
            if str(csk.get(k)) != str(v):
                diff.append({"section": "技能", "field": f"{sk.get('name') or ''}·{k}",
                             "old": csk.get(k), "new": v})
    skip_a = {"id", "character_id", "sort"}
    for a in local["abilities"]:
        ca_row = ca.get(a.get("ability_id"))
        if ca_row is None:
            diff.append({"section": "能力", "field": a.get("name") or a.get("ability_id"),
                         "old": "云端缺失", "new": "存在"})
            continue
        for k, v in a.items():
            if k in skip_a:
                continue
            if str(ca_row.get(k)) != str(v):
                diff.append({"section": "能力", "field": f"{a.get('name') or ''}·{k}",
                             "old": ca_row.get(k), "new": v})
    return {"ok": True, "identical": not diff, "diff": diff}


def _ensure_cloud_character_columns(conn, table: str, rows: list[dict]) -> None:
    """按本地行字段幂等补齐云端 character/character_skill/character_ability
    缺失列（与 _ensure_cloud_weapon_columns 同理，防云端表早于本地新增列）。"""
    for row in rows:
        for col, val in row.items():
            if col == "id":
                continue
            ctype = "BIGINT" if isinstance(val, int) else "TEXT"
            conn.execute(
                f'ALTER TABLE "{table}" ADD COLUMN IF NOT EXISTS "{col}" {ctype}'
            )
        return


def character_sync_push(char_id: int) -> dict:
    """把本地单驾驶员全量写入云端（character / skills / abilities 覆盖）。"""
    local = _character_local(char_id)
    if not local:
        return {"ok": False, "error": "本地不存在该驾驶员"}
    import psycopg  # noqa: F401

    try:
        with _connect_pg(direct_cloud_url()) as conn:
            with conn.cursor() as cur:
                char_cols = [c for c in local if c not in ("skills", "abilities")]
                _ensure_cloud_character_columns(conn, "character",
                                                [{c: local[c] for c in char_cols}])
                _ensure_cloud_character_columns(conn, "character_skill",
                                                local["skills"])
                _ensure_cloud_character_columns(conn, "character_ability",
                                                local["abilities"])
                ccols_sql = ", ".join(f'"{c}"' for c in char_cols)
                cph = ", ".join(["%s"] * len(char_cols))
                cupd = ", ".join(
                    f'"{c}" = EXCLUDED."{c}"' for c in char_cols if c != "id"
                )
                cur.execute(
                    f'INSERT INTO "character" ({ccols_sql}) VALUES ({cph}) '
                    f'ON CONFLICT ("id") DO UPDATE SET {cupd}',
                    [local[c] for c in char_cols],
                )
                # 技能 / 能力整体替换（不写本地自增 id，交给云端分配，避免主键冲突）
                cur.execute(
                    'DELETE FROM "character_skill" WHERE character_id = %s',
                    (char_id,),
                )
                for sk in local["skills"]:
                    skcols = [c for c in sk if c not in ("id", "sort")]
                    s_sql = ", ".join(f'"{c}"' for c in skcols)
                    s_ph = ", ".join(["%s"] * len(skcols))
                    cur.execute(
                        f'INSERT INTO "character_skill" ({s_sql}) VALUES ({s_ph})',
                        [sk[c] for c in skcols],
                    )
                cur.execute(
                    'DELETE FROM "character_ability" WHERE character_id = %s',
                    (char_id,),
                )
                for a in local["abilities"]:
                    acols = [c for c in a if c not in ("id", "sort")]
                    a_sql = ", ".join(f'"{c}"' for c in acols)
                    a_ph = ", ".join(["%s"] * len(acols))
                    cur.execute(
                        f'INSERT INTO "character_ability" ({a_sql}) VALUES ({a_ph})',
                        [a[c] for c in acols],
                    )
            conn.commit()
        return {"ok": True, "message": "该驾驶员已同步到服务器"}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"同步失败：{exc}"}


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

    last = None
    for attempt in (1, 2):
        try:
            conn = psycopg.connect(url, connect_timeout=20)
            if statement_timeout_ms:
                conn.execute(f"SET statement_timeout = {int(statement_timeout_ms)}")
            return conn
        except psycopg.OperationalError as exc:
            last = exc
            if attempt == 1:
                time.sleep(2)
    raise last if last is not None else RuntimeError("connect failed")


def _friendly_cloud_error(exc: Exception) -> str:
    """Convert common cloud connection errors to actionable Chinese hints."""
    text = str(exc)
    low = text.lower()
    if "no module named 'psycopg'" in low or "no module named psycopg" in low:
        return "缺少 psycopg 驱动，请运行 pip install \"psycopg[binary]\" 后重试"
    if "permission denied" in low or "10013" in text or "wsaeacces" in low:
        return (
            "云端连接被系统拦截（网络权限不足，错误 10013）。"
            "请确认服务进程允许访问外网（例如在普通终端运行，或放行防火墙/安全软件）后重试同步。"
        )
    if "timed out" in low or "timeout" in low:
        return f"连接云端超时：{text}"
    if ("name or service not known" in low or "getaddrinfo" in low
            or "nodename nor servname" in low):
        return f"无法解析云端地址（DNS 失败）：{text}"
    if "connection refused" in low:
        return f"云端拒绝连接：{text}"
    if "connection reset" in low or "broken pipe" in low or "connection closed" in low:
        return f"云端连接中断：{text}"
    return text


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
    global last_cloud_error
    url = direct_cloud_url(url)
    if not url:
        last_cloud_error = "未设置 NEON_DB_URL，无法从云端恢复"
        print(last_cloud_error)
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
            last_cloud_error = f"云端缺少表 {missing}，放弃恢复"
            print(last_cloud_error)
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
                    # 只写入本地 schema 里存在的列：云端可能残留旧版本的列
                    # （例如已废弃的 stage.map），否则 INSERT 会整表失败。
                    local_cols = {
                        r[1] for r in lite.execute(f'PRAGMA table_info("{tname}")')
                    }
                    use = [i for i, c in enumerate(cols) if c in local_cols]
                    dropped = [c for c in cols if c not in local_cols]
                    if dropped:
                        print(f"  {tname}: 跳过本地不存在的列 {dropped}")
                    if not use:
                        raise RuntimeError(f"表 {tname} 与本地 schema 无共同列")
                    use_cols = [cols[i] for i in use]
                    ph = ", ".join("?" for _ in use_cols)
                    cols_sql = ", ".join(f'"{c}"' for c in use_cols)
                    insert = (
                        f'INSERT INTO "{tname}" ({cols_sql}) '
                        f"VALUES ({ph})"
                    )
                    n = len(rows)
                    lite.executemany(
                        insert, [tuple(r[i] for i in use) for r in rows]
                    )
                    done.add(tname)
                    print(
                        f"  {tname}: {n} 行 "
                        f"({time.perf_counter() - t0:.1f}s)"
                    )
            pending = [t for t in TABLE_ORDER if t not in done]
            if pending:
                last_cloud_error = f"云端恢复失败：以下表未恢复 {pending}"
                print(last_cloud_error)
                try:
                    tmp.unlink()
                except OSError:
                    pass
                return False
            lite.commit()
        finally:
            lite.close()
        if tmp.stat().st_size == 0:
            last_cloud_error = "云端数据为空"
            tmp.unlink()
            return False
        os.replace(tmp, db_path)
        print(f"已从云端恢复本地数据库 -> {db_path}")
        return True
    except Exception as exc:  # noqa: BLE001
        last_cloud_error = _friendly_cloud_error(exc)
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


UNIT_PILOT_DDL = (
    "CREATE TABLE IF NOT EXISTS unit_pilot ("
    "unit_id INTEGER PRIMARY KEY, pilot_id INTEGER NOT NULL, "
    "unit_name TEXT, pilot_name TEXT, score INTEGER, signal TEXT, "
    "updated_at TEXT)"
)
UNIT_PILOT_COLS = ["unit_id", "pilot_id", "unit_name", "pilot_name", "score", "signal", "updated_at"]


def _ensure_local_unit_pilot(con: sqlite3.Connection) -> None:
    con.execute(UNIT_PILOT_DDL)
    con.execute(
        "CREATE INDEX IF NOT EXISTS idx_unit_pilot_pilot ON unit_pilot(pilot_id)"
    )
    # 老库补 updated_at 列（CREATE TABLE IF NOT EXISTS 在表已存在时不会加列）
    try:
        cols = {r[1] for r in con.execute("PRAGMA table_info(unit_pilot)")}
        if "updated_at" not in cols:
            con.execute("ALTER TABLE unit_pilot ADD COLUMN updated_at TEXT")
    except sqlite3.OperationalError:
        pass
    con.commit()


def _ensure_cloud_unit_pilot_columns(cur) -> None:
    """云端 unit_pilot 若缺 updated_at 列则补齐（幂等，Neon PG 支持 ADD COLUMN IF NOT EXISTS）。"""
    cur.execute(
        'ALTER TABLE "unit_pilot" ADD COLUMN IF NOT EXISTS updated_at TEXT'
    )


def upload_unit_pilot_to_cloud(url: str | None = None) -> dict:
    """只上传 unit_pilot 原作映射表到云端（建表 + 按 unit_id 覆盖写）。

    整库迁移要重传 190MB，映射表只有 1 千多行，单独同步更快。
    人工修正（signal='manual'）也会一并上传，换机器不丢。
    """
    url = direct_cloud_url(url)
    if not url:
        return {"ok": False, "message": "未设置 NEON_DB_URL"}
    if not config.DB_PATH.exists():
        return {"ok": False, "message": f"本地数据库不存在: {config.DB_PATH}"}

    con = sqlite3.connect(f"file:{config.DB_PATH}?mode=ro", uri=True)
    try:
        has = con.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='unit_pilot'"
        ).fetchone()
        if not has:
            return {"ok": False, "message": "本地无 unit_pilot 表，先跑 scripts/build_unit_pilot.py"}
        rows = con.execute(
            f"SELECT {', '.join(UNIT_PILOT_COLS)} FROM unit_pilot"
        ).fetchall()
    finally:
        con.close()

    if not rows:
        return {"ok": False, "message": "本地 unit_pilot 为空，无可上传数据"}

    import psycopg  # 延迟导入

    cols = ", ".join(f'"{c}"' for c in UNIT_PILOT_COLS)
    ph = ", ".join(["%s"] * len(UNIT_PILOT_COLS))
    upd = ", ".join(
        f'"{c}"=EXCLUDED."{c}"' for c in UNIT_PILOT_COLS if c != "unit_id"
    )
    try:
        with psycopg.connect(url, connect_timeout=30) as conn:
            conn.autocommit = False
            with conn.cursor() as cur:
                cur.execute(UNIT_PILOT_DDL)
                _ensure_cloud_unit_pilot_columns(cur)
                cur.execute(
                    "CREATE INDEX IF NOT EXISTS idx_unit_pilot_pilot "
                    "ON unit_pilot(pilot_id)"
                )
                cur.executemany(
                    f"INSERT INTO unit_pilot ({cols}) VALUES ({ph}) "
                    f"ON CONFLICT (unit_id) DO UPDATE SET {upd}",
                    [tuple(r) for r in rows],
                )
                cur.execute("SELECT COUNT(*) FROM unit_pilot")
                cloud_n = cur.fetchone()[0]
            conn.commit()
        return {
            "ok": True,
            "uploaded": len(rows),
            "cloud_rows": cloud_n,
            "message": f"unit_pilot 已上传 {len(rows)} 行，云端现有 {cloud_n} 行",
        }
    except Exception as exc:  # 云端异常不应带崩本地流程
        return {"ok": False, "message": f"上传失败：{exc}"}


def push_unit_pilot_row(unit_id: int, url: str | None = None) -> dict:
    """单条同步 unit_pilot 到云端（编辑后实时调用，毫秒级）。

    - 本地存在该行 → upsert（含 updated_at，用于冲突判定）。
    - 本地已删除该行（用户清除了映射）→ 从云端删除，避免云端残留旧映射。
    - 云端表缺列时自动补齐 updated_at，老的云端表兼容。
    - 云端不可达时返回 ok=False，由调用方降级处理（不阻塞本地编辑）。
    """
    url = direct_cloud_url(url)
    if not url:
        return {"ok": False, "message": "未设置 NEON_DB_URL"}
    if not config.DB_PATH.exists():
        return {"ok": False, "message": f"本地数据库不存在: {config.DB_PATH}"}

    con = sqlite3.connect(f"file:{config.DB_PATH}?mode=ro", uri=True)
    try:
        has = con.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='unit_pilot'"
        ).fetchone()
        if not has:
            return {"ok": False, "message": "本地无 unit_pilot 表"}
        # 老库可能没有 updated_at 列；用列清单动态取，缺列则取不到（None）
        cols = [r[1] for r in con.execute("PRAGMA table_info(unit_pilot)")]
        sel = ", ".join(cols)
        row = con.execute(
            f"SELECT {sel} FROM unit_pilot WHERE unit_id = ?", (unit_id,)
        ).fetchone()
        if row is not None:
            row = dict(zip(cols, row))
    finally:
        con.close()

    import psycopg  # 延迟导入

    try:
        with psycopg.connect(url, connect_timeout=30) as conn:
            with conn.cursor() as cur:
                cur.execute(UNIT_PILOT_DDL)
                _ensure_cloud_unit_pilot_columns(cur)
                if row is None:
                    cur.execute(
                        'DELETE FROM "unit_pilot" WHERE unit_id = %s', (unit_id,)
                    )
                else:
                    # 缺 updated_at 列时补空字符串，保证 7 列对齐
                    vals = [row.get(c) for c in UNIT_PILOT_COLS]
                    csql = ", ".join(f'"{c}"' for c in UNIT_PILOT_COLS)
                    cph = ", ".join(["%s"] * len(UNIT_PILOT_COLS))
                    cupd = ", ".join(
                        f'"{c}"=EXCLUDED."{c}"'
                        for c in UNIT_PILOT_COLS if c != "unit_id"
                    )
                    cur.execute(
                        f'INSERT INTO "unit_pilot" ({csql}) VALUES ({cph}) '
                        f'ON CONFLICT (unit_id) DO UPDATE SET {cupd}',
                        vals,
                    )
            conn.commit()
        return {"ok": True, "message": "已同步 1 条到服务器" if row is not None
                else "已从云端删除该映射"}
    except Exception as exc:  # 云端异常不应带崩本地编辑流程
        return {"ok": False, "message": f"同步失败：{exc}"}


# ---------------------------------------------------------------------------
# 组队（team / team_config）云端单行同步
# 组队是用户个人数据，编辑/删除后实时单条上云；本地删除则云端同步删除。
# ---------------------------------------------------------------------------
TEAM_DDL = (
    "CREATE TABLE IF NOT EXISTS team ("
    "team_id TEXT PRIMARY KEY, name TEXT, "
    "payload TEXT NOT NULL, updated_at TEXT)"
)
TEAM_COLS = ["team_id", "name", "payload", "updated_at"]

TEAM_CONFIG_DDL = (
    "CREATE TABLE IF NOT EXISTS team_config ("
    "gkey TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT)"
)
TEAM_CONFIG_COLS = ["gkey", "payload", "updated_at"]


def push_team_row(team_id: str, url: str | None = None) -> dict:
    """单条同步 team 到云端（编辑/删除后实时调用）。本地存在→upsert，已删→云端删除。"""
    url = direct_cloud_url(url)
    if not url:
        return {"ok": False, "message": "未设置 NEON_DB_URL"}
    if not config.DB_PATH.exists():
        return {"ok": False, "message": f"本地数据库不存在: {config.DB_PATH}"}
    con = sqlite3.connect(f"file:{config.DB_PATH}?mode=ro", uri=True)
    try:
        has = con.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='team'"
        ).fetchone()
        if not has:
            return {"ok": False, "message": "本地无 team 表"}
        row = con.execute(
            f"SELECT {', '.join(TEAM_COLS)} FROM team WHERE team_id = ?", (team_id,)
        ).fetchone()
    finally:
        con.close()

    import psycopg  # 延迟导入

    try:
        with psycopg.connect(url, connect_timeout=30) as conn:
            with conn.cursor() as cur:
                cur.execute(TEAM_DDL)
                if row is None:
                    cur.execute('DELETE FROM "team" WHERE team_id = %s', (team_id,))
                else:
                    csql = ", ".join(f'"{c}"' for c in TEAM_COLS)
                    cph = ", ".join(["%s"] * len(TEAM_COLS))
                    cupd = ", ".join(
                        f'"{c}"=EXCLUDED."{c}"' for c in TEAM_COLS if c != "team_id"
                    )
                    cur.execute(
                        f'INSERT INTO "team" ({csql}) VALUES ({cph}) '
                        f'ON CONFLICT (team_id) DO UPDATE SET {cupd}',
                        tuple(row),
                    )
            conn.commit()
        return {"ok": True, "message": "已同步 1 条到服务器" if row is not None
                else "已从云端删除该队伍"}
    except Exception as exc:  # 云端异常不应带崩本地编辑流程
        return {"ok": False, "message": f"同步失败：{exc}"}


def push_team_config_row(gkey: str = "default", url: str | None = None) -> dict:
    """单条同步 team_config（全局 bench/customEnemy）到云端。本地存在→upsert，已删→云端删除。"""
    url = direct_cloud_url(url)
    if not url:
        return {"ok": False, "message": "未设置 NEON_DB_URL"}
    if not config.DB_PATH.exists():
        return {"ok": False, "message": f"本地数据库不存在: {config.DB_PATH}"}
    con = sqlite3.connect(f"file:{config.DB_PATH}?mode=ro", uri=True)
    try:
        has = con.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='team_config'"
        ).fetchone()
        if not has:
            return {"ok": False, "message": "本地无 team_config 表"}
        row = con.execute(
            f"SELECT {', '.join(TEAM_CONFIG_COLS)} FROM team_config WHERE gkey = ?",
            (gkey,),
        ).fetchone()
    finally:
        con.close()

    import psycopg  # 延迟导入

    try:
        with psycopg.connect(url, connect_timeout=30) as conn:
            with conn.cursor() as cur:
                cur.execute(TEAM_CONFIG_DDL)
                if row is None:
                    cur.execute('DELETE FROM "team_config" WHERE gkey = %s', (gkey,))
                else:
                    csql = ", ".join(f'"{c}"' for c in TEAM_CONFIG_COLS)
                    cph = ", ".join(["%s"] * len(TEAM_CONFIG_COLS))
                    cupd = ", ".join(
                        f'"{c}"=EXCLUDED."{c}"' for c in TEAM_CONFIG_COLS if c != "gkey"
                    )
                    cur.execute(
                        f'INSERT INTO "team_config" ({csql}) VALUES ({cph}) '
                        f'ON CONFLICT (gkey) DO UPDATE SET {cupd}',
                        tuple(row),
                    )
            conn.commit()
        return {"ok": True, "message": "已同步全局配置到服务器" if row is not None
                else "已从云端删除该配置"}
    except Exception as exc:  # 云端异常不应带崩本地编辑流程
        return {"ok": False, "message": f"同步失败：{exc}"}


def restore_unit_pilot_from_cloud(url: str | None = None) -> dict:
    """把云端 unit_pilot 合并回本地（按 updated_at 取较新一方，本地独有保留）。

    合并规则：
    - 云端有新行、本地没有 → 采用云端。
    - 两边都有 → 比较 updated_at（缺失视为最旧），取较新者。
    - 本地有、云端没有 → 保留本地（不删除）。
    这样本地刚做的人工修正不会被一次「服务器同步到本地」覆盖掉。
    """
    url = direct_cloud_url(url)
    if not url:
        return {"ok": False, "message": "未设置 NEON_DB_URL"}

    import psycopg  # 延迟导入

    cols = ", ".join(f'"{c}"' for c in UNIT_PILOT_COLS)
    try:
        with psycopg.connect(url, connect_timeout=30) as conn:
            with conn.cursor() as cur:
                cur.execute(UNIT_PILOT_DDL)
                _ensure_cloud_unit_pilot_columns(cur)
                cur.execute(f"SELECT {cols} FROM unit_pilot")
                cloud_rows = cur.fetchall()
    except Exception as exc:
        return {"ok": False, "message": f"读取云端失败：{exc}"}

    if not cloud_rows:
        return {"ok": False, "message": "云端 unit_pilot 为空"}

    con = sqlite3.connect(config.DB_PATH)
    con.row_factory = sqlite3.Row
    try:
        _ensure_local_unit_pilot(con)
        local_by_id = {
            r["unit_id"]: dict(r) for r in con.execute(
                f"SELECT {', '.join(UNIT_PILOT_COLS)} FROM unit_pilot"
            )
        }
        merged: dict[int, dict] = {}
        for cr in cloud_rows:
            d = dict(zip(UNIT_PILOT_COLS, cr))
            uid = d["unit_id"]
            local = local_by_id.get(uid)
            if local is None:
                merged[uid] = d  # 云端新行
            else:
                # 比较更新时间：缺失视为最旧，取较新者
                cc = d.get("updated_at") or ""
                lc = local.get("updated_at") or ""
                merged[uid] = d if cc >= lc else local
        # 本地独有（云端没有）一律保留
        for uid, lr in local_by_id.items():
            merged.setdefault(uid, lr)
        ph = ", ".join(["?"] * len(UNIT_PILOT_COLS))
        con.execute("DELETE FROM unit_pilot")
        for d in merged.values():
            con.execute(
                f"INSERT OR REPLACE INTO unit_pilot ({cols}) VALUES ({ph})",
                [d.get(c) for c in UNIT_PILOT_COLS],
            )
        con.commit()
        n = con.execute("SELECT COUNT(*) FROM unit_pilot").fetchone()[0]
    finally:
        con.close()
    return {"ok": True, "downloaded": len(cloud_rows), "local_rows": n,
            "message": f"已从云端合并 {len(cloud_rows)} 行（按 updated_at 取较新），本地现有 {n} 行"}


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
