"""分析三个机体的能力 traits 结构：无限正义高达、刘备独角兽高达(EX)、G-3高达。"""
import json, sys, sqlite3
from pathlib import Path
_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))
from src import config
from src.db import _load_json
from src.labels import parse_ability_stat_bonuses

conn = sqlite3.connect(config.DB_PATH)
conn.row_factory = sqlite3.Row

targets = [
    ("无限正义高达", "LIKE '%无限正义%'"),
    ("刘备独角兽高达(EX)", "LIKE '%刘备%' OR name LIKE '%独角兽%EX%'"),
    ("G-3高达", "LIKE '%G-3%'"),
]

for label, where in targets:
    rows = conn.execute(f"SELECT id, name, rarity, raw_path FROM unit WHERE name {where}").fetchall()
    print(f"\n{'='*70}")
    print(f"目标: {label}  匹配{len(rows)}台")
    for r in rows:
        print(f"  id={r['id']}  rarity={r['rarity']}  {r['name']}")
    if not rows:
        continue

    target = rows[0]
    raw = _load_json(config.RAW_DIR / target["raw_path"])
    print(f"\n  分析: {target['name']}")

    # 看顶层 abilities
    for a in raw.get("abilities") or []:
        ab = a.get("ability") or {}
        detail = ab.get("detail") or {}
        name = detail.get("name") or ab.get("name") or ""
        print(f"\n  --- 能力: {name} ---")
        for t in ab.get("traits") or []:
            tr = t.get("trait") or t
            desc = tr.get("desc") or ""
            tv = tr.get("trait_value")
            ac = tr.get("active_condition")
            print(f"    desc={desc}")
            print(f"    trait_value={tv}  trait_type={tr.get('trait_type')}")
            if ac:
                print(f"    active_condition.hp_rate_gte_threshold={ac.get('hp_rate_gte_threshold')}")
                print(f"    active_condition.hp_rate_lte_threshold={ac.get('hp_rate_lte_threshold')}")
            # 用 parse_ability_stat_bonuses 解析
            ub, cb = parse_ability_stat_bonuses(desc, "unit", ac, {}, {})
            if ub:
                print(f"    -> 无条件加成: {ub}")
            if cb:
                print(f"    -> 条件加成: {cb}")

    # SSP 新增能力
    sc = raw.get("ssp_config") or {}
    ir = sc.get("initial_release") or {}
    ac = ir.get("ability_change") or {}
    ab = ac.get("ability")
    if ab:
        detail = ab.get("detail") or {}
        name = detail.get("name") or ab.get("name") or ""
        print(f"\n  --- SSP新增能力: {name} ---")
        for t in ab.get("traits") or []:
            tr = t.get("trait") or t
            desc = tr.get("desc") or ""
            tv = tr.get("trait_value")
            ac_cond = tr.get("active_condition")
            print(f"    desc={desc}")
            print(f"    trait_value={tv}  trait_type={tr.get('trait_type')}")
            if ac_cond:
                print(f"    active_condition: hp_rate_gte={ac_cond.get('hp_rate_gte_threshold')} hp_rate_lte={ac_cond.get('hp_rate_lte_threshold')}")
            ub, cb = parse_ability_stat_bonuses(desc, "unit", ac_cond, {}, {})
            if ub:
                print(f"    -> 无条件加成: {ub}")
            if cb:
                print(f"    -> 条件加成: {cb}")

conn.close()
