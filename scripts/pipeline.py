"""命令行入口：fetch / build / verify / all。"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src import config  # noqa: E402
from src.db import build_db  # noqa: E402
from src.fetch import fetch_all  # noqa: E402
from src.verify import manifest_summary, verify  # noqa: E402
from src.webapp import run_server  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="高达 G 世纪永恒资料库流水线")
    parser.add_argument(
        "step",
        choices=["fetch", "build", "verify", "manifest", "serve", "all"],
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
    args = parser.parse_args()

    if args.step in ("fetch", "all"):
        fetch_all(limit=args.limit)
    if args.step in ("build", "all"):
        build_db()
    if args.step in ("verify", "all"):
        verify()
    if args.step == "manifest":
        manifest_summary()
    if args.step == "serve":
        run_server(port=args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
