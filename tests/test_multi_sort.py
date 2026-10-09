"""多级排序：list 接口的 sort/order 逗号串（主 -> 次键）稳定多键排序。"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import src.config as config  # noqa: E402
from src.webapp import api_units, api_characters, api_supporters  # noqa: E402


def _db_ready() -> bool:
    try:
        p = Path(config.DB_PATH)
    except Exception:
        return False
    return p.exists() and p.stat().st_size > 0


def _units(sort, order, limit=200):
    return api_units("", "", "", "", "", "", "all", "and", "", "any", "",
                     sort, order, limit, 0)["items"]


@unittest.skipUnless(_db_ready(), "本地库不存在，跳过排序集成校验")
class TestMultiSort(unittest.TestCase):
    def test_units_rarity_then_role(self):
        items = _units("rarity,role", "desc,asc")
        keys = [(r["rarity"], r["role"]) for r in items]
        # rarity 降序，同级内 role 升序（取负便于统一比较）
        norm = [(a, -b) for a, b in keys]
        self.assertEqual(norm, sorted(norm, reverse=True))
        # 覆盖到多个 rarity 层
        self.assertGreater(len({a for a, _ in keys}), 1)

    def test_units_single_key_still_works(self):
        names = [r["name"] for r in _units("name", "asc", 50)]
        self.assertEqual(names, sorted(names))

    def test_units_secondary_breaks_ties(self):
        # 「攻击」列按展示值 atk_f（3★ 换算后）排序，而非基础 attack
        items = _units("rarity,attack", "desc,desc")
        pairs = [(r["rarity"], r["atk_f"] or 0) for r in items]
        self.assertEqual(pairs, sorted(pairs, reverse=True))

    def test_characters_rarity_then_type(self):
        items = api_characters("", "", "", "", "", "all", "and", "", "any", "",
                               "rarity,role", "desc,asc", 200, 0)["items"]
        norm = [(r["rarity"], -r["role"]) for r in items]
        self.assertEqual(norm, sorted(norm, reverse=True))

    def test_supporters_name_asc(self):
        items = api_supporters("", "", "any", "", "any", "name", "asc", 50, 0)["items"]
        names = [r["name"] for r in items]
        self.assertEqual(names, sorted(names))

    def test_unknown_key_falls_back_to_default(self):
        # 全是无效键 -> 回到默认（稀有度降序）
        items = _units("bogus,alsobad", "desc,desc", 20)
        self.assertTrue(items)
        rar = [r["rarity"] for r in items]
        self.assertEqual(rar, sorted(rar, reverse=True))


if __name__ == "__main__":
    unittest.main()
