"""直接看 raw JSON weapons 的原始 key 结构。"""
import json, sys
from pathlib import Path
_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))
from src import config
from src.db import _load_json

raw = _load_json(config.RAW_DIR / "unit\\1310000300.json")
weapons = raw.get("weapons") or []
print(f"weapons count: {len(weapons)}")
for i, w in enumerate(weapons):
    print(f"\n--- weapon[{i}] ---")
    print(f"  top keys: {list(w.keys())}")
    # 打印关键字段
    for k in w:
        v = w[k]
        if isinstance(v, dict):
            print(f"  {k}: dict keys={list(v.keys())}")
        elif isinstance(v, list):
            print(f"  {k}: list len={len(v)}")
        else:
            print(f"  {k}: {v}")
    # 看 weapon_status
    ws = w.get("weapon_status")
    if ws:
        print(f"  weapon_status keys: {list(ws.keys())}")
        growth = ws.get("growth") or {}
        if growth:
            print(f"  growth keys: {list(growth.keys())}")
            sc = growth.get("stats_change") or []
            print(f"  stats_change count: {len(sc)}")
            for c in sc:
                print(f"    {c}")
