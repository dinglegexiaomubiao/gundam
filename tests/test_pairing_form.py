"""配对页形态开关：uform/ufullcond 影响机体数值、pform 影响驾驶员数值，评分随之变化；结果支持多级排序。"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import src.config as config  # noqa: E402
from src import pairing  # noqa: E402


def _db_ready() -> bool:
    try:
        p = Path(config.DB_PATH)
    except Exception:
        return False
    return p.exists() and p.stat().st_size > 0


def _sample_unit() -> tuple[int, int]:
    """一个非 UR、有武器、有 SSP/条件数据的机体 (unit_id, weapon_id)。"""
    import sqlite3
    conn = sqlite3.connect(config.DB_PATH)
    row = conn.execute(
        "SELECT u.id, (SELECT id FROM unit_weapon w WHERE w.unit_id = u.id LIMIT 1) "
        "FROM unit u WHERE u.rarity < 5 AND u.rarity IS NOT NULL "
        "AND EXISTS (SELECT 1 FROM unit_weapon w WHERE w.unit_id = u.id) "
        "ORDER BY u.id LIMIT 1"
    ).fetchone()
    conn.close()
    return int(row[0]), int(row[1])


@unittest.skipUnless(_db_ready(), "本地库不存在，跳过配对形态校验")
class TestPairingForm(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.uid, cls.wid = _sample_unit()

    def _match(self, **filters):
        f = {"sort": "score", "order": "desc"}
        f.update(filters)
        return pairing.match_pilot(self.uid, "attack", self.wid, "low", {}, f)

    def test_uform_sp_changes_score(self):
        base = self._match()
        sp = self._match(uform="sp")
        self.assertTrue(base.get("ok"), base)
        self.assertNotEqual(base["pilots"][0]["score"], sp["pilots"][0]["score"])
        # 形态数值提升 -> 评分不降
        self.assertGreaterEqual(sp["pilots"][0]["score"], base["pilots"][0]["score"])

    def test_ufullcond_not_lower(self):
        base = self._match()
        fc = self._match(ufullcond="1")
        self.assertGreaterEqual(fc["pilots"][0]["score"], base["pilots"][0]["score"])

    def test_pform_sp_changes_score(self):
        base = self._match()
        sp = self._match(pform="sp")
        self.assertNotEqual(base["pilots"][0]["score"], sp["pilots"][0]["score"])

    def test_multi_sort_results(self):
        res = self._match(sort="rarity,score", order="desc,desc")
        ks = [(r["rarity"], r["score"]) for r in res["pilots"]]
        self.assertEqual(ks, sorted(ks, reverse=True))


if __name__ == "__main__":
    unittest.main()
