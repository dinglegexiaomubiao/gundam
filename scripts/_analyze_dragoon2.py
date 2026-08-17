"""深入分析龙骑兵突击高达的 weapon_enhance / weapon_effect / ability_change 结构。"""
from __future__ import annotations

import json
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))
from src import config
from src.db import _load_json


def main():
    raw = _load_json(config.RAW_DIR / "unit\\1310000300.json")
    sc = raw.get("ssp_config") or {}

    print("=" * 70)
    print("weapon_enhance (type=1) 详情")
    print("=" * 70)
    for ci, core in enumerate(sc.get("cores") or []):
        for ri, rel in enumerate(core.get("releases") or []):
            t = rel.get("release_function_type_index")
            if t == 1:
                we = rel.get("weapon_enhance") or {}
                print(f"  core#{ci} rel#{ri}: target_weapon_id={we.get('target_weapon_id')}  "
                      f"type_index={we.get('weapon_enhance_type_index')}  effect_value={we.get('effect_value')}")

    print("\n" + "=" * 70)
    print("weapon_effect (type=7) 详情")
    print("=" * 70)
    for ci, core in enumerate(sc.get("cores") or []):
        for ri, rel in enumerate(core.get("releases") or []):
            t = rel.get("release_function_type_index")
            if t == 7:
                wfe = rel.get("weapon_effect") or {}
                wt = wfe.get("weapon_trait") or {}
                print(f"  core#{ci} rel#{ri}: target_weapon_id={wfe.get('target_weapon_id')}  "
                      f"trait_id={wfe.get('weapon_trait_id')}  rate%={wfe.get('battle_power_rating_point_rate_percent')}")
                print(f"    weapon_trait: {json.dumps(wt, ensure_ascii=False, indent=2)}")

    print("\n" + "=" * 70)
    print("ability_change 详情")
    print("=" * 70)
    ir = sc.get("initial_release") or {}
    ac = ir.get("ability_change") or {}
    ab = ac.get("ability") or {}
    print(f"  before_ability_id={ac.get('before_ability_id')}")
    print(f"  after_ability_id={ac.get('after_ability_id')}")
    detail = ab.get("detail") or {}
    print(f"  name={detail.get('name') or ab.get('name')}")
    print(f"  desc={detail.get('desc')}")
    print(f"  ability_type={ab.get('ability_type')}")
    traits = ab.get("traits") or []
    print(f"  traits ({len(traits)} 条):")
    for t in traits:
        tc = t.get("trait_content") or {}
        tv = tc.get("trait_value") or {}
        print(f"    trait: {json.dumps(t, ensure_ascii=False)}")

    # 对比 SP 满级 vs SSP 满级计算
    print("\n" + "=" * 70)
    print("SSP 属性计算验证")
    print("=" * 70)
    st = raw.get("stats") or {}
    sst = sc.get("stats") or {}
    keys = ["hp", "en", "attack", "defense", "mobility", "movement"]
    for k in keys:
        sp_max = st.get(f"sp_max_{k}") or 0
        ssp_max = sst.get(f"ssp_max_{k}") or 0
        total = sp_max + ssp_max
        print(f"  {k}: sp_max={sp_max} + ssp_max={ssp_max} = {total}  (用户期望 SSP满级基础值)")


if __name__ == "__main__":
    main()
