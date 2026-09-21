"""回归测试：云端 DDL 翻译必须兼容旧库 sqlite_master 中带引号标识符的建表语句。

背景：旧版 SCHEMA 写入的建表语句带双引号（如 CREATE TABLE "unit_weapon" ("id" INTEGER ...)），
而 `_translate_ddl` 旧正则只认无引号表名，导致「本地同步覆盖服务器」在 unit_weapon/unit_pilot
处抛「无法解析建表语句」。修复后需兼容：引号表名/列名 + 可选 IF NOT EXISTS，且不产生双重引号。
"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.cloud import _translate_ddl, _translate_index


class TestTranslateDDL(unittest.TestCase):
    def test_unquoted_table(self):
        out = _translate_ddl("CREATE TABLE unit (id INTEGER PRIMARY KEY, name TEXT)")
        self.assertIn('CREATE TABLE "unit"', out)
        self.assertIn('"id" BIGINT PRIMARY KEY', out)
        self.assertIn('"name" TEXT', out)
        # 不应出现双重引号
        self.assertNotIn('""', out)

    def test_quoted_table_and_columns(self):
        """旧库真实形态：表名与列名均带引号 —— 之前在此处抛错。"""
        sql = ('CREATE TABLE "unit_weapon" ('
               '"id" INTEGER PRIMARY KEY, '
               '"unit_id" INTEGER, '
               '"weapon_attrs" TEXT)')
        out = _translate_ddl(sql)  # 不应抛 ValueError
        self.assertIn('CREATE TABLE "unit_weapon"', out)
        self.assertIn('"id" BIGINT PRIMARY KEY', out)
        self.assertIn('"unit_id" BIGINT', out)
        self.assertIn('"weapon_attrs" TEXT', out)
        self.assertNotIn('""', out)

    def test_if_not_exists(self):
        out = _translate_ddl(
            "CREATE TABLE IF NOT EXISTS foo (id INTEGER PRIMARY KEY, v REAL)"
        )
        self.assertIn('CREATE TABLE "foo"', out)
        self.assertIn('"id" BIGINT PRIMARY KEY', out)
        self.assertIn('"v" DOUBLE PRECISION', out)
        self.assertNotIn('IF NOT EXISTS', out)  # 云端不应保留该子句
        self.assertNotIn('""', out)

    def test_quoted_foreign_key(self):
        sql = ('CREATE TABLE "stage_map_npc" ('
               '"mid" INTEGER PRIMARY KEY, '
               '"stage_id" INTEGER, '
               'FOREIGN KEY ("stage_id") REFERENCES "stage" ("id"))')
        out = _translate_ddl(sql)
        self.assertIn('FOREIGN KEY ("stage_id") REFERENCES "stage" ("id")', out)
        self.assertNotIn('""', out)

    def test_real_local_db_all_tables_parse(self):
        """直接用本地库的 sqlite_master 校验全部表都能翻译，防止再次回归。"""
        import sqlite3
        db_path = ROOT / "data" / "db" / "gundam.db"
        if not db_path.exists():
            self.skipTest("本地库不存在，跳过真实库校验")
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            rows = con.execute(
                "SELECT name, sql FROM sqlite_master "
                "WHERE type='table' AND name != 'sqlite_sequence'"
            ).fetchall()
        finally:
            con.close()
        self.assertTrue(rows, "本地库无表？")
        for name, sql in rows:
            with self.subTest(table=name):
                self.assertIsNotNone(sql, f"{name} 无 sql")
                translated = _translate_ddl(sql)  # 不应抛异常
                self.assertNotIn('""', translated, f"{name} 出现双重引号")

    def test_quoted_index_on_quoted_table(self):
        """旧库真实形态：索引作用在带引号表名上（idx_unit_pilot_pilot ON "unit_pilot"）。"""
        sql = 'CREATE INDEX idx_unit_pilot_pilot ON "unit_pilot"(pilot_id)'
        out = _translate_index(sql)  # 不应抛 ValueError
        self.assertIn('CREATE INDEX "idx_unit_pilot_pilot"', out)
        self.assertIn('ON "unit_pilot" ("pilot_id")', out)
        self.assertNotIn('""', out)

    def test_real_local_db_all_indexes_parse(self):
        """用本地库校验全部索引（含带引号表名的）都能翻译。"""
        import sqlite3
        db_path = ROOT / "data" / "db" / "gundam.db"
        if not db_path.exists():
            self.skipTest("本地库不存在，跳过真实库校验")
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            rows = con.execute(
                "SELECT name, sql FROM sqlite_master "
                "WHERE type='index' AND name NOT LIKE 'sqlite_%'"
            ).fetchall()
        finally:
            con.close()
        self.assertTrue(rows, "本地库无索引？")
        for name, sql in rows:
            with self.subTest(index=name):
                self.assertIsNotNone(sql, f"{name} 无 sql")
                translated = _translate_index(sql)
                self.assertNotIn('""', translated, f"{name} 出现双重引号")


if __name__ == "__main__":
    unittest.main()
