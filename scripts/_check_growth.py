"""查 raw JSON 中 weapons 的结构。"""
import json, sys
from pathlib import Path
_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))
from src import config
from src.db import _load_json

raw = _load_json(config.RAW_DIR / "unit\\1310000300.json")
weapons = raw.get("weapons") or []
print(f"weapons count: {len(weapons)}")
for w in weapons:
    ws = w.get("weapon_status") or {}
    growth = ws.get("growth") or {}
    changes = growth.get("stats_change") or []
    print(f"\n  id={w.get('id')}  name={w.get('name')}")
    print(f"  power={ws.get('power')}  range={ws.get('range_min')}~{ws.get('range_max')}")
    print(f"  growth.stats_change count: {len(changes)}")
    for c in changes:
        print(f"    level={c.get('weapon_level')}  power_rate={c.get('power_correction_rate')}")
