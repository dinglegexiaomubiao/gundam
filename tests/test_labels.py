"""labels 解析函数与效果正则回归测试。

为什么值得测：
    这些正则同时被「详情页展示」和「配对/组队算分」两处使用（已收敛到本模块）。
    改错一个字符，界面上的加成数字和配对排名会**静默**不一致——没有任何报错，
    只是推荐结果悄悄变了。这里把它们锁死。

期望值来源：
    - 常量与数值：按 README / formulas.docx 的口径手工推导；
    - 正则：语料取自数据库里的**真实**能力文案（如「自身射击值提升20%」）。
"""
from __future__ import annotations

import os
import sqlite3
import unittest

from src import config
from src.labels import (
    ATK_UP_RE,
    CRIT_DMG_RE,
    CRIT_RATE_RE,
    DEF_STACK_RE,
    DEF_UP_RE,
    DMG_DOWN_RE,
    DMG_UP_RE,
    HP_RECOVER_RE,
    RARITY,
    ROLE_NAMES,
    STAR_LABEL,
    STAR_MULT,
    STAT_ALIAS,
    STAT_COMBO_RE,
    parse_weapon_max_level,
    split_trait_stages,
    star_value,
)


class TestConstants(unittest.TestCase):
    """与游戏设定绑定的常量，改了就是改了业务口径。"""

    def test_稀有度映射(self):
        self.assertEqual(RARITY, {5: "UR", 4: "SSR", 3: "SR", 2: "R", 1: "N"})

    def test_升星倍率与显示标签一致(self):
        """倍率分数与 UI 上显示的 ×1.2/×1.3/×1.4 必须对得上。"""
        for star, label in STAR_LABEL.items():
            num, den = STAR_MULT[star]
            self.assertEqual(
                label,
                f"×{num / den:.1f}",
                msg=f"{star} 星的倍率与显示标签不一致",
            )

    def test_升星倍率数值(self):
        self.assertEqual(STAR_MULT[0], (1, 1))    # ×1.0
        self.assertEqual(STAR_MULT[1], (6, 5))    # ×1.2
        self.assertEqual(STAR_MULT[2], (13, 10))  # ×1.3
        self.assertEqual(STAR_MULT[3], (7, 5))    # ×1.4

    def test_角色类型名称(self):
        self.assertEqual(
            ROLE_NAMES, {1: "攻击型", 2: "耐久型", 3: "支援型"}
        )

    def test_驾驶员属性别名齐全(self):
        self.assertEqual(
            STAT_ALIAS,
            {
                "射击值": "ranged",
                "格斗值": "melee",
                "守备值": "defense",
                "觉醒值": "awaken",
                "反应值": "reaction",
            },
        )


class TestStarValue(unittest.TestCase):
    """星级基础值 = floor(基础值 × 倍率)；最终值 = floor(星级基础值 × (1+加成%))。"""

    def test_0星无加成(self):
        self.assertEqual(star_value(1000, 0, 0), (1000, 0))

    def test_3星无加成(self):
        """floor(1000 × 1.4) = 1400。"""
        self.assertEqual(star_value(1000, 0, 3), (1400, 0))

    def test_3星带15加成(self):
        """floor(1400 × 1.15) = 1610，绿色 +210 是能力加成部分。"""
        self.assertEqual(star_value(1000, 15, 3), (1610, 210))

    def test_2星带15加成(self):
        """floor(1000 × 1.3) = 1300 → floor(1300 × 1.15) = 1495。"""
        self.assertEqual(star_value(1000, 15, 2), (1495, 195))

    def test_向下取整而非四舍五入(self):
        """floor(999 × 1.2) = floor(1198.8) = 1198（四舍五入会得到 1199）。"""
        self.assertEqual(star_value(999, 0, 1), (1198, 0))

    def test_未知星级退回1_0倍(self):
        self.assertEqual(star_value(1000, 0, 99), (1000, 0))

    def test_加成部分始终非负(self):
        for star in (0, 1, 2, 3):
            final, bonus = star_value(500, 20, star)
            self.assertEqual(final - bonus, 500 * STAR_MULT[star][0]
                             // STAR_MULT[star][1])


class TestSplitTraitStages(unittest.TestCase):
    """能力描述按「效果结束时」分段。"""

    def test_空串返回空列表(self):
        self.assertEqual(split_trait_stages(""), [])
        self.assertEqual(split_trait_stages(None), [])

    def test_单段原样返回(self):
        self.assertEqual(split_trait_stages("自身射击值提升20%"),
                         ["自身射击值提升20%"])

    def test_按全角逗号分段(self):
        self.assertEqual(
            split_trait_stages("第一段效果结束时，第二段"),
            ["第一段", "第二段"],
        )

    def test_兼容半角逗号(self):
        self.assertEqual(
            split_trait_stages("第一段效果结束时, 第二段"),
            ["第一段", "第二段"],
        )


class TestEffectRegex(unittest.TestCase):
    """效果文案解析正则——语料取自数据库真实文案。"""

    def test_损伤提升_真实文案(self):
        m = DMG_UP_RE.search("对敌方造成的损伤提升15%")
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), "15")

    def test_爆击损伤不被当成普通损伤提升(self):
        """负向后视保护：爆击损伤提升必须走 CRIT_DMG_RE，不能被重复计入。"""
        text = "自身爆击损伤提升10%"
        self.assertIsNotNone(CRIT_DMG_RE.search(text))
        self.assertEqual(CRIT_DMG_RE.search(text).group(1), "10")
        self.assertIsNone(
            DMG_UP_RE.search(text),
            msg="爆击损伤被 DMG_UP_RE 重复匹配，会导致加成被算两次",
        )

    def test_损伤减轻(self):
        m = DMG_DOWN_RE.search("自身受到的损伤减轻15%")
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), "15")

    def test_防御力提升_真实文案(self):
        m = DEF_UP_RE.search("自身防御力提升20%")
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), "20")

    def test_攻击力提升(self):
        m = ATK_UP_RE.search("自身攻击力提升10%")
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), "10")

    def test_爆击率提升_真实文案(self):
        m = CRIT_RATE_RE.search("自身爆击率提升15%")
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), "15")

    def test_驾驶员属性提升_单属性(self):
        m = STAT_COMBO_RE.search("自身射击值提升20%")
        self.assertIsNotNone(m)
        self.assertEqual(m.group(2), "20")
        self.assertIn("射击值", m.group(1))

    def test_驾驶员属性提升_多属性(self):
        m = STAT_COMBO_RE.search("自身射击值及格斗值提升15%")
        self.assertIsNotNone(m)
        self.assertEqual(m.group(2), "15")
        self.assertIn("射击值", m.group(1))
        self.assertIn("格斗值", m.group(1))

    def test_真实文案_觉醒值及反应值(self):
        """数据库原文：自身觉醒值及反应值提升20%。"""
        m = STAT_COMBO_RE.search("自身觉醒值及反应值提升20%")
        self.assertIsNotNone(m)
        self.assertEqual(m.group(2), "20")

    def test_防御叠加_全角括号(self):
        m = DEF_STACK_RE.search(
            "每次受到来自敌方的损伤时，自身防御力提升5%（最高25%）"
        )
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), "5")
        self.assertEqual(m.group(2), "25")

    def test_防御叠加_半角括号(self):
        """真实文案存在半角括号写法；只认全角会让它被静默忽略。"""
        m = DEF_STACK_RE.search(
            "每次受到来自敌方的损伤时，自身防御力提升10%(最高50%)"
        )
        self.assertIsNotNone(m, msg="半角括号写法未被识别")
        self.assertEqual(m.group(1), "10")
        self.assertEqual(m.group(2), "50")

    def test_防御叠加_真实文案含换行(self):
        """数据库原文在「损伤时，」后有换行，两种括号都要能识别。"""
        cases = (
            ("每次受到来自敌方的损伤时，\n自身防御力提升5%（最高25%）",
             "5", "25"),
            ("每次受到来自敌方的损伤时，\n自身防御力提升10%(最高50%)",
             "10", "50"),
        )
        for text, step, cap in cases:
            m = DEF_STACK_RE.search(text)
            self.assertIsNotNone(m, msg=f"未识别：{text!r}")
            self.assertEqual(m.group(1), step)
            self.assertEqual(m.group(2), cap)

    def test_HP恢复(self):
        m = HP_RECOVER_RE.search("自身HP为50%以下时，自身HP恢复20%（1次）")
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), "50")
        self.assertEqual(m.group(2), "20")

    def test_无效文案不匹配(self):
        for text in ("自身移动力提升1", "“支援防御”+1次", "自身MP提升2"):
            self.assertIsNone(DMG_UP_RE.search(text), msg=text)
            self.assertIsNone(DEF_UP_RE.search(text), msg=text)


class TestParseWeaponMaxLevel(unittest.TestCase):
    """武器取最高级数值：数值 = floor(基础值 × 修正率 / 100)。"""

    def _weapon(self, trait_level=5, stats_level=5):
        return {
            "power": 3000,
            "en": 20,
            "hit_rate": 90,
            "critical_rate": 10,
            "growth": {
                "stats_change": [
                    {
                        "weapon_level": 1,
                        "power_correction_rate": 100,
                        "en_correction_rate": 100,
                        "hit_rate_correction_rate": 100,
                        "crit_correction_rate": 100,
                    },
                    {
                        "weapon_level": stats_level,
                        "power_correction_rate": 130,
                        "en_correction_rate": 110,
                        "hit_rate_correction_rate": 105,
                        "crit_correction_rate": 120,
                    },
                ],
                "traits": [
                    {
                        "current_weapon_level": trait_level,
                        "slot_number": 1,
                        "trait": {"name": "特效A", "desc": "描述A"},
                    }
                ],
            },
        }

    def test_最高级与数值换算(self):
        r = parse_weapon_max_level(self._weapon())
        self.assertEqual(r["level"], 5)
        # floor(3000 × 130 / 100) = 3900
        self.assertEqual(r["power"], 3900)
        # floor(20 × 110 / 100) = 22
        self.assertEqual(r["en"], 22)
        # floor(90 × 105 / 100) = floor(94.5) = 94
        self.assertEqual(r["hit"], 94)
        # floor(10 × 120 / 100) = 12
        self.assertEqual(r["crit"], 12)

    def test_特效最高级优先于属性最高级(self):
        """SSP 武器特效到 9 级，此时最高级应取 9 而非属性的 5。"""
        r = parse_weapon_max_level(self._weapon(trait_level=9))
        self.assertEqual(r["level"], 9)

    def test_无特效时取属性最高级(self):
        w = self._weapon()
        w["growth"]["traits"] = []
        self.assertEqual(parse_weapon_max_level(w)["level"], 5)

    def test_特效按槽位排序输出(self):
        w = self._weapon()
        w["growth"]["traits"] = [
            {"current_weapon_level": 5, "slot_number": 2,
             "trait": {"name": "B", "desc": "dB"}},
            {"current_weapon_level": 5, "slot_number": 1,
             "trait": {"name": "A", "desc": "dA"}},
        ]
        r = parse_weapon_max_level(w)
        self.assertEqual([e["name"] for e in r["effects"]], ["A", "B"])

    def test_空输入不报错(self):
        r = parse_weapon_max_level({})
        self.assertEqual(r["level"], 0)
        self.assertEqual(r["effects"], [])


@unittest.skipUnless(
    os.path.exists(config.DB_PATH), "需要本地数据库 data/db/gundam.db"
)
class TestRegexAgainstRealCorpus(unittest.TestCase):
    """用数据库里的真实文案体检：正则若与真实措辞脱节，这里会失败。

    这条测试不验证具体数值，只保证每条正则在真实语料上仍有命中——
    防止改正则时把某类效果整个漏掉而无人察觉。
    """

    @classmethod
    def setUpClass(cls):
        conn = sqlite3.connect(f"file:{config.DB_PATH}?mode=ro", uri=True)
        corpus: list[str] = []
        for table in (
            "character_ability",
            "unit_ability",
            "character_skill",
            "supporter_skill",
        ):
            try:
                rows = conn.execute(
                    f"SELECT traits FROM {table} WHERE traits IS NOT NULL"
                ).fetchall()
            except sqlite3.OperationalError:
                continue
            for (raw,) in rows:
                try:
                    items = __import__("json").loads(raw)
                except (ValueError, TypeError):
                    continue
                for it in items or []:
                    d = (it.get("desc") or "").strip()
                    if d:
                        corpus.append(d)
        for table in (
            "character_skill",
            "unit_skill",
            "supporter_skill",
            "character_ability",
            "unit_ability",
        ):
            for (d,) in conn.execute(
                f"SELECT desc FROM {table} "
                f"WHERE desc IS NOT NULL AND desc != ''"
            ):
                corpus.append((d or "").strip())
        conn.close()
        cls.corpus = list(dict.fromkeys(corpus))

    def test_语料非空(self):
        self.assertGreater(len(self.corpus), 100)

    def test_每条正则在真实语料上都有命中(self):
        # HP_RECOVER_RE / DEF_STACK_RE 在真实文案里较少见，阈值放低
        expected = {
            DMG_UP_RE: 5,
            DMG_DOWN_RE: 5,
            DEF_UP_RE: 3,
            ATK_UP_RE: 3,
            CRIT_RATE_RE: 3,
            STAT_COMBO_RE: 10,
            CRIT_DMG_RE: 1,
            HP_RECOVER_RE: 1,
            DEF_STACK_RE: 1,
        }
        for rx, floor in expected.items():
            hits = sum(1 for d in self.corpus if rx.search(d))
            self.assertGreaterEqual(
                hits,
                floor,
                msg=f"{rx.pattern[:40]}... 只命中 {hits} 条，"
                    f"疑似与真实措辞脱节",
            )


if __name__ == "__main__":
    unittest.main()
