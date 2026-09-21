"""回归测试：dbutil 的连接封装、安全换库与在线备份。

覆盖三类曾出问题的点：
1. 连接缺少 timeout → 并发时直接 `database is locked`；
2. 整库替换用裸 `os.replace` → WAL 边车残留造成脏读、Windows 下被占用即失败；
3. 备份/导出用 `shutil.copy2` 只拷主库 → 漏掉尚未 checkpoint 的 WAL 内容。
"""
import os
import shutil
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import src.dbutil as dbutil  # noqa: E402


def _make_db(path, value=1):
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE t (a INTEGER)")
    con.execute("INSERT INTO t VALUES (?)", (value,))
    con.commit()
    con.close()


def _values(path):
    con = sqlite3.connect(path)
    try:
        return [r[0] for r in con.execute("SELECT a FROM t")]
    finally:
        con.close()


class TestConnections(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="gge_dbutil_"))
        self.db = self.tmp / "a.db"
        _make_db(self.db)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_connect_ro_rejects_write(self):
        con = dbutil.connect_ro(self.db)
        try:
            self.assertEqual(con.execute("SELECT COUNT(*) FROM t").fetchone()[0], 1)
            with self.assertRaises(sqlite3.OperationalError):
                con.execute("INSERT INTO t VALUES (2)")
        finally:
            con.close()

    def test_connect_ro_row_factory_switch(self):
        con = dbutil.connect_ro(self.db)
        try:
            self.assertIsInstance(con.execute("SELECT a FROM t").fetchone(), sqlite3.Row)
        finally:
            con.close()
        con = dbutil.connect_ro(self.db, row_factory=None)
        try:
            self.assertIsInstance(con.execute("SELECT a FROM t").fetchone(), tuple)
        finally:
            con.close()

    def test_connect_rw_applies_wal_fk_and_timeout(self):
        con = dbutil.connect_rw(self.db, timeout=1.5)
        try:
            self.assertEqual(con.execute("PRAGMA journal_mode").fetchone()[0].lower(), "wal")
            self.assertEqual(con.execute("PRAGMA foreign_keys").fetchone()[0], 1)
            # python sqlite3 的 timeout 参数即 busy_timeout（秒 → 毫秒）
            self.assertEqual(con.execute("PRAGMA busy_timeout").fetchone()[0], 1500)
        finally:
            con.close()

    def test_default_timeout_is_generous(self):
        self.assertGreaterEqual(dbutil.DEFAULT_TIMEOUT, 30)
        con = dbutil.connect_ro(self.db)
        try:
            self.assertEqual(
                con.execute("PRAGMA busy_timeout").fetchone()[0],
                int(dbutil.DEFAULT_TIMEOUT * 1000),
            )
        finally:
            con.close()


class TestSwapAndBackup(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="gge_dbutil_"))
        self.db = self.tmp / "a.db"
        _make_db(self.db, 1)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _wal_paths(self, p):
        return [Path(str(p) + s) for s in dbutil.SIDECAR_SUFFIXES]

    def test_swap_replaces_and_drops_sidecars(self):
        # 让主库处于 WAL 模式并留下未合并的 -wal
        con = sqlite3.connect(self.db)
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("INSERT INTO t VALUES (3)")
        con.commit()
        con.close()

        new = self.tmp / "new.db"
        _make_db(new, 2)

        dbutil.swap_db_file(new, self.db)

        self.assertEqual(_values(self.db), [2])
        for side in self._wal_paths(self.db):
            self.assertFalse(side.exists(), f"残留边车 {side.name}")

    def test_swap_raises_readable_error_on_occupied_db(self):
        """被占用时（同进程另一连接持有）应给出可读提示而非裸 WinError 5。"""
        new = self.tmp / "new.db"
        _make_db(new, 2)
        holder = sqlite3.connect(self.db)
        holder.execute("PRAGMA journal_mode=WAL")
        holder.execute("SELECT * FROM t").fetchall()
        try:
            try:
                dbutil.swap_db_file(new, self.db)
                swapped = True
            except PermissionError as exc:
                swapped = False
                self.assertIn("仍被占用", str(exc))
            # Windows 会失败并给提示；类 Unix 允许替换，两种都算通过。
            if swapped:
                self.assertEqual(_values(self.db), [2])
        finally:
            holder.close()

    def test_checkpoint_and_clear_merges_wal(self):
        con = sqlite3.connect(self.db)
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("INSERT INTO t VALUES (7)")
        con.commit()
        con.close()
        dbutil.checkpoint_and_clear(self.db)
        # checkpoint 后数据必须已落到主库，且边车被清掉
        self.assertIn(7, _values(self.db))
        for side in self._wal_paths(self.db):
            self.assertFalse(side.exists())

    def test_backup_includes_uncheckpointed_wal(self):
        """关键回归：连接仍打开、WAL 未合并时，快照也必须包含最新提交。"""
        con = sqlite3.connect(self.db)
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("INSERT INTO t VALUES (99)")
        con.commit()
        dest = self.tmp / "snap.db"
        try:
            dbutil.backup_db_file(self.db, dest)   # 连接保持打开
        finally:
            con.close()
        self.assertIn(99, _values(dest))
        # 快照本身必须是可用的独立库（无旁挂边车）
        for side in self._wal_paths(dest):
            self.assertFalse(side.exists())

    def test_backup_overwrites_existing_dest(self):
        dest = self.tmp / "snap.db"
        _make_db(dest, 555)
        dbutil.backup_db_file(self.db, dest)
        self.assertEqual(_values(dest), [1])


if __name__ == "__main__":
    unittest.main()
