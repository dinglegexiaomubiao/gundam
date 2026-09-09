"""查 57mm高出力光束步枪 的 weapon_status 完整结构 + weapon_enhance 数值验证。"""
from __future__ import annotations
import json, sys
from pathlib import Path
_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))
from src import config
from src.db import _load_json

raw = _load_json(config.RAW_DIR / "unit\\1310000300.json")
for w in raw.get("weapons") or []:
    if w.get("id") == 131000030002:
        ws = w.get("weapon_status") or {}
        print("=== 57mm高出力光束步枪 weapon_status ===")
        print(json.dumps(ws, ensure_ascii=False, indent=2))
        break

# 验证 weapon_enhance type_index 含义
sc = raw.get("ssp_config") or {}
print("\n=== 所有 weapon_enhance 汇总 ===")
for ci, core in enumerate(sc.get("cores") or []):
    for rel in core.get("releases") or []:
        if rel.get("release_function_type_index") == 1:
            we = rel.get("weapon_enhance") or {}
            print(f"  core#{ci}: target={we.get('target_weapon_id')} type_idx={we.get('weapon_enhance_type_index')} val={we.get('effect_value')}")

# 也看看 ssp_weapon 里的武器（龙骑兵系统 SSP）的 weapon_status
print("\n=== 龙骑兵系统 SSP weapon_change.weapon.weapon_status ===")
for core in sc.get("cores") or []:
    for rel in core.get("releases") or []:
        if rel.get("release_function_type_index") == 5:
            wep = (rel.get("weapon_change") or {}).get("weapon") or {}
            ws = wep.get("weapon_status") or {}
            print(f"  name={wep.get('name')} id={wep.get('id')}")
            print(f"  power={ws.get('power')} en={ws.get('en')} range={ws.get('range_min')}~{ws.get('range_max')}")
            # 看有没有 level_status
            for k in ws:
                if 'level' in k.lower() or 'status' in k.lower():
                    print(f"  {k}={ws[k]}")
