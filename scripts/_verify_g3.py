"""验证 G-3高达 SSP 移动力。"""
import sys
from pathlib import Path
_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))
from src import webapp as wa

uid = 1007000200
detail = wa.api_unit_detail(uid)
ssp_form = detail.get("forms", {}).get("ssp", {})
sp_form = detail.get("forms", {}).get("sp", {})
print(f"机体: {detail['name']}  rarity={detail['rarity']}")
print(f"SP movement: {sp_form.get('movement')}")
print(f"SSP movement: {ssp_form.get('movement')}")
