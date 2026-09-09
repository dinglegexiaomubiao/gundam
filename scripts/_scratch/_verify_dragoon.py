"""验证龙骑兵突击高达 SSP 全部修复点。"""
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

print("=== 武器对比 ===")
for w in s.get("weapons") or []:
    wid = w.get("weapon_id")
    # 找 default 中对应武器
    dw = next((x for x in (d.get("weapons") or []) if x.get("weapon_id") == wid), None)
    print(f"\n  {w.get('name')} (id={wid})")
    print(f"    range: {w.get('range_min')}~{w.get('range_max')}  power={w.get('power')}  power_lv5={w.get('power_lv5')}  power_lv9={w.get('power_lv9')}")
    if dw:
        print(f"    [default] range: {dw.get('range_min')}~{dw.get('range_max')}  power={dw.get('power')}  power_lv5={dw.get('power_lv5')}  power_lv9={dw.get('power_lv9')}")

print("\n=== 能力对比 ===")
print("default:", [a.get("name") for a in (d.get("abilities") or [])])
print("ssp:", [a.get("name") for a in (s.get("abilities") or [])])

print("\n=== SSP 属性 3星 ===")
ssp_form = detail.get("forms", {}).get("ssp", {})
if ssp_form:
    star3 = (ssp_form.get("stars") or [{}])[3]
    st = star3.get("stats") or {}
    for k in ["hp","en","attack","defense","mobility"]:
        print(f"  {k}: 3★max={st.get(k,{}).get('max')}")
    print(f"  movement: {ssp_form.get('movement')}")

# 也对比 SP 3星
sp_form = detail.get("forms", {}).get("sp", {})
if sp_form:
    star3 = (sp_form.get("stars") or [{}])[3]
    st = star3.get("stats") or {}
    print("\n=== SP 属性 3星（对比）===")
    for k in ["hp","en","attack","defense","mobility"]:
        print(f"  {k}: 3★max={st.get(k,{}).get('max')}")
