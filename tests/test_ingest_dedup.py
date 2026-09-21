"""回归测试：ingest 子表在重建时不得重复累积。

根因：本地旧表缺 UNIQUE 约束，且 ingest 重建前不清空子表，导致每点一次
「爬取数据」就把 unit_weapon 等子表行数翻倍。修复为 ingest 前先清空子表。

本测试直接驱动 ingest_units 连跑两次，断言 unit_weapon 行数不翻倍。
"""
import os
import shutil
import sqlite3
import tempfile
import unittest
from pathlib import Path

import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import src.config as config
import src.db as db


UNIT_JSON = {
    "id": 1001,
    "name": "测试机体",
    "short_name": "测试",
    "rarity": 5,
    "series_set": [{"series": {"id": 1}}],
    "stats": {"hp": 100, "en": 100, "attack": 100, "defense": 100,
              "mobility": 100, "movement": 6},
    "weapons": [
        {"sort": 1, "weapon": {"id": 11, "name": "武器A", "weapon_attr": 1,
                               "weapon_status": {"power": 1000, "en": 10,
                                                 "hit_rate": 100, "critical_rate": 5}}},
        {"sort": 2, "weapon": {"id": 12, "name": "武器B", "weapon_attr": 2,
                               "weapon_status": {"power": 2000, "en": 20,
                                                 "hit_rate": 95, "critical_rate": 10}}},
    ],
    "abilities": [],
}


class TestIngestDedup(unittest.TestCase):
    _orig = {}
    _tmp = None

    @classmethod
    def setUpClass(cls):
        cls._orig = {k: getattr(config, k) for k in ("RAW_DIR", "DB_PATH")}
        cls._tmp = Path(tempfile.mkdtemp(prefix="gge_dedup_test_"))
        raw = cls._tmp / "raw"
        (raw / "unit").mkdir(parents=True)
        (raw / "character").mkdir(parents=True)
        (raw / "supporter").mkdir(parents=True)
        config.RAW_DIR = raw
        config.DB_PATH = cls._tmp / "gundam.db"
        # 写入一个最小机体 raw
        import json
        (raw / "unit" / "1001.json").write_text(
            json.dumps(UNIT_JSON, ensure_ascii=False), encoding="utf-8"
        )
        # 建库并应用 SCHEMA
        con = sqlite3.connect(config.DB_PATH)
        con.executescript(db.SCHEMA)
        con.execute("INSERT INTO series (id, name) VALUES (1, '测试系列')")
        con.commit()
        con.close()

    @classmethod
    def tearDownClass(cls):
        for k, v in cls._orig.items():
            setattr(config, k, v)
        if cls._tmp and cls._tmp.exists():
            shutil.rmtree(cls._tmp, ignore_errors=True)

    def _make_conn(self):
        return sqlite3.connect(config.DB_PATH)

    def test_ingest_units_twice_no_duplicate(self):
        conn = self._make_conn()
        try:
            db.ingest_units(conn, {})
            db.ingest_units(conn, {})  # 连跑第二次，模拟再次「爬取数据」
            total = conn.execute(
                "SELECT COUNT(*) FROM unit_weapon WHERE unit_id=1001"
            ).fetchone()[0]
            distinct = conn.execute(
                "SELECT COUNT(*) FROM ("
                "SELECT 1 FROM unit_weapon WHERE unit_id=1001 "
                "GROUP BY unit_id, weapon_id)"
            ).fetchone()[0]
        finally:
            conn.close()
        # 该机体有 2 把武器，连跑两次后应当仍是 2 行，而非 4 行
        self.assertEqual(total, 2, f"unit_weapon 出现重复：应有 2 行，实际 {total} 行")
        self.assertEqual(distinct, 2)

    def test_ingest_one_unit_no_duplicate(self):
        conn = self._make_conn()
        try:
            db.ingest_one_unit(conn, UNIT_JSON, {}, {1: "测试系列"}, "unit/1001.json")
            db.ingest_one_unit(conn, UNIT_JSON, {}, {1: "测试系列"}, "unit/1001.json")
            total = conn.execute(
                "SELECT COUNT(*) FROM unit_weapon WHERE unit_id=1001"
            ).fetchone()[0]
        finally:
            conn.close()
        self.assertEqual(total, 2, f"单条覆盖后 unit_weapon 出现重复：应有 2 行，实际 {total} 行")


if __name__ == "__main__":
    unittest.main()
