"""生成机体 → 原作驾驶员 显式映射表并写入 DB 的 unit_pilot 表。

用法：
    python scripts/build_unit_pilot.py            # 全量生成并输出统计
    python scripts/build_unit_pilot.py --low      # 额外列出非「主动驾驶」的低置信条目，便于人工核对

映射依据（无显式外键，启发式）：
    active   = 机体 desc 里明写「驾驶员名+搭乘/驾驶」（最准）
    mention  = 机体 desc 里出现驾驶员名（可能是对手登场，次准）
    role     = 仅同系列 + 同类型 + 同稀有度（兜底）
生成后 /api/canonical 端点会优先读这张表，人工修正表即可覆盖启发式结果。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src import config  # noqa: E402
from src.pairing import build_unit_pilot  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="生成机体→原作驾驶员映射表")
    parser.add_argument("--low", action="store_true", help="列出低置信（非主动驾驶）条目")
    args = parser.parse_args()

    stats = build_unit_pilot()
    print(f"映射表已写入 {config.DB_PATH} 的 unit_pilot 表")
    print(f"  共 {stats['total']} 条机体映射")
    print(f"    主动驾驶(desc 明写搭乘/驾驶): {stats.get('active', 0)}")
    print(f"    名字出现(可能对手登场):       {stats.get('mention', 0)}")
    print(f"    仅系列+类型+稀有度(兜底):     {stats.get('role', 0)}")
    print(f"    未匹配:                       {stats.get('none', 0)}")

    if args.low:
        import sqlite3
        conn = sqlite3.connect(config.DB_PATH)
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT unit_id, unit_name, pilot_id, pilot_name, signal "
            "FROM unit_pilot WHERE signal != 'active' ORDER BY signal, unit_id"
        ).fetchall()
        conn.close()
        print(f"\n低置信条目（{len(rows)} 条，signal != active）：")
        for r in rows:
            print(f"  [{r['signal']:7s}] #{r['unit_id']} {r['unit_name']} → "
                  f"#{r['pilot_id']} {r['pilot_name']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
