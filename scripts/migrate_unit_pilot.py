"""单独同步「原作映射」表（unit_pilot）与云端，不重传整库。

用法：
    python scripts/migrate_unit_pilot.py            # 本地 → 云端（默认）
    python scripts/migrate_unit_pilot.py --down     # 云端 → 本地

整库迁移用 migrate_cloud.py（190MB，慢）；本脚本只传 1 千多行映射，秒级完成。
人工修正过的映射（signal='manual'）也会同步，换机器/重装不丢。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.cloud import (  # noqa: E402
    restore_unit_pilot_from_cloud,
    upload_unit_pilot_to_cloud,
)


def main() -> int:
    parser = argparse.ArgumentParser(description="同步 unit_pilot 原作映射表")
    parser.add_argument(
        "--down", action="store_true", help="反向：以云端为准覆盖本地"
    )
    args = parser.parse_args()

    res = (restore_unit_pilot_from_cloud() if args.down
           else upload_unit_pilot_to_cloud())
    print(res.get("message", ""))
    return 0 if res.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
