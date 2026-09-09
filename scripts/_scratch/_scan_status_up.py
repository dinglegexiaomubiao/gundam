"""扫描所有机体的 ssp_config.cores 中 type=3 status_up 节点，统计 unit_status_type_index 分布。"""
import json, sys, sqlite3
from collections import Counter, defaultdict
from pathlib import Path
_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))
from src import config
from src.db import _load_json

conn = sqlite3.connect(config.DB_PATH)
conn.row_factory = sqlite3.Row
rows = conn.execute("SELECT id, name, rarity, raw_path FROM unit WHERE rarity < 5").fetchall()
conn.close()

index_counter = Counter()
index_samples = defaultdict(list)

for r in rows:
    try:
        raw = _load_json(config.RAW_DIR / r["raw_path"])
    except Exception:
        continue
    sc = raw.get("ssp_config") or {}
    for core in sc.get("cores") or []:
        for rel in core.get("releases") or []:
            if rel.get("release_function_type_index") == 3:
                su = rel.get("status_up") or {}
                idx = su.get("unit_status_type_index")
                val = su.get("effect_value")
                index_counter[idx] += 1
                if len(index_samples[idx]) < 3:
                    index_samples[idx].append((r["id"], r["name"], val))

print("=== unit_status_type_index 分布 ===")
for idx, count in sorted(index_counter.items(), key=lambda x: (x[0] is None, x[0])):
    print(f"\n  index={idx}  count={count}")
    for uid, name, val in index_samples[idx]:
        print(f"    id={uid}  {name}  effect_value={val}")
