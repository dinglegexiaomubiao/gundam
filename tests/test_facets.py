"""筛选分面数量（facets）：/api/units|characters|supporters 的 facets=1。

语义：某维度 D 的每个选项数量 = 应用“除 D 以外”的全部当前筛选后，叠加该选项的命中数；
`__all__` = 清空 D 后的命中数。本测试用本地真实库做相对断言（不写死数字）。
"""
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


def _units(**kw):
    args = dict(q="", rarity="", acq="", series="", type_="", tags="",
                tag_mode="all", match="and", wfx="", wfx_mode="any",
                cond="", sort="", order="desc", limit=5, offset=0, facets=True)
    args.update(kw)
    return api_units(args.pop("q"), args.pop("rarity"), args.pop("acq"),
                     args.pop("series"), args.pop("type_"), args.pop("tags"),
                     args.pop("tag_mode"), args.pop("match"), args.pop("wfx"),
                     args.pop("wfx_mode"), args.pop("cond"), args.pop("sort"),
                     args.pop("order"), args.pop("limit"), args.pop("offset"),
                     args.pop("facets"))


def _supporters(**kw):
    args = dict(q="", tags="", tag_mode="any", skills="", skill_mode="any",
                sort="", order="desc", limit=5, offset=0, facets=True)
    args.update(kw)
    return api_supporters(args.pop("q"), args.pop("tags"), args.pop("tag_mode"),
                          args.pop("skills"), args.pop("skill_mode"),
                          args.pop("sort"), args.pop("order"), args.pop("limit"),
                          args.pop("offset"), facets=args.pop("facets"))


@unittest.skipUnless(_db_ready(), "本地库不存在，跳过 facets 集成校验")
class TestFacets(unittest.TestCase):
    def test_units_absent_when_not_requested(self):
        d = api_units("", "", "", "", "", "", "all", "and", "", "any", "",
                      "", "desc", 5, 0)  # facets 默认 False
        self.assertNotIn("facets", d)

    def test_units_scalar_dimension_partitions_total(self):
        d = _units()
        r = d["facets"]["rarity"]
        total = sum(v for k, v in r.items() if k != "__all__")
        self.assertEqual(total, r["__all__"])
        self.assertEqual(r["__all__"], d["total"])
        # 类型维度同样应恰好划分全集
        t = d["facets"]["type"]
        self.assertEqual(sum(v for k, v in t.items() if k != "__all__"), t["__all__"])

    def test_units_own_dimension_ignored_others_respected(self):
        base = _units()
        base_total = base["total"]
        filt = _units(rarity="5")
        f = filt["facets"]
        # rarity 维度忽略自身 -> 与未筛选一致
        self.assertEqual(f["rarity"]["__all__"], base_total)
        self.assertEqual(f["rarity"]["5"], filt["total"])
        # 其它维度要服从 rarity=5
        self.assertEqual(f["tags"]["__all__"], filt["total"])
        self.assertEqual(f["series"]["__all__"], filt["total"])
        self.assertEqual(f["wfx"]["__all__"], filt["total"])

    def test_units_tag_facet_matches_filter(self):
        base = _units()
        counts = {k: v for k, v in base["facets"]["tags"].items() if k != "__all__"}
        tag = max(counts, key=counts.get)  # 取一个命中最多的标签
        got = _units(tags=tag, tag_mode="any")
        self.assertEqual(got["facets"]["tags"][tag], got["total"])
        # 清空 tags 维度后应回到全集
        self.assertEqual(got["facets"]["tags"]["__all__"], base["total"])

    def test_characters_support_filter_respected(self):
        base = api_characters("", "", "", "", "", "all", "and", "", "any", "",
                              "", "desc", 5, 0, facets=True)
        label = max(
            ((k, v) for k, v in base["facets"]["support"].items() if k != "__all__"),
            key=lambda kv: kv[1],
        )[0]
        filt = api_characters("", "", "", "", "", "all", "and", "", "any", label,
                              "", "desc", 5, 0, facets=True)
        f = filt["facets"]
        self.assertEqual(f["support"][label], filt["total"])
        self.assertEqual(f["support"]["__all__"], base["total"])  # 忽略自身
        self.assertEqual(f["rarity"]["__all__"], filt["total"])   # 其它维度服从 support
        self.assertEqual(f["skills"]["__all__"], filt["total"])

    def test_supporters_facets_structure(self):
        d = _supporters()
        f = d["facets"]
        self.assertEqual(set(f), {"tags", "skills"})
        self.assertEqual(f["tags"]["__all__"], d["total"])
        self.assertEqual(f["skills"]["__all__"], d["total"])
        skills = {k: v for k, v in f["skills"].items() if k != "__all__"}
        if skills:
            name = max(skills, key=skills.get)
            got = _supporters(skills=name, skill_mode="any")
            self.assertEqual(got["facets"]["skills"][name], got["total"])


if __name__ == "__main__":
    unittest.main()
