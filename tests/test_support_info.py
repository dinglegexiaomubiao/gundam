"""支援次数备注：无条件 / 有条件 拆分（_support_info 与 support_label）。

背景：原实现把同一类的“无条件”与“有条件”次数合并成一个 count，导致
例如胡索·艾文（EX）被显示成「有条件额外行动2次」，而正确应是
「无条件额外行动1次+有条件额外行动1次」。
"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.db import _support_info  # noqa: E402
from src.labels import support_label  # noqa: E402


def _trait(desc, cond=None):
    return {"trait": {"desc": desc, "active_condition": cond}}


class TestSupportInfoSplit(unittest.TestCase):
    def test_uncond_and_cond_kept_separate(self):
        abilities = [{"ability": {"id": 1, "traits": [
            _trait("“额外行动”+1次"),
            _trait("搭乘单位含有上述“标签”，且自身战意为“超一击”以上时，"
                   "“无条件额外行动”+1次(每场战斗1次)",
                   {"unit_tags": "1086", "tension": "Supercharged"}),
        ]}}]
        info = _support_info(abilities, [])
        self.assertEqual(info["extra"]["count"], 2)
        self.assertEqual(info["extra"]["uncond_count"], 1)
        self.assertEqual(info["extra"]["cond_count"], 1)
        self.assertTrue(info["extra"]["cond"])

    def test_pure_unconditional(self):
        abilities = [{"ability": {"id": 2, "traits": [_trait("“支援防御”+2次")]}}]
        info = _support_info(abilities, [])
        self.assertEqual(info["defense"]["uncond_count"], 2)
        self.assertEqual(info["defense"]["cond_count"], 0)
        self.assertFalse(info["defense"]["cond"])


class TestSupportLabel(unittest.TestCase):
    def test_single_unconditional(self):
        info = {"defense": {"count": 2, "cond": False,
                            "uncond_count": 2, "cond_count": 0}}
        self.assertEqual(support_label(info), "无条件支援防御2次")

    def test_combined_parts_joined(self):
        info = {"extra": {"count": 2, "cond": True,
                          "uncond_count": 1, "cond_count": 1}}
        self.assertEqual(support_label(info), "无条件额外行动1次+有条件额外行动1次")

    def test_multiple_kinds_order(self):
        info = {"attack": {"count": 1, "cond": False, "uncond_count": 1, "cond_count": 0},
                "extra": {"count": 1, "cond": True, "uncond_count": 0, "cond_count": 1}}
        # SUPPORT_ORDER = defense, attack, extra
        self.assertEqual(support_label(info), "无条件支援攻击1次+有条件额外行动1次")

    def test_legacy_fallback(self):
        # 旧数据只有 count + cond 标志
        self.assertEqual(support_label({"attack": {"count": 2, "cond": True}}),
                         "有条件支援攻击2次")
        self.assertEqual(support_label({"defense": {"count": 1, "cond": False}}),
                         "无条件支援防御1次")

    def test_empty(self):
        self.assertEqual(support_label({}), "")
        self.assertEqual(support_label(None), "")


if __name__ == "__main__":
    unittest.main()
