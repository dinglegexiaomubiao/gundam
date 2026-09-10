"""伤害公式回归测试（公式依据：formulas.docx）。

设计原则：
- 期望值一律**手工推导**得出，不从被测代码抄输出，否则代码错了测试会跟着错；
- 能精确手算的量（sigmoid 在攻=防时恒为 0.5、向上取整边界）用精确断言；
- 依赖 exp() 的量用手算近似值 + 容差；
- 另有一组结构性断言（护盾/暴击/战意/单调性），它们锁的是**关系**而非具体数字，
  即使数值微调也不会误报，但公式被改动时会立刻失败。
"""
from __future__ import annotations

import math
import unittest

from src.damage import (
    CRITICAL_CORRECTION,
    VIGOR_DAMAGE_BONUS,
    CombatantStats,
    DamageContext,
    calculate_damage,
)


class TestDamageFormula(unittest.TestCase):
    """damage.calculate_damage 公式链。"""

    def test_攻防相等时两个sigmoid恒为0_5(self):
        """攻=防 → exp(0)=1 → sigmoid = 1/(1+1) = 0.5，可精确手算。"""
        a = CombatantStats(unit_attack=1000, character_attack=1000)
        d = CombatantStats(unit_defense=1000, character_defense=1000)
        r = calculate_damage(a, d, DamageContext(weapon_power=1000))

        # 两个 stat_ratio 因 max(0, ...) 归零
        self.assertEqual(r["character_stat_ratio"], 0.0)
        self.assertEqual(r["unit_stat_ratio"], 0.0)
        # 两个 sigmoid 精确等于 0.5
        self.assertAlmostEqual(r["character_sigmoid"], 0.5, places=12)
        self.assertAlmostEqual(r["unit_sigmoid"], 0.5, places=12)
        # sum = 1.0 → base = weapon_power
        self.assertEqual(r["base_damage"], 1000)

    def test_基础伤害手算值并验证向上取整(self):
        """手算：char_ratio=0.1, unit_ratio=0.01, 两个 sigmoid≈0.7773/0.5312。

        sum ≈ 1.41851 → 1000 倍 = 1418.51 → 向上取整 = 1419。
        注意 1419 ≠ round(1418.51)=1418，这条同时锁住了 RoundUp 语义。
        """
        a = CombatantStats(unit_attack=1000, character_attack=1000)
        d = CombatantStats(unit_defense=500, character_defense=500)
        r = calculate_damage(a, d, DamageContext(weapon_power=1000))

        self.assertAlmostEqual(r["character_stat_ratio"], 0.1, places=12)
        self.assertAlmostEqual(r["unit_stat_ratio"], 0.01, places=12)
        # 1/(exp(-1.25)+1) ≈ 0.77730
        self.assertAlmostEqual(r["character_sigmoid"], 0.7773, places=4)
        # 1/(exp(-0.125)+1) ≈ 0.53121
        self.assertAlmostEqual(r["unit_sigmoid"], 0.5312, places=4)
        # 向上取整，不是四舍五入
        self.assertEqual(r["base_damage"], 1419)

    def test_攻击低于防御时ratio归零且伤害不为负(self):
        """max(0, ...) 保护：攻击方远弱于防御方时 ratio 为 0，最终伤害 >= 0。"""
        a = CombatantStats(unit_attack=100, character_attack=100)
        d = CombatantStats(unit_defense=5000, character_defense=5000)
        r = calculate_damage(a, d, DamageContext(weapon_power=1000))

        self.assertEqual(r["character_stat_ratio"], 0.0)
        self.assertEqual(r["unit_stat_ratio"], 0.0)
        self.assertGreaterEqual(r["final_damage"], 0)

    def test_战意增伤档位常量(self):
        """来自 formulas.docx：normal +0%、强势 +10%、超强势 +20%、超一击 +30%。"""
        self.assertEqual(
            VIGOR_DAMAGE_BONUS,
            {"normal": 0.0, "high": 10.0, "max": 20.0, "supercharged": 30.0},
        )

    def test_战意加成进入总倍率(self):
        """战意 = max 时，总倍率应为 +20%（无其他加成项）。"""
        a = CombatantStats(unit_attack=1000, character_attack=1000)
        d = CombatantStats(unit_defense=1000, character_defense=1000)
        ctx = DamageContext(weapon_power=1000, attacker_vigor="max")
        r = calculate_damage(a, d, ctx)

        self.assertEqual(r["total_damage_multiplier_percent"], 20.0)

    def test_暴击修正档位常量(self):
        """一般士气 +10%、强势/超强势 +20%、超一击 +30%。"""
        self.assertEqual(
            CRITICAL_CORRECTION,
            {"normal": 10.0, "high": 20.0, "max": 20.0, "supercharged": 30.0},
        )

    def test_暴击时按1_1倍放大(self):
        """普通战意 + 暴击 → 修正 10% → final ≈ ceil(combined × 1.1)。"""
        a = CombatantStats(unit_attack=1000, character_attack=1000)
        d = CombatantStats(unit_defense=1000, character_defense=1000)
        base = calculate_damage(a, d, DamageContext(weapon_power=1000))
        crit = calculate_damage(
            a, d, DamageContext(weapon_power=1000, critical=True)
        )

        self.assertEqual(crit["critical_correction_percent"], 10.0)
        expected = math.ceil(base["combined_damage"] * 1.1)
        self.assertEqual(crit["final_damage"], expected)
        self.assertGreater(crit["final_damage"], base["final_damage"])

    def test_未暴击时无暴击修正(self):
        a = CombatantStats(unit_attack=1000, character_attack=1000)
        d = CombatantStats(unit_defense=1000, character_defense=1000)
        r = calculate_damage(a, d, DamageContext(weapon_power=1000))
        self.assertEqual(r["critical_correction_percent"], 0.0)

    def test_护盾使伤害降到0_8倍(self):
        """defensive_correction = 0.8（有护盾）时最终伤害约为无护盾的 80%。"""
        a = CombatantStats(unit_attack=1200, character_attack=900)
        d = CombatantStats(unit_defense=800, character_defense=700)
        no_shield = calculate_damage(
            a, d, DamageContext(weapon_power=1500, defensive_correction=1.0)
        )
        shield = calculate_damage(
            a, d, DamageContext(weapon_power=1500, defensive_correction=0.8)
        )

        self.assertAlmostEqual(
            shield["combined_damage"],
            no_shield["combined_damage"] * 0.8,
            places=6,
        )
        self.assertLess(shield["final_damage"], no_shield["final_damage"])

    def test_地形修正线性作用于战斗伤害(self):
        a = CombatantStats(unit_attack=1000, character_attack=1000)
        d = CombatantStats(unit_defense=1000, character_defense=1000)
        flat = calculate_damage(
            a, d, DamageContext(weapon_power=1000, terrain_correction=1.0)
        )
        half = calculate_damage(
            a, d, DamageContext(weapon_power=1000, terrain_correction=0.5)
        )

        self.assertEqual(
            half["battle_damage"], math.ceil(flat["battle_damage"] * 0.5)
        )

    def test_伤害随攻击方攻击力单调不减(self):
        """结构性断言：攻击力提升不应让伤害下降。"""
        d = CombatantStats(unit_defense=1000, character_defense=1000)
        prev = -1
        for atk in (600, 800, 1000, 1200, 1400, 1600):
            a = CombatantStats(unit_attack=atk, character_attack=1000)
            r = calculate_damage(a, d, DamageContext(weapon_power=1000))
            self.assertGreaterEqual(
                r["final_damage"], prev, msg=f"攻击力 {atk} 时伤害回退了"
            )
            prev = r["final_damage"]

    def test_伤害随防御方防御力单调不增(self):
        """结构性断言：防御力提升不应让伤害上升。"""
        a = CombatantStats(unit_attack=1500, character_attack=1200)
        prev = float("inf")
        for dfn in (400, 700, 1000, 1300, 1600):
            d = CombatantStats(unit_defense=dfn, character_defense=dfn)
            r = calculate_damage(a, d, DamageContext(weapon_power=1000))
            self.assertLessEqual(
                r["final_damage"], prev, msg=f"防御力 {dfn} 时伤害反而上升了"
            )
            prev = r["final_damage"]

    def test_武器威力线性放大基础伤害(self):
        a = CombatantStats(unit_attack=1000, character_attack=1000)
        d = CombatantStats(unit_defense=1000, character_defense=1000)
        r1 = calculate_damage(a, d, DamageContext(weapon_power=1000))
        r2 = calculate_damage(a, d, DamageContext(weapon_power=2000))
        self.assertEqual(r2["base_damage"], r1["base_damage"] * 2)

    def test_伤害加成与减伤项互相抵消(self):
        """+30% 增伤 与 -30% 减伤 应相互抵消，等同于无修正。"""
        a = CombatantStats(unit_attack=1000, character_attack=1000)
        d = CombatantStats(unit_defense=1000, character_defense=1000)
        plain = calculate_damage(a, d, DamageContext(weapon_power=1000))
        offset = calculate_damage(
            a,
            d,
            DamageContext(
                weapon_power=1000,
                attacker_damage_dealt_percent=[30.0],
                defender_damage_taken_percent=[30.0],
            ),
        )
        self.assertEqual(offset["total_damage_multiplier_percent"], 0.0)
        self.assertEqual(offset["final_damage"], plain["final_damage"])

    def test_返回全部中间字段(self):
        """前端伤害页依赖这些字段逐个展示，缺一个就会显示 undefined。"""
        a = CombatantStats(unit_attack=1000, character_attack=1000)
        d = CombatantStats(unit_defense=1000, character_defense=1000)
        r = calculate_damage(a, d, DamageContext(weapon_power=1000))

        for key in (
            "character_stat_ratio",
            "unit_stat_ratio",
            "character_sigmoid",
            "unit_sigmoid",
            "base_damage",
            "attacker_combined_stat",
            "target_combined_stat",
            "damage_correction",
            "battle_damage",
            "total_damage_multiplier_percent",
            "scaled_damage",
            "combined_damage",
            "critical_correction_percent",
            "final_damage",
        ):
            self.assertIn(key, r)


if __name__ == "__main__":
    unittest.main()
