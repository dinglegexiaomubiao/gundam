"""回填 conditional_bonuses 到数据库（重新从 raw JSON 解析）。"""
from __future__ import annotations
import json, sqlite3, sys
from pathlib import Path
_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))
from src import config
from src.db import _load_json
from src.labels import parse_ability_stat_bonuses

def main():
    conn = sqlite3.connect(config.DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT id, raw_path FROM unit WHERE raw_path IS NOT NULL").fetchall()
    print(f"共 {len(rows)} 台机体")
    updated = 0
    for r in rows:
        try:
            raw = _load_json(config.RAW_DIR / r["raw_path"])
        except Exception:
            continue
        stat_bonuses = {}
        conditional_bonuses = []
        for a in raw.get("abilities") or []:
            ab = a.get("ability") or {}
            ab_name = (ab.get("detail") or {}).get("name") or ab.get("name") or ""
            for t in ab.get("traits") or []:
                tr = t.get("trait") or t
                ub, cb = parse_ability_stat_bonuses(
                    tr.get("desc") or "", "unit",
                    tr.get("active_condition"), {}, {},
                )
                for key, pct in ub.items():
                    stat_bonuses[key] = stat_bonuses.get(key, 0) + pct
                for item in cb:
                    item["name"] = ab_name
                    conditional_bonuses.append(item)
        conn.execute(
            "UPDATE unit SET stat_bonuses=?, conditional_bonuses=? WHERE id=?",
            (json.dumps(stat_bonuses, ensure_ascii=False),
             json.dumps(conditional_bonuses, ensure_ascii=False),
             r["id"]),
        )
        updated += 1
        if updated % 200 == 0:
            conn.commit()
            print(f"  已处理 {updated}/{len(rows)}")
    conn.commit()
    conn.close()
    print(f"完成！更新 {updated} 台")

if __name__ == "__main__":
    main()
