"""检查能否通过条件加成的 name 来识别 SSP 专属条件。"""
import sys, json, sqlite3
from pathlib import Path
_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))
from src import webapp as wa

# 龙骑兵突击高达
uid = 1310000300
detail = wa.api_unit_detail(uid)
default_ab_names = {a.get("name") for a in detail.get("abilities") or []}
print(f"default abilities 名称: {default_ab_names}")
print(f"\nconditional_bonuses 条件来源:")
for c in detail.get("conditional_bonuses") or []:
    name = c.get("name") or ""
    ssp_only = name not in default_ab_names
    print(f"  name={name!r}  stat={c['stat']}  pct={c['pct']}%  SSP专属={ssp_only}")
