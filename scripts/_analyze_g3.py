"""分析 G-3高达 的 SSP 移动力数据。"""
import json, sys, sqlite3
from pathlib import Path
_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))
from src import config
from src.db import _load_json

conn = sqlite3.connect(config.DB_PATH)
conn.row_factory = sqlite3.Row
rows = conn.execute(
    "SELECT id, name, rarity, raw_path, movement, sp_movement, ssp_movement, max_movement, sp_max_movement, ssp_max_movement FROM unit WHERE name LIKE '%G-3%' OR name LIKE '%G3%'"
).fetchall()
print(f"匹配机体: {len(rows)}")
for r in rows:
    print(f"  id={r['id']}  rarity={r['rarity']}  {r['name']}")
    print(f"    movement={r['movement']} sp_movement={r['sp_movement']} ssp_movement={r['ssp_movement']}")
    print(f"    max_movement={r['max_movement']} sp_max_movement={r['sp_max_movement']} ssp_max_movement={r['ssp_max_movement']}")
    print(f"    raw_path={r['raw_path']}")
conn.close()

if not rows:
    sys.exit(0)

# 分析第一台的 raw JSON
target = rows[0]
raw = _load_json(config.RAW_DIR / target["raw_path"])
st = raw.get("stats") or {}
sc = raw.get("ssp_config") or {}
sst = sc.get("stats") or {}

print(f"\n=== raw JSON stats (movement 相关) ===")
for k in sorted(st.keys()):
    if 'movement' in k:
        print(f"  stats.{k} = {st[k]}")

print(f"\n=== ssp_config.stats (movement 相关) ===")
for k in sorted(sst.keys()):
    if 'movement' in k:
        print(f"  ssp_config.stats.{k} = {sst[k]}")

# 查看 ssp_config.cores 中是否有 movement 相关的 release
print(f"\n=== ssp_config.cores releases (所有 type) ===")
for ci, core in enumerate(sc.get("cores") or []):
    for ri, rel in enumerate(core.get("releases") or []):
        t = rel.get("release_function_type_index")
        keys = [k for k in rel.keys() if k not in ("release_function_type_index", "sort_order", "target_id", "unit_ssp_custom_core_release_function_set_id")]
        print(f"  core#{ci} rel#{ri}: type={t}  data_keys={keys}")
        # 打印非空内容
        for k in keys:
            v = rel.get(k)
            if isinstance(v, dict):
                print(f"    {k}: {json.dumps(v, ensure_ascii=False)[:200]}")
            else:
                print(f"    {k}: {v}")
