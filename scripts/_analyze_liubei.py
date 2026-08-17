"""分析刘备独角兽高达(EX) id=1725000150 的完整能力。"""
import json, sys, sqlite3
from pathlib import Path
_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))
from src import config
from src.db import _load_json
from src.labels import parse_ability_stat_bonuses

raw = _load_json(config.RAW_DIR / "unit\\1725000150.json")
print(f"机体: {raw.get('name')}  rarity={raw.get('rarity')}")

for a in raw.get("abilities") or []:
    ab = a.get("ability") or {}
    detail = ab.get("detail") or {}
    name = detail.get("name") or ab.get("name") or ""
    print(f"\n--- 能力: {name} ---")
    for t in ab.get("traits") or []:
        tr = t.get("trait") or t
        desc = tr.get("desc") or ""
        tv = tr.get("trait_value")
        ac = tr.get("active_condition")
        print(f"  desc={desc}")
        print(f"  trait_value={tv}  trait_type={tr.get('trait_type')}")
        if ac:
            print(f"  active_condition: hp_gte={ac.get('hp_rate_gte_threshold')} hp_lte={ac.get('hp_rate_lte_threshold')}")
        ub, cb = parse_ability_stat_bonuses(desc, "unit", ac, {}, {})
        if ub:
            print(f"  -> 无条件: {ub}")
        if cb:
            print(f"  -> 条件: {cb}")

# 查数据库中的 conditional_bonuses
conn = sqlite3.connect(config.DB_PATH)
conn.row_factory = sqlite3.Row
row = conn.execute("SELECT conditional_bonuses, stat_bonuses FROM unit WHERE id=1725000150").fetchone()
if row:
    import json as j
    print(f"\n数据库 conditional_bonuses: {j.dumps(j.loads(row['conditional_bonuses'] or '[]'), ensure_ascii=False, indent=2)}")
    print(f"数据库 stat_bonuses: {row['stat_bonuses']}")
conn.close()
