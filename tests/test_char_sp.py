"""驾驶员 SP 形态：能力/技能按形态分开（覆盖而非叠加）+ 支援备注只计默认形态。

背景：同一槽位的 ability/ability_sp 是默认形态与 SP 形态（SP 是升级、覆盖），
原实现把二者都入库并都计入支援次数，导致「约姆·卡克斯」之类的能力显示翻倍、
备注被算成 2 次。
"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import src.config as config  # noqa: E402
from src.db import _char_slot_variants, _support_info  # noqa: E402
from src.webapp import api_character_detail  # noqa: E402


def _db_ready() -> bool:
    try:
        p = Path(config.DB_PATH)
    except Exception:
        return False
    return p.exists() and p.stat().st_size > 0


class TestCharSlotVariants(unittest.TestCase):
    def test_same_id_kept_once_as_default(self):
        slot = {"skill": {"id": 10}, "skill_sp": {"id": 10}}
        out = _char_slot_variants(slot, "skill", "skill_sp",
                                  "character_skill_id", "sp_character_skill_id")
        self.assertEqual([(i, s) for i, _o, s in out], [(10, 0)])

    def test_different_ids_split_into_two(self):
        slot = {"ability": {"id": 1}, "ability_sp": {"id": 2}}
        out = _char_slot_variants(slot, "ability", "ability_sp",
                                  "ability_id", "sp_ability_id")
        self.assertEqual([(i, s) for i, _o, s in out], [(1, 0), (2, 1)])

    def test_sp_only_slot(self):
        slot = {"skill": None, "skill_sp": {"id": 5}}
        out = _char_slot_variants(slot, "skill", "skill_sp",
                                  "character_skill_id", "sp_character_skill_id")
        self.assertEqual([(i, s) for i, _o, s in out], [(5, 1)])


class TestSupportInfoNotDoubled(unittest.TestCase):
    def test_sp_upgrade_not_added(self):
        # 同一槽位：默认 LV2(+1) 与 SP LV3(+1) —— 只应按默认计 1 次
        abilities = [{
            "ability": {"id": 1, "traits": [{"desc": "“支援攻击／反击”+1次"}]},
            "ability_sp": {"id": 2, "traits": [{"desc": "“支援攻击／反击”+1次"}]},
        }]
        info = _support_info(abilities, [])
        self.assertEqual(info["attack"]["count"], 1)
        self.assertEqual(info["attack"]["uncond_count"], 1)


@unittest.skipUnless(_db_ready(), "本地库不存在，跳过 SP 集成校验")
class TestCharSpIntegration(unittest.TestCase):
    # 约姆·卡克斯(SR)：4 个槽位，3 个槽位 SP 后升级、1 个不变
    YOM = 1125001700

    def test_default_form_has_four_abilities(self):
        d = api_character_detail(self.YOM)
        default_abs = [a for a in d["abilities"] if not a["is_sp"]]
        sp_abs = [a for a in d["abilities"] if a["is_sp"]]
        self.assertEqual(len(default_abs), 4)
        self.assertEqual(len(sp_abs), 3)
        self.assertEqual(d["support_label"], "无条件支援攻击1次")

    def test_unchanged_slot_has_single_row(self):
        d = api_character_detail(self.YOM)
        # 槽位 4「格斗值提升 LV1」SP 后不变 -> 只有一条 is_sp=0
        slot4 = [a for a in d["abilities"] if a["sort"] == 4]
        self.assertEqual(len(slot4), 1)
        self.assertFalse(slot4[0]["is_sp"])


if __name__ == "__main__":
    unittest.main()
