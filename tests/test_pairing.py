"""pairing 评分模型回归测试。

这一层最需要护栏：配对得分由一套纯规则计算得出，一个正则或权重的改动
会**静默**改变全站排名——没有报错，只是推荐结果悄悄变了，人工很难发现。

分两类：
- 纯函数层：_parse_effects 文案 → 效果字典，不依赖数据库；
- 集成层：match_pilot 走真实数据库，锁的是「排得出、排得对、排得稳」。
"""
from __future__ import annotations

import os
import unittest

from src import config
from src.pairing import _parse_effects, default_enemy, match_pilot

# 一条真实存在的机体与它的武器（高达 / 光束军刀）
REAL_UNIT_ID = 1001000100
REAL_WEAPON_ID = 1


class TestParseEffects(unittest.TestCase):
    """能力文案 → 效果字典。"""

    def test_空文案全零(self):
        eff = _parse_effects("")
        self.assertEqual(eff["dmg_up"], 0.0)
        self.assertEqual(eff["atk_pct"], 0.0)
        self.assertEqual(eff["def_pct"], 0.0)
        self.assertEqual(eff["stat_pct"], {})
        self.assertIsNone(eff["def_stack"])
        self.assertIsNone(eff["hp_recover"])

    def test_损伤提升(self):
        self.assertEqual(
            _parse_effects("对敌方造成的损伤提升15%")["dmg_up"], 15.0
        )

    def test_损伤减轻(self):
        self.assertEqual(
            _parse_effects("自身受到的损伤减轻15%")["dmg_down"], 15.0
        )

    def test_攻击力及防御力提升只算一次(self):
        """组合写法必须识别为一组，否则会被 ATK/DEF 两条正则各算一次变成 30%。

        这是本函数顶部专门做 combo 预处理的原因，属于极易回归的点。
        """
        eff = _parse_effects("自身攻击力及防御力提升15%")
        self.assertEqual(eff["atk_pct"], 15.0, msg="攻击力被重复计入")
        self.assertEqual(eff["def_pct"], 15.0, msg="防御力被重复计入")

    def test_攻击力及防御力_用与连接(self):
        eff = _parse_effects("自身攻击力与防御力提升10%")
        self.assertEqual(eff["atk_pct"], 10.0)
        self.assertEqual(eff["def_pct"], 10.0)

    def test_攻击力及爆击损伤不算作攻击力(self):
        """真实文案：自身攻击力及爆击损伤提升10%。

        这个 10% 属于爆击损伤，不应被当成攻击力加成。
        """
        eff = _parse_effects("自身攻击力及爆击损伤提升10%")
        self.assertEqual(eff["crit_dmg"], 10.0)
        self.assertEqual(eff["atk_pct"], 0.0, msg="爆击损伤被误算成攻击力")
        self.assertEqual(eff["dmg_up"], 0.0, msg="爆击损伤被误算成普通增伤")

    def test_爆击率提升(self):
        self.assertEqual(
            _parse_effects("自身爆击率提升15%")["crit_rate"], 15.0
        )

    def test_驾驶员单属性提升(self):
        eff = _parse_effects("自身射击值提升20%")
        self.assertEqual(eff["stat_pct"].get("ranged"), 20.0)

    def test_驾驶员多属性提升各自计入(self):
        eff = _parse_effects("自身觉醒值及反应值提升20%")
        self.assertEqual(eff["stat_pct"].get("awaken"), 20.0)
        self.assertEqual(eff["stat_pct"].get("reaction"), 20.0)

    def test_防御叠加_半角与全角括号都能解析(self):
        """两种括号写法在真实文案里都存在，漏掉半角会少算一条加成。"""
        full = _parse_effects(
            "每次受到来自敌方的损伤时，\n自身防御力提升5%（最高25%）"
        )
        half = _parse_effects(
            "每次受到来自敌方的损伤时，\n自身防御力提升10%(最高50%)"
        )
        self.assertEqual(full["def_stack"], (5, 25))
        self.assertEqual(half["def_stack"], (10, 50),
                         msg="半角括号写法的防御叠加被漏掉了")

    def test_HP恢复(self):
        eff = _parse_effects("自身HP为50%以下时，自身HP恢复20%（1次）")
        self.assertEqual(eff["hp_recover"], (50, 20))

    def test_组合文案可叠加解析(self):
        """真实文案里一段描述常含多个效果，应全部解析出来。"""
        eff = _parse_effects(
            "搭乘单位含有上述“标签”时，\n"
            "对敌方造成的损伤提升15%、\n"
            "自身受到的损伤减轻15%"
        )
        self.assertEqual(eff["dmg_up"], 15.0)
        self.assertEqual(eff["dmg_down"], 15.0)


@unittest.skipUnless(
    os.path.exists(config.DB_PATH), "需要本地数据库 data/db/gundam.db"
)
class TestMatchPilotIntegration(unittest.TestCase):
    """走真实数据库的集成测试，锁定排名行为。"""

    def test_默认敌人配置可用(self):
        e = default_enemy()
        self.assertIn("power", e)
        self.assertGreater(float(e.get("power") or 0), 0)

    def test_攻击模式正常返回且字段完整(self):
        r = match_pilot(
            REAL_UNIT_ID, action="attack", weapon_id=REAL_WEAPON_ID
        )
        self.assertTrue(r.get("ok"), msg=r.get("error"))
        self.assertGreater(len(r["pilots"]), 0)
        self.assertEqual(r["total"], len(r["pilots"]))
        for key in ("id", "name", "score", "damage"):
            self.assertIn(key, r["pilots"][0])

    def test_结果按得分降序排列(self):
        """排名是这个功能的核心价值，顺序错了等于推荐全错。"""
        r = match_pilot(
            REAL_UNIT_ID, action="attack", weapon_id=REAL_WEAPON_ID
        )
        scores = [p["score"] for p in r["pilots"]]
        self.assertEqual(
            scores, sorted(scores, reverse=True), msg="配对结果未按得分降序"
        )

    def test_同一输入结果稳定(self):
        """同样的输入跑两次必须得到同样的排名，否则用户刷新一次结果就变。"""
        a = match_pilot(
            REAL_UNIT_ID, action="attack", weapon_id=REAL_WEAPON_ID
        )
        b = match_pilot(
            REAL_UNIT_ID, action="attack", weapon_id=REAL_WEAPON_ID
        )
        self.assertEqual(
            [p["id"] for p in a["pilots"]],
            [p["id"] for p in b["pilots"]],
            msg="两次配对结果不一致",
        )

    def test_防御模式敌方威力为0时返回错误而非死循环(self):
        """回归：威力 0 时单次伤害恒为 0，模拟循环曾无限卡死请求线程。

        这里不仅断言返回错误，还要求它**立刻**返回——超时即为失败。
        """
        r = match_pilot(
            REAL_UNIT_ID,
            action="defense",
            enemy={"power": 0},
        )
        self.assertFalse(r.get("ok"))
        self.assertIn("威力", r.get("error", ""))

    def test_不存在的机体返回错误(self):
        r = match_pilot(999999999, action="attack", weapon_id=1)
        self.assertFalse(r.get("ok"))


if __name__ == "__main__":
    unittest.main()
