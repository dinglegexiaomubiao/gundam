"""机体/驾驶员列表的形态开关：form（"" | sp | ssp）与 full_cond（完全达成条件）。

口径：只切换「显示 + 排序」的数值，不筛选条目；SP/SSP 独立、同勾以 SSP 为准；
完全达成条件＝叠加该机体全部条件加成（含 HP 条件）；UR 无 SP（回退默认）。
"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import src.config as config  # noqa: E402
from src.labels import star_value  # noqa: E402
from src.webapp import api_units, api_characters  # noqa: E402


def _db_ready() -> bool:
    try:
        p = Path(config.DB_PATH)
    except Exception:
        return False
    return p.exists() and p.stat().st_size > 0


def _units(sort="", order="desc", form="", full_cond=False, limit=1400):
    return api_units("", "", "", "", "", "", "all", "and", "", "any", "",
                     sort, order, limit, 0, False, form, full_cond)["items"]


@unittest.skipUnless(_db_ready(), "本地库不存在，跳过形态开关集成校验")
class TestUnitFormToggle(unittest.TestCase):
    def _by_id(self, items):
        return {r["id"]: r for r in items}

    def test_sp_and_ssp_switch_values(self):
        de = self._by_id(_units())
        sp = self._by_id(_units(form="sp"))
        ssp = self._by_id(_units(form="ssp"))
        # 找一个非 UR（rarity<5）机体：SP/SSP 数值应高于默认
        uid = next(i for i, r in de.items() if (r["rarity"] or 5) < 5)
        self.assertEqual(sp[uid]["form_used"], "sp")
        self.assertGreaterEqual(sp[uid]["atk_f"], de[uid]["atk_f"])
        self.assertGreaterEqual(ssp[uid]["atk_f"], sp[uid]["atk_f"])

    def test_ur_ignores_sp_toggle(self):
        de = self._by_id(_units())
        sp = self._by_id(_units(form="sp"))
        uid = next(i for i, r in de.items() if (r["rarity"] or 5) >= 5)
        self.assertEqual(de[uid]["atk_f"], sp[uid]["atk_f"])
        self.assertEqual(sp[uid]["form_used"], "default")

    def test_full_cond_adds_conditional_bonuses(self):
        de = self._by_id(_units())
        fc = self._by_id(_units(full_cond=True))
        # 存在受条件加成影响的机体：攻击值变大
        changed = [i for i in de if fc[i]["atk_f"] > de[i]["atk_f"]]
        self.assertTrue(changed, "应有机体因完全达成条件而提升攻击值")
        # 无条件的机体不受影响
        same = [i for i in de if fc[i]["atk_f"] == de[i]["atk_f"]]
        self.assertTrue(same)

    def test_ssp_falls_back_to_sp_without_ssp_data(self):
        ssp = self._by_id(_units(form="ssp"))
        sp = self._by_id(_units(form="sp"))
        # 没有 SSP 数据的非 UR 机体：form_used 回落 sp，数值与 SP 一致
        fb = [i for i, r in ssp.items() if r["form_used"] == "sp"]
        self.assertTrue(fb, "应存在无 SSP 数据而回退 SP 的机体")
        for i in fb[:5]:
            self.assertEqual(ssp[i]["atk_f"], sp[i]["atk_f"])

    def test_sort_follows_form(self):
        items = _units(sort="attack", order="desc", form="sp")
        vals = [r["atk_f"] for r in items]
        self.assertEqual(vals, sorted(vals, reverse=True))
        # 数值口径确实变了（SP 形态下攻击值整体更高）
        de = _units(sort="attack", order="desc")
        self.assertNotEqual(sorted(r["atk_f"] for r in items),
                            sorted(r["atk_f"] for r in de))


@unittest.skipUnless(_db_ready(), "本地库不存在，跳过形态开关集成校验")
class TestCharFormToggle(unittest.TestCase):
    def test_char_sp_switches_values(self):
        de = {r["id"]: r for r in api_characters("", "", "", "", "", "all", "and",
                                                 "", "any", "", "", "desc", 700, 0)["items"]}
        sp = {r["id"]: r for r in api_characters("", "", "", "", "", "all", "and",
                                                 "", "any", "", "", "desc", 700, 0,
                                                 False, "sp")["items"]}
        uid = next(i for i, r in de.items() if (r["rarity"] or 5) < 5)
        self.assertEqual(sp[uid]["form_used"], "sp")
        self.assertGreaterEqual(sp[uid]["ranged_f"], de[uid]["ranged_f"])
        # UR 不受影响
        ur = next(i for i, r in de.items() if (r["rarity"] or 5) >= 5)
        self.assertEqual(sp[ur]["ranged_f"], de[ur]["ranged_f"])


if __name__ == "__main__":
    unittest.main()
