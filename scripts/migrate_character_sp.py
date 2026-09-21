#!/usr/bin/env python3
"""驾驶员技能/能力「SP 变体补全」迁移脚本。

背景
----
原始 character.json 的每个技能槽 / 能力槽同时带主对象（skill / ability）与
SP 对象（skill_sp / ability_sp）。旧版 ingest 只读主对象，导致：

- 主对象为空的 380 个技能槽 / 140 个能力槽 → 子表行内容为空、自然键为 NULL；
- 主 / SP 的 id 不同的 208 个技能 / 1048 个能力 → SP 侧被静默丢弃。

而 SQLite 的 UNIQUE / PRIMARY KEY **对 NULL 不生效**，NULL 键会让
``INSERT OR IGNORE`` 形同虚设，重复行只能靠「入库前先 DELETE」兜住。

本脚本按修复后的入库逻辑（``db.ingest_character_children``）重建每名驾驶员的
character_skill / character_ability，并用 ``db.recompute_character_derived``
重算 stat_bonuses / conditional_bonuses / support_info（SP 能力的加成此前被漏算）。
**只动这三处**，不改 character 主行的其它字段，因此不会覆盖人工修改过的字段。

幂等：重复执行结果不变。执行前自动备份数据库到 data/backup/。

用法：
    python scripts/migrate_character_sp.py            # 执行
    python scripts/migrate_character_sp.py --dry-run  # 只统计不写库
    python scripts/migrate_character_sp.py --db data/db/gundam.db
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src import config, dbutil                      # noqa: E402
from src.db import (                                # noqa: E402
    _clear_character_children,
    ingest_character_children,
    recompute_character_derived,
)


def _stats(conn) -> dict:
    q = lambda sql: conn.execute(sql).fetchone()[0]  # noqa: E731
    return {
        "skill": q("SELECT COUNT(*) FROM character_skill"),
        "skill_null": q("SELECT COUNT(*) FROM character_skill "
                        "WHERE character_skill_id IS NULL"),
        "skill_dup": q("SELECT COUNT(*) FROM (SELECT 1 FROM character_skill "
                       "GROUP BY character_id, character_skill_id HAVING COUNT(*)>1)"),
        "ability": q("SELECT COUNT(*) FROM character_ability"),
        "ability_null": q("SELECT COUNT(*) FROM character_ability "
                          "WHERE ability_id IS NULL"),
        "ability_dup": q("SELECT COUNT(*) FROM (SELECT 1 FROM character_ability "
                         "GROUP BY character_id, ability_id HAVING COUNT(*)>1)"),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="data/db/gundam.db",
                    help="本地 SQLite 路径（默认 data/db/gundam.db）")
    ap.add_argument("--raw", default=None,
                    help="raw 目录（默认取 config.RAW_DIR）")
    ap.add_argument("--dry-run", action="store_true", help="只统计，不写库")
    args = ap.parse_args()

    db_path = Path(args.db).resolve()
    raw_dir = Path(args.raw).resolve() if args.raw else config.RAW_DIR
    if not db_path.exists():
        print(f"数据库不存在：{db_path}")
        return 1
    chars_path = raw_dir / "character.json"
    if not chars_path.exists():
        print(f"缺少原始数据：{chars_path}")
        return 1

    config.DB_PATH = db_path
    config.RAW_DIR = raw_dir
    chars = json.loads(chars_path.read_text(encoding="utf-8"))

    conn = dbutil.connect_rw(db_path)
    try:
        before = _stats(conn)
        print("=== 迁移前 ===")
        for k, v in before.items():
            print(f"  {k:14s} {v}")

        existing = {r[0] for r in conn.execute("SELECT id FROM character")}
        todo = [c for c in chars if c.get("id") in existing]
        print(f"\nraw 驾驶员 {len(chars)} 人，库中存在 {len(todo)} 人将重建子表")

        if args.dry_run:
            print("\n--dry-run：未写库。")
            return 0

        # 先备份：整库级操作，留一份可回退的快照
        from src.maintain import backup_db, prune_backups
        backup_db()
        prune_backups()

        for c in todo:
            cid = int(c["id"])
            _clear_character_children(conn, cid)
            ingest_character_children(conn, c)
            recompute_character_derived(conn, cid)
        conn.commit()

        after = _stats(conn)
        print("\n=== 迁移后 ===")
        for k, v in after.items():
            delta = v - before[k]
            sign = "+" if delta > 0 else ""
            print(f"  {k:14s} {v}  ({sign}{delta})")

        ok = (after["skill_null"] == 0 and after["ability_null"] == 0
              and after["skill_dup"] == 0 and after["ability_dup"] == 0)
        print("\n" + ("迁移完成，自然键已无 NULL、无重复。" if ok
                      else "!! 迁移后仍有 NULL 或重复，请检查。"))
        return 0 if ok else 2
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
