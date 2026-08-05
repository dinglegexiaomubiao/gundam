"""数量与抽样校验。"""
from __future__ import annotations

import json
import os
import sqlite3

from . import config


def _count(conn, sql):
    return conn.execute(sql).fetchone()[0]


def verify() -> None:
    raw = config.RAW_DIR
    unit_files = len(list((raw / "unit").glob("*.json"))) if (raw / "unit").exists() else 0
    stage_files = len(list((raw / "stage").glob("*.json"))) if (raw / "stage").exists() else 0
    event_files = len(list((raw / "event/story").glob("*.json"))) if (raw / "event/story").exists() else 0

    print("===== 原始 JSON 数量 =====")
    print(f"机体详情: {unit_files}")
    print(f"关卡详情: {stage_files}")
    print(f"剧情事件详情: {event_files}")
    for rel in ("series/v2.json", "faction.json", "unit/min.json",
                "character.json", "supporter.json", "supporter_growth.json",
                "event/story.json", "event/tower.json"):
        p = raw / rel
        size = os.path.getsize(p) if p.exists() else 0
        print(f"{rel}: {'存在' if p.exists() else '缺失'} ({size/1024/1024:.1f} MB)")

    conn = sqlite3.connect(config.DB_PATH)
    print("\n===== SQLite 表行数 =====")
    tables = [
        ("series", "SELECT COUNT(*) FROM series"),
        ("faction", "SELECT COUNT(*) FROM faction"),
        ("unit", "SELECT COUNT(*) FROM unit"),
        ("unit_weapon", "SELECT COUNT(*) FROM unit_weapon"),
        ("unit_ability", "SELECT COUNT(*) FROM unit_ability"),
        ("character", "SELECT COUNT(*) FROM character"),
        ("character_skill", "SELECT COUNT(*) FROM character_skill"),
        ("character_ability", "SELECT COUNT(*) FROM character_ability"),
        ("supporter", "SELECT COUNT(*) FROM supporter"),
        ("supporter_skill", "SELECT COUNT(*) FROM supporter_skill"),
        ("stage", "SELECT COUNT(*) FROM stage"),
        ("stage_map_npc", "SELECT COUNT(*) FROM stage_map_npc"),
        ("stage_map_npc_character", "SELECT COUNT(*) FROM stage_map_npc_character"),
        ("story_event", "SELECT COUNT(*) FROM story_event"),
        ("story_event_boss", "SELECT COUNT(*) FROM story_event_boss"),
        ("tower_event", "SELECT COUNT(*) FROM tower_event"),
        ("tower_stage", "SELECT COUNT(*) FROM tower_stage"),
    ]
    for name, sql in tables:
        print(f"{name:24s} {_count(conn, sql):>6d}")

    print("\n===== 抽样检查 =====")
    for row in conn.execute("SELECT id, name, rarity FROM unit LIMIT 3"):
        print("机体:", row)
    for row in conn.execute(
        "SELECT id, name FROM character WHERE name LIKE '%阿姆罗%' OR name LIKE '%夏亚%' LIMIT 5"
    ):
        print("驾驶员:", row)
    for row in conn.execute("SELECT id, name FROM supporter LIMIT 3"):
        print("支援:", row)
    for row in conn.execute(
        "SELECT stage_id, unit_name, level, hp, attack, defense, mobility "
        "FROM stage_map_npc ORDER BY hp DESC LIMIT 3"
    ):
        print("最强敌人:", row)
    for row in conn.execute(
        "SELECT COUNT(DISTINCT unit_id) FROM stage_map_npc WHERE unit_id NOT IN (SELECT id FROM unit)"
    ):
        print("敌方机体中不在机体表里的数量:", row[0])
    conn.close()


def manifest_summary() -> None:
    p = config.MANIFEST_PATH
    if not p.exists():
        print("无 manifest.json")
        return
    with open(p, encoding="utf-8") as fh:
        m = json.load(fh)
    print("抓取时间:", m.get("fetched_at"))
    print("语言:", m.get("lang"))
    print("失败项:", m.get("failures"))
