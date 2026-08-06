"""命令行入口：fetch / build / verify / all。"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src import config  # noqa: E402
from src.cloud import restore_local_db_from_cloud  # noqa: E402
from src.db import build_db  # noqa: E402
from src.fetch import fetch_all  # noqa: E402
from src.verify import manifest_summary, verify  # noqa: E402
from src.webapp import run_server  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="高达 G 世纪永恒资料库流水线")
    parser.add_argument(
        "step",
        choices=["fetch", "build", "verify", "manifest", "restore", "serve", "all"],
        help="执行步骤",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="冒烟测试：机体详情与关卡详情最多抓 N 条",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8765,
        help="本地 Web 端口（serve 步骤）",
    )
    parser.add_argument(
        "--no-crawl",
        action="store_true",
        help="serve 时本地与云端都没有数据库则报错，不自动爬取",
    )
    args = parser.parse_args()

    if args.step in ("fetch", "all"):
        fetch_all(limit=args.limit)
    if args.step in ("build", "all"):
        build_db()
    if args.step in ("verify", "all"):
        verify()
    if args.step == "manifest":
        manifest_summary()
    if args.step == "restore":
        if restore_local_db_from_cloud():
            print("云端恢复完成。")
            return 0
        print("云端恢复失败（未设置 NEON_DB_URL 或云端不可用）。")
        return 1
    if args.step == "serve":
        if not config.DB_PATH.exists():
            print("本地数据库不存在：先尝试从云端恢复…")
            if restore_local_db_from_cloud():
                print("云端恢复成功。")
            elif args.no_crawl:
                print("云端恢复失败且已指定 --no-crawl，不自动爬取；")
                print("将在空库状态下启动，可在概览页手动导入数据库文件。")
            else:
                print("云端不可用，自动开始爬取数据（fetch + build）…")
                fetch_all(limit=args.limit)
                build_db()
        run_server(port=args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
