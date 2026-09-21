"""回归测试：驾驶员技能/能力的 SP 变体必须入库，自然键不可为 NULL。

根因：原始 `character.json` 每个槽位同时带主对象（skill / ability）与 SP 对象
（skill_sp / ability_sp）。旧版 ingest 只读主对象，导致

- 主对象为空的 380 技能槽 / 140 能力槽 → 行内容为空且自然键为 NULL；
- 主 / SP 的 id 不同的 208 技能 / 1048 能力 → SP 侧被静默丢弃。

而 SQLite 的 UNIQUE / PRIMARY KEY **对 NULL 不生效**，NULL 键会让
`INSERT OR IGNORE` 形同虚设，只能靠「入库前先 DELETE」兜住重复。
"""
import json
import shutil
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import src.config as config  # noqa: E402
import src.db as db  # noqa: E402


CHAR_JSON = {
    "id": 9101,
    "name": "测试驾驶员",
    "rarity": 5,
    "stats": {},
    # 槽 1：skill 与 skill_sp 互为镜像（同 id）→ 只应入库 1 行
    # 槽 2：skill 为空、skill_sp 有值（旧逻辑会写成 NULL 空行）→ 应入库 SP
    "skills": [
        {"sort": 1, "level": 1, "character_skill_id": 111, "sp_character_skill_id": 111,
         "skill": {"id": 111, "name": "主技能"},
         "skill_sp": {"id": 111, "name": "主技能"}},
        {"sort": 2, "level": 30, "character_skill_id": 0, "sp_character_skill_id": 222,
         "skill": None,
         "skill_sp": {"id": 222, "name": "SP技能", "desc": "SP 描述", "sp": 10,
                      "duration": 1, "is_auto_usage": True}},
    ],
    # 主 / SP 的 id 不同 → 两行都要
    "abilities": [
        {"sort": 1, "level": 1, "ability_id": 333, "sp_ability_id": 444,
         "ability": {"id": 333, "detail": {"name": "主能力"}, "traits": []},
         "ability_sp": {"id": 444, "detail": {"name": "SP能力"}, "traits": []}},
    ],
}


class TestSlotVariants(unittest.TestCase):
    def test_mirror_deduped(self):
        slot = {"skill": {"id": 5}, "skill_sp": {"id": 5}}
        out = db._slot_variants(slot, "skill", "skill_sp",
                                "character_skill_id", "sp_character_skill_id")
        self.assertEqual([i for i, _ in out], [5])

    def test_distinct_kept(self):
        slot = {"skill": {"id": 5}, "skill_sp": {"id": 6}}
        out = db._slot_variants(slot, "skill", "skill_sp",
                                "character_skill_id", "sp_character_skill_id")
        self.assertEqual([i for i, _ in out], [5, 6])

    def test_sp_only(self):
        slot = {"skill": None, "skill_sp": {"id": 6}}
        out = db._slot_variants(slot, "skill", "skill_sp",
                                "character_skill_id", "sp_character_skill_id")
        self.assertEqual([i for i, _ in out], [6])

    def test_fallback_never_null(self):
        """两个来源都空时也要给出非空自然键（否则 UNIQUE 失效）。"""
        slot = {"skill": None, "skill_sp": None, "character_skill_id": 0,
                "sp_character_skill_id": 0, "sort": 3}
        out = db._slot_variants(slot, "skill", "skill_sp",
                                "character_skill_id", "sp_character_skill_id")
        self.assertEqual(len(out), 1)
        self.assertIsNotNone(out[0][0])
        self.assertNotEqual(out[0][0], 0)
        self.assertEqual(out[0][0], -3)


class TestCharacterChildrenIngest(unittest.TestCase):
    _orig = {}
    _tmp = None

    @classmethod
    def setUpClass(cls):
        cls._orig = {k: getattr(config, k) for k in ("RAW_DIR", "DB_PATH")}
        cls._tmp = Path(tempfile.mkdtemp(prefix="gge_charsp_test_"))
        raw = cls._tmp / "raw"
        raw.mkdir(parents=True)
        config.RAW_DIR = raw
        config.DB_PATH = cls._tmp / "gundam.db"
        (raw / "character.json").write_text(
            json.dumps([CHAR_JSON], ensure_ascii=False), encoding="utf-8"
        )
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

    def _conn(self):
        return sqlite3.connect(config.DB_PATH)

    def test_ingest_writes_sp_variants(self):
        conn = self._conn()
        try:
            db.ingest_one_character(conn, CHAR_JSON, {}, {}, "character.json")
            conn.commit()
            skills = [r[0] for r in conn.execute(
                "SELECT character_skill_id FROM character_skill "
                "WHERE character_id=? ORDER BY character_skill_id", (9101,))]
            abilities = [r[0] for r in conn.execute(
                "SELECT ability_id FROM character_ability "
                "WHERE character_id=? ORDER BY ability_id", (9101,))]
            names = {r[0] for r in conn.execute(
                "SELECT name FROM character_skill WHERE character_id=?", (9101,))}
        finally:
            conn.close()
        self.assertEqual(skills, [111, 222], "镜像槽应去重、SP 变体应入库")
        self.assertEqual(abilities, [333, 444], "主 / SP 的 id 不同，应各入库一行")
        self.assertIn("SP技能", names)

    def test_no_null_keys_and_idempotent(self):
        conn = self._conn()
        try:
            db.ingest_one_character(conn, CHAR_JSON, {}, {}, "character.json")
            conn.commit()
            snap1 = self._snapshot(conn)
            # 连跑两次，模拟重复「爬取数据」
            for _ in range(2):
                db._clear_character_children(conn, 9101)
                db.ingest_character_children(conn, CHAR_JSON)
                db.recompute_character_derived(conn, 9101)
            conn.commit()
            snap2 = self._snapshot(conn)
        finally:
            conn.close()
        self.assertEqual(snap1, snap2, "重复入库不应改变行数")
        self.assertEqual(snap2["skill_null"], 0)
        self.assertEqual(snap2["ability_null"], 0)
        self.assertEqual(snap2["skill_dup"], 0)
        self.assertEqual(snap2["ability_dup"], 0)

    @staticmethod
    def _snapshot(conn):
        q = lambda sql: conn.execute(sql).fetchone()[0]  # noqa: E731
        return {
            "skill": q("SELECT COUNT(*) FROM character_skill WHERE character_id=9101"),
            "skill_null": q("SELECT COUNT(*) FROM character_skill "
                            "WHERE character_id=9101 AND character_skill_id IS NULL"),
            "skill_dup": q("SELECT COUNT(*) FROM (SELECT 1 FROM character_skill "
                           "WHERE character_id=9101 "
                           "GROUP BY character_id, character_skill_id HAVING COUNT(*)>1)"),
            "ability": q("SELECT COUNT(*) FROM character_ability WHERE character_id=9101"),
            "ability_null": q("SELECT COUNT(*) FROM character_ability "
                              "WHERE character_id=9101 AND ability_id IS NULL"),
            "ability_dup": q("SELECT COUNT(*) FROM (SELECT 1 FROM character_ability "
                             "WHERE character_id=9101 "
                             "GROUP BY character_id, ability_id HAVING COUNT(*)>1)"),
        }


if __name__ == "__main__":
    unittest.main()
