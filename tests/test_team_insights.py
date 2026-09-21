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
        # 驾驶员协同条目必须带 verdict / note（前端据此渲染括号文案）
        for item in ins["defense"]["pilot_synergy"]:
            self.assertIn(item["verdict"], ("met", "unmet", "enemy", "always"))
            self.assertIn("note", item)

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

    def test_pilot_synergy_marks_met(self):
        """机体侧条件满足的能力 → 文案「条件已满足」（不再说"时机待定"）。"""
        syn = self.d["pilot_synergy"]
        self.assertTrue(syn, "应有驾驶员协同条目")
        hp = [s for s in syn if "HP恢复7%" in s["desc"].replace(" ", "")]
        self.assertTrue(hp, f"应包含 HP恢复7% 条目，实际：{[s['desc'] for s in syn]}")
        self.assertIs(hp[0]["unit_ok"], True, "刹那 EX 能力限定 00强化模组，这里应判定为满足")
        self.assertEqual(hp[0]["verdict"], "met")
        self.assertEqual(hp[0]["note"], "条件已满足")

    def test_pilot_synergy_marks_met_for_mp_boost(self):
        syn = self.d["pilot_synergy"]
        mp = [s for s in syn if "MP提升5" in s["desc"].replace(" ", "")]
        self.assertTrue(mp)
        self.assertEqual(mp[0]["verdict"], "met")
        self.assertEqual(mp[0]["note"], "条件已满足")

    def test_pilot_mechanics_include_support_defense_count(self):
        """「支援防御几次」要在耐久段展示出来。"""
        mech = self.d["pilot_mechanics"]
        labels = [m["label"] for m in mech]
        self.assertTrue(
            any("支援防御" in x for x in labels),
            f"应展示支援防御次数，实际：{labels}",
        )
        # base_mech 里的主动技能列表不应混进机制区
        self.assertFalse([m for m in mech if m.get("kind") == "skill"])

    def test_pilot_synergy_marks_unmet_on_mismatch(self):
        """换到非 00 系的耐久机 → 限定 00强化模组 的能力应显示「不能触发」。"""
        r = self._score([
            {"unit_id": 1200003900, "star": 3, "weapon_id": 0, "pilot_id": SETSUNA_TANK},
        ])
        syn = r["insights"]["defense"]["pilot_synergy"]
        unmet = [s for s in syn if s["verdict"] == "unmet"]
        self.assertTrue(unmet, f"应出现不能触发的条目，实际：{[(s['verdict'], s['desc'][:30]) for s in syn]}")
        self.assertTrue(all(s["note"] == "不能触发" for s in unmet))
        hp = [s for s in syn if "HP恢复7%" in s["desc"].replace(" ", "")]
        self.assertTrue(hp)
        self.assertEqual(hp[0]["verdict"], "unmet", "00 限定能力在非 00 机体上不能触发")

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


class TestSynergyAndBaseline(_TeamInsightBase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        con = dbutil.connect_ro(config.DB_PATH)
        try:
            # 只提供「光束损伤提升」的支援型 → 与神高达的 物理+特殊 完全不匹配
            row = con.execute(
                "SELECT u.id, u.name FROM unit u JOIN unit_weapon w ON w.unit_id = u.id "
                "WHERE u.role = 3 AND w.weapon_effects LIKE '%光束损伤提升%' "
                "AND w.weapon_effects NOT LIKE '%物理损伤提升%' "
                "AND w.weapon_effects NOT LIKE '%特殊损伤提升%' "
                "AND IFNULL(w.map_weapon_range,'') IN ('','null','0') LIMIT 1"
            ).fetchone()
            cls.beam_only_support = row["id"] if row else None
            # 有支援攻击 ≥2 的驾驶员
            row = con.execute(
                "SELECT id FROM character WHERE "
                "CAST(json_extract(support_info,'$.attack.count') AS INTEGER) >= 2 LIMIT 1"
            ).fetchone()
            cls.attack_support_pilot = row["id"] if row else None
        finally:
            con.close()

    def _team(self, support_id, support_pilot=0):
        return [
            {"unit_id": GUNDAM_EX, "star": 3,
             "weapon_id": self.gundam_weapon_id, "pilot_id": DOMON},
            {"unit_id": OO_EX, "star": 3, "weapon_id": 0, "pilot_id": SETSUNA_TANK},
            {"unit_id": support_id, "star": 3, "weapon_id": 0, "pilot_id": support_pilot},
        ]

    def test_synergy_present_and_has_level(self):
        ins = self._score(self._team(self.support_unit_id))["insights"]
        sy = ins.get("synergy")
        self.assertIsInstance(sy, dict)
        self.assertIn(sy["level"], ("full", "partial", "none", "neutral", "unknown"))
        self.assertTrue(sy["detail"], "协同结论应有可读的说明句")

    def test_synergy_none_when_types_mismatch(self):
        """支援只给光束、攻击武器是物理+特殊 → 无法匹配 0/2。"""
        if not self.beam_only_support:
            self.skipTest("库里没有仅提供光束损伤提升的支援型")
        sy = self._score(self._team(self.beam_only_support))["insights"]["synergy"]
        self.assertEqual(sy["level"], "none")
        self.assertIn("无法匹配：0/2", sy["detail"])
        self.assertIn("支援提供 光束损伤提升", sy["detail"])
        self.assertIn("物理、特殊", sy["detail"], "说明里要点出攻击武器的实际类型")

    def test_synergy_partial_mentions_hit_and_miss(self):
        if not self.support_unit_id:
            self.skipTest("库里没有带物理损伤提升的支援型")
        sy = self._score(self._team(self.support_unit_id))["insights"]["synergy"]
        if sy["level"] != "partial":
            self.skipTest(f"该支援的匹配结果为 {sy['level']}，不适用部分匹配断言")
        self.assertIn("命中", sy["detail"])
        self.assertIn("未命中", sy["detail"])

    def test_baseline_items_and_counts(self):
        b = self._score(self._team(self.support_unit_id))["insights"]["baseline"]
        keys = {x["key"] for x in b["items"]}
        self.assertIn("movement", keys)
        self.assertIn("support_range", keys)
        self.assertIn("support_attack", keys)
        self.assertIn("defense_support", keys)
        self.assertEqual(b["passed"], sum(1 for x in b["items"] if x["ok"]))
        self.assertEqual(b["total"], len(b["items"]))
        # 移动力对全队逐一检查（3 台机体 → 至少 3 条）
        self.assertGreaterEqual(len([x for x in b["items"] if x["key"] == "movement"]), 3)

    def test_baseline_movement_threshold_is_5(self):
        b = self._score(self._team(self.support_unit_id))["insights"]["baseline"]
        for x in b["items"]:
            if x["key"] == "movement":
                self.assertEqual(x["need"], 5)
                self.assertEqual(x["ok"], x["actual"] >= 5)

    def test_baseline_ur_defense_support_defense(self):
        """UR 防御型：刹那(支援防御2次) → 达标。"""
        b = self._score(self._team(self.support_unit_id))["insights"]["baseline"]
        dfn = [x for x in b["items"] if x["key"] == "defense_support"]
        self.assertEqual(len(dfn), 1, "UR 防御型应产生一条检查")
        self.assertTrue(dfn[0]["ok"], f"刹那应达标：{dfn[0]}")
        self.assertEqual(dfn[0]["actual"], 2)

    def test_baseline_support_attack_needs_pilot(self):
        """支援槽没选驾驶员 → 支援攻击次数 0，判不达标并说明。"""
        b = self._score(self._team(self.support_unit_id, 0))["insights"]["baseline"]
        item = next(x for x in b["items"] if x["key"] == "support_attack")
        self.assertEqual(item["actual"], 0)
        self.assertFalse(item["ok"])
        self.assertEqual(item["unit"], "未选驾驶员")

        if not self.attack_support_pilot:
            self.skipTest("库里没有支援攻击≥2 的驾驶员")
        b2 = self._score(
            self._team(self.support_unit_id, self.attack_support_pilot)
        )["insights"]["baseline"]
        item2 = next(x for x in b2["items"] if x["key"] == "support_attack")
        self.assertTrue(item2["ok"])
        self.assertGreaterEqual(item2["actual"], 2)

    def test_support_counts_carried_in_insight(self):
        if not self.attack_support_pilot:
            self.skipTest("库里没有支援攻击≥2 的驾驶员")
        ins = self._score(
            self._team(self.support_unit_id, self.attack_support_pilot)
        )["insights"]
        counts = ins["support"]["support_counts"]
        self.assertIn("attack", counts)
        self.assertGreaterEqual(counts["attack"]["count"], 2)


if __name__ == "__main__":
    unittest.main()
