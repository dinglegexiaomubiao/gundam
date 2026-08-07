"""本地 Web 查看器：http.server + SQLite 只读查询 + 伤害计算 API。

启动：python scripts/pipeline.py serve --port 8765
页面：http://127.0.0.1:8765
"""
from __future__ import annotations

import json
import mimetypes
import sqlite3
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
import re

from . import config
from .cloud import (
    cloud_diff,
    restore_local_db_from_cloud,
    unit_sync_diff,
    unit_sync_push,
    upload_local_db_to_cloud,
)
from .damage import CRITICAL_CORRECTION, CombatantStats, DamageContext, calculate_damage
from . import pairing
from .db import build_db
from .fetch import fetch_all
from .labels import (
    ACQUISITION_ROUTE,
    ATTACK_ATTR,
    ATTACK_ATTR_DEP_LABEL,
    ATTACK_ATTR_STAT,
    ATTACK_ATTR_STATS,
    RARITY,
    STAR_LABEL,
    STAR_MULT,
    SUPPORTER_SKILL_TYPE,
    ULTIMATE_TAG,
    WEAPON_ATTR,
    resolve_trait_text,
    star_value,
    support_label,
)

WEB_DIR = config.PROJECT_ROOT / "web"

# 手动爬取任务状态（仅由概览页「爬取数据」按钮触发，禁止自动爬取）
_crawl_lock = threading.Lock()
_crawl_state: dict = {
    "running": False,
    "step": "",
    "started_at": None,
    "error": None,
}
_sync_lock = threading.Lock()
_sync_state: dict = {
    "running": False,
    "direction": "",
    "step": "",
    "started_at": None,
    "error": None,
}


def _run_crawl_worker(preserve_ids: list[int]) -> None:
    try:
        _crawl_state.update({
            "running": True,
            "step": "fetch",
            "started_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "error": None,
        })
        from .cloud import _unit_local, restore_unit_locally

        snapshots: dict[int, dict] = {}
        for uid in preserve_ids:
            snap = _unit_local(uid)
            if snap:
                snapshots[uid] = snap
        fetch_all()
        _crawl_state["step"] = "build"
        build_db()
        for uid, snap in snapshots.items():
            try:
                restore_unit_locally(snap)
                print(f"已保留机体编辑: {uid}")
            except Exception as exc:  # noqa: BLE001
                print(f"保留机体 {uid} 失败: {exc}")
        _crawl_state["step"] = "done"
    except Exception as exc:  # noqa: BLE001
        _crawl_state["error"] = str(exc)
    finally:
        _crawl_state["running"] = False


def start_crawl(preserve: list | None = None) -> dict:
    with _crawl_lock:
        if _crawl_state["running"] or _sync_state["running"]:
            return {"ok": False, "message": "爬取已在进行中"}
        preserve_ids = [
            int(x) for x in (preserve or []) if str(x).strip().isdigit()
        ]
        threading.Thread(
            target=_run_crawl_worker, args=(preserve_ids,), daemon=True
        ).start()
        return {
            "ok": True,
            "message": "已开始爬取，完成后自动构建数据库"
            + (f"（保留 {len(preserve_ids)} 台机体的编辑）" if preserve_ids else ""),
        }


def crawl_status() -> dict:
    with _crawl_lock:
        return dict(_crawl_state)


def api_crawl_edits() -> list:
    """有本地编辑记录的机体列表（爬取前供用户勾选保留）。"""
    conn = _conn()
    rows = conn.execute(
        "SELECT u.id AS unit_id, u.name, COUNT(e.id) AS edits, "
        "MAX(e.edited_at) AS last_edited "
        "FROM unit_edit_log e JOIN unit u ON u.id = e.unit_id "
        "GROUP BY u.id ORDER BY last_edited DESC"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def _run_sync_worker(direction: str) -> None:
    try:
        _sync_state.update({
            "running": True,
            "direction": direction,
            "step": "working",
            "started_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "error": None,
        })
        if direction == "upload":
            res = upload_local_db_to_cloud()
            if not res.get("ok"):
                _sync_state["error"] = res.get("message", "上传失败")
        else:
            if not restore_local_db_from_cloud():
                _sync_state["error"] = (
                    "同步失败（云端不可用或未配置 NEON_DB_URL）"
                )
        _sync_state["step"] = "done"
    except Exception as exc:  # noqa: BLE001
        _sync_state["error"] = str(exc)
    finally:
        _sync_state["running"] = False


def start_sync(direction: str) -> dict:
    if direction not in ("upload", "download"):
        return {"ok": False, "message": "无效的同步方向"}
    with _sync_lock:
        if _sync_state["running"] or _crawl_state["running"]:
            return {"ok": False, "message": "已有任务在进行中"}
        threading.Thread(
            target=_run_sync_worker, args=(direction,), daemon=True
        ).start()
        label = "上传本地到服务器" if direction == "upload" else "服务器同步到本地"
        return {"ok": True, "message": f"已开始同步（{label}）"}


def sync_status() -> dict:
    with _sync_lock:
        return dict(_sync_state)

UNIT_STAR_STATS = ("hp", "en", "attack", "defense", "mobility")
CHAR_STAR_STATS = ("ranged", "melee", "defense", "reaction", "awaken")
CHAR_LEVEL_CAPS = {5: 100, 4: 90, 3: 80, 2: 70, 1: 60}
UNIT_LEVEL_CAPS = {5: 100, 4: 90, 3: 80, 2: 70, 1: 60}

ROLE_NAMES = {1: "攻击型", 2: "耐久型", 3: "支援型"}

_DMG_UP_RE = re.compile(r"(?<!爆击)损伤提升\s*(\d+)%")
_DMG_DOWN_RE = re.compile(r"损伤(?:减轻|降低)\s*(\d+)%")
_DEF_UP_RE = re.compile(r"(?:防御力|守备值)(?:及|与|和)?(?:攻击力)?提升\s*(\d+)%")
_ATK_UP_RE = re.compile(r"攻击力(?:及|与|和)?(?:防御力)?提升\s*(\d+)%")
_DEF_STACK_RE = re.compile(
    r"每次受到(?:来自敌方的)?损伤时，\s*自身防御力提升(\d+)%（最高(\d+)%）"
)
_HP_RECOVER_RE = re.compile(
    r"自身HP为(\d+)%以下时，\s*自身HP恢复(\d+)%（1次）"
)
_CRIT_DMG_RE = re.compile(r"爆击损伤提升\s*(\d+)%")
_CRIT_RATE_RE = re.compile(r"爆击率提升\s*(\d+)%")
_STAT_COMBO_RE = re.compile(
    r"((?:射击值|格斗值|觉醒值)(?:及|与|和)?(?:射击值|格斗值|觉醒值)?)提升\s*(\d+)%"
)
_STAT_ALIAS = {"射击值": "ranged", "格斗值": "melee", "觉醒值": "awaken"}
_WA_MAP = {"Physical": 1, "Beam": 2, "Special": 3}


def _parse_ability_effects(d: str) -> list[dict]:
    """从能力描述提取可应用的效果：增伤/减伤/攻击/防御百分比。"""
    effs: list[dict] = []
    m = _DMG_UP_RE.search(d)
    if m:
        effs.append({"kind": "dmg_up", "pct": int(m.group(1))})
    m = _DMG_DOWN_RE.search(d)
    if m:
        effs.append({"kind": "dmg_down", "pct": int(m.group(1))})
    m = _DEF_UP_RE.search(d)
    if m:
        effs.append({"kind": "def_pct", "pct": int(m.group(1))})
    m = _ATK_UP_RE.search(d)
    if m:
        effs.append({"kind": "atk_pct", "pct": int(m.group(1))})
    m = _DEF_STACK_RE.search(d)
    if m:
        effs.append({
            "kind": "def_stack", "pct": int(m.group(1)), "max": int(m.group(2)),
        })
    m = _HP_RECOVER_RE.search(d)
    if m:
        effs.append({
            "kind": "hp_recover", "threshold": int(m.group(1)), "pct": int(m.group(2)),
        })
    m = _CRIT_DMG_RE.search(d)
    if m:
        effs.append({"kind": "crit_dmg", "pct": int(m.group(1))})
    m = _CRIT_RATE_RE.search(d)
    if m:
        effs.append({"kind": "crit_rate", "pct": int(m.group(1))})
    m = _STAT_COMBO_RE.search(d)
    if m:
        pct = int(m.group(2))
        for name in _STAT_ALIAS:
            if name in m.group(1):
                effs.append({
                    "kind": "stat_pct", "stat": _STAT_ALIAS[name], "pct": pct,
                })
    return effs


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{config.DB_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _write_conn() -> sqlite3.Connection:
    """可写连接（编辑保存等写操作使用，WAL 模式避免读写锁）。"""
    config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(config.DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
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
        cond = t.get("active_condition") or {}
        ser_ids = [
            int(x) for x in str(cond.get("unit_series") or "").split(",")
            if x.strip().isdigit()
        ]
        s_obj = cond.get("series")
        if isinstance(s_obj, dict) and s_obj.get("id"):
            sid = int(s_obj["id"])
            if sid not in ser_ids:
                ser_ids.append(sid)
        tag_names = [
            tag_by_id[int(tid)] for tid in str(cond.get("unit_tags") or "").split(",")
            if tid.strip().isdigit() and int(tid) in tag_by_id
        ]
        combo_mode = None
        if ser_ids and tag_names:
            combo_mode = "and"
        elif len(ser_ids) >= 2 or len(tag_names) >= 2:
            combo_mode = "or"
        if combo_mode:
            key = ("combo", tuple(ser_ids), tuple(tag_names))
            if key not in seen:
                seen.add(key)
                entities.append({
                    "kind": "combo",
                    "name": "词条对象",
                    "series": ser_ids,
                    "tags": tag_names,
                    "mode": combo_mode,
                })
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


SUMMARY_TABLES = (
    "unit", "character", "supporter", "stage", "stage_map_npc",
    "stage_map_npc_character", "unit_weapon", "unit_ability",
    "character_skill", "character_ability", "story_event",
    "story_event_boss", "tower_event", "tower_stage",
)


def api_summary() -> dict:
    counts = {t: 0 for t in SUMMARY_TABLES}
    built = None
    db_ok = False
    if config.DB_PATH.exists():
        conn = None
        try:
            conn = _conn()
            for table in SUMMARY_TABLES:
                counts[table] = conn.execute(
                    f"SELECT COUNT(*) FROM {table}"
                ).fetchone()[0]
            row = conn.execute(
                "SELECT value FROM meta WHERE key='built_at'"
            ).fetchone()
            built = row[0] if row else None
            db_ok = True
        except sqlite3.Error:
            db_ok = False
        finally:
            if conn is not None:
                conn.close()
    expected = {"unit": 1210, "stage": 594}
    return {
        "counts": counts,
        "expected": expected,
        "built_at": built,
        "db_exists": config.DB_PATH.exists(),
        "db_has_data": sum(counts.values()) > 0,
        "db_size_mb": (
            round(config.DB_PATH.stat().st_size / 1048576, 1)
            if config.DB_PATH.exists() else None
        ),
        "db_ok": db_ok,
    }


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


def _counter_guard_ids(conn) -> set[int]:
    """有「反击时支援防御」类能力的驾驶员 ID（反击援防）。"""
    ids: set[int] = set()
    for cid, name, traits in conn.execute(
        "SELECT character_id, name, traits FROM character_ability"
    ):
        texts = [
            (t.get("desc") or "") for t in _json_list(traits)
            if t.get("desc")
        ]
        joined = (name or "") + "".join(texts)
        if "反击" in joined and "支援防御" in joined:
            ids.add(cid)
    return ids


def api_support_labels() -> list:
    conn = _conn()
    rows = conn.execute("SELECT support_info FROM character").fetchall()
    labels: set[str] = set()
    for (si,) in rows:
        lbl = support_label(_json_dict(si))
        if lbl:
            labels.add(lbl)
    if _counter_guard_ids(conn):
        labels.add("反击援防")
    conn.close()
    return sorted(labels)


def api_supporter_skillnames() -> list:
    conn = _conn()
    rows = conn.execute(
        "SELECT DISTINCT name FROM supporter_skill "
        "WHERE skill_type = 'active' AND name != '' ORDER BY name"
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
                           n.attack, n.defense, n.hp
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
                r["attack_bonus"] = 0
                r["defense_bonus"] = 0
                r["atk_base"] = r.get("attack") or 0
                r["def_base"] = r.get("defense") or 0
                r["atk_pct"] = 0
                r["def_pct"] = 0
                r["hp_base"] = r.get("hp") or 0
                r["hp_pct"] = 0
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
                           u.max_hp AS hp,
                           u.tags, s.name AS series_name, u.stat_bonuses
                    FROM unit u LEFT JOIN series s ON s.id = u.series_id {w}
                    ORDER BY u.rarity DESC, u.id""",
                args,
            )
            for r in items:
                r["source"] = "library"
                r["tags"] = _json_list(r.get("tags"))
                r["role_label"] = ROLE_NAMES.get(r.get("role"), "—")
                bonuses = _json_dict(r.pop("stat_bonuses", None))
                r["atk_base"] = r.get("attack") or 0
                r["def_base"] = r.get("defense") or 0
                r["atk_pct"] = bonuses.get("attack", 0)
                r["def_pct"] = bonuses.get("defense", 0)
                r["hp_base"] = r.get("hp") or 0
                r["hp_pct"] = bonuses.get("hp", 0)
                for k, bkey in (("attack", "atk_pct"), ("defense", "def_pct")):
                    v, b = star_value(r.get(k) or 0, r[f"{'atk' if k == 'attack' else 'def'}_pct"], 0)
                    r[k] = v
                    r[f"{k}_bonus"] = b
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
                r["defense_bonus"] = 0
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
                           c.tags, s.name AS series_name, c.stat_bonuses
                    FROM character c LEFT JOIN series s ON s.id = c.series_id {w}
                    ORDER BY c.rarity DESC, c.id""",
                args,
            )
            for r in items:
                r["source"] = "library"
                r["tags"] = _json_list(r.get("tags"))
                r["role_label"] = ROLE_NAMES.get(r.get("role"), "—")
                bonuses = _json_dict(r.pop("stat_bonuses", None))
                for k in ("ranged", "melee", "awaken", "defense"):
                    v, b = star_value(r.get(k) or 0, bonuses.get(k, 0), 0)
                    r[k] = v
                    if k == "defense":
                        r["defense_bonus"] = b
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


def _supporter_active_skill_where(alias: str, skills: str, skill_mode: str):
    """支援角色主动技筛选：技能名称多选（任一 / 全部）。"""
    names = [s for s in (skills or "").split(",") if s]
    if not names:
        return "", []
    if skill_mode == "all":
        clauses = [
            f"EXISTS (SELECT 1 FROM supporter_skill ss{i} "
            f"WHERE ss{i}.supporter_id = {alias}.id "
            f"AND ss{i}.skill_type = 'active' AND ss{i}.name = ?)"
            for i in range(len(names))
        ]
        return "(" + " AND ".join(clauses) + ")", names
    ph = ",".join("?" for _ in names)
    return (
        f"EXISTS (SELECT 1 FROM supporter_skill ss "
        f"WHERE ss.supporter_id = {alias}.id "
        f"AND ss.skill_type = 'active' AND ss.name IN ({ph}))",
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
    "support": "support_label",
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
    "has_unit_skill": (
        "EXISTS (SELECT 1 FROM unit_skill us WHERE us.unit_id = u.id)"
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

# 备注显示优先级：命中了更具体的选项（射程5及以上 / 不含MAP）时，隐藏笼统项
WFX_SPECIFIC_REMOVE = {
    "range5_nomap": "range5",
    "range5plus_nomap": "range5plus",
    "phys_r5": "phys",
    "beam_r5": "beam",
    "spec_r5": "spec",
    "defdown_r5": "defdown",
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
              cond: str, sort: str, order: str, limit: int, offset: int) -> dict:
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
    cond_sql, cond_args = _cond_where("u", cond)
    if cond_sql:
        where.append(cond_sql)
        args += cond_args
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
        aattr = w.get("attack_attr")
        wattr = w.get("weapon_attr")
        w["attack_attr_label"] = ATTACK_ATTR.get(aattr, "—")
        w["weapon_attr_label"] = WEAPON_ATTR.get(wattr, "—")
        w["pilot_stat"] = ATTACK_ATTR_DEP_LABEL.get(aattr, "—")
        try:
            raw_attrs = json.loads(w.get("weapon_attrs") or "[]")
            attrs = (
                [int(x) for x in raw_attrs]
                if isinstance(raw_attrs, list) else []
            )
        except (TypeError, ValueError, json.JSONDecodeError):
            attrs = []
        if not attrs and wattr:
            attrs = [wattr]
        w["attrs"] = attrs
        w["attrs_label"] = "、".join(
            WEAPON_ATTR.get(x, f"#{x}") for x in attrs
        ) or "—"
        try:
            w["effects"] = json.loads(w.get("weapon_effects") or "[]")
        except (TypeError, json.JSONDecodeError):
            w["effects"] = []
    abilities = _all(
        conn,
        "SELECT * FROM unit_ability WHERE unit_id = ? ORDER BY sort",
        (unit_id,),
    )
    skills = _all(
        conn,
        "SELECT * FROM unit_skill WHERE unit_id = ? ORDER BY sort",
        (unit_id,),
    )
    wfx_matches: list[str] = []
    for key, pred in WFX_FILTERS.items():
        sql = (
            "SELECT EXISTS (SELECT 1 FROM unit u WHERE u.id = ? "
            f"AND ({pred}))"
        )
        try:
            hit = conn.execute(sql, (unit_id,)).fetchone()[0]
        except sqlite3.Error:
            hit = 0
        if hit:
            wfx_matches.append(key)
    matched = set(wfx_matches)
    for specific, general in WFX_SPECIFIC_REMOVE.items():
        if specific in matched:
            matched.discard(general)
    wfx_matches = [k for k in wfx_matches if k in matched]
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
    u["series_names"] = _series_names(
        u.get("series_ids"), u.get("series_id"), series_by_id
    )
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
    u["skills"] = skills
    u["wfx_matches"] = wfx_matches
    return u


def _series_names(series_ids_raw, primary_id, series_by_id) -> list[dict]:
    """机体/驾驶员所属系列列表（含主系列与多系列归属，按 id 去重）。"""
    seen: set[int] = set()
    out: list[dict] = []

    def add(sid):
        if sid in seen:
            return
        seen.add(sid)
        name = series_by_id.get(sid)
        if name:
            out.append({"id": sid, "name": name})

    if primary_id:
        try:
            add(int(primary_id))
        except (TypeError, ValueError):
            pass
    for sid in _json_list(series_ids_raw):
        try:
            add(int(sid))
        except (TypeError, ValueError):
            continue
    return out


def api_weapon_effects() -> list:
    """全库武器特效去重列表（名称 + 效果文本），供编辑选择器使用。"""
    conn = _conn()
    seen: dict[str, dict] = {}
    for (we,) in conn.execute(
        "SELECT weapon_effects FROM unit_weapon "
        "WHERE weapon_effects NOT IN ('', '[]')"
    ):
        for e in _json_list(we):
            name = (e.get("name") or "").strip()
            if name and name not in seen:
                seen[name] = {
                    "name": name,
                    "desc": (e.get("desc") or "").strip(),
                }
    conn.close()
    return sorted(seen.values(), key=lambda x: x["name"])


def api_abilities() -> list:
    """全库能力去重列表（按 ability_id），供编辑选择器使用。"""
    conn = _conn()
    seen: dict[int, dict] = {}
    for aid, name, desc, atype, traits in conn.execute(
        "SELECT ability_id, name, desc, ability_type, traits "
        "FROM unit_ability WHERE ability_id IS NOT NULL "
        "ORDER BY ability_id"
    ):
        if aid not in seen:
            seen[aid] = {
                "ability_id": aid,
                "name": name or "",
                "desc": desc or "",
                "ability_type": atype,
                "traits": traits or "[]",
            }
    conn.close()
    return sorted(seen.values(), key=lambda x: x["name"])


def api_supporter_panel() -> list:
    """支援角色面板数据：各突破阶段队长技加成% + 满星攻击/HP 固定值。"""
    conn = _conn()
    out = []
    for s in conn.execute(
        "SELECT id, rarity, name, max_attack_addition_value, "
        "max_hp_addition_value FROM supporter ORDER BY rarity DESC, name"
    ):
        pct = 0
        leader_pcts = [0, 0, 0, 0]
        for row in conn.execute(
            "SELECT limit_break_step, traits FROM supporter_skill "
            "WHERE supporter_id = ? AND skill_type = 'leader' "
            "ORDER BY limit_break_step",
            (s["id"],),
        ):
            step = min(max(int(row["limit_break_step"] or 0), 0), 3)
            step_pct = 0
            for t in _json_list(row["traits"]):
                tv = (t.get("trait_content") or {}).get("trait_value") or {}
                try:
                    step_pct = max(step_pct, int(tv.get("value") or 0))
                except (TypeError, ValueError):
                    pass
            leader_pcts[step] = step_pct
            pct = max(pct, step_pct)
        # 缺失的阶段用已有值回填
        last = 0
        for i in range(4):
            if leader_pcts[i]:
                last = leader_pcts[i]
            else:
                leader_pcts[i] = last
        mstep = max(range(4), key=lambda i: leader_pcts[i])
        conds: list[str] = []
        crow = conn.execute(
            "SELECT conditions FROM supporter_skill "
            "WHERE supporter_id = ? AND skill_type = 'leader' "
            "AND limit_break_step = ? LIMIT 1",
            (s["id"], mstep),
        ).fetchone()
        if crow:
            for c in _json_list(crow["conditions"]):
                t = (c.get("text") or "").strip()
                if t and t not in conds:
                    conds.append(t)
        out.append({
            "id": s["id"],
            "rarity": s["rarity"],
            "name": s["name"],
            "leader_pct": pct,
            "leader_pcts": leader_pcts,
            "conds": conds,
            "atk_add": s["max_attack_addition_value"] or 0,
            "hp_add": s["max_hp_addition_value"] or 0,
        })
    conn.close()
    return out


_UNIT_STAT_KEYS = ("hp", "en", "attack", "defense", "mobility", "movement")
_UNIT_STAT_LABELS = {
    "hp": "HP", "en": "EN", "attack": "攻击", "defense": "防御",
    "mobility": "机动", "movement": "移动",
}
_TERRAIN_KEYS = ("space", "atmospheric", "ground", "surface", "underwater")
_TERRAIN_LABELS = {
    "space": "宇宙", "atmospheric": "大气圈", "ground": "地面",
    "surface": "水面", "underwater": "水中",
}


def _clean_int(value, field: str, minimum=0) -> int:
    try:
        v = int(value)
    except (TypeError, ValueError):
        raise ValueError(f"{field} 必须是整数") from None
    if v < minimum:
        raise ValueError(f"{field} 不能小于 {minimum}")
    return v


def api_unit_edit(payload: dict, preview: bool = True) -> dict:
    """机体编辑：校验 + 差异对比；preview=False 时写库并记录 edit_log。"""
    unit_id = _clean_int(payload.get("unit_id"), "unit_id")
    conn = _write_conn()
    row = conn.execute("SELECT * FROM unit WHERE id = ?", (unit_id,)).fetchone()
    u = dict(row) if row else None
    if not u:
        conn.close()
        return {"ok": False, "error": "机体不存在"}
    weapons = [dict(w) for w in conn.execute(
        "SELECT * FROM unit_weapon WHERE unit_id = ? ORDER BY sort",
        (unit_id,),
    ).fetchall()]
    abilities = [dict(a) for a in conn.execute(
        "SELECT * FROM unit_ability WHERE unit_id = ? ORDER BY sort",
        (unit_id,),
    ).fetchall()]
    tags_now = _json_list(u["tags"])
    is_ult = ULTIMATE_TAG in tags_now
    rarity = u["rarity"] or 5

    diff: list[dict] = []

    def add_diff(section: str, field: str, old, new) -> None:
        diff.append({
            "section": section,
            "field": field,
            "old": old,
            "new": new,
        })

    # ---- 类型 ----
    role = _clean_int(payload.get("role"), "类型")
    if role not in (1, 2, 3):
        conn.close()
        return {"ok": False, "error": "类型只能为 1=攻击型 / 2=耐久型 / 3=支援型"}
    if role != (u["role"] or 0):
        add_diff("机体", "类型",
                 ROLE_NAMES.get(u["role"], u["role"]),
                 ROLE_NAMES.get(role, role))

    # ---- 0星满级属性 ----
    max_stats = payload.get("max_stats") or {}
    stats_new: dict[str, int] = {}
    for key in _UNIT_STAT_KEYS:
        if key not in max_stats:
            conn.close()
            return {"ok": False, "error": f"缺少属性 {key}"}
        stats_new[key] = _clean_int(max_stats[key], _UNIT_STAT_LABELS[key])
    for key in _UNIT_STAT_KEYS:
        old = u.get(f"max_{key}") or 0
        if stats_new[key] != old:
            add_diff("属性", f"{_UNIT_STAT_LABELS[key]}（0星满级）", old, stats_new[key])

    # ---- SP / SSP（仅非 UR 且非终极）----
    sp_new = ssp_new = None
    if rarity < 5 and not is_ult:
        if "sp_stats" in payload:
            sp_new = {}
            for key in _UNIT_STAT_KEYS:
                if key in payload["sp_stats"]:
                    sp_new[key] = _clean_int(
                        payload["sp_stats"][key], f"SP {_UNIT_STAT_LABELS[key]}"
                    )
                    old = u.get(f"sp_max_{key}")
                    if sp_new[key] != (old or 0):
                        add_diff("属性", f"SP {_UNIT_STAT_LABELS[key]}（满级）",
                                 old or 0, sp_new[key])
        if "ssp_stats" in payload:
            ssp_new = {}
            for key in _UNIT_STAT_KEYS:
                if key in payload["ssp_stats"]:
                    ssp_new[key] = _clean_int(
                        payload["ssp_stats"][key], f"SSP {_UNIT_STAT_LABELS[key]}"
                    )
                    old = u.get(f"ssp_max_{key}")
                    if ssp_new[key] != (old or 0):
                        add_diff("属性", f"SSP {_UNIT_STAT_LABELS[key]}（满级）",
                                 old or 0, ssp_new[key])

    # ---- 地形 ----
    terrain = payload.get("terrain") or {}
    terrain_new: dict[str, int] = {}
    for key in _TERRAIN_KEYS:
        if key not in terrain:
            conn.close()
            return {"ok": False, "error": f"缺少地形 {key}"}
        v = _clean_int(terrain[key], _TERRAIN_LABELS[key])
        if v > 5:
            conn.close()
            return {"ok": False, "error": f"{_TERRAIN_LABELS[key]} 适性不能超过 5"}
        terrain_new[key] = v
    terrain_old = _json_dict(u["terrain"])
    for key in _TERRAIN_KEYS:
        if terrain_new[key] != (terrain_old.get(key) or 0):
            add_diff("地形", _TERRAIN_LABELS[key],
                     terrain_old.get(key) or 0, terrain_new[key])

    # ---- 标签 ----
    tags_new = [str(t) for t in (payload.get("tags") or []) if str(t).strip()]
    tags_new = list(dict.fromkeys(tags_new))
    if is_ult and ULTIMATE_TAG not in tags_new:
        conn.close()
        return {"ok": False, "error": "「终极」标签不可删除"}
    removed = [t for t in tags_now if t not in tags_new]
    added = [t for t in tags_new if t not in tags_now]
    if removed:
        add_diff("标签", "删除", "、".join(removed), "")
    if added:
        add_diff("标签", "添加", "", "、".join(added))

    # ---- 武器 ----
    weapon_payload = {str(w.get("weapon_id")): w for w in (payload.get("weapons") or [])}
    weapon_rows = {str(w["weapon_id"]): w for w in weapons}
    missing_w = [wid for wid in weapon_payload if wid not in weapon_rows]
    if missing_w:
        conn.close()
        return {"ok": False, "error": f"包含不存在的武器: {missing_w}"}
    weapons_new: list[dict] = []
    for wid, wrow in weapon_rows.items():
        pw = weapon_payload.get(wid)
        if not pw:
            continue
        attack_attr = _clean_int(pw.get("attack_attr"), "依赖属性", minimum=0)
        weapon_attr = _clean_int(pw.get("weapon_attr"), "伤害类型", minimum=0)
        attrs = [int(x) for x in (pw.get("weapon_attrs") or []) if str(x).isdigit()]
        attrs = list(dict.fromkeys(attrs))
        if not attrs:
            attrs = [weapon_attr] if weapon_attr else []
        if any(x not in (1, 2, 3) for x in attrs):
            conn.close()
            return {"ok": False, "error": f"多伤害集合只能包含 实弹/光束/特殊"}
        rmin = _clean_int(pw.get("range_min"), "射程下限")
        rmax = _clean_int(pw.get("range_max"), "射程上限")
        if rmin > rmax:
            conn.close()
            return {"ok": False, "error": "射程下限不能大于上限"}
        fields = {
            "attack_attr": attack_attr, "weapon_attr": weapon_attr,
            "weapon_attrs": json.dumps(attrs, ensure_ascii=False),
            "range_min": rmin, "range_max": rmax,
        }
        for base in ("power", "en", "hit", "crit"):
            lv5 = _clean_int(pw.get(f"{base}_lv5"), f"{base}_lv5")
            lv9 = None
            if pw.get(f"{base}_lv9") not in (None, ""):
                lv9 = _clean_int(pw[f"{base}_lv9"], f"{base}_lv9")
            fields[f"{base}_lv5"] = lv5
            if lv9 is not None:
                fields[f"{base}_lv9"] = lv9
            if base == "hit" and lv5 > 150:
                conn.close()
                return {"ok": False, "error": "命中不能超过 150"}
            if base == "crit" and lv5 > 100:
                conn.close()
                return {"ok": False, "error": "暴击不能超过 100"}
        effects = payload_effects = pw.get("weapon_effects") or []
        slots = []
        for i, e in enumerate(payload_effects, 1):
            slots.append({
                "slot": i,
                "name": (e.get("name") or "").strip(),
                "desc": (e.get("desc") or "").strip(),
            })
        fields["weapon_effects"] = json.dumps(slots, ensure_ascii=False)
        old_row = {k: wrow[k] for k in fields}
        old_row["weapon_attrs"] = (
            wrow["weapon_attrs"] or str([wrow["weapon_attr"]] if wrow["weapon_attr"] else [])
        )
        old_effects = _json_list(wrow["weapon_effects"])
        changed = []
        for fk, fv in fields.items():
            ov = old_row.get(fk)
            if fk == "weapon_effects":
                ov = json.dumps(old_effects, ensure_ascii=False)
            elif fk == "weapon_attrs":
                pass
            if str(ov) != str(fv):
                changed.append((fk, ov, fv))
        if changed:
            add_diff("武器", f"{wrow['name']}", "、".join(
                f"{c[0]}: {c[1]}" for c in changed
            ), "、".join(f"{c[0]}: {c[2]}" for c in changed))
        weapons_new.append({"weapon_id": wid, **fields})

    # ---- 能力 ----
    abilities_new = payload.get("abilities") or []
    seen_aids = set()
    for a in abilities_new:
        aid = _clean_int(a.get("ability_id"), "能力", minimum=0)
        if aid in seen_aids:
            conn.close()
            return {"ok": False, "error": f"能力重复: {aid}"}
        seen_aids.add(aid)
    old_aids = [a["ability_id"] for a in abilities]
    new_aids = [int(a["ability_id"]) for a in abilities_new]
    if set(old_aids) != set(new_aids):
        add_diff("能力", "列表",
                 f"{len(old_aids)} 个（{'、'.join(map(str, old_aids))}）",
                 f"{len(new_aids)} 个（{'、'.join(map(str, new_aids))}）")

    if preview:
        conn.close()
        return {"ok": True, "diff": diff, "changed": len(diff) > 0}

    # ---- 写库 ----
    try:
        conn.execute(
            "UPDATE unit SET role=?, max_hp=?, max_en=?, max_attack=?, "
            "max_defense=?, max_mobility=?, max_movement=?, terrain=?, tags=? "
            "WHERE id=?",
            (role, stats_new["hp"], stats_new["en"], stats_new["attack"],
             stats_new["defense"], stats_new["mobility"], stats_new["movement"],
             json.dumps(terrain_new, ensure_ascii=False),
             json.dumps(tags_new, ensure_ascii=False), unit_id),
        )
        if sp_new:
            conn.execute(
                "UPDATE unit SET sp_max_hp=?, sp_max_en=?, sp_max_attack=?, "
                "sp_max_defense=?, sp_max_mobility=?, sp_max_movement=? WHERE id=?",
                (sp_new["hp"], sp_new["en"], sp_new["attack"],
                 sp_new["defense"], sp_new["mobility"], sp_new["movement"],
                 unit_id),
            )
        if ssp_new:
            conn.execute(
                "UPDATE unit SET ssp_max_hp=?, ssp_max_en=?, ssp_max_attack=?, "
                "ssp_max_defense=?, ssp_max_mobility=?, ssp_max_movement=? WHERE id=?",
                (ssp_new["hp"], ssp_new["en"], ssp_new["attack"],
                 ssp_new["defense"], ssp_new["mobility"], ssp_new["movement"],
                 unit_id),
            )
        for w in weapons_new:
            conn.execute(
                "UPDATE unit_weapon SET attack_attr=?, weapon_attr=?, "
                "weapon_attrs=?, range_min=?, range_max=?, power_lv5=?, en_lv5=?, "
                "hit_lv5=?, crit_lv5=?, power_lv9=?, en_lv9=?, hit_lv9=?, "
                "crit_lv9=?, weapon_effects=? WHERE weapon_id=?",
                (w["attack_attr"], w["weapon_attr"], w["weapon_attrs"],
                 w["range_min"], w["range_max"], w["power_lv5"], w["en_lv5"],
                 w["hit_lv5"], w["crit_lv5"], w.get("power_lv9"), w.get("en_lv9"),
                 w.get("hit_lv9"), w.get("crit_lv9"), w["weapon_effects"],
                 w["weapon_id"]),
            )
        conn.execute("DELETE FROM unit_ability WHERE unit_id = ?", (unit_id,))
        for i, a in enumerate(abilities_new):
            traits_raw = a.get("traits") or []
            if isinstance(traits_raw, str):
                try:
                    traits_raw = json.loads(traits_raw or "[]")
                except json.JSONDecodeError:
                    traits_raw = []
            conn.execute(
                "INSERT INTO unit_ability (unit_id, ability_id, sort, name, "
                "desc, ability_type, traits) VALUES (?,?,?,?,?,?,?)",
                (unit_id, a["ability_id"], i + 1, a.get("name") or "",
                 a.get("desc") or "", a.get("ability_type"),
                 json.dumps(traits_raw, ensure_ascii=False)),
            )
        now = time.strftime("%Y-%m-%d %H:%M:%S")
        for item in diff:
            conn.execute(
                "INSERT INTO unit_edit_log (unit_id, field, old_value, "
                "new_value, edited_at, source) VALUES (?,?,?,?,?,?)",
                (unit_id, f"{item['section']}·{item['field']}",
                 str(item["old"]), str(item["new"]), now, "web"),
            )
        conn.commit()
    except sqlite3.Error as exc:
        conn.rollback()
        conn.close()
        return {"ok": False, "error": f"写入失败: {exc}"}
    conn.close()
    return {"ok": True, "diff": diff, "message": "已保存到本地"}


def api_characters(q: str, rarity: str, series: str, type_: str,
                   tags: str, tag_mode: str, match: str, skills: str, skill_mode: str,
                   support: str, sort: str, order: str,
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
    counter_guard = _counter_guard_ids(conn)
    rows = _all(
        conn,
        f"""SELECT c.id, c.rarity, c.name, s.name AS series_name,
                   c.role, c.ranged, c.melee, c.defense, c.reaction, c.awaken,
                   max_ranged, max_melee, max_defense, max_reaction, max_awaken,
                   c.stat_bonuses, c.support_info
            FROM character c LEFT JOIN series s ON s.id = c.series_id
            {w} ORDER BY c.id""",
        args,
    )
    conn.close()
    for r in rows:
        r["role_label"] = ROLE_NAMES.get(r.get("role"), "—")
        lbl = support_label(_json_dict(r.get("support_info")))
        if r["id"] in counter_guard:
            lbl = "反击援防"
        r["support_label"] = lbl
        bonuses = _json_dict(r.get("stat_bonuses"))
        for key in ("ranged", "melee", "defense", "reaction", "awaken"):
            r[f"{key}_f"] = star_value(
                r.get(f"max_{key}") or 0, bonuses.get(key, 0), 0
            )[0]
    if support:
        rows = [r for r in rows if r["support_label"] == support]
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
    c["series_names"] = _series_names(
        c.get("series_ids"), c.get("series_id"), series_by_id
    )
    c["support_label"] = support_label(_json_dict(c.get("support_info")))
    bonuses = _json_dict(c.get("stat_bonuses"))
    conditionals = _json_list(c.get("conditional_bonuses"))
    c["forms"], c["conditional_bonuses"], c["level_cap"], c["has_sp"] = (
        _apply_char_forms(c, bonuses, conditionals)
    )
    c["stat_bonuses"] = bonuses
    c["skills"] = skills
    c["abilities"] = abilities
    return c


def _cond_mode(series_ids: list[int], tags: list[str]) -> str:
    """一个条件分支内的组合语义：系列+标签=交集；多个系列/标签=并集。"""
    if series_ids and tags:
        return "and"
    if len(series_ids) >= 2 or len(tags) >= 2:
        return "or"
    return "single"


def _parse_id_list(raw) -> list[int]:
    """兼容 JSON 数组（[2300]）与逗号字符串（"2300,2400"）两种形式。"""
    if isinstance(raw, list):
        return [int(x) for x in raw if str(x).strip().isdigit()]
    return [
        int(x) for x in str(raw or "").split(",")
        if x.strip().isdigit()
    ]


def _cond_groups_from_conditions(conditions: list[dict], tag_by_id: dict,
                                 series_by_id: dict) -> list[dict]:
    """把支援角色队长技能的条件列表整理为“分支组”，保留并集/交集语义。

    每个 condition 记录代表一个可加成分支；多个分支之间取并集（任一满足）。
    """
    seen: set[tuple] = set()
    groups: list[dict] = []
    for c in conditions:
        series_ids = _parse_id_list(c.get("series_ids"))
        tags = [t for t in (c.get("tags") or []) if t]
        key = (tuple(sorted(series_ids)), tuple(sorted(tags)))
        if key in seen:
            continue
        seen.add(key)
        mode = _cond_mode(series_ids, tags)
        text = (c.get("text") or "").strip()
        if not text:
            parts = []
            if series_ids:
                parts.append("系列：" + "、".join(
                    series_by_id.get(s, f"#{s}") for s in series_ids
                ))
            if tags:
                parts.append("标签：" + "、".join(tags))
            text = "同组 · " + " · ".join(parts)
        groups.append({
            "text": text,
            "mode": mode,
            "series": [
                {"id": s, "name": series_by_id.get(s, f"系列{s}")}
                for s in series_ids
            ],
            "tags": tags,
        })
    return groups


def _cond_where(alias: str, cond_raw: str):
    """词条对象分支筛选：多个分支取并集，分支内系列/标签取交集。

    分支格式: {"series": [id...], "tags": [名称...], "tag_mode": "any"|"all"}
    """
    try:
        branches = json.loads(cond_raw or "[]")
    except (TypeError, json.JSONDecodeError):
        return "", []
    if not isinstance(branches, list) or not branches:
        return "", []
    ors: list[str] = []
    args: list = []
    for br in branches:
        if not isinstance(br, dict):
            continue
        parts: list[str] = []
        series = [s for s in (br.get("series") or []) if str(s).strip()]
        if series:
            ph = ",".join("?" for _ in series)
            parts.append(
                f"EXISTS (SELECT 1 FROM json_each({alias}.series_ids) je "
                f"WHERE je.value IN ({ph}))"
            )
            args += [int(s) for s in series]
        tags = [t for t in (br.get("tags") or []) if str(t).strip()]
        if tags:
            if br.get("tag_mode") == "all":
                clauses = [
                    f"EXISTS (SELECT 1 FROM json_each({alias}.tags) je{i} "
                    f"WHERE je{i}.value = ?)"
                    for i in range(len(tags))
                ]
                parts.append("(" + " AND ".join(clauses) + ")")
                args += tags
            else:
                ph = ",".join("?" for _ in tags)
                parts.append(
                    f"EXISTS (SELECT 1 FROM json_each({alias}.tags) je "
                    f"WHERE je.value IN ({ph}))"
                )
                args += tags
        if parts:
            ors.append("(" + " AND ".join(parts) + ")")
    if not ors:
        return "", []
    return "(" + " OR ".join(ors) + ")", args


SUPPORTER_SORT_KEYS = {
    "name": "name",
    "rarity": "rarity",
    "conds": "cond_key",
    "skill": "active_skill",
    "hp": "hp",
    "atk": "atk",
    "route": "route",
}


def api_supporters(q: str, tags: str, tag_mode: str, skills: str, skill_mode: str,
                   sort: str, order: str, limit: int, offset: int) -> dict:
    conn = _conn()
    tag_by_id = {r[0]: r[1] for r in conn.execute("SELECT id, name FROM tag")}
    series_by_id = {r[0]: r[1] for r in conn.execute("SELECT id, name FROM series")}
    where, args = [], []
    if q:
        where.append("(s.name LIKE ? OR s.tags LIKE ?)")
        args += [f"%{q}%", f"%{q}%"]
    tag_sql, tag_args = _tag_where("s", tags, tag_mode)
    if tag_sql:
        where.append(tag_sql)
        args += tag_args
    skill_sql, skill_args = _supporter_active_skill_where("s", skills, skill_mode)
    if skill_sql:
        where.append(skill_sql)
        args += skill_args
    w = ("WHERE " + " AND ".join(where)) if where else ""
    rows = _all(
        conn,
        f"""SELECT s.id, s.rarity, s.name, s.tags,
                  s.max_hp_addition_value, s.max_attack_addition_value,
                  s.acquisition_route
           FROM supporter s {w} ORDER BY s.id""",
        args,
    )
    for r in rows:
        try:
            r["tags"] = json.loads(r.get("tags") or "[]")
        except (TypeError, json.JSONDecodeError):
            r["tags"] = []
    leader_traits: dict[int, list[str]] = {}
    for sid, traits in conn.execute(
        "SELECT supporter_id, traits FROM supporter_skill "
        "WHERE skill_type = 'leader' ORDER BY limit_break_step"
    ):
        leader_traits.setdefault(sid, []).append(traits or "")
    active_skills: dict[int, list[str]] = {}
    for sid, name in conn.execute(
        "SELECT supporter_id, name FROM supporter_skill "
        "WHERE skill_type = 'active' AND name != ''"
    ):
        if name not in active_skills.setdefault(sid, []):
            active_skills[sid].append(name)
    conn.close()

    def cond_groups_for(sid: int) -> list[dict]:
        all_branches: list[list[dict]] = []
        for traits in leader_traits.get(sid, []):
            all_branches.append(
                _leader_branches(traits, tag_by_id, series_by_id)
            )
        return _flatten_cond_groups(all_branches)

    for r in rows:
        r["condition_tags"] = cond_groups_for(r["id"])
        r["active_skill"] = "、".join(active_skills.get(r["id"], []))
        r["hp"] = r.get("max_hp_addition_value") or 0
        r["atk"] = r.get("max_attack_addition_value") or 0
        r["route"] = r.get("acquisition_route") or 0
        r["cond_key"] = (
            len(r["condition_tags"]),
            " ".join(c["text"] for c in r["condition_tags"]),
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
    tag_by_id = {r[0]: r[1] for r in conn.execute("SELECT id, name FROM tag")}
    series_by_id = {r[0]: r[1] for r in conn.execute("SELECT id, name FROM series")}
    skills = _all(
        conn,
        "SELECT * FROM supporter_skill WHERE supporter_id = ? ORDER BY limit_break_step, skill_type",
        (sup_id,),
    )
    conn.close()
    s["tags"] = _json_list(s.get("tags"))
    active: dict[str, dict] = {}
    leader: dict[int, dict] = {}
    for sk in skills:
        if (sk.get("skill_type") or "") == "active":
            name = (sk.get("name") or "").strip() or "主动技能"
            active.setdefault(name, {
                "name": name,
                "desc": sk.get("desc") or "",
                "range_type": sk.get("range_type"),
                "effect_range": sk.get("effect_range"),
                "is_auto_usage": sk.get("is_auto_usage"),
            })
        else:
            step = sk.get("limit_break_step") or 0
            branches = _leader_branches(
                sk.get("traits"), tag_by_id, series_by_id
            )
            prev = leader.get(step)
            if prev is None:
                leader[step] = {
                    "step": step,
                    "desc": sk.get("desc") or "",
                    "branches": branches,
                }
            else:
                prev["branches"].extend(branches)
    s["active_skills"] = list(active.values())
    s["leader_skills"] = [leader[k] for k in sorted(leader)]
    s["cond_groups"] = _flatten_cond_groups(
        [ls["branches"] for ls in leader.values()]
    )
    s["condition_tags"] = s["cond_groups"]
    return s


def _leader_branches(traits_raw: str, tag_by_id: dict,
                     series_by_id: dict) -> list[dict]:
    """解析队长技能 traits → 各加成分支（效果描述 + 词条对象子分支）。

    一个 trait 内的 trait_condition 按 group_id 分组：
      - 共享同一非空 group_id 的多条条件 = 或（并集，各自是子分支）；
      - group_id 为空 = 且（交集，合并维度）；
      - 单条条件内的多个系列/多个标签 = 或（任一）。
    分支结果含 subs（子分支列表），词条对象由 subs 展平得到。
    """
    out: list[dict] = []
    for t in _json_list(traits_raw):
        entries = [
            c for c in (t.get("trait_condition") or [])
            if isinstance(c, dict)
        ]
        if not entries:
            continue
        groups: dict[str, list[tuple[list[int], list[str]]]] = {}
        for idx, c in enumerate(entries):
            g = (c.get("group_id") or "").strip()
            key = g if g else f"__and_{idx}"
            series_ids = _parse_id_list(c.get("unit_series"))
            tag_ids = [
                int(x) for x in str(c.get("unit_tags") or "").split(",")
                if x.strip().isdigit()
            ]
            tags = sorted({tag_by_id[tid] for tid in tag_ids if tid in tag_by_id})
            groups.setdefault(key, []).append((series_ids, tags))
        # 组间取且（交集），组内取或（并集）
        subs: list[tuple[set[int], set[str]]] = [(set(), set())]
        for items in groups.values():
            new_subs: list[tuple[set[int], set[str]]] = []
            for sids, tags in items:
                for a, b in subs:
                    merged = (a | set(sids), b | set(tags))
                    if merged not in new_subs:
                        new_subs.append(merged)
            subs = new_subs
        sub_list: list[dict] = []
        for sids, tags in subs:
            sids_sorted = sorted(sids)
            tags_sorted = sorted(tags)
            parts = []
            if sids_sorted:
                parts.append("系列：" + "、".join(
                    series_by_id.get(x, f"#{x}") for x in sids_sorted
                ))
            if tags_sorted:
                parts.append("标签：" + "、".join(tags_sorted))
            sub_list.append({
                "text": "同组 · " + " · ".join(parts),
                "mode": _cond_mode(sids_sorted, tags_sorted),
                "series": [
                    {"id": x, "name": series_by_id.get(x, f"系列{x}")}
                    for x in sids_sorted
                ],
                "tags": tags_sorted,
            })
        branch: dict = {"desc": (t.get("desc") or "").strip(), "subs": sub_list}
        if len(sub_list) == 1:
            branch["text"] = sub_list[0]["text"]
            branch["mode"] = sub_list[0]["mode"]
            branch["series"] = sub_list[0]["series"]
            branch["tags"] = sub_list[0]["tags"]
        out.append(branch)
    return out


def _flatten_cond_groups(branches_list: list[list[dict]]) -> list[dict]:
    """把各分支的 subs 展平成词条对象列表（去重）。"""
    seen: set[tuple] = set()
    groups: list[dict] = []
    for branches in branches_list:
        for br in branches:
            subs = br.get("subs") or [{
                "text": br.get("text"),
                "mode": br.get("mode"),
                "series": br.get("series") or [],
                "tags": br.get("tags") or [],
            }]
            for s in subs:
                key = (tuple(x["id"] for x in s["series"]), tuple(s["tags"]))
                if key in seen:
                    continue
                seen.add(key)
                groups.append(s)
    return groups


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


def _defensive_correction(q: dict) -> float:
    """防御修正：无防御 1.0 / 防御·无盾 0.8 / 防御·有盾 0.6（兼容旧 shield 参数）。"""
    st = q.get("defend_state", [""])[0]
    if st == "defend":
        return 0.8
    if st == "defend_shield":
        return 0.6
    if q.get("shield", ["0"])[0] == "1":
        return 0.8
    return 1.0


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
        defensive_correction=_defensive_correction(q),
        attacker_vigor=q.get("vigor", ["normal"])[0],
        critical=q.get("critical", ["0"])[0] == "1",
        attacker_damage_dealt_percent=[f("buff", 0.0)],
        defender_damage_taken_percent=[f("debuff", 0.0)],
    )
    steps = calculate_damage(attacker, defender, ctx)
    return {"params": {"attacker": attacker.__dict__, "defender": defender.__dict__,
                       "context": {k: v for k, v in ctx.__dict__.items()
                                   if not isinstance(v, list)}},
            "steps": [[k, v] for k, v in steps.items()]}


def api_damage_sim(q: dict) -> dict:
    """多次攻击模拟：逐次计算伤害，随攻击叠防御、HP 低于阈值恢复，直到 HP 归零。"""
    def f(name, default=0.0):
        try:
            return float(q.get(name, [str(default)])[0])
        except (TypeError, ValueError):
            return default

    dhp = f("dhp", 0)
    if dhp <= 0:
        return {"hits": [], "error": "请先选择防御方机体以获取 HP"}
    aua = f("aua")
    aca = f("aca")
    dud = f("dud")
    dcd = f("dcd")
    wp = f("wp", 1000)
    terrain = f("terrain", 1.0)
    vigor = q.get("vigor", ["normal"])[0]
    buff = f("buff")
    debuff = f("debuff")
    crit = q.get("critical", ["0"])[0] == "1"
    defensive_correction = _defensive_correction(q)
    crit_damage_bonus = f("crit_damage_bonus")
    def_stack_pct = f("def_stack_pct")
    def_stack_max = f("def_stack_max")
    hp_recover_pct = f("hp_recover_pct")
    hp_recover_threshold = f("hp_recover_threshold")

    base_dud = dud
    hp = dhp
    max_hp = dhp
    hits = []
    recovered = False
    n = 0
    while hp > 0 and n < 300:
        n += 1
        attacker = CombatantStats(unit_attack=aua, character_attack=aca)
        defender = CombatantStats(unit_defense=dud, character_defense=dcd)
        ctx = DamageContext(
            weapon_power=wp,
            terrain_correction=terrain,
            defensive_correction=defensive_correction,
            attacker_vigor=vigor,
            critical=crit,
            critical_correction_percent=(
                CRITICAL_CORRECTION.get(vigor, 0) + crit_damage_bonus
            ) if crit else None,
            attacker_damage_dealt_percent=[buff],
            defender_damage_taken_percent=[debuff],
        )
        dmg = calculate_damage(attacker, defender, ctx)["final_damage"]
        hp = max(0.0, hp - dmg)
        recover_now = False
        if (
            not recovered and hp > 0 and hp_recover_pct and hp_recover_threshold
            and max_hp > 0 and hp / max_hp * 100 <= hp_recover_threshold
        ):
            hp = min(max_hp, hp + max_hp * hp_recover_pct / 100)
            recovered = True
            recover_now = True
        hits.append({
            "n": n,
            "defense": int(round(dud)),
            "damage": int(dmg),
            "hp": int(round(hp)),
            "hp_pct": round(hp / max_hp * 1000) / 10 if max_hp > 0 else 0,
            "recovered": recover_now,
        })
        if def_stack_pct and def_stack_max:
            stacks = min(n, int(def_stack_max // def_stack_pct))
            dud = base_dud * (1 + stacks * def_stack_pct / 100)
    return {"hits": hits}


def _cond_met(cond: dict, own_unit, enemy_unit, weapon_attrs,
              tag_by_id: dict, ignore_unknown: bool = False) -> bool:
    """评估能力条件的类型/标签/系列/武器属性是否满足。"""
    if not cond:
        return True
    target = cond.get("target") or "Owner"
    unit = enemy_unit if target in ("Enemy", "AttackTarget") else own_unit
    role = cond.get("unit_role")
    if role and str(role).isdigit():
        if not unit or int(role) != (unit.get("role") or 0):
            return False
    tag_ids = [int(t) for t in str(cond.get("unit_tags") or "").split(",") if t.strip().isdigit()]
    if tag_ids:
        if not unit:
            return False
        names = {tag_by_id.get(i) for i in tag_ids}
        names.discard(None)
        if names and not names <= set(unit.get("tags") or []):
            return False
    series = [int(s) for s in str(cond.get("unit_series") or "").split(",") if s.strip().isdigit()]
    if series:
        if not unit or not (set(series) & set(unit.get("series_ids") or [])):
            return False
    uids = [int(x) for x in str(cond.get("unit_ids") or "").split(",") if x.strip().isdigit()]
    if uids:
        if not unit or unit.get("id") not in uids:
            return False
    wa = cond.get("weapon_attribute")
    if wa:
        want = _WA_MAP.get(wa)
        # 多伤害集合：武器任一伤害属性与条件匹配即命中
        if want is None or not weapon_attrs or want not in weapon_attrs:
            return False
    # 其他无法静态判断的条件（HP阈值/战意/回合/距离等）视为未满足
    unknown = [
        "hp_type", "hp_rate_lte_threshold", "hp_rate_gte_threshold",
        "en_rate_lte_threshold", "en_rate_gte_threshold",
        "en_value_lte_threshold", "en_value_gte_threshold",
        "tension", "turn_number", "is_in_one_on_one",
        "attack_distance_gte_threshold", "attack_distance_lte_threshold",
        "is_in_chance_step",
    ]
    if not ignore_unknown and any(
        cond.get(k) not in (None, "", 0, False) for k in unknown
    ):
        return False
    return True


def api_damage_bonus(atk_uid, atk_usrc, atk_pid, atk_psrc,
                     def_uid, def_usrc, def_pid, def_psrc,
                     weapon_attr, attack_attr, attr_nullify,
                     atk_u_on, atk_p_on, def_u_on, def_p_on,
                     atk_star, def_star,
                     atk_unit_skill, def_unit_skill,
                     atk_ship, atk_support, atk_op, atk_fixed,
                     def_ship, def_support, def_op, def_fixed,
                     atk_skill_ranged, atk_skill_melee, atk_skill_awaken) -> dict:
    """根据已选机体/驾驶员/武器 + 能力开关，计算加成与数值。"""
    conn = _conn()
    tag_by_id = {r[0]: r[1] for r in conn.execute("SELECT id, name FROM tag")}
    series_by_id = {r[0]: r[1] for r in conn.execute("SELECT id, name FROM series")}
    unit_by_id = {r[0]: r[1] for r in conn.execute("SELECT id, name FROM unit")}

    def load_unit(uid, src):
        if not uid or src != "library":
            return None
        row = conn.execute(
            "SELECT id, role, tags, series_ids, stat_bonuses, "
            "max_attack, max_defense, max_hp FROM unit WHERE id=?", (uid,),
        ).fetchone()
        if not row:
            return None
        return {
            "id": row["id"], "role": row["role"],
            "tags": _json_list(row["tags"]),
            "series_ids": _json_list(row["series_ids"]),
            "bonuses": _json_dict(row["stat_bonuses"]),
            "max_attack": row["max_attack"] or 0,
            "max_defense": row["max_defense"] or 0,
            "max_hp": row["max_hp"] or 0,
        }

    def load_char(cid, src):
        if not cid or src != "library":
            return None
        row = conn.execute(
            "SELECT id, stat_bonuses, max_ranged, max_melee, max_awaken, max_defense "
            "FROM character WHERE id=?", (cid,),
        ).fetchone()
        if not row:
            return None
        return {
            "id": row["id"],
            "bonuses": _json_dict(row["stat_bonuses"]),
            "stats": {
                "ranged": row["max_ranged"] or 0,
                "melee": row["max_melee"] or 0,
                "awaken": row["max_awaken"] or 0,
                "defense": row["max_defense"] or 0,
            },
        }

    atk_unit = load_unit(atk_uid, atk_usrc)
    def_unit = load_unit(def_uid, def_usrc)
    atk_pilot = load_char(atk_pid, atk_psrc)
    def_pilot = load_char(def_pid, def_psrc)
    weapon_attrs = {
        int(x) for x in str(weapon_attr or "").split(",")
        if x.strip().isdigit()
    }
    attack_attr_i = int(attack_attr) if str(attack_attr).isdigit() else None
    nullify = attr_nullify == "1"
    atk_star_i = int(atk_star) if str(atk_star).isdigit() else 0
    def_star_i = int(def_star) if str(def_star).isdigit() else 0
    on = {
        "atk_u": set((atk_u_on or "").split(",")) if atk_u_on else set(),
        "atk_p": set((atk_p_on or "").split(",")) if atk_p_on else set(),
        "def_u": set((def_u_on or "").split(",")) if def_u_on else set(),
        "def_p": set((def_p_on or "").split(",")) if def_p_on else set(),
    }

    def ability_rows(table, owner_id, owner, own_unit, enemy_unit):
        if not owner:
            return [], 0, 0
        rows = conn.execute(
            f"SELECT id, name, traits FROM {table} WHERE {owner_id} = ?",
            (owner["id"],),
        )
        out = []
        auto_up = 0
        auto_down = 0
        for rid, rname, traits in rows:
            for t in _json_list(traits):
                effs = _parse_ability_effects(t.get("desc") or "")
                if not effs:
                    continue
                cond = t.get("active_condition") or {}
                has_cond = any(
                    cond.get(k) not in (None, "", 0, False)
                    for k in (
                        "unit_role", "unit_tags", "unit_series", "weapon_attribute",
                        "map_battle_action", "hp_type", "tension", "turn_number",
                        "hp_rate_lte_threshold", "hp_rate_gte_threshold",
                    )
                )
                if not has_cond:
                    auto_up += sum(e["pct"] for e in effs if e["kind"] == "dmg_up")
                    auto_down += sum(e["pct"] for e in effs if e["kind"] == "dmg_down")
                    effs = [e for e in effs if e["kind"] in ("def_stack", "hp_recover")]
                    if not effs:
                        continue
                is_special = any(
                    e["kind"] in ("hp_recover", "def_stack") for e in effs
                )
                met = _cond_met(
                    cond, own_unit, enemy_unit, weapon_attrs, tag_by_id,
                    ignore_unknown=is_special,
                )
                if cond.get("weapon_attribute") and nullify:
                    met = False
                desc, _ = resolve_trait_text(
                    t.get("desc") or "", cond, tag_by_id, series_by_id, unit_by_id
                )
                out.append({
                    "row_id": f"{table}:{rid}:{t.get('id')}",
                    "name": rname or "",
                    "effects": effs,
                    "met": met,
                    "desc": desc.strip().replace("\n", " "),
                })
        return out, auto_up, auto_down

    atk_unit_ab, auto_u_up, _ = ability_rows("unit_ability", "unit_id", atk_unit, atk_unit, def_unit)
    atk_pilot_ab, auto_p_up, _ = ability_rows("character_ability", "character_id", atk_pilot, atk_unit, def_unit)
    def_unit_ab, _, auto_u_down = ability_rows("unit_ability", "unit_id", def_unit, def_unit, atk_unit)
    def_pilot_ab, _, auto_p_down = ability_rows("character_ability", "character_id", def_pilot, def_unit, atk_unit)
    conn.close()

    def sum_kind(rows, onset, kind):
        return sum(
            e["pct"]
            for r in rows if r["row_id"] in onset
            for e in r["effects"] if e["kind"] == kind
        )

    def sum_stat(rows, onset, stat):
        return sum(
            e["pct"]
            for r in rows if r["row_id"] in onset
            for e in r["effects"]
            if e["kind"] == "stat_pct" and e.get("stat") == stat
        )

    atk_damage = (
        auto_u_up + auto_p_up +
        sum_kind(atk_pilot_ab, on["atk_p"], "dmg_up")
        + sum_kind(atk_unit_ab, on["atk_u"], "dmg_up")
    )
    def_taken = (
        auto_u_down + auto_p_down +
        sum_kind(def_pilot_ab, on["def_p"], "dmg_down")
        + sum_kind(def_unit_ab, on["def_u"], "dmg_down")
    )
    atk_unit_extra = sum_kind(atk_unit_ab, on["atk_u"], "atk_pct")
    def_unit_extra = sum_kind(def_unit_ab, on["def_u"], "def_pct")
    def_pilot_extra = sum_kind(def_pilot_ab, on["def_p"], "def_pct")
    try:
        atk_us_pct = float(atk_unit_skill or 0)
    except (TypeError, ValueError):
        atk_us_pct = 0
    try:
        def_us_pct = float(def_unit_skill or 0)
    except (TypeError, ValueError):
        def_us_pct = 0
    try:
        atk_ship_pct = float(atk_ship or 0)
    except (TypeError, ValueError):
        atk_ship_pct = 0
    try:
        atk_support_pct = float(atk_support or 0)
    except (TypeError, ValueError):
        atk_support_pct = 0
    try:
        atk_op_pct = float(atk_op or 0)
    except (TypeError, ValueError):
        atk_op_pct = 0
    try:
        def_ship_pct = float(def_ship or 0)
    except (TypeError, ValueError):
        def_ship_pct = 0
    try:
        def_support_pct = float(def_support or 0)
    except (TypeError, ValueError):
        def_support_pct = 0
    try:
        def_op_pct = float(def_op or 0)
    except (TypeError, ValueError):
        def_op_pct = 0
    try:
        atk_fixed_v = int(atk_fixed or 0)
    except (TypeError, ValueError):
        atk_fixed_v = 0
    try:
        def_fixed_v = int(def_fixed or 0)
    except (TypeError, ValueError):
        def_fixed_v = 0

    atk_unit_attack = None
    if atk_unit:
        atk_unit_attack = star_value(
            atk_unit["max_attack"],
            atk_unit["bonuses"].get("attack", 0) + atk_unit_extra
            + atk_us_pct + atk_ship_pct + atk_support_pct + atk_op_pct,
            atk_star_i,
        )[0] + atk_fixed_v
    def_unit_defense = None
    if def_unit:
        def_unit_defense = star_value(
            def_unit["max_defense"],
            def_unit["bonuses"].get("defense", 0) + def_unit_extra
            + def_us_pct + def_ship_pct + def_support_pct + def_op_pct,
            def_star_i,
        )[0] + def_fixed_v
    def_unit_hp = None
    if def_unit:
        def_unit_hp = star_value(
            def_unit["max_hp"],
            def_unit["bonuses"].get("hp", 0),
            def_star_i,
        )[0]
    atk_pilot_attack = None
    if atk_pilot and attack_attr_i in ATTACK_ATTR_STATS:
        skill_pcts = {
            "ranged": atk_skill_ranged, "melee": atk_skill_melee, "awaken": atk_skill_awaken,
        }
        candidates = []
        for key in ATTACK_ATTR_STATS[attack_attr_i]:
            if key not in atk_pilot["stats"]:
                continue
            try:
                skill_pct = float(skill_pcts.get(key, 0) or 0)
            except (TypeError, ValueError):
                skill_pct = 0
            ability_pct = sum_stat(atk_pilot_ab, on["atk_p"], key)
            candidates.append(star_value(
                atk_pilot["stats"][key],
                atk_pilot["bonuses"].get(key, 0) + ability_pct + skill_pct,
                0,
            )[0])
        if candidates:
            atk_pilot_attack = max(candidates)
    def_pilot_defense = None
    if def_pilot:
        def_pilot_defense = star_value(
            def_pilot["stats"]["defense"],
            def_pilot["bonuses"].get("defense", 0) + def_pilot_extra,
            0,
        )[0]

    return {
        "atk_unit_attack": atk_unit_attack,
        "atk_pilot_attack": atk_pilot_attack,
        "def_unit_defense": def_unit_defense,
        "def_unit_hp": def_unit_hp,
        "def_pilot_defense": def_pilot_defense,
        "attacker_damage_bonus": atk_damage,
        "defender_damage_taken": def_taken,
        "abilities": {
            "atk_unit": atk_unit_ab,
            "atk_pilot": atk_pilot_ab,
            "def_unit": def_unit_ab,
            "def_pilot": def_pilot_ab,
        },
    }


def _validate_sqlite_db(path: Path) -> bool:
    """校验上传文件是否为可用的 SQLite 资料库备份。"""
    try:
        with path.open("rb") as f:
            if f.read(16) != b"SQLite format 3\x00":
                return False
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            tables = {
                r[0] for r in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
        finally:
            conn.close()
        return {"unit", "character", "supporter", "stage"}.issubset(tables)
    except (sqlite3.Error, OSError):
        return False


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

    def _send_file_download(self, path: Path, filename: str):
        size = path.stat().st_size
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(size))
        self.send_header(
            "Content-Disposition", f'attachment; filename="{filename}"'
        )
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        with path.open("rb") as f:
            while True:
                chunk = f.read(1 << 20)
                if not chunk:
                    break
                self.wfile.write(chunk)

    def _read_upload(self, max_bytes: int) -> Path | None:
        """把上传内容流式写入临时文件；失败返回 None。"""
        try:
            content_length = int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            return None
        if content_length <= 0 or content_length > max_bytes:
            return None
        tmp = config.DB_PATH.with_name(config.DB_PATH.name + ".import.tmp")
        tmp.parent.mkdir(parents=True, exist_ok=True)
        remaining = content_length
        try:
            with tmp.open("wb") as out:
                while remaining > 0:
                    chunk = self.rfile.read(min(1 << 20, remaining))
                    if not chunk:
                        break
                    out.write(chunk)
                    remaining -= len(chunk)
        except OSError:
            tmp.unlink(missing_ok=True)
            return None
        if remaining > 0:
            tmp.unlink(missing_ok=True)
            return None
        return tmp

    @staticmethod
    def _cleanup_import_files(tmp: Path):
        for p in (tmp, Path(str(tmp) + "-shm"), Path(str(tmp) + "-wal")):
            try:
                p.unlink(missing_ok=True)
            except OSError:
                pass

    def _handle_api(self, path: str, q: dict):
        if path == "/api/summary":
            return self._send_json(api_summary())
        if path == "/api/crawl-status":
            return self._send_json(crawl_status())
        if path == "/api/crawl-edits":
            return self._send_json(api_crawl_edits())
        if path == "/api/sync-diff":
            return self._send_json(cloud_diff())
        if path == "/api/sync-status":
            return self._send_json(sync_status())
        if path == "/api/weapon-effects":
            return self._send_json(api_weapon_effects())
        if path == "/api/abilities":
            return self._send_json(api_abilities())
        if path == "/api/supporter-panel":
            return self._send_json(api_supporter_panel())
        if path == "/api/unit-sync-diff":
            try:
                uid = int(q.get("unit_id", ["0"])[0])
            except ValueError:
                uid = 0
            return self._send_json(unit_sync_diff(uid))
        if path == "/api/export":
            if not config.DB_PATH.exists():
                return self._send_json({"error": "数据库不存在"}, 404)
            return self._send_file_download(config.DB_PATH, "gundam.db")
        if path == "/api/series":
            return self._send_json(api_series())
        if path == "/api/tags":
            return self._send_json(api_tags(q.get("kind", [""])[0]))
        if path == "/api/skillnames":
            return self._send_json(api_skillnames())
        if path == "/api/support-labels":
            return self._send_json(api_support_labels())
        if path == "/api/supporter-skillnames":
            return self._send_json(api_supporter_skillnames())
        if path == "/api/units":
            limit = min(int(q.get("limit", ["25"])[0]), 100)
            offset = max(int(q.get("offset", ["0"])[0]), 0)
            return self._send_json(api_units(
                q.get("q", [""])[0], q.get("rarity", [""])[0],
                q.get("acq", [""])[0], q.get("series", [""])[0], q.get("type", [""])[0],
                q.get("tags", [""])[0], q.get("tag_mode", ["all"])[0],
                q.get("match", ["and"])[0], q.get("wfx", [""])[0],
                q.get("wfx_mode", ["any"])[0], q.get("cond", [""])[0],
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
                q.get("support", [""])[0],
                q.get("sort", [""])[0],
                q.get("order", ["desc"])[0], limit, offset))
        if path == "/api/supporters":
            limit = min(int(q.get("limit", ["25"])[0]), 100)
            offset = max(int(q.get("offset", ["0"])[0]), 0)
            return self._send_json(api_supporters(
                q.get("q", [""])[0], q.get("tags", [""])[0],
                q.get("tag_mode", ["any"])[0],
                q.get("skills", [""])[0], q.get("skill_mode", ["any"])[0],
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
        if path == "/api/damage-sim":
            return self._send_json(api_damage_sim(q))
        if path == "/api/damage-bonus":
            return self._send_json(api_damage_bonus(
                q.get("atk_uid", [""])[0], q.get("atk_usrc", [""])[0],
                q.get("atk_pid", [""])[0], q.get("atk_psrc", [""])[0],
                q.get("def_uid", [""])[0], q.get("def_usrc", [""])[0],
                q.get("def_pid", [""])[0], q.get("def_psrc", [""])[0],
                q.get("weapon_attr", [""])[0], q.get("attack_attr", [""])[0],
                q.get("attr_nullify", ["0"])[0],
                q.get("atk_u_on", [""])[0], q.get("atk_p_on", [""])[0],
                q.get("def_u_on", [""])[0], q.get("def_p_on", [""])[0],
                q.get("atk_star", ["0"])[0], q.get("def_star", ["0"])[0],
                q.get("atk_unit_skill", ["0"])[0],
                q.get("def_unit_skill", ["0"])[0],
                q.get("atk_ship", ["0"])[0], q.get("atk_support", ["0"])[0],
                q.get("atk_op", ["0"])[0],
                q.get("atk_fixed", ["0"])[0],
                q.get("def_ship", ["0"])[0], q.get("def_support", ["0"])[0],
                q.get("def_op", ["0"])[0],
                q.get("def_fixed", ["0"])[0],
                q.get("atk_skill_ranged", ["0"])[0],
                q.get("atk_skill_melee", ["0"])[0],
                q.get("atk_skill_awaken", ["0"])[0]))
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

    def do_POST(self):
        try:
            api_path = self.path.split("?")[0]
            if api_path == "/api/crawl":
                length = int(self.headers.get("Content-Length") or 0)
                body = {}
                if length > 0:
                    try:
                        parsed = json.loads(
                            self.rfile.read(length).decode("utf-8") or "{}"
                        )
                        if isinstance(parsed, dict):
                            body = parsed
                    except (ValueError, UnicodeDecodeError):
                        body = {}
                return self._send_json(start_crawl(body.get("preserve")))
            if api_path == "/api/sync":
                length = int(self.headers.get("Content-Length") or 0)
                body = {}
                if length > 0:
                    try:
                        body = json.loads(
                            self.rfile.read(length).decode("utf-8") or "{}"
                        )
                    except (ValueError, UnicodeDecodeError):
                        body = {}
                return self._send_json(start_sync(body.get("direction", "")))
            if api_path == "/api/unit-edit":
                length = int(self.headers.get("Content-Length") or 0)
                body = {}
                if length > 0:
                    try:
                        parsed = json.loads(
                            self.rfile.read(length).decode("utf-8") or "{}"
                        )
                        if isinstance(parsed, dict):
                            body = parsed
                    except (ValueError, UnicodeDecodeError):
                        body = {}
                preview = parse_qs(urlparse(self.path).query).get(
                    "preview", ["0"]
                )[0] == "1"
                return self._send_json(api_unit_edit(body, preview=preview))
            if api_path == "/api/unit-sync":
                length = int(self.headers.get("Content-Length") or 0)
                body = {}
                if length > 0:
                    try:
                        parsed = json.loads(
                            self.rfile.read(length).decode("utf-8") or "{}"
                        )
                        if isinstance(parsed, dict):
                            body = parsed
                    except (ValueError, UnicodeDecodeError):
                        body = {}
                try:
                    uid = int(body.get("unit_id") or 0)
                except (TypeError, ValueError):
                    uid = 0
                return self._send_json(unit_sync_push(uid))
            if api_path == "/api/import":
                tmp = self._read_upload(max_bytes=512 * 1024 * 1024)
                if tmp is None:
                    return self._send_json(
                        {"error": "上传无效或文件超过 512MB"}, 400
                    )
                if not _validate_sqlite_db(tmp):
                    self._cleanup_import_files(tmp)
                    return self._send_json(
                        {"error": "文件不是有效的数据库备份"}, 400
                    )
                config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
                tmp.replace(config.DB_PATH)
                self._cleanup_import_files(tmp)
                info = api_summary()
                return self._send_json({
                    "ok": True,
                    "message": "导入成功，数据库已保存到本地",
                    "counts": info["counts"],
                })
            return self._send_json({"error": "unknown api"}, 404)
        except Exception as exc:  # 兜底：避免连接挂死
            try:
                self._send_json({"error": str(exc)}, 500)
            except Exception:
                pass


def run_server(port: int = 8765) -> None:
    if not config.DB_PATH.exists():
        print(f"提示：本地数据库不存在（{config.DB_PATH}），概览页可导入数据库文件。")
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
