"""测试 webapp.py: api_unit_detail 返回的 form_content 正确性。"""
from __future__ import annotations

import json
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))
from src import webapp as wa


def main():
    # 选一个之前看到有ssp数据的机体，比如 id=10007（自由高达）或其他
    conn = wa._conn()
    rows = conn.execute("SELECT id, name, rarity FROM unit WHERE rarity < 5 LIMIT 10").fetchall()
    print("低稀有度机体样例:")
    for r in rows:
        print(f"  id={r['id']}  rarity={r['rarity']}  {r['name']}")
    conn.close()

    test_ids = [rows[0]['id']] if rows else []
    # 再加 id=10007 / 10079 等之前看到的低稀有度机体
    for cand in [10007, 10079, 10030]:
        if cand not in test_ids:
            test_ids.append(cand)

    for uid in test_ids:
        print(f"\n========= 测试 unit_id={uid} =========")
        detail = wa.api_unit_detail(uid)
        if not detail:
            print("  不存在")
            continue
        print(f"  名称: {detail['name']}  rarity={detail['rarity']}  has_ssp={detail.get('has_ssp')}")
        # 检查 SSP 属性字段是否非 0
        print(f"  ssp_max_hp={detail.get('ssp_max_hp')}  ssp_max_attack={detail.get('ssp_max_attack')}  ssp_max_defense={detail.get('ssp_max_defense')}")
        # 检查 forms.ssp 存在且不是 fallback
        forms = detail.get("forms") or {}
        ssp_form = forms.get("ssp")
        if ssp_form:
            print(f"  forms.ssp: level_cap={ssp_form.get('level_cap')} fallback={ssp_form.get('fallback')}")
            # 打印 SSP 形态 0 星满级属性
            ss = (ssp_form.get("stars") or [{}])[0]
            st = ss.get("stats") or {}
            print(f"    SSP 0★ max属性: HP={st.get('hp', {}).get('max')} ATK={st.get('attack', {}).get('max')} DEF={st.get('defense', {}).get('max')}")
        else:
            print("  forms.ssp: None")
        # 检查 form_content
        fc = detail.get("form_content") or {}
        print(f"  form_content keys: {list(fc.keys())}")
        def_k = (fc.get("default") or {})
        ssp_k = (fc.get("ssp") or {})
        print(f"  default: 武器{len(def_k.get('weapons') or [])} 能力{len(def_k.get('abilities') or [])} 地形={def_k.get('terrain')}")
        if ssp_k:
            print(f"  ssp:     武器{len(ssp_k.get('weapons') or [])} 能力{len(ssp_k.get('abilities') or [])} 地形={ssp_k.get('terrain')}")
            # 打印武器名对比
            def_wp_names = [w.get("name") for w in (def_k.get("weapons") or [])]
            ssp_wp_names = [w.get("name") for w in (ssp_k.get("weapons") or [])]
            if def_wp_names != ssp_wp_names:
                print(f"   武器变更: {def_wp_names} -> {ssp_wp_names}")
            # 能力对比
            def_ab_names = [a.get("name") for a in (def_k.get("abilities") or [])]
            ssp_ab_names = [a.get("name") for a in (ssp_k.get("abilities") or [])]
            if def_ab_names != ssp_ab_names:
                print(f"   能力变更: {def_ab_names} -> {ssp_ab_names}")
            # 地形对比
            if def_k.get("terrain") != ssp_k.get("terrain"):
                print(f"   地形变更: {def_k.get('terrain')} -> {ssp_k.get('terrain')}")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
