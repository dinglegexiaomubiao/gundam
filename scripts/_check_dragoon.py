"""快速查龙骑兵突击高达的武器满级数值 + 验证 ssp_only_ids 过滤。"""
from __future__ import annotations
import sys
from pathlib import Path
_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))
from src import webapp as wa

uid = 1310000300
detail = wa.api_unit_detail(uid)
fc = detail.get("form_content") or {}
d = fc.get("default") or {}
s = fc.get("ssp") or {}
print("=== default 武器 ===")
for w in d.get("weapons") or []:
    print(f"  id={w.get('weapon_id')}  name={w.get('name')}  range={w.get('range_min')}~{w.get('range_max')}  power={w.get('power')}  power_lv9={w.get('power_lv9')}")
print("\n=== ssp 武器 ===")
for w in s.get("weapons") or []:
    print(f"  id={w.get('weapon_id')}  name={w.get('name')}  range={w.get('range_min')}~{w.get('range_max')}  power={w.get('power')}  power_lv9={w.get('power_lv9')}")

print("\n=== abilities ===")
print("default:", [a.get("name") for a in (d.get("abilities") or [])])
print("ssp:", [a.get("name") for a in (s.get("abilities") or [])])

print("\n=== SSP 属性 (当前代码计算) ===")
ssp_form = detail.get("forms", {}).get("ssp", {})
if ssp_form:
    star0 = (ssp_form.get("stars") or [{}])[0]
    st = star0.get("stats") or {}
    for k in ["hp","en","attack","defense","mobility"]:
        print(f"  {k}: max={st.get(k,{}).get('max')}")
    print(f"  movement: {ssp_form.get('movement')}")
