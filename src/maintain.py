"""定期维护：数据库快照备份、变更报告、一键更新（update）。

维护流程（手动触发）：
- 日常更新：python scripts/pipeline.py update          （增量：只抓新增条目）
- 每月全量：python scripts/pipeline.py update --full   （重抓全部详情，刷新数值改动）
- 手动备份：python scripts/pipeline.py backup

update 步骤：快照当前库 -> fetch -> build -> verify -> 新旧库对比报告；
build 阶段抛异常时自动用快照回滚。
"""
from __future__ import annotations

import shutil
import sqlite3
import time

from . import config
from .db import build_db
from .fetch import fetch_all
from .labels import RARITY
from .verify import verify

BACKUP_DIR = config.DATA_DIR / "backup"
KEEP_BACKUPS = 3  # 本地滚动保留份数

# 参与对比的表（与 verify.py 保持一致）
DIFF_TABLES = [
    "series", "faction", "unit", "unit_weapon", "unit_ability",
    "character", "character_skill", "character_ability",
    "supporter", "supporter_skill",
    "stage", "stage_map_npc", "stage_map_npc_character",
    "story_event", "story_event_boss", "tower_event", "tower_stage",
]


def backup_db() -> "str | None":
    """快照当前数据库到 data/backup/，滚动保留最近 KEEP_BACKUPS 份。返回快照路径。"""
    if not config.DB_PATH.exists():
        print("本地无数据库，跳过快照。")
        return None
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    dest = BACKUP_DIR / f"gundam_{stamp}.db"
    shutil.copy2(config.DB_PATH, dest)
    print(f"已快照数据库 -> {dest.name}（{dest.stat().st_size / 1024 / 1024:.1f} MB）")
    prune_backups()
    return str(dest)


def prune_backups() -> None:
    """只保留最近 KEEP_BACKUPS 份快照。"""
    if not BACKUP_DIR.exists():
        return
    backups = sorted(BACKUP_DIR.glob("gundam_*.db"))
    for old in backups[:-KEEP_BACKUPS]:
        old.unlink()
        print(f"清理旧快照 {old.name}")


def rollback(snapshot: str) -> None:
    """用快照覆盖当前数据库（update 失败时调用）。"""
    shutil.copy2(snapshot, config.DB_PATH)
    print(f"!! 已回滚数据库到快照 {snapshot}")


def _table_counts(db_path) -> dict[str, int]:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    counts = {}
    for t in DIFF_TABLES:
        try:
            counts[t] = conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        except sqlite3.OperationalError:
            counts[t] = -1
    conn.close()
    return counts


def _rows(db_path, table: str, cols: str = "*") -> dict:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        cur = conn.execute(f"SELECT {cols} FROM {table}")
        names = [d[0] for d in cur.description]
        rows = {r[0]: r for r in cur.fetchall()}
    except sqlite3.OperationalError:
        names, rows = [], {}
    conn.close()
    return names, rows


def diff_report(old_db: "str | None", new_db=None) -> None:
    """对比更新前后的数据库，输出变更摘要。"""
    new_db = new_db or config.DB_PATH
    print("\n========== 变更报告 ==========")
    if not old_db or not __import__("pathlib").Path(old_db).exists():
        print("（无更新前快照，跳过对比）")
        return
    old_counts, new_counts = _table_counts(old_db), _table_counts(new_db)
    changed_any = False
    for t in DIFF_TABLES:
        o, n = old_counts.get(t, -1), new_counts.get(t, -1)
        if o != n:
            changed_any = True
            sign = "+" if n > o else ""
            print(f"[{t}] {o} -> {n}（{sign}{n - o}）")

    # 新增机体名单
    _, old_units = _rows(old_db, "unit", "id, name, rarity")
    _, new_units = _rows(new_db, "unit", "id, name, rarity")
    added = sorted(set(new_units) - set(old_units))
    if added:
        changed_any = True
        print(f"\n新增机体 {len(added)} 台：")
        for uid in added[:30]:
            name, rarity = new_units[uid][1], new_units[uid][2]
            print(f"  [{RARITY.get(rarity, rarity)}] {name}（id={uid}）")
        if len(added) > 30:
            print(f"  …等共 {len(added)} 台")

    # 机体/驾驶员行级变更（数值调整）
    for table, label in (("unit", "机体"), ("character", "驾驶员")):
        _, old_rows = _rows(old_db, table)
        _, new_rows = _rows(new_db, table)
        common = set(old_rows) & set(new_rows)
        name_rows = _rows(new_db, table, "id, name")[1]
        changed = [i for i in common if old_rows[i] != new_rows[i]]
        if changed:
            changed_any = True
            print(f"\n{label}数值/内容变更 {len(changed)} 条，例如：")
            for i in sorted(changed)[:10]:
                print(f"  {name_rows.get(i, (None, f'id={i}'))[1]}")
            if len(changed) > 10:
                print(f"  …等共 {len(changed)} 条")

    if not changed_any:
        print("本次更新无数据变化。")


def run_update(full: bool = False, limit: int | None = None) -> int:
    """一键更新：快照 -> fetch -> build -> verify -> 报告；build 失败回滚。"""
    snapshot = backup_db()
    print(f"\n>>>> 抓取（{'全量刷新' if full else '增量'}）开始 {time.strftime('%F %T')}")
    failures = fetch_all(limit=limit, refresh=full)
    total_fail = sum(len(v) for v in failures.values())
    if total_fail:
        print(f"!! 有 {total_fail} 个条目抓取失败，详见 data/meta/manifest.json；"
              f"build 仍会基于现有数据继续。")

    print(f"\n>>>> 构建数据库 {time.strftime('%F %T')}")
    try:
        build_db()
    except Exception as exc:
        print(f"!! 构建失败：{exc}")
        if snapshot:
            rollback(snapshot)
        return 1

    print(f"\n>>>> 校验 {time.strftime('%F %T')}")
    verify()
    diff_report(snapshot)
    print(f"\n更新完成 {time.strftime('%F %T')}。"
          f"如需云端同步，请在 Web 概览页操作或运行 migrate_cloud.py。")
    return 0
