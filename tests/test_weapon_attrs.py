"""伤害类型（weapon_attrs）映射与「重建一致性」回归测试。

背景 bug
--------
`weapon_attr`（单值）→ `weapon_attrs`（集合）的推导原先把 5 / 6 映射为空、
4 映射为 [3]，丢掉了 4/5/6 类武器的多类型信息。库里那 5 个多类型值是手工改的
⇒ **只要重新点一次「爬取数据」重建数据库，多类型信息就会丢失**。

正确映射（由「库内手工修正值」与「武器名分布」双向验证）：
    4 = 光束 + 物理      5 = 物理 + 特殊      6 = 光束 + 特殊

本测试锁三件事：
1. 映射表本身正确；
2. 数据库里每一把武器的 `weapon_attrs` 都等于按原始 JSON 重新推导的值
   —— 也就是「重新爬取重建」不会再改变任何一行（防再次漂移）；
3. 迁移脚本与 db.py 的规则完全一致（防止两处规则分叉）。
"""

from __future__ import annotations

import glob
import json
import sqlite3
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src import config  # noqa: E402
from src.db import WEAPON_ATTR_EXPAND, _weapon_attrs_from_attr  # noqa: E402
from src.labels import DAMAGE_TYPE_NAMES, damage_type_label  # noqa: E402

sys.path.insert(0, str(ROOT / "scripts"))
from migrate_weapon_attrs_v2 import expected_attrs  # noqa: E402


class TestWeaponAttrMapping(unittest.TestCase):
    def test_single_types(self):
        for v, want in ((1, [1]), (2, [2]), (3, [3])):
            with self.subTest(weapon_attr=v):
                self.assertEqual(json.loads(_weapon_attrs_from_attr(v)), want)

    def test_combination_types(self):
        """4/5/6 是双类型组合（这是本次修复的核心）。"""
        for v, want in ((4, [1, 2]), (5, [1, 3]), (6, [2, 3])):
            with self.subTest(weapon_attr=v):
                got = json.loads(_weapon_attrs_from_attr(v))
                self.assertEqual(sorted(got), want, f"weapon_attr={v} 应为 {want}")

    def test_never_emits_nothing_for_known_values(self):
        """1-6 都不应产出空集合（空集合会让「损伤提升匹配」永远失配）。"""
        for v in (1, 2, 3, 4, 5, 6):
            with self.subTest(weapon_attr=v):
                self.assertNotEqual(json.loads(_weapon_attrs_from_attr(v)), [])

    def test_unknown_values_are_empty(self):
        for v in (None, 0, 7, 99, "", "abc"):
            with self.subTest(weapon_attr=v):
                self.assertEqual(json.loads(_weapon_attrs_from_attr(v)), [])

    def test_output_is_sorted_and_stable(self):
        """升序 + 幂等：便于比较，且重复调用结果一致。"""
        for v in range(1, 7):
            a = json.loads(_weapon_attrs_from_attr(v))
            b = json.loads(_weapon_attrs_from_attr(v))
            self.assertEqual(a, b)
            self.assertEqual(a, sorted(a))

    def test_mapping_table_is_the_single_source(self):
        """映射表就是 1-6，不多不少（7 未在数据中出现，故不映射）。"""
        self.assertEqual(set(WEAPON_ATTR_EXPAND), {1, 2, 3, 4, 5, 6})

    def test_script_rule_matches_db_rule(self):
        """迁移脚本与 db.py 的推导必须一致，否则两处会分叉。"""
        for v in list(range(0, 9)) + [None]:
            with self.subTest(weapon_attr=v):
                self.assertEqual(
                    expected_attrs(v),
                    json.loads(_weapon_attrs_from_attr(v)),
                )

    def test_damage_type_label(self):
        self.assertEqual(damage_type_label([1, 3]), "物理、特殊")
        self.assertEqual(damage_type_label([2]), "光束")
        self.assertEqual(damage_type_label([]), "—")
        self.assertEqual(damage_type_label([1, 2, 3]), "物理、光束、特殊")
        self.assertEqual(set(DAMAGE_TYPE_NAMES), {1, 2, 3})


class TestWeaponAttrsRebuildConsistency(unittest.TestCase):
    """真实库 vs 原始 JSON：重建不应改变任何一行。"""

    @classmethod
    def setUpClass(cls):
        cls.db_path = Path(config.DB_PATH)
        cls.raw_dir = Path(config.RAW_DIR)
        if not cls.db_path.exists() or not (cls.raw_dir / "unit").is_dir():
            raise unittest.SkipTest("本地数据库或原始 JSON 不存在，跳过真实库校验")

    def test_every_weapon_matches_rebuild(self):
        expected: dict[int, list[int]] = {}
        for f in glob.glob(str(self.raw_dir / "unit" / "*.json")):
            if f.endswith("min.json"):
                continue
            try:
                with open(f, encoding="utf-8") as fh:
                    u = json.load(fh)
            except (OSError, json.JSONDecodeError):
                continue
            for entry in u.get("weapons") or []:
                w = entry.get("weapon") or {}
                wid = w.get("id")
                if wid:
                    expected[int(wid)] = json.loads(
                        _weapon_attrs_from_attr(w.get("weapon_attr"))
                    )
        self.assertTrue(expected, "原始 JSON 里没解析到任何武器？")

        con = sqlite3.connect(f"file:{self.db_path}?mode=ro", uri=True)
        try:
            rows = con.execute(
                "SELECT weapon_id, name, weapon_attrs FROM unit_weapon"
            ).fetchall()
        finally:
            con.close()
        self.assertTrue(rows, "unit_weapon 无数据？")

        mismatched = []
        for wid, name, attrs in rows:
            want = expected.get(wid)
            if want is None:
                continue
            got = json.loads(attrs or "[]")
            if got != want:
                mismatched.append((name, wid, got, want))

        self.assertEqual(
            mismatched[:10], [],
            f"有 {len(mismatched)} 把武器的 weapon_attrs 与「重建值」不一致，"
            f"重新爬取会改变数据；示例：{mismatched[:5]}",
        )

    def test_known_multi_type_weapons(self):
        """关键样例：这些武器的多类型信息曾经会被重建抹掉。"""
        con = sqlite3.connect(f"file:{self.db_path}?mode=ro", uri=True)
        try:
            got = {
                name: json.loads(attrs or "[]")
                for name, attrs in con.execute(
                    "SELECT name, weapon_attrs FROM unit_weapon "
                    "WHERE name IN ('洗牌同盟拳 EX', '解除阿赖耶识限制器', "
                    "'光束军刀 EX', '全领域攻击 EX')"
                )
            }
        finally:
            con.close()

        self.assertEqual(got.get("洗牌同盟拳 EX"), [1, 3],
                         "洗牌同盟拳 EX 应为 物理 + 特殊")
        self.assertEqual(got.get("解除阿赖耶识限制器"), [1, 3])
        self.assertEqual(got.get("光束军刀 EX"), [1, 2],
                         "光束军刀 EX 应为 物理 + 光束")
        self.assertEqual(got.get("全领域攻击 EX"), [2, 3],
                         "全领域攻击 EX 应为 光束 + 特殊")


if __name__ == "__main__":
    unittest.main()
