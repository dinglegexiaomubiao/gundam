"""深入分析无限正义高达的「战斗次数条件」trait。"""
import json, sys
from pathlib import Path
_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))
from src import config
from src.db import _load_json

raw = _load_json(config.RAW_DIR / "unit\\1330002800.json")
for a in raw.get("abilities") or []:
    ab = a.get("ability") or {}
    detail = ab.get("detail") or {}
    name = detail.get("name") or ab.get("name") or ""
    if "战斗次数" in name:
        print(f"能力: {name}")
        for t in ab.get("traits") or []:
            tr = t.get("trait") or t
            print(json.dumps(tr, ensure_ascii=False, indent=2))
