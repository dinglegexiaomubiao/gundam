"""本地 Web 查看器：http.server + SQLite 只读查询 + 伤害计算 API。

启动：python scripts/pipeline.py serve --port 8765
页面：http://127.0.0.1:8765
"""
from __future__ import annotations

import json
import mimetypes
import sqlite3
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import config
from .damage import CombatantStats, DamageContext, calculate_damage
from . import pairing
from .labels import (
    ACQUISITION_ROUTE,
    ATTACK_ATTR,
    ATTACK_ATTR_STAT,
    RARITY,
    STAR_LABEL,
    STAR_MULT,
    SUPPORTER_SKILL_TYPE,
    ULTIMATE_TAG,
    WEAPON_ATTR,
    resolve_trait_text,
    star_value,
)

WEB_DIR = config.PROJECT_ROOT / "web"

UNIT_STAR_STATS = ("hp", "en", "attack", "defense", "mobility")
CHAR_STAR_STATS = ("ranged", "melee", "defense", "reaction", "awaken")
CHAR_LEVEL_CAPS = {5: 100, 4: 90, 3: 80, 2: 70, 1: 60}
UNIT_LEVEL_CAPS = {5: 100, 4: 90, 3: 80, 2: 70, 1: 60}

ROLE_NAMES = {1: "攻击型", 2: "耐久型", 3: "支援型"}


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{config.DB_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _one(conn, sql, args=()):
    row = conn.execute(sql, args).fetchone()
    return dict(row) if row else None


def _all(conn, sql, args=()):
    return [dict(r) for r in conn.execute(sql, args).fetchall()]


def _json_list(raw):
    try:
        v = json.loads(raw or "[]")
        return v if isinstance(v, list) else []
    except (TypeError, json.JSONDecodeError):
        return []


def _trait_descs(traits_raw: str) -> list[str]:
    """从 traits JSON 中提取非空效果描述（traits[].desc 为完整效果文本）。"""
    out = []
    for t in _json_list(traits_raw):
        d = (t.get("desc") or "").strip()
        if d:
            out.append(d)
    return out


def _trait_effects(traits_raw: str, tag_by_id: dict, series_by_id: dict, unit_by_id: dict):
    """解析能力 traits：占位符替换 + 收集实际条件实体（标签/系列/类型/机体）。"""
    effects: list[str] = []
    entities: list[dict] = []
    seen: set[tuple] = set()
    for t in _json_list(traits_raw):
        d = (t.get("desc") or "").strip()
        if not d:
            continue
        resolved, ents = resolve_trait_text(
            d, t.get("active_condition"), tag_by_id, series_by_id, unit_by_id
        )
        effects.append(resolved)
        for ent in ents:
            key = (ent["kind"], ent.get("id"), ent["name"])
            if key not in seen:
                seen.add(key)
                entities.append(ent)
    return effects, entities


def _json_dict(raw):
    try:
        v = json.loads(raw or "{}")
        return v if isinstance(v, dict) else {}
    except (TypeError, json.JSONDecodeError):
        return {}


def _apply_char_forms(row: dict, bonuses: dict, conditionals: list[dict]):
    """按驾驶员默认形态（稀有度等级上限）与 SP 形态（满级 100）计算属性。"""
    keys = CHAR_STAR_STATS
    cap = CHAR_LEVEL_CAPS.get(row.get("rarity"), 60)
    has_sp = (row.get("rarity") or 5) < 5

    def build(lv1_prefix, max_prefix, level_cap):
        form = {"level_cap": level_cap, "stats": {}}
        for key in keys:
            lv1 = row.get(lv1_prefix + key) or 0
            mx = row.get(max_prefix + key) or 0
            pct = bonuses.get(key, 0)
            v1, b1 = star_value(lv1, pct, 0)
            vm, bm = star_value(mx, pct, 0)
            form["stats"][key] = {"lv1": v1, "lv1_bonus": b1, "max": vm, "max_bonus": bm}
        return form

    forms = {
        "default": build("", "max_", cap),
    }
    if has_sp:
        forms["sp"] = build("sp_", "sp_max_", 100)

    cond_items = []
    for item in conditionals:
        key = item.get("stat")
        total_pct = bonuses.get(key, 0) + item.get("pct", 0)
        item = dict(item)
        item["values"] = {}
        for form_key, form in forms.items():
            lv1 = row.get(("sp_" if form_key == "sp" else "") + key) or 0
            mx = row.get(("sp_max_" if form_key == "sp" else "max_") + key) or 0
            item["values"][form_key] = {
                "lv1": lv1 * (100 + total_pct) // 100,
                "max": mx * (100 + total_pct) // 100,
            }
        cond_items.append(item)
    return forms, cond_items, cap, has_sp


def _apply_unit_forms(row: dict, bonuses: dict, conditionals: list[dict]):
    """机体形态：默认（稀有度等级上限）/ SP / SSP（均叠加 0~3 星）。"""
    keys = UNIT_STAR_STATS
    cap = UNIT_LEVEL_CAPS.get(row.get("rarity"), 60)
    has_sp = (row.get("rarity") or 5) < 5
    has_ssp = has_sp

    def build(lv1_prefix, max_prefix, level_cap):
        stars = []
        for star in range(4):
            stats = {}
            for key in keys:
                lv1 = row.get(lv1_prefix + key) or 0
                mx = row.get(max_prefix + key) or 0
                pct = bonuses.get(key, 0)
                v1, b1 = star_value(lv1, pct, star)
                vm, bm = star_value(mx, pct, star)
                stats[key] = {"lv1": v1, "lv1_bonus": b1, "max": vm, "max_bonus": bm}
            stars.append({
                "star": star,
                "label": STAR_LABEL[star],
                "stats": stats,
            })
        return {
            "level_cap": level_cap,
            "stars": stars,
            "movement": (
                row.get(lv1_prefix + "movement") or 0,
                row.get(max_prefix + "movement") or 0,
            ),
        }

    forms = {"default": build("", "max_", cap)}
    if has_sp:
        forms["sp"] = build("sp_", "sp_max_", 100)
    if has_ssp:
        forms["ssp"] = build("ssp_", "ssp_max_", 100)
        ssp_present = any(
            (row.get(f"ssp_{key}") or 0) or (row.get(f"ssp_max_{key}") or 0)
            for key in keys
        )
        if not ssp_present:
            forms["ssp"]["fallback"] = True

    cond_items = []
    for item in conditionals:
        key = item.get("stat")
        total_pct = bonuses.get(key, 0) + item.get("pct", 0)
        item = dict(item)
        item["forms"] = {}
        for form_key, lv1_prefix, max_prefix in (
            ("default", "", "max_"),
            ("sp", "sp_", "sp_max_"),
            ("ssp", "ssp_", "ssp_max_"),
        ):
            if form_key not in forms:
                continue
            lv1 = row.get(lv1_prefix + key) or 0
            mx = row.get(max_prefix + key) or 0
            item["forms"][form_key] = {}
            for star in range(4):
                num, den = STAR_MULT[star]
                sb1 = lv1 * num // den
                sbm = mx * num // den
                item["forms"][form_key][star] = {
                    "lv1": sb1 * (100 + total_pct) // 100,
                    "max": sbm * (100 + total_pct) // 100,
                }
        cond_items.append(item)
    return forms, cond_items, cap, has_sp, has_ssp


def api_summary() -> dict:
    conn = _conn()
    counts = {}
    for table in ("unit", "character", "supporter", "stage", "stage_map_npc",
                  "stage_map_npc_character", "unit_weapon", "unit_ability",
                  "character_skill", "character_ability", "story_event",
                  "story_event_boss", "tower_event", "tower_stage"):
        counts[table] = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
    built = conn.execute("SELECT value FROM meta WHERE key='built_at'").fetchone()
    conn.close()
    expected = {"unit": 1210, "stage": 594}
    return {"counts": counts, "expected": expected, "built_at": built[0] if built else None}


def api_series() -> list:
    conn = _conn()
    rows = _all(conn, "SELECT id, name, world_id FROM series ORDER BY sort")
    conn.close()
    return rows


def api_tags(kind: str) -> list:
    conn = _conn()
    if kind == "unit":
        rows = conn.execute("SELECT tags FROM unit WHERE tags != '[]'")
    elif kind == "character":
        rows = conn.execute("SELECT tags FROM character WHERE tags != '[]'")
    elif kind == "supporter":
        rows = conn.execute("SELECT tags FROM supporter WHERE tags != '[]'")
    else:
        conn.close()
        return []
    seen: set[str] = set()
    for (tags,) in rows:
        try:
            seen.update(json.loads(tags or "[]"))
        except (TypeError, json.JSONDecodeError):
            continue
    conn.close()
    return sorted(seen)


def api_skillnames() -> list:
    conn = _conn()
    rows = conn.execute(
        "SELECT DISTINCT name FROM character_skill WHERE name != '' ORDER BY name"
    ).fetchall()
    conn.close()
    return [r[0] for r in rows]


PICKER_SORT_KEYS = {
    "name": "name",
    "rarity": "rarity",
    "type": "role",
    "tags": "tag_text",
    "series": "series_name",
    "attack": "atk",
    "defense": "defense",
}


def api_picker(kind: str, q: str, source: str, rarity: str, type_: str,
               series: str, tags: str, sort: str, order: str,
               limit: int, offset: int) -> dict:
    """伤害计算器的机体/驾驶员选择器：机体库 或 关卡敌人。"""
    like = f"%{_like_escape(q)}%" if q else "%"
    conn = _conn()
    items: list[dict] = []
    total = 0
    if kind == "units":
        if source == "enemy":
            total = conn.execute(
                "SELECT COUNT(DISTINCT unit_id) FROM stage_map_npc "
                "WHERE unit_name LIKE ? ESCAPE '\\'", (like,)
            ).fetchone()[0]
            items = _all(
                conn,
                f"""SELECT n.unit_id AS id, n.unit_name AS name, n.level,
                           n.attack, n.defense
                    FROM stage_map_npc n
                    JOIN (SELECT unit_id, MAX(level) AS ml FROM stage_map_npc
                          GROUP BY unit_id) m
                      ON n.unit_id = m.unit_id AND n.level = m.ml
                    WHERE n.unit_name LIKE ? ESCAPE '\\'
                    ORDER BY n.unit_name""",
                (like,),
            )
            for r in items:
                r["source"] = "enemy"
                r["tags"] = []
                r["series_name"] = ""
                r["role_label"] = "—"
                r["role"] = 0
        else:
            where = ["u.name LIKE ? ESCAPE '\\'"]
            args: list = [like]
            if rarity:
                where.append("u.rarity = ?")
                args.append(int(rarity))
            preds, f_args = _filter_predicates("u", series, type_, tags, "any")
            if preds:
                where.append(" AND ".join(preds))
                args += f_args
            w = "WHERE " + " AND ".join(where)
            total = conn.execute(f"SELECT COUNT(*) FROM unit u {w}", args).fetchone()[0]
            items = _all(
                conn,
                f"""SELECT u.id, u.name, u.rarity,
                           u.role,
                           u.max_attack AS attack, u.max_defense AS defense,
                           u.tags, s.name AS series_name
                    FROM unit u LEFT JOIN series s ON s.id = u.series_id {w}
                    ORDER BY u.rarity DESC, u.id""",
                args,
            )
            for r in items:
                r["source"] = "library"
                r["tags"] = _json_list(r.get("tags"))
                r["role_label"] = ROLE_NAMES.get(r.get("role"), "—")
    elif kind == "pilots":
        if source == "enemy":
            total = conn.execute(
                "SELECT COUNT(*) FROM (SELECT 1 FROM stage_map_npc_character "
                "WHERE IFNULL(character_name,'') LIKE ? ESCAPE '\\' "
                "GROUP BY character_id, IFNULL(character_name,''))", (like,)
            ).fetchone()[0]
            items = _all(
                conn,
                f"""SELECT c.character_id AS id, c.character_name AS name, c.level,
                           c.ranged, c.melee, c.awaken, c.defense
                    FROM stage_map_npc_character c
                    JOIN (SELECT character_id, character_name, MAX(level) AS ml
                          FROM stage_map_npc_character
                          GROUP BY character_id, IFNULL(character_name,'')) m
                      ON c.character_id = m.character_id
                     AND IFNULL(c.character_name,'') = IFNULL(m.character_name,'')
                     AND c.level = m.ml
                    WHERE IFNULL(c.character_name,'') LIKE ? ESCAPE '\\'
                    ORDER BY c.character_name""",
                (like,),
            )
            for r in items:
                r["source"] = "enemy"
                r["tags"] = []
                r["series_name"] = ""
                r["role_label"] = "—"
                r["role"] = 0
        else:
            where = ["c.name LIKE ? ESCAPE '\\'"]
            args: list = [like]
            if rarity:
                where.append("c.rarity = ?")
                args.append(int(rarity))
            preds, f_args = _filter_predicates("c", series, type_, tags, "any")
            if preds:
                where.append(" AND ".join(preds))
                args += f_args
            w = "WHERE " + " AND ".join(where)
            total = conn.execute(f"SELECT COUNT(*) FROM character c {w}", args).fetchone()[0]
            items = _all(
                conn,
                f"""SELECT c.id, c.name, c.rarity,
                           c.role,
                           c.max_ranged AS ranged, c.max_melee AS melee,
                           c.max_awaken AS awaken, c.max_defense AS defense,
                           c.tags, s.name AS series_name
                    FROM character c LEFT JOIN series s ON s.id = c.series_id {w}
                    ORDER BY c.rarity DESC, c.id""",
                args,
            )
            for r in items:
                r["source"] = "library"
                r["tags"] = _json_list(r.get("tags"))
                r["role_label"] = ROLE_NAMES.get(r.get("role"), "—")
    conn.close()
    for r in items:
        r["tag_text"] = "、".join(r.get("tags") or [])
        if kind == "pilots":
            r["atk"] = max(
                r.get("ranged") or 0, r.get("melee") or 0, r.get("awaken") or 0
            )
        else:
            r["atk"] = r.get("attack") or 0
    if sort in PICKER_SORT_KEYS:
        key = PICKER_SORT_KEYS[sort]
        fallback = 0 if key in ("rarity", "atk", "defense") else ""
        items.sort(
            key=lambda x: (x.get(key) or fallback, x.get("id") or 0),
            reverse=(order != "asc"),
        )
    else:
        items.sort(key=lambda x: (-(x.get("rarity") or 0), x.get("id") or 0))
    return {"total": total, "items": items[offset:offset + limit]}


def _skill_where(skills: str, skill_mode: str):
    names = [s for s in (skills or "").split(",") if s]
    if not names:
        return "", []
    if skill_mode == "all":
        clauses = [
            f"EXISTS (SELECT 1 FROM character_skill cs{i} "
            f"WHERE cs{i}.character_id = c.id AND cs{i}.name = ?)"
            for i in range(len(names))
        ]
        return "(" + " AND ".join(clauses) + ")", names
    ph = ",".join("?" for _ in names)
    return (
        f"EXISTS (SELECT 1 FROM character_skill cs "
        f"WHERE cs.character_id = c.id AND cs.name IN ({ph}))",
        names,
    )


def _tag_where(alias: str, tags: str, tag_mode: str):
    tag_list = [t for t in (tags or "").split(",") if t]
    if not tag_list:
        return "", []
    if tag_mode == "all":
        clauses = [
            f"EXISTS (SELECT 1 FROM json_each({alias}.tags) je{i} "
            f"WHERE je{i}.value = ?)"
            for i in range(len(tag_list))
        ]
        return "(" + " AND ".join(clauses) + ")", tag_list
    ph = ",".join("?" for _ in tag_list)
    return (
        f"EXISTS (SELECT 1 FROM json_each({alias}.tags) je "
        f"WHERE je.value IN ({ph}))",
        tag_list,
    )


def _filter_predicates(alias: str, series: str, type_: str, tags: str, tag_mode: str):
    """系列 / 类型 / 标签 三个筛选维度的条件谓词（供交集或并集组合）。"""
    preds: list[str] = []
    args: list = []
    series_list = [s for s in (series or "").split(",") if s]
    if series_list:
        ph = ",".join("?" for _ in series_list)
        preds.append(
            f"EXISTS (SELECT 1 FROM json_each({alias}.series_ids) je "
            f"WHERE je.value IN ({ph}))"
        )
        args += [int(s) for s in series_list]
    if type_:
        preds.append(f"{alias}.role = ?")
        args.append(int(type_))
    tag_list = [t for t in (tags or "").split(",") if t]
    if tag_list:
        t_sql, t_args = _tag_where(alias, tags, tag_mode)
        preds.append(t_sql)
        args += t_args
    return preds, args


UNIT_SORT_KEYS = {
    "name": "name",
    "rarity": "rarity",
    "role": "role",
    "attack": "atk_f",
    "defense": "def_f",
    "mobility": "mob_f",
    "hp": "hp_f",
    "en": "en_f",
    "movement": "mov",
}
CHAR_SORT_KEYS = {
    "name": "name",
    "rarity": "rarity",
    "role": "role",
    "ranged": "ranged_f",
    "melee": "melee_f",
    "defense": "defense_f",
    "reaction": "reaction_f",
    "awaken": "awaken_f",
}

WFX_FILTERS = {
    "map": (
        "EXISTS (SELECT 1 FROM unit_weapon w WHERE w.unit_id = u.id "
        "AND w.map_weapon_range NOT IN ('','null','0'))"
    ),
    "range5": (
        "EXISTS (SELECT 1 FROM unit_weapon w WHERE w.unit_id = u.id "
        "AND w.range_max = 5)"
    ),
    "range5plus": (
        "EXISTS (SELECT 1 FROM unit_weapon w WHERE w.unit_id = u.id "
        "AND w.range_max > 5)"
    ),
    "range5_nomap": (
        "EXISTS (SELECT 1 FROM unit_weapon w WHERE w.unit_id = u.id "
        "AND w.range_max = 5 AND w.map_weapon_range IN ('','null','0'))"
    ),
    "range5plus_nomap": (
        "EXISTS (SELECT 1 FROM unit_weapon w WHERE w.unit_id = u.id "
        "AND w.range_max > 5 AND w.map_weapon_range IN ('','null','0'))"
    ),
    "phys_r5": (
        "EXISTS (SELECT 1 FROM unit_weapon w WHERE w.unit_id = u.id "
        "AND w.weapon_effects LIKE '%物理损伤提升%' AND w.range_max >= 5)"
    ),
    "beam_r5": (
        "EXISTS (SELECT 1 FROM unit_weapon w WHERE w.unit_id = u.id "
        "AND w.weapon_effects LIKE '%光束损伤提升%' AND w.range_max >= 5)"
    ),
    "spec_r5": (
        "EXISTS (SELECT 1 FROM unit_weapon w WHERE w.unit_id = u.id "
        "AND w.weapon_effects LIKE '%特殊损伤提升%' AND w.range_max >= 5)"
    ),
    "defdown": (
        "EXISTS (SELECT 1 FROM unit_weapon w WHERE w.unit_id = u.id "
        "AND w.weapon_effects LIKE '%防御力减少%')"
    ),
    "defdown_r5": (
        "EXISTS (SELECT 1 FROM unit_weapon w WHERE w.unit_id = u.id "
        "AND w.weapon_effects LIKE '%防御力减少%' AND w.range_max >= 5)"
    ),
    "phys": (
        "EXISTS (SELECT 1 FROM unit_weapon w WHERE w.unit_id = u.id "
        "AND w.weapon_effects LIKE '%物理损伤提升%')"
    ),
    "beam": (
        "EXISTS (SELECT 1 FROM unit_weapon w WHERE w.unit_id = u.id "
        "AND w.weapon_effects LIKE '%光束损伤提升%')"
    ),
    "spec": (
        "EXISTS (SELECT 1 FROM unit_weapon w WHERE w.unit_id = u.id "
        "AND w.weapon_effects LIKE '%特殊损伤提升%')"
    ),
}


def _wfx_where(wfx: str, wfx_mode: str):
    keys = [k for k in (wfx or "").split(",") if k in WFX_FILTERS]
    if not keys:
        return "", []
    preds = [WFX_FILTERS[k] for k in keys]
    join = " AND " if wfx_mode == "all" else " OR "
    return "(" + join.join(preds) + ")", []


def api_units(q: str, rarity: str, acq: str, series: str, type_: str,
              tags: str, tag_mode: str, match: str, wfx: str, wfx_mode: str,
              sort: str, order: str, limit: int, offset: int) -> dict:
    where, args = [], []
    if q:
        where.append("(u.name LIKE ? OR u.short_name LIKE ?)")
        args += [f"%{q}%", f"%{q}%"]
    if rarity:
        where.append("rarity = ?")
        args.append(int(rarity))
    if acq:
        if acq == "other":
            where.append("u.acquisition != 1")
        else:
            where.append("u.acquisition = ?")
            args.append(int(acq))
    wfx_sql, wfx_args = _wfx_where(wfx, wfx_mode)
    if wfx_sql:
        where.append(wfx_sql)
        args += wfx_args
    preds, f_args = _filter_predicates("u", series, type_, tags, tag_mode)
    if preds:
        join = " OR " if match == "or" else " AND "
        where.append("(" + join.join(preds) + ")")
        args += f_args
    w = ("WHERE " + " AND ".join(where)) if where else ""
    conn = _conn()
    rows = _all(
        conn,
        f"""SELECT u.id, u.rarity, u.name, u.role, u.series_id, s.name AS series_name,
                   u.attack, u.defense, u.mobility, u.movement,
                   u.max_attack, u.max_defense, u.max_mobility,
                   u.max_hp, u.max_en, u.max_movement, u.stat_bonuses, u.tags
            FROM unit u LEFT JOIN series s ON s.id = u.series_id
            {w} ORDER BY u.id""",
        args,
    )
    conn.close()
    for r in rows:
        r["role_label"] = ROLE_NAMES.get(r.get("role"), "—")
        bonuses = _json_dict(r.get("stat_bonuses"))
        short = {"attack": "atk_f", "defense": "def_f", "mobility": "mob_f",
                 "hp": "hp_f", "en": "en_f"}
        star = 0 if ULTIMATE_TAG in _json_list(r.get("tags")) else 3
        for key, fname in short.items():
            r[fname] = star_value(
                r.get(f"max_{key}") or 0, bonuses.get(key, 0), star
            )[0]
        r["mov"] = r.get("max_movement") or 0
    if sort in UNIT_SORT_KEYS:
        key = UNIT_SORT_KEYS[sort]
        rows.sort(
            key=lambda x: (x.get(key) or 0, x.get("id") or 0),
            reverse=(order != "asc"),
        )
    else:
        rows.sort(key=lambda x: (-(x.get("rarity") or 0), x.get("id") or 0))
    total = len(rows)
    return {"total": total, "items": rows[offset:offset + limit]}


def api_unit_detail(unit_id: int) -> dict | None:
    conn = _conn()
    u = _one(conn, "SELECT * FROM unit WHERE id = ?", (unit_id,))
    if not u:
        conn.close()
        return None
    weapons = _all(
        conn,
        "SELECT * FROM unit_weapon WHERE unit_id = ? ORDER BY sort",
        (unit_id,),
    )
    for w in weapons:
        w["attack_attr_label"] = ATTACK_ATTR.get(w.get("attack_attr"), "—")
        w["weapon_attr_label"] = WEAPON_ATTR.get(w.get("weapon_attr"), "—")
        w["pilot_stat"] = ATTACK_ATTR_STAT.get(w.get("attack_attr"), "—")
        try:
            w["effects"] = json.loads(w.get("weapon_effects") or "[]")
        except (TypeError, json.JSONDecodeError):
            w["effects"] = []
    abilities = _all(
        conn,
        "SELECT * FROM unit_ability WHERE unit_id = ? ORDER BY sort",
        (unit_id,),
    )
    series = _one(conn, "SELECT name FROM series WHERE id = ?", (u.get("series_id"),))
    tag_by_id = {r[0]: r[1] for r in conn.execute("SELECT id, name FROM tag")}
    series_by_id = {r[0]: r[1] for r in conn.execute("SELECT id, name FROM series")}
    unit_by_id = {r[0]: r[1] for r in conn.execute("SELECT id, name FROM unit")}
    for a in abilities:
        a["effects"], a["cond_entities"] = _trait_effects(
            a.get("traits"), tag_by_id, series_by_id, unit_by_id
        )
    conn.close()
    u["series_name"] = series["name"] if series else None
    u["role_label"] = ROLE_NAMES.get(u.get("role"), "—")
    u["terrain"] = json.loads(u.get("terrain") or "{}")
    u["tags"] = json.loads(u.get("tags") or "[]")
    u["can_star"] = ULTIMATE_TAG not in (u.get("tags") or [])
    u["transform_to"] = json.loads(u.get("transform_to") or "[]")
    bonuses = _json_dict(u.get("stat_bonuses"))
    conditionals = _json_list(u.get("conditional_bonuses"))
    u["forms"], u["conditional_bonuses"], u["level_cap"], u["has_sp"], u["has_ssp"] = (
        _apply_unit_forms(u, bonuses, conditionals)
    )
    u["stat_bonuses"] = bonuses
    u["weapons"] = weapons
    u["abilities"] = abilities
    return u


def api_characters(q: str, rarity: str, series: str, type_: str,
                   tags: str, tag_mode: str, match: str, skills: str, skill_mode: str,
                   sort: str, order: str,
                   limit: int, offset: int) -> dict:
    where, args = [], []
    if q:
        where.append("c.name LIKE ?")
        args.append(f"%{q}%")
    if rarity:
        where.append("c.rarity = ?")
        args.append(int(rarity))
    preds, f_args = _filter_predicates("c", series, type_, tags, tag_mode)
    if preds:
        join = " OR " if match == "or" else " AND "
        where.append("(" + join.join(preds) + ")")
        args += f_args
    skill_sql, skill_args = _skill_where(skills, skill_mode)
    if skill_sql:
        where.append(skill_sql)
        args += skill_args
    w = ("WHERE " + " AND ".join(where)) if where else ""
    conn = _conn()
    rows = _all(
        conn,
        f"""SELECT c.id, c.rarity, c.name, s.name AS series_name,
                   c.role, c.ranged, c.melee, c.defense, c.reaction, c.awaken,
                   max_ranged, max_melee, max_defense, max_reaction, max_awaken,
                   c.stat_bonuses
            FROM character c LEFT JOIN series s ON s.id = c.series_id
            {w} ORDER BY c.id""",
        args,
    )
    conn.close()
    for r in rows:
        r["role_label"] = ROLE_NAMES.get(r.get("role"), "—")
        bonuses = _json_dict(r.get("stat_bonuses"))
        for key in ("ranged", "melee", "defense", "reaction", "awaken"):
            r[f"{key}_f"] = star_value(
                r.get(f"max_{key}") or 0, bonuses.get(key, 0), 0
            )[0]
    if sort in CHAR_SORT_KEYS:
        key = CHAR_SORT_KEYS[sort]
        rows.sort(
            key=lambda x: (x.get(key) or 0, x.get("id") or 0),
            reverse=(order != "asc"),
        )
    else:
        rows.sort(key=lambda x: (-(x.get("rarity") or 0), x.get("id") or 0))
    total = len(rows)
    return {"total": total, "items": rows[offset:offset + limit]}


def api_character_detail(char_id: int) -> dict | None:
    conn = _conn()
    c = _one(conn, "SELECT * FROM character WHERE id = ?", (char_id,))
    if not c:
        conn.close()
        return None
    skills = _all(
        conn,
        "SELECT * FROM character_skill WHERE character_id = ? ORDER BY sort",
        (char_id,),
    )
    abilities = _all(
        conn,
        "SELECT * FROM character_ability WHERE character_id = ? ORDER BY sort",
        (char_id,),
    )
    tag_by_id = {r[0]: r[1] for r in conn.execute("SELECT id, name FROM tag")}
    series_by_id = {r[0]: r[1] for r in conn.execute("SELECT id, name FROM series")}
    unit_by_id = {r[0]: r[1] for r in conn.execute("SELECT id, name FROM unit")}
    for sk in skills:
        sk["effects"], sk["cond_entities"] = _trait_effects(
            sk.get("traits"), tag_by_id, series_by_id, unit_by_id
        )
    for a in abilities:
        a["effects"], a["cond_entities"] = _trait_effects(
            a.get("traits"), tag_by_id, series_by_id, unit_by_id
        )
    conn.close()
    c["tags"] = json.loads(c.get("tags") or "[]")
    c["role_label"] = ROLE_NAMES.get(c.get("role"), "—")
    bonuses = _json_dict(c.get("stat_bonuses"))
    conditionals = _json_list(c.get("conditional_bonuses"))
    c["forms"], c["conditional_bonuses"], c["level_cap"], c["has_sp"] = (
        _apply_char_forms(c, bonuses, conditionals)
    )
    c["stat_bonuses"] = bonuses
    c["skills"] = skills
    c["abilities"] = abilities
    return c


def _build_condition_tags(conditions: list[dict]) -> list[dict]:
    seen: set[tuple] = set()
    cond_tags: list[dict] = []
    for c in conditions:
        for sid, name in zip(c.get("series_ids") or [], c.get("series") or []):
            key = ("s", sid)
            if key not in seen:
                seen.add(key)
                cond_tags.append({"kind": "series", "name": name, "id": sid})
        for name in c.get("tags") or []:
            key = ("t", name)
            if key not in seen:
                seen.add(key)
                cond_tags.append({"kind": "tag", "name": name})
    return cond_tags


SUPPORTER_SORT_KEYS = {
    "name": "name",
    "rarity": "rarity",
    "conds": "cond_key",
    "hp": "hp",
    "atk": "atk",
    "route": "route",
}


def api_supporters(q: str, tags: str, tag_mode: str, sort: str, order: str,
                   limit: int, offset: int) -> dict:
    where, args = [], []
    if q:
        where.append("(s.name LIKE ? OR s.tags LIKE ?)")
        args += [f"%{q}%", f"%{q}%"]
    tag_sql, tag_args = _tag_where("s", tags, tag_mode)
    if tag_sql:
        where.append(tag_sql)
        args += tag_args
    w = ("WHERE " + " AND ".join(where)) if where else ""
    conn = _conn()
    rows = _all(
        conn,
        f"""SELECT s.id, s.rarity, s.name, s.tags,
                  s.max_hp_addition_value, s.max_attack_addition_value,
                  s.acquisition_route
           FROM supporter s {w} ORDER BY s.id""",
        args,
    )
    conn.close()
    for r in rows:
        try:
            r["tags"] = json.loads(r.get("tags") or "[]")
        except (TypeError, json.JSONDecodeError):
            r["tags"] = []
    conds_by_sup: dict[int, list[dict]] = {}
    conn = _conn()
    for sid, conds in conn.execute(
        "SELECT supporter_id, conditions FROM supporter_skill WHERE conditions != '[]'"
    ):
        conds_by_sup.setdefault(sid, []).extend(_json_list(conds))
    conn.close()
    for r in rows:
        r["condition_tags"] = _build_condition_tags(conds_by_sup.get(r["id"], []))
        r["hp"] = r.get("max_hp_addition_value") or 0
        r["atk"] = r.get("max_attack_addition_value") or 0
        r["route"] = r.get("acquisition_route") or 0
        r["cond_key"] = (
            len(r["condition_tags"]),
            " ".join(c["name"] for c in r["condition_tags"]),
        )
    if sort in SUPPORTER_SORT_KEYS:
        key = SUPPORTER_SORT_KEYS[sort]
        rows.sort(
            key=lambda x: (x.get(key), x.get("id") or 0),
            reverse=(order != "asc"),
        )
    else:
        rows.sort(key=lambda x: (-(x.get("rarity") or 0), x.get("id") or 0))
    total = len(rows)
    return {"total": total, "items": rows[offset:offset + limit]}


def api_supporter_detail(sup_id: int) -> dict | None:
    conn = _conn()
    s = _one(conn, "SELECT * FROM supporter WHERE id = ?", (sup_id,))
    if not s:
        conn.close()
        return None
    skills = _all(
        conn,
        "SELECT * FROM supporter_skill WHERE supporter_id = ? ORDER BY limit_break_step, skill_type",
        (sup_id,),
    )
    for sk in skills:
        sk["conditions"] = _json_list(sk.get("conditions"))
    conn.close()
    s["skills"] = skills
    s["tags"] = _json_list(s.get("tags"))
    all_conds: list[dict] = []
    for sk in skills:
        for c in sk.get("conditions") or []:
            all_conds.append(c)
    s["condition_tags"] = _build_condition_tags(all_conds)
    return s


def _like_escape(q: str) -> str:
    return (q or "").replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


SEARCH_SORT_KEYS = {
    "name": "name",
    "owner": "owner_name",
    "rarity": "owner_rarity",
    "series": "series_name",
    "effect": "effect_text",
}


def api_search(type_: str, q: str, kind: str, sort: str, order: str,
               limit: int, offset: int) -> dict:
    """跨实体查询：技能 / 能力 / 武装效果。

    type_: skill | ability | weapon；kind: all | unit | character（武器仅机体）。
    """
    q = (q or "").strip()
    if type_ not in ("skill", "ability", "weapon"):
        return {"total": 0, "items": []}
    like = f"%{_like_escape(q)}%" if q else None
    conn = _conn()
    items: list[dict] = []

    if type_ in ("skill", "ability"):
        for owner in ("unit", "character"):
            if kind not in ("all", owner):
                continue
            tbl = f"{owner}_{type_}"
            oid = f"{owner}_id"
            where = ""
            args: tuple = ()
            if like is not None:
                where = (
                    "WHERE sk.name LIKE ? ESCAPE '\\' "
                    "OR sk.desc LIKE ? ESCAPE '\\' "
                    "OR sk.traits LIKE ? ESCAPE '\\'"
                )
                args = (like, like, like)
            rows = _all(
                conn,
                f"""SELECT o.id AS owner_id, o.rarity AS owner_rarity, o.name AS owner_name,
                           o.role, s.name AS series_name,
                           sk.name AS name, sk.desc AS detail_desc, sk.traits
                    FROM {tbl} sk
                    JOIN {owner} o ON o.id = sk.{oid}
                    LEFT JOIN series s ON s.id = o.series_id
                    {where}
                    ORDER BY o.rarity DESC, o.id, sk.sort""",
                args,
            )
            for r in rows:
                r["owner_type"] = owner
                r["effects"] = _trait_descs(r.pop("traits", None))
                items.append(r)
    else:
        where = "WHERE w.weapon_effects NOT IN ('[]','null','')"
        args: tuple = ()
        if like is not None:
            where = "WHERE w.weapon_effects LIKE ? ESCAPE '\\'"
            args = (like,)
        rows = _all(
            conn,
            f"""SELECT u.id AS owner_id, u.rarity AS owner_rarity, u.name AS owner_name,
                      u.role, s.name AS series_name,
                      w.name AS name, w.weapon_effects
               FROM unit_weapon w
               JOIN unit u ON u.id = w.unit_id
               LEFT JOIN series s ON s.id = u.series_id
               {where}
               ORDER BY u.rarity DESC, u.id, w.sort""",
            args,
        )
        for r in rows:
            r["owner_type"] = "unit"
            r["effects"] = _json_list(r.pop("weapon_effects", None))
            items.append(r)
    conn.close()

    items.sort(key=lambda x: (-(x.get("owner_rarity") or 0), x.get("owner_id") or 0))
    for r in items:
        eff = r.get("effects") or []
        first = eff[0] if eff else (r.get("detail_desc") or "")
        r["effect_text"] = (first.get("name") or first.get("desc") or first) if isinstance(first, dict) else (first or "")
        r["series_name"] = r.get("series_name") or ""
    if sort in SEARCH_SORT_KEYS:
        key = SEARCH_SORT_KEYS[sort]
        fallback = 0 if key == "owner_rarity" else ""
        items.sort(
            key=lambda x: (x.get(key) or fallback, x.get("owner_id") or 0),
            reverse=(order != "asc"),
        )
    total = len(items)
    for r in items:
        r["role_label"] = ROLE_NAMES.get(r.get("role"), "—")
        r["detail_desc"] = r.pop("detail_desc", None) or ""
    return {"total": total, "items": items[offset:offset + limit]}


def api_stages(q: str, limit: int, offset: int) -> dict:
    where, args = [], []
    if q:
        where.append("(name LIKE ? OR CAST(id AS TEXT) LIKE ?)")
        args += [f"%{q}%", f"%{q}%"]
    w = ("WHERE " + " AND ".join(where)) if where else ""
    conn = _conn()
    total = conn.execute(f"SELECT COUNT(*) FROM stage {w}", args).fetchone()[0]
    rows = _all(
        conn,
        f"""SELECT st.id, st.name, st.stage_type, st.cp, st.ap,
                   (SELECT COUNT(*) FROM stage_map_npc n WHERE n.stage_id = st.id) AS enemy_count
            FROM stage st {w} ORDER BY st.id LIMIT ? OFFSET ?""",
        args + [limit, offset],
    )
    conn.close()
    return {"total": total, "items": rows}


def api_stage_detail(stage_id: int) -> dict | None:
    conn = _conn()
    st = _one(conn, "SELECT * FROM stage WHERE id = ?", (stage_id,))
    if not st:
        conn.close()
        return None
    npcs = _all(
        conn,
        "SELECT * FROM stage_map_npc WHERE stage_id = ? ORDER BY battle_side, y, x",
        (stage_id,),
    )
    chars = _all(
        conn,
        "SELECT * FROM stage_map_npc_character WHERE stage_id = ?",
        (stage_id,),
    )
    conn.close()
    st["condition"] = json.loads(st.get("condition") or "[]")
    st["npcs"] = npcs
    st["npc_characters"] = chars
    return st


def api_damage(q: dict) -> dict:
    def f(name: str, default: float = 0.0) -> float:
        try:
            return float(q.get(name, [str(default)])[0])
        except (TypeError, ValueError):
            return default

    attacker = CombatantStats(
        unit_attack=f("aua"),
        character_attack=f("aca"),
    )
    defender = CombatantStats(
        unit_defense=f("dud"),
        character_defense=f("dcd"),
    )
    ctx = DamageContext(
        weapon_power=f("wp", 1000),
        terrain_correction=f("terrain", 1.0),
        defensive_correction=0.8 if q.get("shield", ["0"])[0] == "1" else 1.0,
        attacker_vigor=q.get("vigor", ["normal"])[0],
        critical=q.get("critical", ["0"])[0] == "1",
        attacker_damage_dealt_percent=[f("buff", 0.0)],
        defender_damage_taken_percent=[f("debuff", 0.0)],
    )
    steps = calculate_damage(attacker, defender, ctx)
    return {"params": {"attacker": attacker.__dict__, "defender": defender.__dict__,
                       "context": {k: v for k, v in ctx.__dict__.items()
                                   if not isinstance(v, list)}}, "steps": steps}


class Handler(BaseHTTPRequestHandler):
    server_version = "GundamDB/0.1"

    def log_message(self, fmt, *args):  # 保持安静，可自行取消注释
        pass

    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _handle_api(self, path: str, q: dict):
        if path == "/api/summary":
            return self._send_json(api_summary())
        if path == "/api/series":
            return self._send_json(api_series())
        if path == "/api/tags":
            return self._send_json(api_tags(q.get("kind", [""])[0]))
        if path == "/api/skillnames":
            return self._send_json(api_skillnames())
        if path == "/api/units":
            limit = min(int(q.get("limit", ["25"])[0]), 100)
            offset = max(int(q.get("offset", ["0"])[0]), 0)
            return self._send_json(api_units(
                q.get("q", [""])[0], q.get("rarity", [""])[0],
                q.get("acq", [""])[0], q.get("series", [""])[0], q.get("type", [""])[0],
                q.get("tags", [""])[0], q.get("tag_mode", ["all"])[0],
                q.get("match", ["and"])[0], q.get("wfx", [""])[0],
                q.get("wfx_mode", ["any"])[0],
                q.get("sort", [""])[0], q.get("order", ["desc"])[0],
                limit, offset))
        if path == "/api/characters":
            limit = min(int(q.get("limit", ["25"])[0]), 100)
            offset = max(int(q.get("offset", ["0"])[0]), 0)
            return self._send_json(api_characters(
                q.get("q", [""])[0], q.get("rarity", [""])[0], q.get("series", [""])[0],
                q.get("type", [""])[0], q.get("tags", [""])[0],
                q.get("tag_mode", ["all"])[0], q.get("match", ["and"])[0],
                q.get("skills", [""])[0], q.get("skill_mode", ["any"])[0],
                q.get("sort", [""])[0],
                q.get("order", ["desc"])[0], limit, offset))
        if path == "/api/supporters":
            limit = min(int(q.get("limit", ["25"])[0]), 100)
            offset = max(int(q.get("offset", ["0"])[0]), 0)
            return self._send_json(api_supporters(
                q.get("q", [""])[0], q.get("tags", [""])[0],
                q.get("tag_mode", ["any"])[0],
                q.get("sort", [""])[0], q.get("order", ["desc"])[0],
                limit, offset))
        if path == "/api/search":
            limit = min(int(q.get("limit", ["25"])[0]), 100)
            offset = max(int(q.get("offset", ["0"])[0]), 0)
            return self._send_json(api_search(
                q.get("type", [""])[0], q.get("q", [""])[0],
                q.get("kind", ["all"])[0],
                q.get("sort", [""])[0], q.get("order", ["desc"])[0],
                limit, offset))
        if path == "/api/picker/units" or path == "/api/picker/pilots":
            kind = path.split("/")[-1]
            limit = min(int(q.get("limit", ["20"])[0]), 100)
            offset = max(int(q.get("offset", ["0"])[0]), 0)
            return self._send_json(api_picker(
                kind, q.get("q", [""])[0], q.get("source", ["library"])[0],
                q.get("rarity", [""])[0], q.get("type", [""])[0],
                q.get("series", [""])[0], q.get("tags", [""])[0],
                q.get("sort", [""])[0], q.get("order", ["desc"])[0],
                limit, offset))
        if path == "/api/stages":
            limit = min(int(q.get("limit", ["25"])[0]), 100)
            offset = max(int(q.get("offset", ["0"])[0]), 0)
            return self._send_json(api_stages(q.get("q", [""])[0], limit, offset))
        if path == "/api/damage":
            return self._send_json(api_damage(q))
        parts = path.split("/")
        if len(parts) == 5 and parts[1] == "api" and parts[2] == "pairing":
            kind, item_id = parts[3], parts[4]
            try:
                item_id = int(item_id)
            except ValueError:
                return self._send_json({"error": "bad id"}, 400)
            limit = min(int(q.get("limit", ["10"])[0]), 50)
            if kind == "units":
                return self._send_json(pairing.recommend_pilots(item_id, limit))
            if kind == "characters":
                return self._send_json(pairing.recommend_units(item_id, limit))
            return self._send_json({"error": "unknown pairing kind"}, 404)
        if len(parts) == 4 and parts[1] == "api":
            kind, item_id = parts[2], parts[3]
            try:
                item_id = int(item_id)
            except ValueError:
                return self._send_json({"error": "bad id"}, 400)
            data = None
            if kind == "units":
                data = api_unit_detail(item_id)
            elif kind == "characters":
                data = api_character_detail(item_id)
            elif kind == "supporters":
                data = api_supporter_detail(item_id)
            elif kind == "stages":
                data = api_stage_detail(item_id)
            if data is None:
                return self._send_json({"error": "not found"}, 404)
            return self._send_json(data)
        return self._send_json({"error": "unknown api"}, 404)

    def _handle_static(self, path: str):
        if path == "/":
            path = "/index.html"
        rel = Path(path.lstrip("/"))
        full = (WEB_DIR / rel).resolve()
        if not str(full).startswith(str(WEB_DIR.resolve())) or not full.is_file():
            self.send_error(404)
            return
        body = full.read_bytes()
        ctype = mimetypes.guess_type(full.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith("text/") else ""))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        try:
            if parsed.path.startswith("/api/"):
                self._handle_api(parsed.path, parse_qs(parsed.query))
            else:
                self._handle_static(parsed.path)
        except Exception as exc:  # 兜底：避免连接挂死
            try:
                self._send_json({"error": str(exc)}, 500)
            except Exception:
                pass


def run_server(port: int = 8765) -> None:
    if not config.DB_PATH.exists():
        raise SystemExit(f"数据库不存在：{config.DB_PATH}，请先运行 build")
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    print(f"GGE 资料库已启动：http://127.0.0.1:{port}")
    print(f"按 Ctrl+C 停止（数据来自 {config.DB_PATH}）")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
