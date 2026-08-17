"""显示用标签映射与结构化数据解析辅助。"""
from __future__ import annotations

import re

RARITY = {5: "UR", 4: "SSR", 3: "SR", 2: "R", 1: "N"}
ULTIMATE_TAG = "终极"

# 升星倍率：0/1/2/3 星对应 ×1.0 / ×1.2 / ×1.3 / ×1.4
# 计算方式：星级基础值 = floor(基础值 × 倍率)；最终值 = floor(星级基础值 × (1 + 能力加成%))
STAR_MULT = {0: (1, 1), 1: (6, 5), 2: (13, 10), 3: (7, 5)}
STAR_LABEL = {0: "×1.0", 1: "×1.2", 2: "×1.3", 3: "×1.4"}

UNIT_STAT_KEYWORDS = {
    "最大HP": "hp",
    "最大EN": "en",
    "攻击力": "attack",
    "防御力": "defense",
    "机动力": "mobility",
}
CHAR_STAT_KEYWORDS = {
    "射击值": "ranged",
    "格斗值": "melee",
    "防御力": "defense",
    "守备值": "defense",
    "反应值": "reaction",
    "觉醒值": "awaken",
}
_ALL_STAT_HINT = "全能力值"
_CONDITION_HINTS = (
    "含有", "包含", "搭乘", "进行", "时", "期间", "以上", "以下", "未满",
    "若", "每回合", "结束时", "开始时", "战斗中", "发动", "战后", "攻击后",
    "战意", "赋予", "对同部队", "持有", "装备", "状态", "期间",
)
_PCT_RE = re.compile(r"提升\s*(\d+)\s*%")
_MAX_PCT_RE = re.compile(r"最高\s*(\d+)\s*%")


def split_trait_stages(desc: str) -> list[str]:
    """把能力描述按「效果结束时」拆成顺序阶段，返回独立段文本列表。"""
    text = (desc or "").strip()
    if not text:
        return []
    parts = re.split(r"效果结束时[，,]\s*", text)
    return [p.strip().strip("\n") for p in parts if p.strip()]


def star_value(base: int, pct: int, star: int) -> tuple[int, int]:
    """返回 (最终值, 能力加成部分)。"""
    num, den = STAR_MULT.get(star, (1, 1))
    star_base = base * num // den
    final = star_base * (100 + pct) // 100
    return final, final - star_base


def _split_clauses(desc: str) -> list[str]:
    parts = re.split(r"[，；。、\n]+|\s+", desc)
    return [p.strip() for p in parts if p.strip()]


def _resolve_condition(
    active_condition, tag_map: dict | None, series_by_id: dict | None
) -> str:
    cond = active_condition or {}
    parts: list[str] = []
    target = cond.get("target") or ""
    if target in TARGET_LABEL:
        parts.append(TARGET_LABEL[target])
    tags: list[str] = []
    if tag_map:
        for tid in str(cond.get("unit_tags") or "").split(","):
            tid = tid.strip()
            if tid and tid.isdigit() and int(tid) in tag_map:
                tags.append(tag_map[int(tid)])
    series: list[str] = []
    if series_by_id:
        for sid in str(cond.get("unit_series") or "").split(","):
            sid = sid.strip()
            if sid and sid.isdigit() and int(sid) in series_by_id:
                series.append(series_by_id[int(sid)])
    if tags:
        parts.append("标签：" + "、".join(tags))
    if series:
        parts.append("系列：" + "、".join(series))
    if not tags and not series:
        return ""
    role = cond.get("unit_role")
    if role is not None and str(role).isdigit() and int(role) in UNIT_ROLE_NAMES:
        parts.append("类型：" + UNIT_ROLE_NAMES[int(role)])
    return " · ".join(parts)


def parse_ability_stat_bonuses(
    desc: str,
    kind: str,
    active_condition=None,
    tag_map: dict | None = None,
    series_by_id: dict | None = None,
) -> tuple[dict, list[dict]]:
    """从能力效果描述解析属性百分比加成。

    返回 (无条件加成 {stat: pct}, 条件加成 [{name, stat, pct, condition}])。
    kind 为 "unit" 或 "character"。
    """
    keywords = UNIT_STAT_KEYWORDS if kind == "unit" else CHAR_STAT_KEYWORDS
    clauses = _split_clauses(desc or "")
    uncond: dict[str, int] = {}
    conds: list[dict] = []
    for i, clause in enumerate(clauses):
        m = _PCT_RE.search(clause)
        if not m:
            continue
        if "赋予" in clause or "对同部队" in clause or "对部队" in clause:
            continue
        keys = [k for kw, k in keywords.items() if kw in clause]
        if _ALL_STAT_HINT in clause:
            keys = list(keywords.values())
        if not keys:
            continue
        pct = int(m.group(1))
        # 如果描述中包含「最高X%」，用 X 替代（如"攻击力提升3%（最高15%）"→ pct=15）
        max_m = _MAX_PCT_RE.search(clause)
        if max_m:
            pct = int(max_m.group(1))
        leading = [c for c in clauses[:i] if c]
        is_cond = any(h in clause for h in _CONDITION_HINTS) or any(
            h in c for c in leading for h in _CONDITION_HINTS
        )
        if not is_cond:
            for key in keys:
                uncond[key] = uncond.get(key, 0) + pct
            continue
        text = _resolve_condition(active_condition, tag_map, series_by_id)
        if not text:
            text = " · ".join(leading) if leading else clause
        text, _ = resolve_trait_text(text, active_condition, tag_map, series_by_id)
        # 提取 HP 范围用于互斥判断
        cond = active_condition or {}
        hp_gte = cond.get("hp_rate_gte_threshold") or 0
        hp_lte = cond.get("hp_rate_lte_threshold") or 0
        has_hp_cond = hp_gte > 0 or hp_lte > 0
        for key in keys:
            conds.append({
                "stat": key, "pct": pct, "condition": text,
                "hp_gte": hp_gte, "hp_lte": hp_lte, "has_hp_cond": has_hp_cond,
            })
    return uncond, conds

# 武器攻击属性：决定武器依靠驾驶员哪项属性
ATTACK_ATTR = {
    1: "射击",
    2: "格斗",
    3: "特殊",
    4: "特殊",
    5: "特殊",
    6: "特殊",
    7: "EX",
}
ATTACK_ATTR_STAT = {
    1: "射击值",
    2: "格斗值",
    3: "觉醒值",
}

# 依赖取值规则：1=射击、2=格斗、3=觉醒、
# 4=格斗/射击最高值、5=射击/觉醒最高值、6=格斗/觉醒最高值、7=三者最高值
ATTACK_ATTR_STATS = {
    1: ("ranged",),
    2: ("melee",),
    3: ("awaken",),
    4: ("melee", "ranged"),
    5: ("ranged", "awaken"),
    6: ("melee", "awaken"),
    7: ("ranged", "melee", "awaken"),
}

ATTACK_ATTR_DEP_LABEL = {
    1: "射击值",
    2: "格斗值",
    3: "觉醒值",
    4: "格斗/射击最高值",
    5: "射击/觉醒最高值",
    6: "格斗/觉醒最高值",
    7: "射击/格斗/觉醒最高值",
}

def attack_attr_value(stats: dict, attack_attr: int):
    """按攻击属性规则取驾驶员依赖值（射击/格斗/觉醒 单项或最高值）。"""
    keys = ATTACK_ATTR_STATS.get(attack_attr or 0)
    if not keys:
        return None
    vals = [stats.get(k) for k in keys if stats.get(k) is not None]
    return max(vals) if vals else None


# 武器伤害类型
WEAPON_ATTR = {
    1: "实弹",
    2: "光束",
    3: "特殊",
    4: "特殊招式",
    5: "特殊招式",
    6: "EX",
}

SUPPORTER_SKILL_TYPE = {"leader": "队长技", "active": "主动技"}
ACQUISITION_ROUTE = {1: "扭蛋", 2: "活动", 3: "商店", 4: "其他"}
TARGET_LABEL = {"Owner": "自身", "SameGroup": "同组"}
UNIT_ROLE_NAMES = {1: "攻击型", 2: "耐久型", 3: "支援型"}


def resolve_trait_text(
    desc: str, active_condition, tag_by_id, series_by_id, unit_by_id=None
):
    """把效果文本里的 上述“类型/标签/系列” 占位符替换为实际指定名称。

    返回 (替换后的文本, 实体列表 [{kind, name, id}])。
    """
    cond = active_condition or {}
    text = desc or ""
    tag_items: list[tuple] = []
    series_items: list[tuple] = []
    type_items: list[tuple] = []
    unit_items: list[tuple] = []

    for tid in str(cond.get("unit_tags") or "").split(","):
        tid = tid.strip()
        if tid and tid.isdigit() and int(tid) in (tag_by_id or {}):
            name = tag_by_id[int(tid)]
            if (int(tid), name) not in tag_items:
                tag_items.append((int(tid), name))
    series_obj = cond.get("series")
    if isinstance(series_obj, dict) and series_obj.get("name"):
        series_items.append((series_obj.get("id"), series_obj["name"]))
    for sid in str(cond.get("unit_series") or "").split(","):
        sid = sid.strip()
        if sid and sid.isdigit() and int(sid) in (series_by_id or {}):
            name = series_by_id[int(sid)]
            if (int(sid), name) not in series_items:
                series_items.append((int(sid), name))
    role = cond.get("unit_role")
    if role is not None and str(role).isdigit() and int(role) in UNIT_ROLE_NAMES:
        type_items.append((int(role), UNIT_ROLE_NAMES[int(role)]))
    for uid in str(cond.get("unit_ids") or "").split(","):
        uid = uid.strip()
        if uid and uid.isdigit() and int(uid) in (unit_by_id or {}):
            name = unit_by_id[int(uid)]
            if (int(uid), name) not in unit_items:
                unit_items.append((int(uid), name))

    tag_names = [n for _, n in tag_items]
    series_names = [n for _, n in series_items]
    type_names = [n for _, n in type_items]
    unit_names = [n for _, n in unit_items]

    def repl(m):
        kind = m.group(1)
        if "标签／系列" in kind or "标签/系列" in kind:
            names = tag_names + series_names
            return "、".join(names) if names else kind
        if kind in ("类型", "タイプ"):
            return "、".join(type_names) if type_names else kind
        if kind == "标签":
            return "、".join(tag_names) if tag_names else kind
        if kind == "系列":
            return "、".join(series_names) if series_names else kind
        return kind

    text = re.sub(
        r"上述\s*[“”‘’\"'『』]?(标签／系列|标签/系列|类型|标签|系列)[“”‘’\"'『』]?",
        repl,
        text,
    )
    entities: list[dict] = [
        {"kind": "tag", "name": n, "id": i} for i, n in tag_items
    ] + [
        {"kind": "series", "name": n, "id": i} for i, n in series_items
    ] + [
        {"kind": "type", "name": n, "id": i} for i, n in type_items
    ] + [
        {"kind": "unit", "name": n, "id": i} for i, n in unit_items
    ]
    return text, entities


def parse_weapon_effects(growth_traits) -> list[dict]:
    """从 weapon_status.growth.traits 提取武器特效，按 trait.id 去重并保留最高等级。"""
    best: dict[int, dict] = {}
    for item in growth_traits or []:
        if not isinstance(item, dict):
            continue
        tr = item.get("trait") or {}
        tid = tr.get("id")
        if tid is None:
            continue
        level = item.get("current_weapon_level")
        cur = best.get(tid)
        if cur is None or (level or 0) > (cur.get("level") or 0):
            best[tid] = {
                "level": level,
                "name": tr.get("name") or "",
                "desc": tr.get("desc") or "",
            }
    return sorted(
        best.values(),
        key=lambda x: (x.get("level") or 0, x.get("name") or ""),
    )


def parse_weapon_max_level(weapon_status: dict) -> dict:
    """从 weapon_status 计算武器最高级数值与最高级特效。

    属性成长（stats_change）固定为 1~5 级；SSP 武器的特效最高到 9 级，
    故最高级 = 特效最高等级（无特效时取属性最高等级），
    属性取 stats_change 最高级修正，特效取最高级槽位。
    数值 = floor(基础值 × 修正率 / 100)。
    """
    growth = (weapon_status or {}).get("growth") or {}
    changes = growth.get("stats_change") or []
    top_change = None
    max_stats_level = 0
    for c in changes:
        lvl = c.get("weapon_level") or 0
        if lvl > max_stats_level:
            max_stats_level = lvl
            top_change = c
    traits = growth.get("traits") or []
    max_trait_level = max(
        (t.get("current_weapon_level") or 0 for t in traits),
        default=0,
    )
    max_level = max(max_trait_level, max_stats_level)
    rates = top_change or {}
    power = weapon_status.get("power") or 0
    en = weapon_status.get("en") or 0
    hit = weapon_status.get("hit_rate") or 0
    crit = weapon_status.get("critical_rate") or 0

    def scale(base: int, rate_key: str) -> int:
        return base * (rates.get(rate_key) or 100) // 100

    effects = []
    top_traits = [
        t for t in growth.get("traits") or []
        if (t.get("current_weapon_level") or 0) == max_trait_level
    ]
    for t in sorted(top_traits, key=lambda x: x.get("slot_number") or 0):
        tr = t.get("trait") or {}
        effects.append({
            "slot": t.get("slot_number"),
            "name": tr.get("name") or "",
            "desc": tr.get("desc") or "",
        })
    return {
        "level": max_level,
        "power": scale(power, "power_correction_rate"),
        "en": scale(en, "en_correction_rate"),
        "hit": scale(hit, "hit_rate_correction_rate"),
        "crit": scale(crit, "crit_correction_rate"),
        "effects": effects,
    }


def parse_supporter_conditions(
    skills, series_by_id: dict, tag_by_id: dict
) -> tuple[list[dict], list[str]]:
    """解析支援角色队长技的 trait_condition，返回 (条件描述列表, 可搜索标签列表)。"""
    conditions: list[dict] = []
    tags: set[str] = set()
    for sk in skills or []:
        for cond in sk.get("trait_condition") or []:
            parts: list[str] = []
            target = cond.get("target") or ""
            if target in TARGET_LABEL:
                parts.append(TARGET_LABEL[target])
            cond_series: list[str] = []
            cond_series_ids: list[int] = []
            cond_tags: list[str] = []
            series = cond.get("series")
            if isinstance(series, dict) and series.get("name"):
                if series["name"] not in cond_series:
                    cond_series.append(series["name"])
                    if series.get("id") is not None:
                        cond_series_ids.append(int(series["id"]))
                tags.add(series["name"])
            for sid in str(cond.get("unit_series") or "").split(","):
                sid = sid.strip()
                if sid and sid.isdigit() and int(sid) in series_by_id:
                    name = series_by_id[int(sid)]
                    if name not in cond_series:
                        cond_series.append(name)
                        cond_series_ids.append(int(sid))
                    tags.add(name)
            for tid in str(cond.get("unit_tags") or "").split(","):
                tid = tid.strip()
                if tid and tid.isdigit() and int(tid) in tag_by_id:
                    name = tag_by_id[int(tid)]
                    if name not in cond_tags:
                        cond_tags.append(name)
            if cond_series:
                parts.append("系列：" + "、".join(cond_series))
            if cond_tags:
                parts.append("标签：" + "、".join(cond_tags))
                tags.update(cond_tags)
            if parts:
                conditions.append({
                    "target": TARGET_LABEL.get(target, target),
                    "text": " · ".join(parts),
                    "series": cond_series,
                    "series_ids": cond_series_ids,
                    "tags": cond_tags,
                })
    return conditions, sorted(tags)


SUPPORT_ORDER = ("defense", "attack", "extra")
SUPPORT_NAMES = {"defense": "支援防御", "attack": "支援攻击", "extra": "额外行动"}


def support_label(info) -> str:
    """支援次数标签，如 无条件支援防御2次 / 有条件支援攻击2次。"""
    info = info or {}
    for k in SUPPORT_ORDER:
        item = info.get(k) or {}
        if item.get("count"):
            cond = "有条件" if item.get("cond") else "无条件"
            return f"{cond}{SUPPORT_NAMES[k]}{item['count']}次"
    return ""
