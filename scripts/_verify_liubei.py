"""验证刘备独角兽高达EX的条件加成计算。"""
import sys, json
from pathlib import Path
_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))
from src import webapp as wa

uid = 1725000150
detail = wa.api_unit_detail(uid)
bonuses = detail.get("stat_bonuses") or {}
print(f"stat_bonuses (无条件加成): {bonuses}")

# 默认 3星
form = detail["forms"]["default"]
star3 = form["stars"][3]
st = star3["stats"]
print(f"\n默认 3★ base stats (star-adjusted, no bonus):")
for k in ["attack", "defense"]:
    print(f"  {k}: max={st[k]['max']}  max_bonus={st[k]['max_bonus']}")

# 条件加成
print(f"\n条件加成:")
for c in detail.get("conditional_bonuses") or []:
    fk = c.get("forms", {}).get("default", {}).get(3)
    print(f"  stat={c['stat']}  pct={c['pct']}%  name={c.get('name')}")
    if fk:
        print(f"    default 3★: lv1={fk['lv1']}  max={fk['max']}")

# all-met
print(f"\ncond_all_met: {detail.get('cond_all_met')}")

# 手动验证
base_max = st['attack']['max']
uncond = bonuses.get('attack', 0)
print(f"\n手动计算 attack:")
print(f"  baseMax(star-adj)={base_max}  uncond_bonus={uncond}")
for cond_pct in [15, 30]:
    val = base_max * (100 + uncond + cond_pct) // 100
    print(f"  +{cond_pct}%: floor({base_max} * {100+uncond+cond_pct} / 100) = {val}")
