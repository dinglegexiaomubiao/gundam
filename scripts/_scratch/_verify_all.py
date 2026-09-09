"""验证三个问题的修复。"""
import sys, json
from pathlib import Path
_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))
from src import webapp as wa

# 1. 无限正义高达: "最高15%" 类能力
print("="*70)
print("1. 无限正义高达 - 最高15%能力")
print("="*70)
detail = wa.api_unit_detail(1330002800)
for c in detail.get("conditional_bonuses") or []:
    if c.get("stat") == "attack":
        print(f"  condition={c.get('condition')}  pct={c.get('pct')}%  name={c.get('name')}")
all_met = detail.get("cond_all_met")
print(f"  cond_all_met={all_met}")

# 2. 刘备独角兽高达(EX): 两个条件能力合计
print(f"\n{'='*70}")
print("2. 刘备独角兽高达(EX) - 全部条件达成")
print("="*70)
detail = wa.api_unit_detail(1725000150)
for c in detail.get("conditional_bonuses") or []:
    print(f"  stat={c.get('stat')}  pct={c.get('pct')}%  condition={c.get('condition')}  hp_gte={c.get('hp_gte')} hp_lte={c.get('hp_lte')} has_hp={c.get('has_hp_cond')}")
all_met = detail.get("cond_all_met")
print(f"  cond_all_met={all_met}")

# 3. G-3高达: SSP新增被动
print(f"\n{'='*70}")
print("3. G-3高达 - SSP新增被动条件加成")
print("="*70)
detail = wa.api_unit_detail(1007000200)
print(f"  has_ssp={detail.get('has_ssp')}")
fc = detail.get("form_content") or {}
ssp_abs = [a.get("name") for a in (fc.get("ssp") or {}).get("abilities") or []]
print(f"  SSP能力: {ssp_abs}")
print(f"  conditional_bonuses:")
for c in detail.get("conditional_bonuses") or []:
    print(f"    stat={c.get('stat')}  pct={c.get('pct')}%  condition={c.get('condition')}  name={c.get('name')}")
    # 检查 SSP form 是否有数值
    ssp_cs = (c.get("forms") or {}).get("ssp", {}).get(0)
    if ssp_cs:
        print(f"      SSP 0★: lv1={ssp_cs['lv1']}  max={ssp_cs['max']}")
all_met = detail.get("cond_all_met")
print(f"  cond_all_met={all_met}")

# 4. 龙骑兵突击高达: SSP新增被动
print(f"\n{'='*70}")
print("4. 龙骑兵突击高达 - SSP新增被动")
print("="*70)
detail = wa.api_unit_detail(1310000300)
print(f"  conditional_bonuses:")
for c in detail.get("conditional_bonuses") or []:
    print(f"    stat={c.get('stat')}  pct={c.get('pct')}%  condition={c.get('condition')}  name={c.get('name')}")
    ssp_cs = (c.get("forms") or {}).get("ssp", {}).get(0)
    if ssp_cs:
        print(f"      SSP 0★: lv1={ssp_cs['lv1']}  max={ssp_cs['max']}")
all_met = detail.get("cond_all_met")
print(f"  cond_all_met={all_met}")
