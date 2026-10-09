"""验证增量爬取的「陈旧机体」变更检测与强制重抓。

背景：增量模式会跳过已存在的详情文件（unit/{id}.json），而 build_db 只读详情文件，
导致游戏对旧机体的属性/标签改动永远抓不到。fetch_units 现在用每次都会重新下载的
/unit/min 与本地详情比对，命中的机体强制重抓。

使用临时目录 + 伪造 api.http_get_json，无需联网、无节流等待。
"""
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import src.api as api  # noqa: E402
import src.config as config  # noqa: E402
import src.fetch as fetch  # noqa: E402


def _stats(**over):
    base = {"hp": 100, "attack": 50, "max_hp": 1000, "max_attack": 500}
    base.update(over)
    return base


def _tags(*names):
    return [{"tag": {"name": n}} for n in names]


class TestStaleDetection(unittest.TestCase):
    _CFG_KEYS = ("RAW_DIR", "BATCH_SIZE", "MAX_WORKERS", "BATCH_PAUSE")

    def setUp(self):
        self._orig_http = api.http_get_json
        self._orig_cfg = {k: getattr(config, k) for k in self._CFG_KEYS}
        self.tmp = Path(tempfile.mkdtemp(prefix="gge_stale_test_"))
        config.RAW_DIR = self.tmp
        config.BATCH_SIZE = 200
        config.MAX_WORKERS = 1
        config.BATCH_PAUSE = 0
        (config.RAW_DIR / "unit").mkdir(parents=True)

    def tearDown(self):
        api.http_get_json = self._orig_http
        for k, v in self._orig_cfg.items():
            setattr(config, k, v)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write_detail(self, uid, stats, tags):
        fetch._save(f"unit/{uid}.json",
                    {"id": uid, "name": f"U{uid}", "stats": stats, "tags": tags})

    def _min(self, uid, stats, tags):
        return {"id": uid, "name": f"U{uid}", "stats": stats, "tags": tags}

    # ---- _stale_unit_ids ----

    def test_detects_numeric_and_tag_and_missing_changes(self):
        # 1: 完全一致 -> 不陈旧
        self._write_detail(1, _stats(), _tags("A"))
        # 2: 数值变化 -> 陈旧
        self._write_detail(2, _stats(), _tags("A"))
        # 3: 新增标签 -> 陈旧
        self._write_detail(3, _stats(), _tags("A"))
        # 4: 详情文件缺失 -> 陈旧
        # 5: 删除标签 -> 陈旧
        self._write_detail(5, _stats(), _tags("A", "B"))

        mins = [
            self._min(1, _stats(), _tags("A")),
            self._min(2, _stats(max_attack=999), _tags("A")),
            self._min(3, _stats(), _tags("A", "老虎")),
            self._min(4, _stats(), _tags("A")),
            self._min(5, _stats(), _tags("A")),
        ]
        self.assertEqual(fetch._stale_unit_ids(mins), {2, 3, 4, 5})

    def test_identical_units_are_not_stale(self):
        self._write_detail(1, _stats(), _tags("A", "B"))
        mins = [self._min(1, _stats(), _tags("A", "B"))]
        self.assertEqual(fetch._stale_unit_ids(mins), set())

    # ---- fetch_units 接线 ----

    def _install_fake_http(self, mins, requested):
        def fake(path, params=None):
            if path == "/unit/min":
                return mins
            if path.startswith("/unit/"):
                uid = int(path.rsplit("/", 1)[-1])
                requested.append(uid)
                return {"id": uid, "name": f"U{uid}", "stats": {},
                        "tags": [], "weapons": [], "abilities": [], "skills": [],
                        "series_set": [], "terrain": {}, "ssp_config": {},
                        "transform_to": []}
            return {}

        api.http_get_json = fake

    def test_fetch_units_refetches_only_changed(self):
        self._write_detail(1, _stats(), _tags("A"))  # 未变 -> 跳过
        self._write_detail(2, _stats(), _tags("A"))  # 数值变 -> 重抓
        mins = [self._min(1, _stats(), _tags("A")),
                self._min(2, _stats(attack=77), _tags("A"))]
        requested = []
        self._install_fake_http(mins, requested)

        fetch.fetch_units()

        self.assertEqual(requested, [2])
        self.assertTrue((config.RAW_DIR / "unit" / "min.json").exists())

    def test_refresh_true_ignores_detection_and_refetches_all(self):
        self._write_detail(1, _stats(), _tags("A"))
        self._write_detail(2, _stats(), _tags("A"))
        mins = [self._min(1, _stats(), _tags("A")),
                self._min(2, _stats(), _tags("A"))]
        requested = []
        self._install_fake_http(mins, requested)

        fetch.fetch_units(refresh=True)

        self.assertEqual(sorted(requested), [1, 2])


if __name__ == "__main__":
    unittest.main()
