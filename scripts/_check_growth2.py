"""查 57mm高出力光束步枪 的 weapon_status growth 数据。"""
import json, sys
from pathlib import Path
_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))
from src import config
from src.db import _load_json
from src.labels import parse_weapon_max_level

raw = _load_json(config.RAW_DIR / "unit\\1310000300.json")
for w in raw.get("weapons") or []:
    wid = w.get("weapon_id")
    if wid == 131000030002:
        wep = w.get("weapon") or {}
        ws = wep.get("weapon_status") or {}
        print(f"weapon_id={wid}  name={wep.get('name')}")
        print(f"weapon_status.power={ws.get('power')}")
        print(f"weapon_status.range_min={ws.get('range_min')} range_max={ws.get('range_max')}")
        growth = ws.get("growth") or {}
        changes = growth.get("stats_change") or []
        print(f"growth.stats_change: {len(changes)} entries")
        for c in changes:
            print(f"  level={c.get('weapon_level')} power_rate={c.get('power_correction_rate')} en_rate={c.get('en_correction_rate')}")
        top = parse_weapon_max_level(ws)
        print(f"\nparse_weapon_max_level result:")
        print(f"  level={top['level']}  power={top['power']}  en={top['en']}")
        # SSP enhance: 2x type_index=1 val=175, 1x type_index=4 val=1
        enhanced_power = top['power'] + 175 + 175
        enhanced_range = (ws.get('range_max') or 0) + 1
        print(f"\n  After SSP enhance: power={enhanced_power}  range_max={enhanced_range}")
        break
