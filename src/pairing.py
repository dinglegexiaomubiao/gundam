"""配对推荐引擎（新版）：机体 → 驾驶员。

流程：
- 选择机体 + 行动（攻击/防御）+ 武器（攻击时）+ 防御基准（低防本/中防本）
- 攻击模式得分 = 六层伤害公式计算的单次伤害（非暴击）；武器有暴击率时同时给出暴击伤害
- 防御模式得分 = 满级防御值 + 减伤% + 特殊机制加权
- 只计入「机体与驾驶员之间触发」的能力（标签/系列/类型/武器属性/搭乘特定机体）；
  依赖敌方标签、HP条件等无法自动判定的条件 → 记入特殊机制，不参与数值。
- 驾驶员属性：UR 用默认形态满级；非 UR 用 SP 形态满级（100 级）。
"""
from __future__ import annotations

import json
import math
import re
import sqlite3
import threading

from . import config
from .damage import (
    CRITICAL_CORRECTION,
    CombatantStats,
    DamageContext,
    calculate_damage,
)
from .labels import (
    ATTACK_ATTR_DEP_LABEL,
    STAR_MULT,
    ULTIMATE_TAG,
    split_trait_stages,
    support_label,
    star_value,
)

ROLE_NAMES = {1: "攻击型", 2: "耐久型", 3: "支援型"}
STAT_KEYS = ("ranged", "melee", "defense", "awaken", "reaction")
DEP_STAT_KEYS = ("ranged", "melee", "awaken")
# attack_attr → 依赖属性关键字（与伤害计算一致）
ATTACK_ATTR_KEYS = {
    1: ["ranged"], 2: ["melee"], 3: ["awaken"],
    4: ["melee", "ranged"], 5: ["ranged", "awaken"], 6: ["melee", "awaken"],
    7: ["ranged", "melee", "awaken"],
}
ATTACK_ATTR_WORD = {1: "Ranged", 2: "Melee", 3: "Awaken"}
WA_ID = {"Physical": 1, "Beam": 2, "Special": 3}

PAIR_BENCH = {
    "low": {
        "label": "低防本", "unit_defense": 1060,
        "character_defense": 109, "unit_hp": 800000,
    },
    "mid": {
        "label": "中防本", "unit_defense": 25072,
        "character_defense": 705, "unit_hp": 3586853,
    },
}
DEFENSE_CORRECTION = 0.6  # 防御且带盾
GUARD_CORRECTION = {0: 1.0, 1: 0.8, 2: 0.6}  # 不防御 / 防御不带盾 / 防御且带盾
GUARD_LABEL = {0: "不防御", 1: "防御不带盾", 2: "防御且带盾"}
DEFAULT_ENEMY = {
    "unit_id": 1370000150,   # 能天使高达 (EX) · 满星满级
    "pilot_id": 1370000100,  # 刹那·F·清英 · UR 攻击型
    "weapon_id": 3123,       # GN剑 EX（威力含 17% 特效加成）
}

_ENEMY_TARGETS = {"Enemy", "AttackTarget", "DamageTarget", "ActiveAttacker"}
_UNVERIFIABLE_KEYS = (
    "hp_type", "hp_rate_lte_threshold", "hp_rate_gte_threshold",
    "en_rate_lte_threshold", "en_rate_gte_threshold", "en_value_lte_threshold",
    "en_value_gte_threshold", "use_hp_rate_lte_threshold",
    "attack_distance_gte_threshold", "attack_distance_lte_threshold",
    "turn_number", "is_in_chance_step", "is_in_one_on_one",
    "standby_terrain",
    "character_tags_id", "character_series_id", "character_ids",
)

# 效果正则（与伤害计算一致）
_DMG_UP_RE = re.compile(r"(?<!爆击)损伤(?:再)?提升\s*(\d+)%")
_DMG_DOWN_RE = re.compile(r"损伤(?:减轻|降低)\s*(\d+)%")
_DEF_UP_RE = re.compile(
    r"(?:防御力|守备值)(?:及|与|和)?(?:攻击力)?(?:再)?提升\s*(\d+)%"
)
_ATK_UP_RE = re.compile(
    r"攻击力(?:及|与|和)?(?:防御力)?(?:再)?提升\s*(\d+)%"
)
_DEF_STACK_RE = re.compile(
    r"每次受到(?:来自敌方的)?损伤时，\s*自身防御力提升(\d+)%（最高(\d+)%）"
)
_HP_RECOVER_RE = re.compile(r"自身HP为(\d+)%以下时，\s*自身HP恢复(\d+)%（1次）")
_CRIT_DMG_RE = re.compile(r"爆击损伤提升\s*(\d+)%")
_CRIT_RATE_RE = re.compile(r"爆击率提升\s*(\d+)%")
_STAT_COMBO_RE = re.compile(
    r"((?:射击值|格斗值|觉醒值|反应值)(?:及|与|和)?"
    r"(?:射击值|格斗值|觉醒值|反应值)?)(?:再)?提升\s*(\d+)%"
)
_STAT_ALIAS = {
    "射击值": "ranged", "格斗值": "melee",
    "觉醒值": "awaken", "反应值": "reaction",
}
_EXTRA_ACTION_RE = re.compile(r"额外行动")
_SUPPORT_WORD_RE = re.compile(r"支援(?:攻击|防御)|反击|支援攻击|支援防御")


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{config.DB_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _json_list(raw) -> list:
    try:
        v = json.loads(raw or "[]")
        return v if isinstance(v, list) else []
    except (TypeError, json.JSONDecodeError):
        return []


def _json_dict(raw) -> dict:
    try:
        v = json.loads(raw or "{}")
        return v if isinstance(v, dict) else {}
    except (TypeError, json.JSONDecodeError):
        return {}


def _zero_eff() -> dict:
    return {
        "dmg_up": 0.0, "dmg_down": 0.0, "atk_pct": 0.0, "def_pct": 0.0,
        "stat_pct": {}, "def_stack": None, "hp_recover": None,
        "crit_rate": 0.0, "crit_dmg": 0.0,
    }


def _add_eff(tot: dict, eff: dict) -> None:
    for key in ("dmg_up", "dmg_down", "atk_pct", "def_pct", "crit_rate", "crit_dmg"):
        tot[key] += eff.get(key, 0.0)
    for k, v in (eff.get("stat_pct") or {}).items():
        tot["stat_pct"][k] = tot["stat_pct"].get(k, 0.0) + v
    if eff.get("def_stack") and tot["def_stack"] is None:
        tot["def_stack"] = eff["def_stack"]
    if eff.get("hp_recover") and tot["hp_recover"] is None:
        tot["hp_recover"] = eff["hp_recover"]


def _parse_effects(d: str) -> dict:
    eff = _zero_eff()
    text = d or ""
    # 攻击力及防御力提升：先整体识别，避免后续两条正则重复计入
    combo = re.search(r"攻击力(?:及|与|和)防御力提升\s*(\d+)%", text)
    if combo:
        pct = float(combo.group(1))
        eff["atk_pct"] += pct
        eff["def_pct"] += pct
        text = text[:combo.start()] + text[combo.end():]
    m = _DMG_UP_RE.search(d or "")
    if m:
        eff["dmg_up"] = float(m.group(1))
    m = _DMG_DOWN_RE.search(d or "")
    if m:
        eff["dmg_down"] = float(m.group(1))
    m = _DEF_UP_RE.search(text)
    if m:
        pct = float(m.group(1))
        eff["def_pct"] += pct
        if "攻击力" in m.group(0):
            eff["atk_pct"] = eff.get("atk_pct", 0.0) + pct
    m = _ATK_UP_RE.search(text)
    if m:
        pct = float(m.group(1))
        eff["atk_pct"] += pct
        if "防御力" in m.group(0):
            eff["def_pct"] = eff.get("def_pct", 0.0) + pct
    m = _DEF_STACK_RE.search(d or "")
    if m:
        eff["def_stack"] = (int(m.group(1)), int(m.group(2)))
    m = _HP_RECOVER_RE.search(d or "")
    if m:
        eff["hp_recover"] = (int(m.group(1)), int(m.group(2)))
    m = _CRIT_DMG_RE.search(d or "")
    if m:
        eff["crit_dmg"] = float(m.group(1))
    m = _CRIT_RATE_RE.search(d or "")
    if m:
        eff["crit_rate"] = float(m.group(1))
    m = _STAT_COMBO_RE.search(d or "")
    if m:
        pct = float(m.group(2))
        for nm in _STAT_ALIAS:
            if nm in m.group(1):
                eff["stat_pct"][_STAT_ALIAS[nm]] = (
                    eff["stat_pct"].get(_STAT_ALIAS[nm], 0.0) + pct
                )
    return eff


def _cond_parse(c: dict, desc: str) -> tuple[dict | None, str | None, bool]:
    """返回 (可匹配条件 dict | None, 机制原因 | None, 是否不可判定)。"""
    cond: dict = {
        "tags": set(), "series": set(), "role": "", "wa": set(),
        "waa": set(), "unit_ids": set(), "side": "self",
        "battle_action": str(c.get("map_battle_action") or "").strip(),
        "tension": str(c.get("tension") or "").strip(),
    }
    for t in c.get("tags") or []:
        if t.get("id"):
            cond["tags"].add(int(t["id"]))
    for x in str(c.get("unit_tags") or "").split(","):
        if x.strip().isdigit():
            cond["tags"].add(int(x))
    s = c.get("series")
    if isinstance(s, dict) and s.get("id"):
        cond["series"].add(int(s["id"]))
    elif isinstance(s, list):
        for x in s:
            if isinstance(x, dict) and x.get("id"):
                cond["series"].add(int(x["id"]))
    for x in str(c.get("unit_series") or "").split(","):
        if x.strip().isdigit():
            cond["series"].add(int(x))
    if c.get("unit_role"):
        cond["role"] = str(c["unit_role"])
    for x in str(c.get("weapon_attribute") or "").split(","):
        x = x.strip()
        if x and x in WA_ID:
            cond["wa"].add(WA_ID[x])
    for x in str(c.get("weapon_attack_attribute") or "").split(","):
        x = x.strip()
        if x:
            cond["waa"].add(x)
    for x in str(c.get("unit_ids") or "").split(","):
        if x.strip().isdigit():
            cond["unit_ids"].add(int(x))
    target = c.get("target") or "Owner"
    mech = None
    for k in _UNVERIFIABLE_KEYS:
        if c.get(k):
            mech = mech or "条件无法自动判定（HP/距离/EN等），未计入"
    if mech:
        return cond, mech, True
    if target in _ENEMY_TARGETS:
        if not cond["role"] and not cond["unit_ids"] and any([
            cond["tags"], cond["series"], cond["wa"], cond["waa"],
        ]):
            # 依赖敌方标签/系列/武器属性的条件：防御模式下可按敌方输入判定
            cond["side"] = "enemy"
            return cond, None, False
        return None, "依赖敌方标签，未计入", True
    has_match = any([
        cond["tags"], cond["series"], cond["role"],
        cond["wa"], cond["waa"], cond["unit_ids"], cond["battle_action"],
        cond["tension"],
    ])
    if not has_match:
        return None, None, False
    return cond, None, False


def _resolve_above(d: str, cond: dict, tag_name: dict, series_name: dict) -> str:
    """把「上述“标签”/“系列”」占位符替换为实际名称。"""
    if "上述" not in d or not cond:
        return d
    tag_ids: set[int] = set()
    for t in cond.get("tags") or []:
        if isinstance(t, dict) and t.get("id"):
            tag_ids.add(int(t["id"]))
    for x in str(cond.get("unit_tags") or "").split(","):
        if x.strip().isdigit():
            tag_ids.add(int(x))
    ser_ids: set[int] = set()
    s = cond.get("series")
    if isinstance(s, dict) and s.get("id"):
        ser_ids.add(int(s["id"]))
    elif isinstance(s, list):
        for x in s:
            if isinstance(x, dict) and x.get("id"):
                ser_ids.add(int(x["id"]))
    for x in str(cond.get("unit_series") or "").split(","):
        if x.strip().isdigit():
            ser_ids.add(int(x))
    tags = [tag_name.get(x) for x in tag_ids if tag_name.get(x)]
    ser = [series_name.get(x) for x in ser_ids if series_name.get(x)]
    role = ""
    if cond.get("role"):
        try:
            role = ROLE_NAMES.get(int(cond["role"]), "") or ""
        except (TypeError, ValueError):
            role = ""

    def repl(m):
        segs = [g for g in m.groups() if g]
        parts: list[str] = []
        for seg in segs:
            if "标签" in seg and "系列" in seg:
                if tags:
                    parts.append("标签：" + "、".join(tags))
                if ser:
                    parts.append("系列：" + "、".join(ser))
            elif "标签" in seg:
                parts.append("、".join(tags) or seg)
            elif "系列" in seg:
                parts.append("、".join(ser) or seg)
            elif "类型" in seg:
                parts.append(role or seg)
            else:
                parts.append(seg)
        return "、".join(parts) or m.group(0)

    return re.sub(
        r"上述\s*[“\"]([^”\"]+)[”\"]"
        r"(?:\s*(?:及|和|、|／)\s*[“\"]([^”\"]+)[”\"])*",
        repl, d,
    )


def _parse_ability(name: str, traits_raw, tag_name=None, series_name=None) -> dict:
    """把一条能力的多个 trait 按 group_id 分组解析。"""
    items = []
    for t in _json_list(traits_raw):
        c = t.get("active_condition") or {}
        # 多阶段能力（如超一击EX1 → 效果结束时 EX2 → MP变动）按段拆分
        for seg in split_trait_stages(t.get("desc") or ""):
            d = seg.strip()
            eff = _parse_effects(d)
            cond, mech, unverifiable = _cond_parse(c, d)
            if tag_name or series_name:
                d = _resolve_above(d, c, tag_name or {}, series_name or {})
            items.append({
                "desc": d,
                "eff": eff,
                "cond": cond,
                "mech": mech,
                "unverifiable": unverifiable,
                "gid": c.get("group_id"),
            })
    return {"name": name or "", "items": items}


def _item_matches(item: dict, unit_ctx: dict) -> bool:
    cond = item["cond"]
    if cond is None:
        return True
    if cond.get("side") == "enemy":
        if cond["wa"] and not cond["wa"] <= unit_ctx.get("enemy_wa", set()):
            return False
        enemy_waa = unit_ctx.get("enemy_waa")
        if cond["waa"] and enemy_waa is not None and not (
            enemy_waa & cond["waa"]
        ):
            return False
        if cond["tags"] and not (
            unit_ctx.get("enemy_tag_ids", set()) & cond["tags"]
        ):
            return False
        if cond["series"] and not (
            unit_ctx.get("enemy_series_ids", set()) & cond["series"]
        ):
            return False
        return True
    if cond["tags"] and not (unit_ctx["tag_ids"] & cond["tags"]):
        return False
    if cond["series"] and not (unit_ctx["series_ids"] & cond["series"]):
        return False
    if cond["role"] and str(unit_ctx["role"]) != cond["role"]:
        return False
    if cond["wa"] and not cond["wa"] <= unit_ctx["weapon_attr_ids"]:
        return False
    if cond["waa"] and not (unit_ctx["weapon_attack_keys"] & cond["waa"]):
        return False
    if cond["unit_ids"] and unit_ctx["id"] not in cond["unit_ids"]:
        return False
    if cond.get("battle_action") and (
        cond["battle_action"] != unit_ctx.get("battle_action")
    ):
        return False
    if cond.get("tension") and (unit_ctx.get("vigor") or "").lower() not in (
        x.lower() for x in cond["tension"].split(",")
    ):
        return False
    return True


def _classify_item(item: dict, unit_ctx: dict, mode: str) -> str:
    """把一条 trait 分为 counted / potential / impossible。"""
    if item["mech"]:
        if _cond_failed_deterministic(item["cond"], unit_ctx):
            return "impossible"
        return "potential"
    cond = item["cond"]
    if cond is None:
        return "counted"
    if cond.get("side") == "enemy":
        has_info = bool(
            unit_ctx.get("enemy_wa") or unit_ctx.get("enemy_tag_ids")
            or unit_ctx.get("enemy_series_ids")
        )
        if not has_info:
            return "potential"
        return "counted" if _item_matches(item, unit_ctx) else "impossible"
    if cond.get("battle_action") and not unit_ctx.get("battle_action"):
        return "potential"
    if cond.get("tension") and not unit_ctx.get("vigor"):
        return "potential"
    return "counted" if _item_matches(item, unit_ctx) else "impossible"


def _cond_failed_deterministic(cond, unit_ctx: dict) -> bool:
    """检查条件中可静态判定的部分是否已确定不满足（不判定战意/行动等未知项）。"""
    if cond is None:
        return False
    if cond.get("side") == "enemy":
        has_info = bool(
            unit_ctx.get("enemy_wa") or unit_ctx.get("enemy_tag_ids")
            or unit_ctx.get("enemy_series_ids")
        )
        if not has_info:
            return False
        return not _item_matches({"cond": cond, "mech": None}, unit_ctx)
    if cond["tags"] and not (unit_ctx["tag_ids"] & cond["tags"]):
        return True
    if cond["series"] and not (unit_ctx["series_ids"] & cond["series"]):
        return True
    if cond["role"] and str(unit_ctx["role"]) != cond["role"]:
        return True
    if cond["wa"] and unit_ctx.get("weapon_attr_ids") and not (
        cond["wa"] <= unit_ctx["weapon_attr_ids"]
    ):
        return True
    if cond["waa"] and unit_ctx.get("weapon_attack_keys") and not (
        unit_ctx["weapon_attack_keys"] & cond["waa"]
    ):
        return True
    if cond["unit_ids"] and unit_ctx["id"] not in cond["unit_ids"]:
        return True
    return False


def _counted_eff(item: dict) -> dict:
    """无条件能力的属性/暴击类提升已并入 stat_bonuses，避免重复计入。"""
    eff = dict(item["eff"])
    if item["cond"] is None:
        for key in ("atk_pct", "def_pct", "crit_rate", "crit_dmg"):
            eff[key] = 0.0
        eff["stat_pct"] = {}
    return eff


def _apply_ability(
    ability: dict, unit_ctx: dict, mode: str = "attack",
) -> tuple[dict, list, list, list]:
    """返回 (效果合计, 触发项, 有可能触发, 不能触发)。"""
    tot = _zero_eff()
    triggered: list[dict] = []
    potential: list[dict] = []
    impossible: list[dict] = []
    groups: dict = {}
    for it in ability["items"]:
        groups.setdefault(it["gid"], []).append(it)
    for gid, items in groups.items():
        if gid is not None and len(items) > 1:
            matched = [
                it for it in items
                if _classify_item(it, unit_ctx, mode) == "counted"
            ]
            if matched:
                # 同一 group = 并集：命中任一即触发，同效果只取最高，避免重复叠加
                g = _zero_eff()
                for it in matched:
                    ceff = _counted_eff(it)
                    for key in ("dmg_up", "dmg_down", "atk_pct", "def_pct",
                                "crit_rate", "crit_dmg"):
                        g[key] = max(g[key], ceff.get(key, 0.0))
                    for k, v in (ceff.get("stat_pct") or {}).items():
                        g["stat_pct"][k] = max(g["stat_pct"].get(k, 0.0), v)
                    if ceff.get("def_stack") and g["def_stack"] is None:
                        g["def_stack"] = ceff["def_stack"]
                    if ceff.get("hp_recover") and g["hp_recover"] is None:
                        g["hp_recover"] = ceff["hp_recover"]
                _add_eff(tot, g)
                seen = set()
                for it in matched:
                    if it["desc"] and it["desc"] not in seen:
                        seen.add(it["desc"])
                        triggered.append({
                            "name": ability["name"],
                            "desc": it["desc"],
                            "eff": it["eff"],
                        })
        else:
            for it in items:
                cls = _classify_item(it, unit_ctx, mode)
                if cls == "counted":
                    _add_eff(tot, _counted_eff(it))
                    if it["desc"]:
                        triggered.append({
                            "name": ability["name"],
                            "desc": it["desc"],
                            "eff": it["eff"],
                        })
                elif cls == "potential":
                    potential.append(_class_entry(ability, it, unit_ctx))
                else:
                    impossible.append(_class_entry(ability, it, unit_ctx))
    # 并集组内的 potential / impossible 也补录
    for it in ability["items"]:
        cls = _classify_item(it, unit_ctx, mode)
        if cls == "potential":
            if not any(p["desc"] == (it["desc"] or "") for p in potential):
                potential.append(_class_entry(ability, it, unit_ctx))
        elif cls == "impossible":
            if not any(x["desc"] == (it["desc"] or "") for x in impossible):
                impossible.append(_class_entry(ability, it, unit_ctx))
    return tot, triggered, potential, impossible


def _class_entry(ability: dict, item: dict, unit_ctx: dict) -> dict:
    cond = item["cond"]
    reason = ""
    if cond is not None and cond.get("side") == "enemy":
        reason = "敌方标签/系列/武器属性不匹配，未触发"
    elif cond is not None and cond.get("unit_ids") and (
        unit_ctx["id"] not in cond["unit_ids"]
    ):
        reason = "搭乘机体不匹配，未触发"
    elif cond is not None and cond["tags"] and not (
        unit_ctx["tag_ids"] & cond["tags"]
    ):
        reason = "机体标签不匹配，未触发"
    elif cond is not None and cond["series"] and not (
        unit_ctx["series_ids"] & cond["series"]
    ):
        reason = "机体系列不匹配，未触发"
    elif cond is not None and cond["role"] and str(unit_ctx["role"]) != cond["role"]:
        reason = "机体类型不匹配，未触发"
    if not reason:
        reason = item["mech"] or "条件不匹配，未触发"
        if item["cond"] is not None and item["cond"].get("battle_action"):
            reason = "当前行动（支援防御）下该行动条件无法触发"
    return {
        "name": ability["name"],
        "desc": item["desc"] or "",
        "reason": reason,
    }


def _full_stat(row: dict, bonuses: dict, key: str, form: str) -> int:
    prefix = "sp_" if form == "sp" else ""
    mx = row.get(prefix + "max_" + key) or 0
    pct = bonuses.get(key, 0)
    return mx * (100 + pct) // 100


def _counter_guard_ids(conn) -> set[int]:
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


def _pilot_series_ids(row: dict) -> set[int]:
    ids: set[int] = set()
    if row.get("series_id"):
        try:
            ids.add(int(row["series_id"]))
        except (TypeError, ValueError):
            pass
    for x in _json_list(row.get("series_ids")):
        try:
            ids.add(int(x))
        except (TypeError, ValueError):
            pass
    return ids


_pilots: list | None = None
_pilots_lock = threading.Lock()
_TAG_ID: dict | None = None
_TAG_NAME: dict = {}
_SERIES_NAME: dict = {}


def _build_pilots() -> list:
    global _pilots, _TAG_ID, _TAG_NAME, _SERIES_NAME
    with _pilots_lock:
        if _pilots is not None:
            return _pilots
        conn = _conn()
        _TAG_ID = {r[1]: r[0] for r in conn.execute("SELECT id, name FROM tag")}
        _TAG_NAME = {r[0]: r[1] for r in conn.execute("SELECT id, name FROM tag")}
        _SERIES_NAME = {r[0]: r[1] for r in conn.execute("SELECT id, name FROM series")}
        counter_guard = _counter_guard_ids(conn)
        pilots: list[dict] = []
        for c in conn.execute("SELECT * FROM character"):
            row = dict(c)
            rarity = row.get("rarity") or 5
            form = "sp" if rarity < 5 else "default"
            bonuses = _json_dict(row.get("stat_bonuses"))
            stats = {k: _full_stat(row, bonuses, k, form) for k in STAT_KEYS}
            abilities = [
                _parse_ability(
                    a["name"], a["traits"], _TAG_NAME, _SERIES_NAME
                )
                for a in conn.execute(
                    "SELECT name, traits FROM character_ability "
                    "WHERE character_id = ?",
                    (row["id"],),
                )
            ]
            skills = [
                {"name": s["name"] or "", "desc": s["desc"] or ""}
                for s in conn.execute(
                    "SELECT name, desc FROM character_skill "
                    "WHERE character_id = ?",
                    (row["id"],),
                )
            ]
            lbl = support_label(_json_dict(row.get("support_info")))
            base_mech: list[dict] = []
            if lbl:
                base_mech.append({"label": lbl, "kind": "support"})
            if row["id"] in counter_guard:
                base_mech.append({"label": "反击援防", "kind": "counter_guard"})
            if any(_EXTRA_ACTION_RE.search(
                (a["name"] or "") + "".join(i["desc"] for i in a["items"])
            ) for a in abilities) or any(
                _EXTRA_ACTION_RE.search((s["name"] or "") + (s["desc"] or ""))
                for s in skills
            ):
                base_mech.append({"label": "额外行动", "kind": "extra_action"})
            for a in abilities:
                for it in a["items"]:
                    if it["eff"].get("hp_recover"):
                        base_mech.append({
                            "label": "HP恢复（1次）", "kind": "hp_recover",
                        })
                    if it["eff"].get("def_stack"):
                        base_mech.append({
                            "label": (
                                f"叠层防御（每次+{it['eff']['def_stack'][0]}%，"
                                f"最高{it['eff']['def_stack'][1]}%）"
                            ),
                            "kind": "def_stack",
                        })
            for s in skills:
                base_mech.append({
                    "label": f"主动技能：{s['name'] or '—'}",
                    "kind": "skill",
                })
            pilots.append({
                "id": row["id"],
                "name": row["name"] or "",
                "rarity": rarity,
                "role": row.get("role") or 0,
                "role_label": ROLE_NAMES.get(row.get("role"), "—"),
                "series_ids": _pilot_series_ids(row),
                "tags": set(_json_list(row.get("tags"))),
                "support_label": lbl,
                "stats": stats,
                "abilities": abilities,
                "skills": skills,
                "base_mech": base_mech,
            })
        conn.close()
        _pilots = pilots
        return _pilots


def _unit_ctx(conn, unit_id: int, weapon_row: dict | None,
              enemy_wa=None, enemy_waa=None,
              enemy_tags=None, enemy_series=None,
              battle_action: str | None = None,
              vigor: str | None = None) -> dict:
    u = dict(conn.execute("SELECT * FROM unit WHERE id = ?", (unit_id,)).fetchone())
    tag_names = set(_json_list(u.get("tags")))
    tag_ids = {_TAG_ID[n] for n in tag_names if n in _TAG_ID}
    series_ids = set()
    if u.get("series_id"):
        series_ids.add(int(u["series_id"]))
    for x in _json_list(u.get("series_ids")):
        try:
            series_ids.add(int(x))
        except (TypeError, ValueError):
            pass
    wa_ids: set[int] = set()
    wa_keys: set[str] = set()
    if weapon_row:
        try:
            attrs = json.loads(weapon_row.get("weapon_attrs") or "[]")
            attrs = [int(x) for x in attrs] if isinstance(attrs, list) else []
        except (TypeError, ValueError, json.JSONDecodeError):
            attrs = []
        if not attrs and weapon_row.get("weapon_attr"):
            attrs = [int(weapon_row["weapon_attr"])]
        wa_ids = {a for a in attrs if a in (1, 2, 3)}
        aattr = weapon_row.get("attack_attr")
        if aattr:
            for k in ATTACK_ATTR_KEYS.get(int(aattr), []):
                if k in DEP_STAT_KEYS:
                    wa_keys.add(ATTACK_ATTR_WORD.get(
                        {"ranged": 1, "melee": 2, "awaken": 3}[k]
                    ))
    return {
        "id": unit_id,
        "role": u.get("role") or 0,
        "tag_ids": tag_ids,
        "series_ids": series_ids,
        "weapon_attr_ids": wa_ids,
        "weapon_attack_keys": wa_keys,
        "enemy_wa": enemy_wa or set(),
        "enemy_waa": enemy_waa,
        "enemy_tag_ids": {
            _TAG_ID[n] for n in (enemy_tags or set()) if n in _TAG_ID
        },
        "enemy_series_ids": set(int(x) for x in (enemy_series or set())),
        "battle_action": battle_action,
        "vigor": vigor,
    }


def _weapon_power(weapon_row: dict) -> int:
    base = (
        weapon_row.get("power_lv9") or weapon_row.get("power_lv5")
        or weapon_row.get("power") or 0
    )
    boost = 0
    for e in _json_list(weapon_row.get("weapon_effects")):
        text = str(e.get("name") or "") + str(e.get("desc") or "")
        if re.search(r"武装POWER(?:越为)?提升", text):
            m = re.search(r"最高提升(\d+)%", text)
            if m:
                boost = max(boost, int(m.group(1)))
    return math.ceil(int(base) * (100 + boost) / 100)


def _unit_attack(unit_row: dict) -> int:
    tags = set(_json_list(unit_row.get("tags")))
    star = 0 if ULTIMATE_TAG in tags else 3
    num, den = STAR_MULT[star]
    bonuses = _json_dict(unit_row.get("stat_bonuses"))
    base = (unit_row.get("max_attack") or 0) * num // den
    return base * (100 + bonuses.get("attack", 0)) // 100


def _unit_mechanics(
    conn, unit_id: int, unit_ctx: dict, mode: str = "attack"
) -> list[dict]:
    """机体单位能力/技能中无法自动判定的机制。"""
    out: list[dict] = []
    for a in conn.execute(
        "SELECT name, traits FROM unit_ability WHERE unit_id = ?", (unit_id,)
    ):
        ab = _parse_ability(
            a["name"], a["traits"], _TAG_NAME, _SERIES_NAME
        )
        _, _, pot, imp = _apply_ability(ab, unit_ctx, mode)
        for item in pot + imp:
            out.append({
                "label": f"「{ab['name']}」{item['reason']}",
                "kind": "potential" if item in pot else "impossible",
            })
    for s in conn.execute(
        "SELECT name, desc FROM unit_skill WHERE unit_id = ?", (unit_id,)
    ):
        if s["name"] or s["desc"]:
            out.append({
                "label": f"单位技能：{s['name'] or '—'}",
                "kind": "unit_skill",
            })
    return out


def _unit_damage_bonus(conn, unit_id: int, unit_ctx: dict) -> float:
    """机体单位能力中可计数（无条件/自身条件匹配）的增伤。"""
    total = 0.0
    for a in conn.execute(
        "SELECT name, traits FROM unit_ability WHERE unit_id = ?", (unit_id,)
    ):
        ab = _parse_ability(
            a["name"], a["traits"], _TAG_NAME, _SERIES_NAME
        )
        eff, _, _, _ = _apply_ability(ab, unit_ctx, "attack")
        total += eff["dmg_up"]
    return total


def _score_attack(
    pilot: dict, unit_ctx: dict, weapon_row: dict,
    bench: dict, unit_row: dict, unit_tot: dict, cfg: dict,
) -> dict:
    tot = _zero_eff()
    triggered: list[dict] = []
    potential: list[dict] = []
    impossible: list[dict] = []
    for ab in pilot["abilities"]:
        t, trig, pot, imp = _apply_ability(ab, unit_ctx, "attack")
        _add_eff(tot, t)
        triggered.extend(trig)
        potential.extend(pot)
        impossible.extend(imp)
    dep_keys = ATTACK_ATTR_KEYS.get(int(weapon_row.get("attack_attr") or 1)) \
        or ["ranged"]
    dep_val = max(
        pilot["stats"][k] * (100 + tot["stat_pct"].get(k, 0.0)) // 100
        for k in dep_keys
    )
    tags = set(_json_list(unit_row.get("tags")))
    star = 0 if ULTIMATE_TAG in tags else 3
    bonuses = _json_dict(unit_row.get("stat_bonuses"))
    atk_pct_total = (
        bonuses.get("attack", 0) + unit_tot["atk_pct"]
        + cfg.get("us_atk_pct", 0.0) + cfg.get("ext_pct", 0.0)
    )
    unit_attack = star_value(
        unit_row.get("max_attack") or 0, atk_pct_total, star
    )[0] + int(cfg.get("ext_fixed", 0))
    dmg_percent = [
        pct for pct in (
            unit_tot["dmg_up"], cfg.get("us_buff", 0.0), tot["dmg_up"],
        ) if pct
    ]
    if str(cfg.get("wp_ov") or "").strip():
        power = float(cfg["wp_ov"])
    else:
        power = _weapon_power(weapon_row)
    base_crit = int(
        weapon_row.get("crit_lv9") or weapon_row.get("crit_lv5")
        or weapon_row.get("critical_rate") or 0
    )
    weapon_crit = (
        float(cfg["crit_ov"]) if str(cfg.get("crit_ov") or "").strip()
        else base_crit
    )
    crit_rate = int(weapon_crit + unit_tot["crit_rate"]
                    + tot["crit_rate"] + cfg.get("us_crit_rate", 0.0))
    weapon_crit_dmg = (
        float(cfg["critdmg_ov"]) if str(cfg.get("critdmg_ov") or "").strip()
        else 0.0
    )
    vigor = cfg.get("vigor", "normal")
    common = dict(
        weapon_power=power,
        terrain_correction=1.0,
        defensive_correction=DEFENSE_CORRECTION,
        attacker_damage_dealt_percent=dmg_percent,
        attacker_vigor=vigor,
    )
    ctx = DamageContext(**common)
    crit_bonus = (
        CRITICAL_CORRECTION.get(vigor, 0.0)
        + unit_tot["crit_dmg"] + tot["crit_dmg"]
        + cfg.get("us_crit_dmg", 0.0) + weapon_crit_dmg
    )
    ctx_crit = DamageContext(
        critical=True, critical_correction_percent=crit_bonus, **common
    )
    att = CombatantStats(
        unit_attack=unit_attack,
        unit_defense=bench["unit_defense"],
        character_attack=float(dep_val),
        character_defense=bench["character_defense"],
    )
    defender = CombatantStats(
        unit_attack=0.0,
        unit_defense=bench["unit_defense"],
        character_attack=0.0,
        character_defense=bench["character_defense"],
    )
    damage = int(calculate_damage(att, defender, ctx)["final_damage"])
    crit_damage = int(calculate_damage(att, defender, ctx_crit)["final_damage"])
    score = crit_damage if crit_rate >= 100 else damage
    return {
        "id": pilot["id"],
        "name": pilot["name"],
        "rarity": pilot["rarity"],
        "role": pilot["role"],
        "role_label": pilot["role_label"],
        "score": score,
        "damage": damage,
        "crit_damage": crit_damage,
        "crit_rate": crit_rate,
        "dep_label": ATTACK_ATTR_DEP_LABEL.get(
            int(weapon_row.get("attack_attr") or 1), "—"
        ),
        "dep_value": dep_val,
        "triggered": triggered[:8],
        "potential": potential[:8],
        "impossible": impossible[:8],
        "support_mech": [
            dict(m) for m in pilot["base_mech"]
            if m["kind"] in ("support", "counter_guard", "extra_action")
        ],
        "skills": [dict(s) for s in pilot["skills"]],
        "series_ids": sorted(pilot["series_ids"]),
        "tags": sorted(pilot["tags"]),
        "support_label": pilot["support_label"],
        "stats": dict(pilot["stats"]),
    }


def _score_defense(
    pilot: dict, unit_ctx: dict, unit_row: dict, enemy_cfg: dict,
    unit_abilities: list, ext: dict,
) -> dict:
    def _def_relevant(eff: dict) -> bool:
        return (
            eff.get("def_pct", 0) > 0 or eff.get("dmg_down", 0) > 0
            or eff.get("def_stack") is not None
            or eff.get("hp_recover") is not None
            or (eff.get("stat_pct") or {}).get("defense", 0) > 0
        )

    tot = _zero_eff()
    triggered: list[dict] = []
    potential: list[dict] = []
    impossible: list[dict] = []
    recoveries: list[tuple] = []
    stacks: list[tuple] = []
    for ab in pilot["abilities"]:
        t, trig, pot, imp = _apply_ability(ab, unit_ctx, "defense")
        _add_eff(tot, t)
        triggered.extend(x for x in trig if _def_relevant(x.get("eff") or {}))
        potential.extend(pot)
        impossible.extend(imp)
        for it in ab["items"]:
            if _classify_item(it, unit_ctx, "defense") == "impossible":
                continue
            if it["eff"].get("hp_recover"):
                recoveries.append(it["eff"]["hp_recover"])
            if it["eff"].get("def_stack"):
                stacks.append(it["eff"]["def_stack"])
    unit_tot = _zero_eff()
    for ab in unit_abilities:
        t, _, _, _ = _apply_ability(ab, unit_ctx, "defense")
        _add_eff(unit_tot, t)
        for it in ab["items"]:
            if _classify_item(it, unit_ctx, "defense") == "impossible":
                continue
            if it["eff"].get("hp_recover"):
                recoveries.append(it["eff"]["hp_recover"])
            if it["eff"].get("def_stack"):
                stacks.append(it["eff"]["def_stack"])
    def_pct = tot["def_pct"] + tot["stat_pct"].get("defense", 0.0)
    def_val = pilot["stats"]["defense"] * (100 + def_pct) // 100
    # 机体满星满级防御 / HP
    tags = set(_json_list(unit_row.get("tags")))
    star = 0 if ULTIMATE_TAG in tags else 3
    bonuses = _json_dict(unit_row.get("stat_bonuses"))
    unit_def = star_value(
        unit_row.get("max_defense") or 0,
        bonuses.get("defense", 0) + unit_tot["def_pct"]
        + ext.get("pct", 0.0),
        star,
    )[0]
    unit_def += int(ext.get("fixed", 0))
    unit_hp = star_value(
        unit_row.get("max_hp") or 0,
        bonuses.get("hp", 0) + ext.get("hp_pct", 0.0),
        star,
    )[0] + int(ext.get("hp_fixed", 0))
    dmg_down = unit_tot["dmg_down"] + tot["dmg_down"]
    if enemy_cfg.get("ignore_reduction"):
        dmg_down = 0.0
    stack_step = stack_max = 0
    for s in stacks:
        stack_step = max(stack_step, s[0])
        stack_max = max(stack_max, s[1])
    # 濒死恢复（HP为0%时，1次）优先；其次是阈值恢复
    death_recover = next((r for r in recoveries if r[0] == 0), None)
    cross_recover = next((r for r in recoveries if r[0] > 0), None)

    def run_sim(critical: bool):
        hp = float(unit_hp)
        hits = 0
        recovered = False
        first = 0
        while hp > 0:
            defense_now = unit_def
            if stack_step and hits > 0:
                mult = 100 + min(hits * stack_step, stack_max)
                defense_now = unit_def * mult // 100
            ctx = DamageContext(
                weapon_power=enemy_cfg["power"],
                terrain_correction=enemy_cfg.get("terrain", 1.0),
                defensive_correction=enemy_cfg.get(
                    "defensive_correction", 0.6
                ),
                defender_damage_taken_percent=[dmg_down] if dmg_down else [],
                attacker_vigor=enemy_cfg.get("vigor", "normal"),
                critical=critical,
                critical_correction_percent=(
                    CRITICAL_CORRECTION.get(
                        enemy_cfg.get("vigor", "normal"), 0.0
                    )
                    if critical else None
                ),
            )
            attacker = CombatantStats(
                unit_attack=enemy_cfg["unit_attack"],
                unit_defense=0.0,
                character_attack=enemy_cfg["pilot_attack"],
                character_defense=0.0,
            )
            defender = CombatantStats(
                unit_attack=0.0,
                unit_defense=float(defense_now),
                character_attack=0.0,
                character_defense=float(def_val),
            )
            dmg = int(calculate_damage(attacker, defender, ctx)["final_damage"])
            if first == 0:
                first = dmg
            prev = hp
            hp -= dmg
            if hp <= 0:
                if death_recover and not recovered:
                    hp = unit_hp * death_recover[1] / 100
                    recovered = True
                else:
                    break
            hits += 1
            if cross_recover and not recovered:
                thresh_val = unit_hp * cross_recover[0] / 100
                if prev > thresh_val and hp <= thresh_val:
                    hp = min(
                        float(unit_hp),
                        hp + unit_hp * cross_recover[1] / 100,
                    )
                    recovered = True
        return hits, first

    survive, first_damage = run_sim(False)
    survive_crit, _ = run_sim(True)
    crit_rate = float(enemy_cfg.get("crit_rate", 0) or 0)
    expected = round(
        survive * (100 - crit_rate) / 100 + survive_crit * crit_rate / 100,
        1,
    )
    return {
        "id": pilot["id"],
        "name": pilot["name"],
        "rarity": pilot["rarity"],
        "role": pilot["role"],
        "role_label": pilot["role_label"],
        "score": expected,
        "survive": survive,
        "survive_crit": survive_crit,
        "crit_rate": crit_rate,
        "first_damage": first_damage,
        "unit_defense": unit_def,
        "unit_hp": unit_hp,
        "defense": def_val,
        "dmg_down": round(unit_tot["dmg_down"] + tot["dmg_down"], 1),
        "triggered": triggered[:8],
        "potential": potential[:8],
        "impossible": impossible[:8],
        "support_mech": [
            dict(m) for m in pilot["base_mech"]
            if m["kind"] in ("support", "counter_guard", "extra_action")
        ],
        "skills": [dict(s) for s in pilot["skills"]],
        "series_ids": sorted(pilot["series_ids"]),
        "tags": sorted(pilot["tags"]),
        "support_label": pilot["support_label"],
        "stats": dict(pilot["stats"]),
    }


def match_pilot(
    unit_id: int, action: str = "attack",
    weapon_id=None, bench: str = "low", enemy=None, filters=None,
) -> dict:
    bench_cfg = PAIR_BENCH.get(bench or "low", PAIR_BENCH["low"])
    enemy = enemy or {}
    enemy_cfg = {
        "unit_attack": float(enemy.get("unit_attack") or 0),
        "pilot_attack": float(enemy.get("pilot_attack") or 0),
        "power": float(enemy.get("power") or 0),
        "vigor": str(enemy.get("vigor") or "normal"),
        "terrain": float(enemy.get("terrain") or 1.0),
        "crit_rate": float(enemy.get("crit_rate") or 0),
        "defensive_correction": GUARD_CORRECTION.get(
            int(enemy.get("guard") or 2), 0.6
        ),
        "ignore_reduction": bool(
            str(enemy.get("ignore_reduction") or "").strip()
            in ("1", "true", "on", "yes")
        ),
    }
    conn = _conn()
    unit_row = dict(conn.execute("SELECT * FROM unit WHERE id = ?", (unit_id,)).fetchone()) \
        if conn.execute("SELECT 1 FROM unit WHERE id = ?", (unit_id,)).fetchone() else None
    if not unit_row:
        conn.close()
        return {"error": "机体不存在", "ok": False}
    weapon_row = None
    if action == "attack":
        wq = conn.execute(
            "SELECT * FROM unit_weapon WHERE id = ? AND unit_id = ?",
            (int(weapon_id), unit_id),
        ).fetchone() if str(weapon_id or "").strip().isdigit() else None
        if wq:
            weapon_row = dict(wq)
        if not weapon_row:
            conn.close()
            return {"error": "请选择该机体的武器", "ok": False}
    _build_pilots()
    enemy_wa = enemy_waa = None
    enemy_tags: set[str] = set()
    enemy_series: set[int] = set()
    battle_action = "SupportDefense" if action == "defense" else None
    my_vigor = (
        str(enemy.get("vigor") or "normal") if action == "attack" else None
    )
    if action == "defense":
        wt = int(enemy.get("weapon_type") or 2)
        enemy_wa = {1, 2, 3} if wt == 6 else {wt}
        waa_word = str(enemy.get("weapon_attack") or "").strip()
        if waa_word in ("Ranged", "Melee", "Awaken"):
            enemy_waa = {waa_word}
        elif waa_word and waa_word != "any":
            enemy_waa = {waa_word}
        for t in str(enemy.get("tags") or "").split(","):
            t = t.strip()
            if t:
                enemy_tags.add(t)
        for x in str(enemy.get("series") or "").split(","):
            x = x.strip()
            if x.isdigit():
                enemy_series.add(int(x))
    unit_ctx = _unit_ctx(
        conn, unit_id, weapon_row,
        enemy_wa=enemy_wa, enemy_waa=enemy_waa,
        enemy_tags=enemy_tags, enemy_series=enemy_series,
        battle_action=battle_action,
        vigor=my_vigor,
    )
    unit_mech = _unit_mechanics(conn, unit_id, unit_ctx, action)
    unit_abilities = [
        _parse_ability(a["name"], a["traits"], _TAG_NAME, _SERIES_NAME)
        for a in conn.execute(
            "SELECT name, traits FROM unit_ability WHERE unit_id = ?",
            (unit_id,),
        )
    ]
    unit_tot = _zero_eff()
    for ab in unit_abilities:
        t, _, _, _ = _apply_ability(ab, unit_ctx, "attack")
        _add_eff(unit_tot, t)
    ext = {
        "pct": float(enemy.get("ext_pct") or 0),
        "fixed": int(float(enemy.get("ext_fixed") or 0)),
        "hp_pct": float(enemy.get("hp_pct") or 0),
        "hp_fixed": int(float(enemy.get("hp_fixed") or 0)),
    }
    us_cfg = {"atk_pct": 0.0, "buff": 0.0, "crit_rate": 0.0, "crit_dmg": 0.0}
    if action == "attack" and str(enemy.get("atk_us") or "").strip():
        want = {
            int(x) for x in str(enemy.get("atk_us") or "").split(",")
            if x.strip().isdigit()
        }
        for s in conn.execute(
            "SELECT id, name, desc FROM unit_skill WHERE unit_id = ?",
            (unit_id,),
        ):
            if s["id"] not in want:
                continue
            d = s["desc"] or ""
            m = re.search(r"攻击力提升\s*(\d+)%", d)
            if m:
                us_cfg["atk_pct"] += float(m.group(1))
            m = re.search(r"(?<!爆击)损伤提升\s*(\d+)%", d)
            if m:
                us_cfg["buff"] += float(m.group(1))
            m = re.search(r"爆击率提升\s*(\d+)%", d)
            if m:
                us_cfg["crit_rate"] += float(m.group(1))
            m = re.search(r"爆击损伤提升\s*(\d+)%", d)
            if m:
                us_cfg["crit_dmg"] += float(m.group(1))
    conn.close()

    rows = []
    if action == "attack":
        cfg = {
            "vigor": str(enemy.get("vigor") or "normal"),
            "ext_pct": ext["pct"],
            "ext_fixed": ext["fixed"],
            "us_atk_pct": us_cfg["atk_pct"],
            "us_buff": us_cfg["buff"],
            "us_crit_rate": us_cfg["crit_rate"],
            "us_crit_dmg": us_cfg["crit_dmg"],
            "wp_ov": str(enemy.get("wp_ov") or "").strip(),
            "crit_ov": str(enemy.get("crit_ov") or "").strip(),
            "critdmg_ov": str(enemy.get("critdmg_ov") or "").strip(),
        }
        for p in _pilots:
            rows.append(_score_attack(
                p, unit_ctx, weapon_row, bench_cfg, unit_row, unit_tot, cfg
            ))
        rows.sort(key=lambda x: x["score"], reverse=True)
    else:
        for p in _pilots:
            rows.append(_score_defense(
                p, unit_ctx, unit_row, enemy_cfg, unit_abilities, ext
            ))
        rows.sort(key=lambda x: x["score"], reverse=True)
    rows = rows[:50]
    rows = _apply_pair_filters(rows, filters or {}, action)

    tag_names = sorted(_json_list(unit_row.get("tags")))
    role_label = ROLE_NAMES.get(unit_row.get("role"), "—")
    tags = set(tag_names)
    star = 0 if ULTIMATE_TAG in tags else 3
    bonuses = _json_dict(unit_row.get("stat_bonuses"))
    unit_attack_display = star_value(
        unit_row.get("max_attack") or 0,
        bonuses.get("attack", 0) + unit_tot["atk_pct"]
        + us_cfg["atk_pct"] + ext["pct"],
        star,
    )[0] + ext["fixed"]
    info = {
        "ok": True,
        "action": action,
        "bench": bench_cfg["label"],
        "bench_cfg": bench_cfg,
        "unit": {
            "id": unit_id,
            "name": unit_row.get("name"),
            "rarity": unit_row.get("rarity"),
            "role_label": role_label,
            "tags": tag_names,
        },
        "unit_attack": unit_attack_display if action == "attack" else None,
        "unit_mechanics": unit_mech,
        "enemy_cfg": {
            "unit_attack": enemy_cfg["unit_attack"],
            "pilot_attack": enemy_cfg["pilot_attack"],
            "power": enemy_cfg["power"],
            "weapon_type": int(enemy.get("weapon_type") or 2),
            "weapon_attack": str(enemy.get("weapon_attack") or "").strip()
                or "any",
            "vigor": enemy_cfg["vigor"],
            "terrain": enemy_cfg["terrain"],
            "crit_rate": enemy_cfg["crit_rate"],
            "ext_pct": ext["pct"],
            "ext_fixed": ext["fixed"],
            "hp_pct": ext["hp_pct"],
            "hp_fixed": ext["hp_fixed"],
            "tags": sorted(enemy_tags),
            "series": sorted(enemy_series),
            "guard": int(enemy.get("guard") or 2),
            "guard_label": GUARD_LABEL.get(
                int(enemy.get("guard") or 2), "防御且带盾"
            ),
            "ignore_reduction": enemy_cfg["ignore_reduction"],
        },
        "weapon": None,
        "pilots": rows,
        "total": len(rows),
    }
    if weapon_row:
        info["weapon"] = {
            "id": weapon_row["id"],
            "name": weapon_row.get("name"),
            "power": (
                float(cfg["wp_ov"]) if str(cfg.get("wp_ov") or "").strip()
                else _weapon_power(weapon_row)
            ),
            "crit_rate": (
                float(cfg["crit_ov"]) if str(cfg.get("crit_ov") or "").strip()
                else int(
                    weapon_row.get("crit_lv9") or weapon_row.get("crit_lv5")
                    or weapon_row.get("critical_rate") or 0
                )
            ),
            "crit_dmg": (
                float(cfg["critdmg_ov"])
                if str(cfg.get("critdmg_ov") or "").strip() else 0.0
            ),
            "dep_label": ATTACK_ATTR_DEP_LABEL.get(
                int(weapon_row.get("attack_attr") or 1), "—"
            ),
        }
    return info


def default_enemy() -> dict:
    """默认敌方：能天使高达(EX) 满星满级 + 刹那·F·清英 + GN剑 EX。"""
    conn = _conn()
    u = dict(conn.execute(
        "SELECT * FROM unit WHERE id = ?", (DEFAULT_ENEMY["unit_id"],)
    ).fetchone())
    p = dict(conn.execute(
        "SELECT * FROM character WHERE id = ?", (DEFAULT_ENEMY["pilot_id"],)
    ).fetchone())
    w = dict(conn.execute(
        "SELECT * FROM unit_weapon WHERE id = ?", (DEFAULT_ENEMY["weapon_id"],)
    ).fetchone())
    conn.close()
    bonuses = _json_dict(p.get("stat_bonuses"))
    pilot_attack = max(
        (p.get(f"max_{k}") or 0) * (100 + bonuses.get(k, 0)) // 100
        for k in DEP_STAT_KEYS
    )
    power_base = int(
        w.get("power_lv9") or w.get("power_lv5") or w.get("power") or 0
    )
    boost = 0
    effects: list[dict] = []
    for e in _json_list(w.get("weapon_effects")):
        text = str(e.get("name") or "") + str(e.get("desc") or "")
        if re.search(r"武装POWER(?:越为)?提升", text):
            m = re.search(r"最高提升(\d+)%", text)
            if m:
                boost = max(boost, int(m.group(1)))
            effects.append({
                "name": e.get("name") or "武装POWER提升",
                "desc": (e.get("desc") or "").strip(),
            })
    return {
        "unit_name": u.get("name"),
        "unit_attack": _unit_attack(u),
        "pilot_name": p.get("name"),
        "pilot_attack": pilot_attack,
        "weapon_name": w.get("name"),
        "power_base": power_base,
        "power_boost": boost,
        "power": math.ceil(power_base * (100 + boost) / 100),
        "power_effects": effects,
        "weapon_type": 6,
        "weapon_attack": "any",
    }


def _apply_pair_filters(rows: list, f: dict, action: str) -> list:
    """对匹配结果应用驾驶员搜索筛选与排序。"""
    q = (f.get("q") or "").strip()
    if q:
        rows = [r for r in rows if q in (r.get("name") or "")]
    rarity = f.get("rarity") or ""
    if rarity:
        rows = [r for r in rows if str(r.get("rarity")) == rarity]
    ptype = f.get("type") or ""
    if ptype:
        rows = [r for r in rows if str(r.get("role")) == ptype]
    series = f.get("series") or ""
    if series and series.isdigit():
        sid = int(series)
        rows = [r for r in rows if sid in (r.get("series_ids") or set())]
    tags = [t for t in str(f.get("tags") or "").split(",") if t]
    skills = [s for s in str(f.get("skills") or "").split(",") if s]
    if tags or skills:
        match_and = (f.get("match") or "and") == "and"
        tag_all = (f.get("tag_mode") or "all") == "all"
        skill_any = (f.get("skill_mode") or "any") == "any"

        def pred(r):
            conds = []
            if tags:
                rt = set(r.get("tags") or [])
                conds.append(
                    all(t in rt for t in tags) if tag_all
                    else any(t in rt for t in tags)
                )
            if skills:
                rs = {s.get("name") for s in (r.get("skills") or [])}
                conds.append(
                    any(s in rs for s in skills) if skill_any
                    else all(s in rs for s in skills)
                )
            return all(conds) if match_and else any(conds)

        rows = [r for r in rows if pred(r)]
    support = f.get("support") or ""
    if support:
        rows = [r for r in rows if (r.get("support_label") or "") == support]
    sort = f.get("sort") or "score"
    order_desc = (f.get("order") or "desc") != "asc"

    def key(r):
        if sort == "name":
            return (r.get("name") or "").lower()
        if sort == "rarity":
            return r.get("rarity") or 0
        if sort == "role":
            return r.get("role") or 0
        if sort in (
            "score", "damage", "crit_damage", "crit_rate", "dep_value",
            "survive", "survive_crit", "first_damage", "defense", "dmg_down",
        ):
            return r.get(sort) or 0
        return r.get("score") or 0

    rows.sort(key=key, reverse=order_desc)
    return rows
