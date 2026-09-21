"""队伍状态摘要（insights）回归测试。

覆盖：
1. 结构完整性：attack / support / defense / match / missing 五块齐备；
2. 攻击型：最大射程（排除 MAP）与「理论最高伤害武器」的伤害类型；
3. 支援型：武器特效归类 + 与攻击武器的类型匹配（命中 / 未命中逐项列出）；
4. 防御型：移动力、GN力场式减伤（含属性）、阈值无效、单位技能；
5. 驾驶员协同：区分「机体侧条件已满足」与「触发时机待定」；
6. 缺少 role 时要如实标记 missing。

关键样例（用户实际场景）：
    神高达 (EX)            → 洗牌同盟拳 EX 的伤害类型 = 物理 + 特殊
    00强化模组(最后决战式样)(EX) → GN力场：物理/光束减伤 20%、损伤 ≤4500 无效
    刹那·F·清英 (UR 耐久型)  → EX 能力「搭乘 00强化模组 时 HP 为 0% 恢复 7%」
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src import config, dbutil  # noqa: E402
from src import pairing  # noqa: E402

GUNDAM_EX = 1200003950
GUNDAM_EX_WEAPON = "洗牌同盟拳 EX"
OO_EX = 1370005950
SETSUNA_TANK = 1370003701          # 刹那·F·清英（UR / 耐久型）
DOMON = 1200000100                 # 多蒙·卡修（攻击型驾驶员）


def db_ready() -> bool:
    return Path(config.DB_PATH).exists()


class _TeamInsightBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not db_ready():
            raise unittest.SkipTest("本地数据库不存在，跳过")
        con = dbutil.connect_ro(config.DB_PATH)
        try:
            row = con.execute(
                "SELECT id FROM unit_weapon WHERE unit_id = ? AND name = ?",
                (GUNDAM_EX, GUNDAM_EX_WEAPON),
            ).fetchone()
            if row is None:
                raise unittest.SkipTest(f"库里找不到 {GUNDAM_EX_WEAPON}")
            cls.gundam_weapon_id = row["id"]
            # 找一台带「物理损伤提升」且非 MAP 的支援型（role=3）机体
            sup = con.execute(
                "SELECT u.id FROM unit u JOIN unit_weapon w ON w.unit_id = u.id "
                "WHERE u.role = 3 AND w.weapon_effects LIKE '%物理损伤提升%' "
                "AND IFNULL(w.map_weapon_range,'') IN ('','null','0') LIMIT 1"
            ).fetchone()
            cls.support_unit_id = sup["id"] if sup else None
        finally:
            con.close()

    def _score(self, pairs):
        return pairing.team_score(pairs, break_step=3, bench="low")


class TestInsightStructure(_TeamInsightBase):
    def test_full_team(self):
        pairs = [
            {"unit_id": GUNDAM_EX, "star": 3,
             "weapon_id": self.gundam_weapon_id, "pilot_id": DOMON},
            {"unit_id": OO_EX, "star": 3, "weapon_id": 0, "pilot_id": SETSUNA_TANK},
        ]
        if self.support_unit_id:
            pairs.append({"unit_id": self.support_unit_id, "star": 3,
                          "weapon_id": 0, "pilot_id": 0})
        r = self._score(pairs)
        self.assertTrue(r.get("ok"))
        ins = r.get("insights")
        self.assertIsInstance(ins, dict, "team_score 应返回 insights")
        for key in ("attack", "support", "defense", "match", "missing"):
            self.assertIn(key, ins)

    def test_missing_roles_are_flagged(self):
        """只有攻击型 → support / defense 应标记缺失。"""
        r = self._score([
            {"unit_id": GUNDAM_EX, "star": 3,
             "weapon_id": self.gundam_weapon_id, "pilot_id": DOMON},
        ])
        miss = r["insights"]["missing"]
        self.assertFalse(miss["attack"])
        self.assertTrue(miss["support"])
        self.assertTrue(miss["defense"])
        self.assertIsNone(r["insights"]["support"])
        self.assertIsNone(r["insights"]["defense"])
        self.assertIsNone(r["insights"]["match"])

    def test_score_shape_unchanged(self):
        """新增 insights 不应破坏既有返回结构。"""
        r = self._score([
            {"unit_id": GUNDAM_EX, "star": 3,
             "weapon_id": self.gundam_weapon_id, "pilot_id": DOMON},
        ])
        for key in ("ok", "bench", "bench_def", "supporter", "pairs"):
            self.assertIn(key, r)
        w = r["pairs"][0]["weapon"]
        self.assertIsNotNone(w)
        # 旧字段仍在
        for key in ("id", "name", "power", "damage", "dep_label", "dep_value"):
            self.assertIn(key, w)
        # 新增字段
        self.assertEqual(w["attrs"], [1, 3], "洗牌同盟拳 EX 应为 物理 + 特殊")


class TestAttackInsight(_TeamInsightBase):
    def setUp(self):
        self.ins = self._score([
            {"unit_id": GUNDAM_EX, "star": 3,
             "weapon_id": self.gundam_weapon_id, "pilot_id": DOMON},
        ])["insights"]

    def test_max_range_excludes_map(self):
        a = self.ins["attack"]
        # 神高达 (EX) 全部武器都不是 MAP，故两个口径一致
        self.assertEqual(a["range"]["map_count"], 0)
        self.assertEqual(a["range"]["max_nomap"], 5)
        self.assertEqual(a["range"]["max"], 5)

    def test_best_weapon_is_theoretical_max(self):
        """「理论最高（武器伤害 + 武器特效）」——不是队伍里选中的那一把。"""
        a = self.ins["attack"]
        bw = a["best_weapon"]
        self.assertIsNotNone(bw)
        self.assertEqual(bw["attrs"], [1, 3], "洗牌同盟拳 EX 应为 物理 + 特殊")
        self.assertGreater(bw["damage"], 0)
        # 石破天惊神威掌（射程 3-5，base 4800）比洗牌同盟拳（6900）低，
        # 故最高伤害武器是洗牌同盟拳；若未来数据变化，至少保证它来自该机体
        self.assertEqual(bw["name"], GUNDAM_EX_WEAPON)

    def test_best_weapon_carries_range_and_dep(self):
        bw = self.ins["attack"]["best_weapon"]
        self.assertEqual((bw["range_min"], bw["range_max"]), (1, 3))
        self.assertTrue(bw.get("dep_label"))
        self.assertFalse(bw.get("map"))


class TestDefenseInsight(_TeamInsightBase):
    def setUp(self):
        self.d = self._score([
            {"unit_id": OO_EX, "star": 3, "weapon_id": 0, "pilot_id": SETSUNA_TANK},
        ])["insights"]["defense"]

    def test_movement(self):
        self.assertEqual(self.d["movement"]["max"], 5)

    def test_gn_field_mitigation_has_attrs(self):
        """GN力场：物理 / 光束 武装减伤 20%。"""
        hits = [m for m in self.d["mitigations"]
                if m["value"] == 20 and sorted(m["attrs"]) == [1, 2]]
        self.assertTrue(hits, f"应有一条 20% 且属物理+光束的减伤，实际：{self.d['mitigations']}")
        self.assertIn("损伤减轻20%", hits[0]["desc"].replace(" ", ""))

    def test_damage_threshold(self):
        """损伤 ≤4500 时无效。"""
        vals = [t["value"] for t in self.d["thresholds"]]
        self.assertIn(4500, vals)

    def test_unit_skill(self):
        skill = self.d.get("unit_skill")
        self.assertIsNotNone(skill, "EX 机体应有单位技能")
        self.assertIn("攻击力提升25%", skill["desc"].replace(" ", ""))
        self.assertIn("防御力提升15%", skill["desc"].replace(" ", ""))

    def test_pilot_synergy_splits_unit_ok_and_timing(self):
        """刹那的 EX 能力：机体条件满足，但触发时机（HP 为 0%）待定。"""
        syn = self.d["pilot_synergy"]
        self.assertTrue(syn, "应有驾驶员协同条目")
        hp = [s for s in syn if "HP恢复7%" in s["desc"].replace(" ", "")]
        self.assertTrue(hp, f"应包含 HP恢复7% 条目，实际：{[s['desc'] for s in syn]}")
        self.assertIs(hp[0]["unit_ok"], True, "刹那 EX 能力限定 00强化模组，这里应判定为满足")
        self.assertEqual(hp[0]["status"], "potential", "HP 为 0% 属时机条件，应标为待定")

    def test_pilot_synergy_counts_unconditional(self):
        syn = self.d["pilot_synergy"]
        mp = [s for s in syn if "MP提升5" in s["desc"].replace(" ", "")]
        self.assertTrue(mp)
        self.assertEqual(mp[0]["status"], "counted", "机体条件满足且无时机条件 → 恒生效")

    def test_no_pilot_means_empty_synergy(self):
        d = self._score([
            {"unit_id": OO_EX, "star": 3, "weapon_id": 0, "pilot_id": 0},
        ])["insights"]["defense"]
        self.assertEqual(d["pilot_synergy"], [])


@unittest.skipUnless(True, "需要库中存在带物理损伤提升的支援型机体")
class TestSupportAndMatch(_TeamInsightBase):
    def setUp(self):
        if not self.support_unit_id:
            self.skipTest("库里没有带「物理损伤提升」的支援型机体")
        self.ins = self._score([
            {"unit_id": GUNDAM_EX, "star": 3,
             "weapon_id": self.gundam_weapon_id, "pilot_id": DOMON},
            {"unit_id": self.support_unit_id, "star": 3,
             "weapon_id": 0, "pilot_id": 0},
        ])["insights"]

    def test_support_effects_classified(self):
        s = self.ins["support"]
        ups = [e for e in s["effects"] if e["kind"] == "dmg_up"]
        self.assertTrue(ups, "应识别出损伤提升类特效")
        self.assertIn(1, s["dmg_up_types"], "至少应提供 物理 损伤提升")
        for e in ups:
            self.assertIsNotNone(e["range_max"], "特效条目应带来源武器射程")
            self.assertTrue(e["weapon"])

    def test_match_lists_hits_and_misses_per_type(self):
        """攻击武器 = 物理+特殊；支援只给物理 → 命中 1 项、未命中 1 项，且逐项可辨。"""
        m = self.ins["match"]
        self.assertEqual(m["attack_attrs"], [1, 3])
        self.assertEqual(m["total"], 2)
        covered = {c["type"] for c in m["covered"]}
        missed = {c["type"] for c in m["missed"]}
        self.assertIn(1, covered, "物理应命中")
        self.assertTrue(missed, "支援未提供特殊，应有一项未命中")
        self.assertEqual(m["hit_count"], len(covered))
        self.assertEqual(covered | missed, {1, 3})
        # 命中项要能追溯到来源特效
        for c in m["covered"]:
            self.assertTrue(c.get("by"))


if __name__ == "__main__":
    unittest.main()
