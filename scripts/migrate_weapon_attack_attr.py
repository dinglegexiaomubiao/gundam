#!/usr/bin/env python3
"""武器表攻击属性改造迁移脚本。

变更点：
1. unit_weapon.attack_attr 由 INTEGER（单列）改为 TEXT（JSON 数组），支持多选。
   历史值展开：1->[1] 2->[2] 3->[3] 4->[1,2] 5->[1,3] 6->[2,3] 7->[1,2,3]
2. 删除 unit_weapon.weapon_attr 列（伤害类型单列）。其职责由 weapon_attrs（多伤害集合）承担。
   对 weapon_attrs 为空的武器，按 weapon_attr 回填：1->[1] 2->[2] 3->[3] 4->[3] 5/6->[]。

幂等：若 attack_attr 已是 TEXT 且 weapon_attr 列不存在，则直接跳过。

用法：
    python scripts/migrate_weapon_attack_attr.py [--db data/db/gundam.db]
"""
import argparse
import json
import sqlite3
import sys

ATK_EXPAND = {1: [1], 2: [2], 3: [3], 4: [1, 2], 5: [1, 3], 6: [2, 3], 7: [1, 2, 3]}


def expand_attack_attr(v):
    if v is None:
        return []
    try:
        v = int(v)
    except (TypeError, ValueError):
        return []
    return list(ATK_EXPAND.get(v, [v]))


def backfill_attrs(weapon_attrs_raw, weapon_attr):
    # 已有多伤害集合则保留
    if weapon_attrs_raw:
        try:
            arr = json.loads(weapon_attrs_raw)
            if isinstance(arr, list) and arr:
                return json.dumps([int(x) for x in arr if str(x).isdigit()], ensure_ascii=False)
        except (ValueError, json.JSONDecodeError):
            pass
    # 否则用 weapon_attr 回填
    if weapon_attr in (1, 2, 3):
        return json.dumps([weapon_attr], ensure_ascii=False)
    if weapon_attr == 4:
        return json.dumps([3], ensure_ascii=False)
    return json.dumps([], ensure_ascii=False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="data/db/gundam.db")
    args = ap.parse_args()

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # 是否已迁移
    cols = [r[1] for r in cur.execute("PRAGMA table_info(unit_weapon)")]
    if "weapon_attr" not in cols and "attack_attr" in cols:
        # 再确认 attack_attr 是 TEXT
        atype = dict((r[1], r[2]) for r in cur.execute("PRAGMA table_info(unit_weapon)")).get("attack_attr")
        if (atype or "").upper() == "TEXT":
            print("已迁移（attack_attr=TEXT 且 weapon_attr 不存在），跳过。")
            conn.close()
            return

    # 取索引定义，重建后恢复
    indexes = cur.execute(
        "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='unit_weapon' AND sql IS NOT NULL"
    ).fetchall()

    rows = cur.execute("SELECT * FROM unit_weapon").fetchall()
    col_names = cols[:]  # 原列顺序

    # 新列：去掉 weapon_attr，attack_attr 改 TEXT
    new_cols = []
    for c in col_names:
        if c == "weapon_attr":
            continue
        new_cols.append(c)
    # 构造建表语句（带类型）
    col_types = {r[1]: r[2] for r in cur.execute("PRAGMA table_info(unit_weapon)")}
    col_defs = []
    for c in new_cols:
        t = "TEXT" if c == "attack_attr" else (col_types.get(c) or "TEXT")
        # 主键 / 自增保持
        extra = "PRIMARY KEY" if c == "id" else ""
        col_defs.append(f'"{c}" {t} {extra}'.strip())
    create_sql = f'CREATE TABLE unit_weapon_new ({", ".join(col_defs)})'

    conn.execute("PRAGMA foreign_keys=OFF")
    conn.execute("DROP TABLE IF EXISTS unit_weapon_new")
    conn.execute(create_sql)

    insert_cols = [c for c in new_cols if c != "id"]  # 含 attack_attr，不含 weapon_attr
    placeholders = ", ".join(["?"] * len(insert_cols))
    q = f'INSERT INTO unit_weapon_new (id, {", ".join(insert_cols)}) VALUES (?, {placeholders})'

    n = 0
    for r in rows:
        r = dict(r)
        aattr = expand_attack_attr(r.get("attack_attr"))
        wattr = r.get("weapon_attr")
        new_attrs = backfill_attrs(r.get("weapon_attrs"), wattr)
        vals = [r.get("id")]
        for c in insert_cols:
            if c == "attack_attr":
                vals.append(json.dumps(aattr, ensure_ascii=False))
            elif c == "weapon_attrs":
                vals.append(new_attrs)
            else:
                vals.append(r.get(c))
        cur.execute(q, vals)
        n += 1

    # 恢复索引
    for idx in indexes:
        try:
            cur.execute(idx["sql"])
        except sqlite3.OperationalError as e:
            print(f"  跳过索引（可能含 weapon_attr）: {e}")

    conn.execute("DROP TABLE unit_weapon")
    conn.execute("ALTER TABLE unit_weapon_new RENAME TO unit_weapon")
    conn.commit()

    print(f"迁移完成：{n} 把武器。attack_attr 已转为 JSON 数组，weapon_attr 列已删除。")
    # 抽样校验
    sample = cur.execute(
        "SELECT weapon_id, attack_attr, weapon_attrs FROM unit_weapon LIMIT 5"
    ).fetchall()
    for s in sample:
        print(f"  weapon_id={s['weapon_id']} attack_attr={s['attack_attr']} weapon_attrs={s['weapon_attrs']}")
    conn.close()


if __name__ == "__main__":
    main()
