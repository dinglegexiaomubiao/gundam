"""soshage gget 全量抓取编排（zh-CN，断点续传）。"""
from __future__ import annotations

import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from . import api, config
from .api import RateLimitAbort


def _save(rel: str, obj) -> Path:
    return api.atomic_write_json(config.RAW_DIR / rel, obj)


def _load(rel: str):
    with open(config.RAW_DIR / rel, encoding="utf-8") as fh:
        return json.load(fh)


def _fetch_many(kind: str, ids: list, path_prefix: str, refresh: bool = False) -> list[tuple[int, str]]:
    """分批并发抓取某类详情，已存在则跳过；批次间长暂停；限流时整体终止。

    refresh=True 时已存在的文件也重新抓取（用于周期性全量刷新旧数据）。
    """
    failures: list[tuple[int, str]] = []
    total_done = 0
    total = len(ids)

    for batch_start in range(0, total, config.BATCH_SIZE):
        batch = ids[batch_start:batch_start + config.BATCH_SIZE]
        print(f"  [{kind}] 批次 {batch_start // config.BATCH_SIZE + 1} "
              f"({len(batch)} 条)，已累计 {total_done}/{total}")
        done = 0
        aborted = False

        def one(item_id: int):
            rel = Path(kind) / f"{item_id}.json"
            if not refresh and (config.RAW_DIR / rel).exists():
                return "skip", item_id
            data = api.http_get_json(f"{path_prefix}/{item_id}")
            _save(rel, data)
            return "ok", item_id

        with ThreadPoolExecutor(max_workers=config.MAX_WORKERS) as pool:
            futures = {pool.submit(one, item_id): item_id for item_id in batch}
            for fut in as_completed(futures):
                done += 1
                item_id = futures[fut]
                try:
                    status, _ = fut.result()
                    if status == "ok":
                        total_done += 1
                except RateLimitAbort:
                    aborted = True
                    total_done += 1
                except Exception as exc:
                    failures.append((item_id, str(exc)))
                    total_done += 1
                if done % 50 == 0 or done == len(batch):
                    print(f"  [{kind}] 本批 {done}/{len(batch)}")

        if aborted:
            raise RateLimitAbort(
                f"[{kind}] 触发站点限流（403/429），已终止任务保护 IP；"
                f"已完成 {total_done} 条，下次运行会自动续传"
            )

        if batch_start + config.BATCH_SIZE < total:
            print(f"  [{kind}] 批次间暂停 {config.BATCH_PAUSE}s…")
            time.sleep(config.BATCH_PAUSE)

    return failures


def fetch_dictionaries():
    series = api.http_get_json("/series/v2")
    _save("series/v2.json", series)
    faction = api.http_get_json("/faction")
    _save("faction.json", faction)
    print(f"系列 {len(series)}，阵营 {len(faction)}")
    return series, faction


def fetch_units(limit: int | None = None, refresh: bool = False):
    units_min = api.http_get_json("/unit/min", {"order_by": "rarity:desc"})
    _save("unit/min.json", units_min)
    ids = [u["id"] for u in units_min]
    print(f"机体列表 {len(ids)} 台")
    if limit:
        ids = ids[:limit]
    failed = _fetch_many("unit", ids, "/unit", refresh=refresh)
    return failed


def fetch_characters():
    chars = api.http_get_json("/character", {"order_by": "rarity:desc"})
    _save("character.json", chars)
    print(f"驾驶员 {len(chars)} 人")
    return chars


def fetch_supporters():
    supporters = api.http_get_json("/supporter", {"order_by": "rarity:desc"})
    _save("supporter.json", supporters)
    growth = api.http_get_json("/supporter/growth")
    _save("supporter_growth.json", growth)
    print(f"支援角色 {len(supporters)} 个，成长记录 {len(growth)} 条")
    return supporters, growth


def fetch_events(refresh: bool = False):
    story = api.http_get_json("/event/story")
    _save("event/story.json", story)
    ids = [e["event_id"] for e in story]
    failed = _fetch_many("event/story", ids, "/event/story", refresh=refresh)
    tower = api.http_get_json("/event/tower")
    _save("event/tower.json", tower)
    print(f"剧情事件 {len(story)} 个，塔楼事件 {len(tower)} 个")
    return story, tower, failed


def collect_stage_ids() -> list[int]:
    """从系列 / 事件数据中汇总所有需要抓取详情的关卡 ID。"""
    ids: set[int] = set()
    for s in _load("series/v2.json"):
        for st in s.get("scenario_stages") or []:
            ids.add(st["id"])
    for e in _load("event/story.json"):
        for b in e.get("boss") or []:
            ids.add(b["stage_id"])
    for e in _load("event/tower.json"):
        for st in (e.get("stage_group") or {}).get("stages") or []:
            ids.add(st["stage_id"])
    return sorted(ids)


def fetch_stages(limit: int | None = None, refresh: bool = False):
    ids = collect_stage_ids()
    print(f"关卡合计 {len(ids)} 个（主线 + 剧情 Boss + 塔楼）")
    if limit:
        ids = ids[:limit]
    return _fetch_many("stage", ids, "/stage", refresh=refresh)


def write_manifest(failures: dict[str, list]) -> None:
    config.META_DIR.mkdir(parents=True, exist_ok=True)
    counts = {}
    for kind in ("series", "faction", "unit", "event/story", "stage"):
        base = config.RAW_DIR / kind
        if kind in ("series", "faction"):
            counts[kind] = len(list(base.glob("*.json"))) if base.exists() else 0
        else:
            counts[kind] = len(list(base.glob("*.json"))) if base.exists() else 0
    for rel in ("character.json", "supporter.json", "supporter_growth.json",
                "event/story.json", "event/tower.json", "unit/min.json",
                "series/v2.json", "faction.json"):
        counts[rel] = (config.RAW_DIR / rel).exists()
    manifest = {
        "lang": config.LANG,
        "base": config.API_BASE,
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "counts": counts,
        "failures": {k: v for k, v in failures.items() if v},
    }
    api.atomic_write_json(config.MANIFEST_PATH, manifest)


def fetch_all(limit: int | None = None, refresh: bool = False) -> dict[str, list]:
    failures: dict[str, list] = {}
    try:
        print("== 1/5 系列与阵营 ==")
        fetch_dictionaries()
        print("== 2/5 机体 ==")
        failures["unit"] = fetch_units(limit, refresh=refresh)
        print("== 3/5 驾驶员 ==")
        fetch_characters()
        print("== 4/5 支援角色 ==")
        fetch_supporters()
        print("== 5/5 事件与关卡（敌人） ==")
        failures["event/story"] = fetch_events(refresh=refresh)[2]
        failures["stage"] = fetch_stages(limit, refresh=refresh)
    except RateLimitAbort as exc:
        print(f"!! {exc}")
        write_manifest(failures)
        return failures
    write_manifest(failures)
    total_fail = sum(len(v) for v in failures.values())
    mode = "全量刷新" if refresh else "增量（跳过已有）"
    print(f"抓取完成（{mode}），共 {total_fail} 个失败项")
    return failures
