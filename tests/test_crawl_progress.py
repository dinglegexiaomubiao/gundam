"""验证「爬取数据」优化：仅爬取四类核心数据 + 进度回调上报。

- fetch_all(on_progress=) 应上报 系列与阵营/机体/驾驶员/支援角色，且不出现 关卡敌人/剧情事件
- build_db(on_progress=) 应上报 构建：* 步骤，且不出现 关卡敌人
使用 monkeypatch 模拟 api.http_get_json 与临时目录，无需联网。
"""
import sys
import tempfile
import shutil
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import src.api as api
import src.config as config
import src.db as db
import src.fetch as fetch


def _fake_http_get_json(path, params=None):
    path = path or ""
    if path == "/series/v2":
        return []
    if path == "/faction":
        return []
    if path == "/unit/min":
        return [{"id": i, "name": f"U{i}"} for i in range(1, 4)]
    if path.startswith("/unit/"):
        uid = int(path.rsplit("/", 1)[-1])
        return {"id": uid, "name": f"U{uid}", "weapons": [], "abilities": [],
                "skills": [], "tags": [], "series_set": [], "stats": {},
                "terrain": {}, "ssp_config": {}, "transform_to": []}
    if path == "/character":
        return [{"id": i, "name": f"C{i}"} for i in range(10, 12)]
    if path.startswith("/character/"):
        cid = int(path.rsplit("/", 1)[-1])
        return {"id": cid, "name": f"C{cid}", "skills": [], "abilities": [],
                "stats": {}, "tags": [], "series_set": []}
    if path == "/supporter":
        return [{"id": 20, "name": "S20"}]
    if path == "/supporter/growth":
        return [{"level": 1, "limit_break": 0, "correction_rate": 1.0}]
    if path.startswith("/supporter/"):
        return {"id": 20, "name": "S20", "skills": []}
    # 关卡敌人 / 事件 路由：不应被调用（返回空，便于检测误调用）
    return {}


class TestCrawlProgress(unittest.TestCase):
    _orig_http = None
    _orig_cfg = None
    _tmp = None

    # 被本测试全局覆写的 config 属性清单（tearDownClass 必须原样还原，避免污染套件内其他测试）
    _CFG_KEYS = ("RAW_DIR", "META_DIR", "MANIFEST_PATH", "DB_PATH",
                 "BATCH_SIZE", "MAX_WORKERS", "BATCH_PAUSE", "LANG", "API_BASE")

    @classmethod
    def setUpClass(cls):
        cls._orig_http = api.http_get_json
        cls._orig_cfg = {k: getattr(config, k) for k in cls._CFG_KEYS}
        api.http_get_json = _fake_http_get_json
        tmp = Path(tempfile.mkdtemp(prefix="gge_crawl_test_"))
        config.RAW_DIR = tmp / "raw"
        config.META_DIR = tmp / "meta"
        config.MANIFEST_PATH = config.META_DIR / "manifest.json"
        config.DB_PATH = tmp / "gundam.db"
        config.BATCH_SIZE = 200
        config.MAX_WORKERS = 2
        config.BATCH_PAUSE = 0
        config.LANG = "zh-CN"
        config.API_BASE = "http://test"
        config.RAW_DIR.mkdir(parents=True)
        config.META_DIR.mkdir(parents=True)
        cls._tmp = tmp

    @classmethod
    def tearDownClass(cls):
        api.http_get_json = cls._orig_http
        for k, v in cls._orig_cfg.items():
            setattr(config, k, v)
        if cls._tmp and cls._tmp.exists():
            shutil.rmtree(cls._tmp, ignore_errors=True)

    def test_fetch_all_progress_excludes_stages(self):
        events = []
        fetch.fetch_all(on_progress=lambda ph, d, t: events.append((ph, d, t)))
        phases = [e[0] for e in events]
        self.assertIn("系列与阵营", phases)
        self.assertIn("机体", phases)
        self.assertIn("驾驶员", phases)
        self.assertIn("支援角色", phases)
        self.assertNotIn("关卡敌人", phases, f"关卡敌人 不应被抓取: {phases}")
        self.assertNotIn("剧情事件", phases, f"事件 不应被抓取: {phases}")
        unit = [e for e in events if e[0] == "机体"]
        self.assertTrue(any(e[1] == 3 and e[2] == 3 for e in unit), unit)

    def test_build_db_progress_excludes_stages(self):
        # build_db 前置依赖：先抓取填充 raw 目录（真实流程中 fetch_all 必先于 build_db）
        fetch.fetch_all()
        events = []
        db.build_db(on_progress=lambda ph, d, t: events.append((ph, d, t)))
        phases = [e[0] for e in events]
        self.assertTrue(any("构建：机体" in p for p in phases), phases)
        self.assertTrue(any("构建：驾驶员" in p for p in phases), phases)
        self.assertTrue(any("构建：支援角色" in p for p in phases), phases)
        self.assertTrue(any("构建：系列与阵营" in p for p in phases), phases)
        self.assertTrue(any("收尾" in p for p in phases), phases)
        self.assertTrue(all("关卡" not in p for p in phases), f"构建不应含关卡: {phases}")
        last = events[-1]
        self.assertEqual(last[2], 5)
        self.assertEqual(last[1], 5)


if __name__ == "__main__":
    unittest.main()
