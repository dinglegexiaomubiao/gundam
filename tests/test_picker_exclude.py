"""组队页跨队伍去重：/api/picker/* 与 /api/supporters 的 exclude 参数。

组队页要求「同一机体 / 驾驶员 / 支援角色不能在不同队伍重复使用」，
选择器据此把已被占用的条目从列表中屏蔽。本测试校验 exclude 生效且
total 同步减少（保证分页正确）。
"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import src.config as config  # noqa: E402
from src.webapp import _exclude_ids, _not_in_clause, api_picker, api_supporters  # noqa: E402


def _db_ready() -> bool:
    try:
        p = Path(config.DB_PATH)
    except Exception:
        return False
    return p.exists() and p.stat().st_size > 0


@unittest.skipUnless(_db_ready(), "本地库不存在，跳过 exclude 集成校验")
class TestPickerExclude(unittest.TestCase):
    def test_exclude_ids_parser(self):
        self.assertEqual(_exclude_ids("1, 2 ,3"), [1, 2, 3])
        self.assertEqual(_exclude_ids(""), [])
        self.assertEqual(_exclude_ids("abc,7"), [7])   # 非数字忽略
        self.assertEqual(_exclude_ids("1001000150"), [1001000150])

    def test_not_in_clause(self):
        self.assertEqual(_not_in_clause("u.id", [1, 2]), "u.id NOT IN (?,?)")

    def test_units_exclude_reduces_total_and_hides_items(self):
        base = api_picker("units", "", "library", "", "", "", "", "any",
                          "", "desc", 5, 0)
        self.assertTrue(base["items"], "机体库无数据？")
        ids = [it["id"] for it in base["items"]][:2]
        got = api_picker("units", "", "library", "", "", "", "", "any",
                         "", "desc", 5, 0, exclude=",".join(str(i) for i in ids))
        self.assertEqual(got["total"], base["total"] - len(ids))
        returned = {it["id"] for it in got["items"]}
        for i in ids:
            self.assertNotIn(i, returned, "被 exclude 的机体不应出现在列表中")

    def test_pilots_exclude_reduces_total_and_hides_items(self):
        base = api_picker("pilots", "", "library", "", "", "", "", "any",
                          "", "desc", 5, 0)
        self.assertTrue(base["items"], "驾驶员库无数据？")
        pid = base["items"][0]["id"]
        got = api_picker("pilots", "", "library", "", "", "", "", "any",
                         "", "desc", 5, 0, exclude=str(pid))
        self.assertEqual(got["total"], base["total"] - 1)
        self.assertNotIn(pid, {it["id"] for it in got["items"]})

    def test_supporters_exclude_hides_items(self):
        base = api_supporters("", "", "any", "", "any", "", "desc", 5, 0)
        self.assertTrue(base["items"], "支援角色库无数据？")
        sid = base["items"][0]["id"]
        got = api_supporters("", "", "any", "", "any", "", "desc", 5, 0,
                             exclude=str(sid))
        self.assertNotIn(sid, {it["id"] for it in got["items"]})

    def test_exclude_nonexistent_id_is_noop(self):
        base = api_picker("units", "", "library", "", "", "", "", "any",
                          "", "desc", 5, 0)
        got = api_picker("units", "", "library", "", "", "", "", "any",
                         "", "desc", 5, 0, exclude="999999999999")
        self.assertEqual(got["total"], base["total"])


if __name__ == "__main__":
    unittest.main()
