"""本地数据库结构升级：武器 lv9 列、多伤害集合列、编辑历史表。

在已有 data/db/gundam.db 上补齐新列/新表（幂等，可重复执行）。
"""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src import config  # noqa: E402


def main() -> int:
    if not config.DB_PATH.exists():
        print(f"本地数据库不存在，无需升级: {config.DB_PATH}")
        return 0
    conn = sqlite3.connect(config.DB_PATH)
    try:
        cols = {
            r[1] for r in conn.execute("PRAGMA table_info(unit_weapon)")
        }
        added = []
        for name, ddl in (
            ("power_lv9", "ALTER TABLE unit_weapon ADD COLUMN power_lv9 INTEGER"),
            ("en_lv9", "ALTER TABLE unit_weapon ADD COLUMN en_lv9 INTEGER"),
            ("hit_lv9", "ALTER TABLE unit_weapon ADD COLUMN hit_lv9 INTEGER"),
            ("crit_lv9", "ALTER TABLE unit_weapon ADD COLUMN crit_lv9 INTEGER"),
            ("weapon_attrs", "ALTER TABLE unit_weapon ADD COLUMN weapon_attrs TEXT"),
        ):
            if name not in cols:
                conn.execute(ddl)
                added.append(name)
        conn.execute(
            "CREATE TABLE IF NOT EXISTS unit_edit_log ("
            "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
            "  unit_id INTEGER,"
            "  field TEXT,"
            "  old_value TEXT,"
            "  new_value TEXT,"
            "  edited_at TEXT,"
            "  source TEXT"
            ")"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_edit_log_unit "
            "ON unit_edit_log(unit_id)"
        )
        conn.commit()
        print(f"升级完成，新增列: {added or '无'}，编辑历史表已就绪")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
