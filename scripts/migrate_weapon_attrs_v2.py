"""回填 unit_weapon.weapon_attrs（伤害类型集合），使其与最新推导规则一致。

背景
----
`weapon_attr`（单值伤害类型）→ `weapon_attrs`（集合）的推导规则原先把 5 / 6 一律
映射为空、4 映射为 [3]，导致 4/5/6 类武器**丢失多类型信息**：

    4 = 光束 + 物理      5 = 物理 + 特殊      6 = 光束 + 特殊

库里原有 5 个多类型值是**手工改的**，一旦重新爬取重建就会被打回 `[3]` / `[]`。
本脚本按新规则（`src/db.py: WEAPON_ATTR_EXPAND`）重算全部武器，使既有库与
「重新爬取重建后的库」完全一致。

注意：迁移脚本 `migrate_weapon_attack_attr.py` 已经把 `unit_weapon.weapon_attr`
列删掉了，所以这里从 `data/raw/zh-CN/unit/*.json` 读原始 `weapon_attr`。

用法
----
    python scripts/migrate_weapon_attrs_v2.py --dry-run   # 只看会改什么
    python scripts/migrate_weapon_attrs_v2.py             # 执行（先自动备份）
"""

from __future__ import annotations

import argparse
import glob
import json
import shutil
import sqlite3
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src import config  # noqa: E402
from src.db import WEAPON_ATTR_EXPAND  # noqa: E402


def expected_attrs(weapon_attr) -> list[int]:
    """与 src/db.py 的推导保持一致（升序）。"""
    try:
        v = int(weapon_attr)
    except (TypeError, ValueError):
        return []
    arr = WEAPON_ATTR_EXPAND.get(v)
    return sorted(arr) if arr else []


def collect_expected(raw_dir: Path) -> dict[int, list[int]]:
    """从原始 JSON 汇总 {weapon_id: 期望的伤害类型集合}。"""
    out: dict[int, list[int]] = {}
    pattern = str(raw_dir / "unit" / "*.json")
    for f in glob.glob(pattern):
        if f.endswith("min.json"):
            continue
        try:
            u = json.load(open(f, encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        for entry in u.get("weapons") or []:
            w = entry.get("weapon") or {}
            wid = w.get("id")
            if not wid:
                continue
            out[int(wid)] = expected_attrs(w.get("weapon_attr"))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=str(config.DB_PATH))
    ap.add_argument("--dry-run", action="store_true", help="只统计，不写库")
    ap.add_argument("--no-backup", action="store_true", help="跳过自动备份")
    args = ap.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        print(f"数据库不存在：{db_path}")
        return 1

    raw_dir = Path(config.RAW_DIR)
    if not raw_dir.is_dir():
        print(f"原始 JSON 目录不存在：{raw_dir}（无法重算，请先抓取数据）")
        return 1

    expected = collect_expected(raw_dir)
    print(f"原始 JSON 中武器数：{len(expected)}")

    conn = sqlite3.connect(str(db_path), timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT id, unit_id, weapon_id, name, weapon_attrs FROM unit_weapon"
        ).fetchall()
        print(f"数据库 unit_weapon 行数：{len(rows)}")

        changes: list[tuple[int, str, str, str]] = []  # id, name, old, new
        unknown = 0
        for r in rows:
            wid = r["weapon_id"]
            if wid not in expected:
                unknown += 1
                continue
            new = json.dumps(expected[wid], ensure_ascii=False)
            old = r["weapon_attrs"] or "[]"
            if json.loads(old) != json.loads(new):
                changes.append((r["id"], r["name"], old, new))

        print(f"原始 JSON 中查不到的武器（保持原值）：{unknown}")
        print(f"需要修正的武器数：{len(changes)}")
        for _id, name, old, new in changes:
            print(f"   {name}: {old} -> {new}")

        if not changes:
            print("已是最新，无需修改。")
            return 0

        if args.dry_run:
            print("\n[dry-run] 未写库。去掉 --dry-run 即执行。")
            return 0

        if not args.no_backup:
            backup_dir = ROOT / "data" / "backup"
            backup_dir.mkdir(parents=True, exist_ok=True)
            stamp = time.strftime("%Y%m%d_%H%M%S")
            dest = backup_dir / f"gundam_pre_weapon_attrs_{stamp}.db"
            shutil.copy2(db_path, dest)
            print(f"已备份 -> {dest.name}（{dest.stat().st_size / 1024 / 1024:.1f} MB）")

        for _id, _name, _old, new in changes:
            conn.execute(
                "UPDATE unit_weapon SET weapon_attrs = ? WHERE id = ?", (new, _id)
            )
        conn.commit()

        left = 0
        for r in conn.execute("SELECT weapon_id, weapon_attrs FROM unit_weapon"):
            wid = r["weapon_id"]
            if wid in expected:
                if json.loads(r["weapon_attrs"] or "[]") != expected[wid]:
                    left += 1
        print(f"\n迁移完成：修正 {len(changes)} 把武器；残留不一致 {left} 条。")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
