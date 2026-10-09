"""选择器接口（api_picker）对齐列表页：形态开关 form/full_cond、匹配模式 match、多级排序。"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import src.config as config  # noqa: E402
from src.webapp import api_picker  # noqa: E402


def _db_ready() -> bool:
    try:
        p = Path(config.DB_PATH)
    except Exception:
        return False
    return p.exists() and p.stat().st_size > 0


def _pick(kind="units", **kw):
    a = dict(q="", source="library", rarity="", type_="", series="", tags="",
             tag_mode="any", sort="", order="desc", limit=1400, offset=0,
             match="and", form="", full_cond=False)
    a.update(kw)
    return api_picker(kind, a["q"], a["source"], a["rarity"], a["type_"],
                      a["series"], a["tags"], a["tag_mode"], a["sort"],
                      a["order"], a["limit"], a["offset"], match=a["match"],
                      form=a["form"], full_cond=a["full_cond"])


@unittest.skipUnless(_db_ready(), "本地库不存在，跳过选择器形态校验")
class TestPickerForm(unittest.TestCase):
    def _by_id(self, items):
        return {r["id"]: r for r in items}

    def test_form_sp_raises_values_for_non_ur(self):
        de = self._by_id(_pick()["items"])
        sp = self._by_id(_pick(form="sp")["items"])
        uid = next(i for i, r in de.items() if (r["rarity"] or 5) < 5)
        self.assertEqual(sp[uid]["form_used"], "sp")
        self.assertGreaterEqual(sp[uid]["attack"], de[uid]["attack"])

    def test_ur_ignores_form(self):
        de = self._by_id(_pick()["items"])
        sp = self._by_id(_pick(form="sp")["items"])
        uid = next(i for i, r in de.items() if (r["rarity"] or 5) >= 5)
        self.assertEqual(de[uid]["attack"], sp[uid]["attack"])
        self.assertEqual(sp[uid]["form_used"], "default")

    def test_full_cond_increases_attack(self):
        de = self._by_id(_pick()["items"])
        fc = self._by_id(_pick(full_cond=True)["items"])
        changed = [i for i in de if fc[i]["attack"] > de[i]["attack"]]
        self.assertTrue(changed, "应有机体因完全达成条件而提升攻击")

    def test_multi_sort(self):
        items = _pick(sort="rarity,type", order="desc,asc")["items"]
        norm = [(r["rarity"], -r["role"]) for r in items]
        self.assertEqual(norm, sorted(norm, reverse=True))

    def test_match_mode(self):
        # 两个标签，交集 <= 并集
        tags = "吉翁公国军,地球联邦军"
        all_n = _pick(tags=tags, tag_mode="any", match="and")["total"]
        any_n = _pick(tags=tags, tag_mode="any", match="or")["total"]
        self.assertLessEqual(all_n, any_n)

    def test_pilot_form_sp(self):
        de = self._by_id(_pick("pilots")["items"])
        sp = self._by_id(_pick("pilots", form="sp")["items"])
        uid = next(i for i, r in de.items() if (r["rarity"] or 5) < 5)
        self.assertEqual(sp[uid]["form_used"], "sp")
        self.assertGreaterEqual(
            max(sp[uid]["ranged"], sp[uid]["melee"], sp[uid]["awaken"]),
            max(de[uid]["ranged"], de[uid]["melee"], de[uid]["awaken"]),
        )


if __name__ == "__main__":
    unittest.main()
