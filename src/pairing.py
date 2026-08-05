"""配对推荐引擎：机体 × 驾驶员 × 支援角色。

评分模型（满分 100）：
- 属性契合 30 分：驾驶员射击/格斗/觉醒属性与机体武器属性的匹配度；
- 驾驶员加成 50 分：驾驶员技能/能力中可作用于该机体的伤害/属性加成；
- 支援加成 20 分：支援角色队长技对该机体的系列/标签条件的加成。

说明：攻击属性 1=射击、2=格斗、3=觉醒（由武器名反推验证）；
技能按 0.7 权重（需要 SP 主动发动），能力按 1.0（常驻被动）。
"""
from __future__ import annotations

import json
import re
import sqlite3
import threading

from . import config

_STAT_ATTR = {1: "ranged", 2: "melee", 3: "awaken"}
_STATS = ("ranged", "melee", "awaken")
_STAT_KW = ("攻击", "能力", "射击", "格斗", "觉醒", "反应", "防御")
_DAMAGE_RE = re.compile(
    r"(?:造成的伤害|造成的损伤|伤害提升|损伤提升|伤害增加|损伤增加|增伤|伤害增强)"
    r"[^0-9]{0,6}?提升\s*(\d+)%"
)
_STAT_RE = re.compile(
    r"(?:攻击力|攻击及防御|攻击和防御|全能力值|全能力|觉醒值|反应值|射击值|格斗值|防御力)"
    r"[^0-9]{0,8}?提升\s*(\d+)%"
    r"|提升[^0-9]{0,10}?(?:全能力值|全能力|攻击力)\s*(\d+)%"
)

_build_lock = threading.Lock()
_index = None


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{config.DB_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _parse_bonus(desc: str) -> tuple[float, float]:
    """从中文描述提取 (伤害加成%, 属性加成%)。"""
    desc = desc or ""
    damage = 0.0
    for m in _DAMAGE_RE.finditer(desc):
        damage = max(damage, float(m.group(1)))
    stat = 0.0
    for m in _STAT_RE.finditer(desc):
        stat = max(stat, float(m.group(1) or m.group(2) or 0))
    return damage, stat


def _cond_from(obj: dict, desc: str) -> dict | None:
    """从条件对象提取 tags/series；若条件针对“敌方”则视为通用。"""
    tags = {t.get("name") for t in obj.get("tags") or [] if t.get("name")}
    series = {s for s in str(obj.get("unit_series") or "").split(",") if s}
    if not tags and not series:
        return None
    if any(k in desc for k in ("敌方包含", "敌方含有", "敌方是", "发起战斗的敌方")):
        return None
    return {"tags": tags, "series": series}


def _trait_bonus(trait: dict, weight: float) -> dict:
    desc = trait.get("desc") or ""
    damage, stat = _parse_bonus(desc)
    conds = []
    for key in ("target_condition", "active_condition"):
        cond = _cond_from(trait.get(key) or {}, desc)
        if cond:
            conds.append(cond)
    tags = set().union(*(c["tags"] for c in conds)) if conds else set()
    series = set().union(*(c["series"] for c in conds)) if conds else set()
    return {
        "damage": damage * weight,
        "stat": stat * weight,
        "tags": tags,
        "series": series,
        "desc": desc.strip().replace("\n", " ")[:100],
        "name": trait.get("name") or "",
    }


def _cond_matches(cond: dict, unit: dict) -> bool:
    if cond["series"] and str(unit["series_id"]) not in cond["series"]:
        return False
    if cond["tags"] and not (unit["tags"] & cond["tags"]):
        return False
    return True


def _jsonable_cond(cond: dict) -> dict:
    """把条件中的 set 转成 list，便于 JSON 输出。"""
    out = dict(cond)
    out["tags"] = sorted(cond.get("tags") or [])
    out["series"] = sorted(cond.get("series") or [])
    return out


def _build_indexes() -> dict:
    global _index
    with _build_lock:
        if _index is not None:
            return _index
        conn = _conn()

        # ---- 驾驶员索引 ----
        pilots = []
        max_stats = {s: [] for s in _STATS}
        for c in conn.execute("SELECT * FROM character"):
            st = {s: c[f"max_{s}"] or 0 for s in _STATS}
            for s in _STATS:
                max_stats[s].append(st[s])
            univ_damage = 0.0
            univ_stat = 0.0
            univ_matches: list[dict] = []
            conditionals: list[dict] = []
            for table, weight, kind in (
                ("character_ability", 1.0, "被动"),
                ("character_skill", 0.7, "主动"),
            ):
                for row in conn.execute(
                    f"SELECT name, traits FROM {table} WHERE character_id = ?",
                    (c["id"],),
                ):
                    for trait in json.loads(row["traits"] or "[]"):
                        b = _trait_bonus(trait, weight)
                        if not (b["damage"] or b["stat"]):
                            continue
                        b["kind"] = kind
                        b["skill_name"] = row["name"] or b["name"]
                        if b["tags"] or b["series"]:
                            conditionals.append(b)
                        else:
                            univ_damage += b["damage"]
                            univ_stat += b["stat"]
                            univ_matches.append(b)
            pilots.append({
                "id": c["id"],
                "name": c["name"],
                "rarity": c["rarity"],
                "series_id": c["series_id"],
                "stats": st,
                "univ_damage": univ_damage,
                "univ_stat": univ_stat,
                "univ_matches": univ_matches,
                "conditionals": conditionals,
            })
        conn.close()

        for s in _STATS:
            lo, hi = min(max_stats[s]), max(max_stats[s])
            for p in pilots:
                p.setdefault("pct", {})[s] = (
                    (p["stats"][s] - lo) / (hi - lo) if hi > lo else 0.5
                )

        # ---- 机体索引 ----
        conn = _conn()
        units = {}
        for u in conn.execute("SELECT * FROM unit"):
            tags = set(json.loads(u["tags"] or "[]"))
            counts = {s: 0 for s in _STATS}
            mapped = 0
            for w in conn.execute(
                "SELECT attack_attr FROM unit_weapon WHERE unit_id = ?", (u["id"],)
            ):
                stat = _STAT_ATTR.get(w["attack_attr"])
                if stat:
                    counts[stat] += 1
                    mapped += 1
            if mapped:
                weights = {s: counts[s] / mapped for s in _STATS}
            else:
                weights = {s: 1 / 3 for s in _STATS}
            units[u["id"]] = {
                "id": u["id"],
                "name": u["name"],
                "rarity": u["rarity"],
                "series_id": u["series_id"],
                "tags": tags,
                "weights": weights,
                "power": u["max_attack"] or 0,
            }

        # ---- 支援角色索引 ----
        supporters = []
        for s in conn.execute("SELECT * FROM supporter"):
            leader_skills = []
            for row in conn.execute(
                """SELECT limit_break_step, name, desc, traits
                   FROM supporter_skill
                   WHERE supporter_id = ? AND skill_type = 'leader'""",
                (s["id"],),
            ):
                for item in json.loads(row["traits"] or "[]"):
                    tv = (item.get("trait_content") or {}).get("trait_value") or {}
                    bonus = float(tv.get("value") or 0) if tv else 0.0
                    if not bonus:
                        _, bonus = _parse_bonus(item.get("desc") or "")
                    for cond in item.get("trait_condition") or []:
                        tags = {t.get("name") for t in cond.get("tags") or [] if t.get("name")}
                        series = {x for x in str(cond.get("unit_series") or "").split(",") if x}
                        if tags or series:
                            leader_skills.append({
                                "bonus": bonus,
                                "tags": tags,
                                "series": series,
                                "desc": (item.get("desc") or row["desc"] or "").strip()[:100],
                                "lb": row["limit_break_step"],
                            })
            supporters.append({
                "id": s["id"],
                "name": s["name"],
                "rarity": s["rarity"],
                "hp_add": s["max_hp_addition_value"],
                "atk_add": s["max_attack_addition_value"],
                "leader_skills": leader_skills,
            })
        conn.close()

        _index = {
            "pilots": pilots,
            "units": units,
            "supporters": supporters,
            "stat_bounds": {s: (min(max_stats[s]), max(max_stats[s])) for s in _STATS},
        }
        return _index


def _pilot_score_for_unit(pilot: dict, unit: dict) -> dict:
    stat = 30.0 * sum(
        unit["weights"][s] * pilot["pct"][s] for s in _STATS
    )
    damage = pilot["univ_damage"]
    stat_bonus = pilot["univ_stat"]
    matched = [_jsonable_cond(m) for m in pilot["univ_matches"]]
    for cond in pilot["conditionals"]:
        if _cond_matches(cond, unit):
            damage += cond["damage"]
            stat_bonus += cond["stat"]
            matched.append(_jsonable_cond(cond))
    bonus = min(50.0, damage + 0.5 * stat_bonus)
    affinity = 0.0
    if pilot["series_id"] and unit["series_id"] and pilot["series_id"] == unit["series_id"]:
        affinity = 6.0
    total = round(min(100.0, stat + bonus + affinity), 1)
    return {
        "character_id": pilot["id"],
        "name": pilot["name"],
        "rarity": pilot["rarity"],
        "stat_score": round(stat, 1),
        "bonus_score": round(bonus, 1),
        "affinity": affinity,
        "series_match": affinity > 0,
        "total_score": total,
        "damage_bonus": round(damage, 1),
        "stat_bonus": round(stat_bonus, 1),
        "stats": pilot["stats"],
        "matched": matched,
    }


def _best_supporters_for_unit(unit: dict, top_n: int = 3) -> list[dict]:
    scored = []
    for sup in _build_indexes()["supporters"]:
        best = None
        for sk in sup["leader_skills"]:
            cond = {"series": sk["series"], "tags": sk["tags"]}
            if _cond_matches(cond, unit):
                if best is None or sk["bonus"] > best["bonus"]:
                    best = sk
        score = 0.0
        if best:
            score = 20.0 * min(1.0, best["bonus"] / 30.0)
        scored.append({
            "supporter_id": sup["id"],
            "name": sup["name"],
            "rarity": sup["rarity"],
            "hp_add": sup["hp_add"],
            "atk_add": sup["atk_add"],
            "bonus": best["bonus"] if best else 0.0,
            "lb": best["lb"] if best else None,
            "desc": best["desc"] if best else "无条件适配",
            "score": round(score, 1),
        })
    scored.sort(key=lambda x: x["score"], reverse=True)
    return scored[:top_n]


def recommend_pilots(unit_id: int, limit: int = 10) -> dict:
    idx = _build_indexes()
    unit = idx["units"].get(unit_id)
    if unit is None:
        return {"error": "机体不存在", "unit": None}
    scored = [_pilot_score_for_unit(p, unit) for p in idx["pilots"]]
    scored.sort(key=lambda x: (x["total_score"], x["stat_score"]), reverse=True)
    return {
        "unit": {"id": unit["id"], "name": unit["name"], "rarity": unit["rarity"]},
        "pilots": scored[:limit],
        "supporters": _best_supporters_for_unit(unit, 3),
    }


def recommend_units(character_id: int, limit: int = 10) -> dict:
    idx = _build_indexes()
    pilot = next((p for p in idx["pilots"] if p["id"] == character_id), None)
    if pilot is None:
        return {"error": "驾驶员不存在", "pilot": None}
    scored = []
    for unit in idx["units"].values():
        s = _pilot_score_for_unit(pilot, unit)
        sup = _best_supporters_for_unit(unit, 1)
        sup_score = sup[0]["score"] if sup else 0.0
        s["supporter_score"] = sup_score
        s["total_score"] = round(
            min(100.0, s["stat_score"] + s["bonus_score"] + s.get("affinity", 0.0) + sup_score), 1
        )
        s["unit_id"] = unit["id"]
        s["unit_name"] = unit["name"]
        s["unit_rarity"] = unit["rarity"]
        s["power"] = unit["power"]
        scored.append(s)
    scored.sort(key=lambda x: (x["total_score"], x["power"]), reverse=True)
    return {
        "pilot": {"id": pilot["id"], "name": pilot["name"], "rarity": pilot["rarity"]},
        "units": scored[:limit],
    }
