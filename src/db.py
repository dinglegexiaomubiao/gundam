"""原始 JSON -> SQLite 规范化入库。"""
from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

from . import config
from .labels import (
    STAR_LABEL,
    STAR_MULT,
    parse_ability_stat_bonuses,
    parse_supporter_conditions,
    parse_weapon_max_level,
)

SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS series (
  id INTEGER PRIMARY KEY,
  world_id INTEGER,
  name TEXT,
  desc TEXT,
  icon TEXT,
  sort INTEGER,
  schedule_id INTEGER,
  scenario_stage_series_id INTEGER,
  lane_number INTEGER,
  difficulty_index INTEGER,
  recommended_combat_power INTEGER,
  raw_path TEXT
);

CREATE TABLE IF NOT EXISTS faction (
  id INTEGER PRIMARY KEY,
  name TEXT
);

CREATE TABLE IF NOT EXISTS tag (
  id INTEGER PRIMARY KEY,
  name TEXT
);

CREATE TABLE IF NOT EXISTS unit (
  id INTEGER PRIMARY KEY,
  rarity INTEGER,
  name TEXT,
  short_name TEXT,
  models TEXT,
  desc TEXT,
  icon TEXT,
  series_id INTEGER,
  series_ids TEXT,
  role INTEGER,
  acquisition INTEGER,
  area INTEGER,
  body_type INTEGER,
  tr INTEGER,
  defend INTEGER,
  evade INTEGER,
  ult INTEGER,
  hp INTEGER, en INTEGER, attack INTEGER, defense INTEGER, mobility INTEGER, movement INTEGER,
  max_hp INTEGER, max_en INTEGER, max_attack INTEGER, max_defense INTEGER, max_mobility INTEGER, max_movement INTEGER,
  sp_hp INTEGER, sp_en INTEGER, sp_attack INTEGER, sp_defense INTEGER, sp_mobility INTEGER, sp_movement INTEGER,
  sp_max_hp INTEGER, sp_max_en INTEGER, sp_max_attack INTEGER, sp_max_defense INTEGER, sp_max_mobility INTEGER, sp_max_movement INTEGER,
  ssp_hp INTEGER, ssp_en INTEGER, ssp_attack INTEGER, ssp_defense INTEGER, ssp_mobility INTEGER, ssp_movement INTEGER,
  ssp_max_hp INTEGER, ssp_max_en INTEGER, ssp_max_attack INTEGER, ssp_max_defense INTEGER, ssp_max_mobility INTEGER, ssp_max_movement INTEGER,
  terrain TEXT,
  tags TEXT,
  transform_to TEXT,
  mechanism_set INTEGER,
  base_skill INTEGER,
  main_unit INTEGER,
  stat_bonuses TEXT,
  conditional_bonuses TEXT,
  raw_path TEXT
);

CREATE TABLE IF NOT EXISTS unit_weapon (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id INTEGER,
  weapon_id INTEGER,
  sort INTEGER,
  name TEXT,
  type INTEGER,
  work_type INTEGER,
  attack_attr INTEGER,
  weapon_attr INTEGER,
  weapon_capability INTEGER,
  weapon_effect INTEGER,
  weapon_level_up_material INTEGER,
  range_min INTEGER,
  range_max INTEGER,
  power INTEGER,
  en INTEGER,
  hit_rate INTEGER,
  critical_rate INTEGER,
  power_lv5 INTEGER,
  en_lv5 INTEGER,
  hit_lv5 INTEGER,
  crit_lv5 INTEGER,
  weapon_max_level INTEGER,
  map_weapon_range TEXT,
  map_weapon_desc INTEGER,
  map_weapon_trait INTEGER,
  map_weapon_can_use_after_move INTEGER,
  is_full_animation INTEGER,
  weapon_effects TEXT,
  UNIQUE(unit_id, weapon_id),
  FOREIGN KEY (unit_id) REFERENCES unit(id)
);
CREATE INDEX IF NOT EXISTS idx_unit_weapon_unit ON unit_weapon(unit_id);

CREATE TABLE IF NOT EXISTS unit_ability (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id INTEGER,
  ability_id INTEGER,
  sort INTEGER,
  name TEXT,
  desc TEXT,
  ability_type INTEGER,
  buff_debuff INTEGER,
  is_stackable INTEGER,
  stack_limit INTEGER,
  traits TEXT,
  UNIQUE(unit_id, ability_id),
  FOREIGN KEY (unit_id) REFERENCES unit(id)
);
CREATE INDEX IF NOT EXISTS idx_unit_ability_unit ON unit_ability(unit_id);

CREATE TABLE IF NOT EXISTS unit_skill (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id INTEGER,
  skill_id INTEGER,
  sort INTEGER,
  name TEXT,
  desc TEXT,
  sp INTEGER,
  duration INTEGER,
  traits TEXT,
  UNIQUE(unit_id, skill_id),
  FOREIGN KEY (unit_id) REFERENCES unit(id)
);

CREATE TABLE IF NOT EXISTS character (
  id INTEGER PRIMARY KEY,
  rarity INTEGER,
  role INTEGER,
  is_playable INTEGER,
  name TEXT,
  sort_name TEXT,
  abbreviation TEXT,
  desc TEXT,
  icon TEXT,
  series_set_id INTEGER,
  main_character_id INTEGER,
  acquisition INTEGER,
  acquisition_voice TEXT,
  killed_quote TEXT,
  voice_resource_id TEXT,
  ranged INTEGER, melee INTEGER, defense INTEGER, reaction INTEGER, awaken INTEGER,
  max_ranged INTEGER, max_melee INTEGER, max_defense INTEGER, max_reaction INTEGER, max_awaken INTEGER,
  sp_ranged INTEGER, sp_melee INTEGER, sp_defense INTEGER, sp_reaction INTEGER, sp_awaken INTEGER,
  sp_max_ranged INTEGER, sp_max_melee INTEGER, sp_max_defense INTEGER, sp_max_reaction INTEGER, sp_max_awaken INTEGER,
  series_id INTEGER,
  tags TEXT,
  series_ids TEXT,
  stat_bonuses TEXT,
  conditional_bonuses TEXT,
  raw_path TEXT
);

CREATE TABLE IF NOT EXISTS character_skill (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER,
  character_skill_id INTEGER,
  sort INTEGER,
  level INTEGER,
  name TEXT,
  desc TEXT,
  sp INTEGER,
  duration INTEGER,
  is_auto_usage INTEGER,
  auto_usage_priority INTEGER,
  traits TEXT,
  UNIQUE(character_id, character_skill_id),
  FOREIGN KEY (character_id) REFERENCES character(id)
);
CREATE INDEX IF NOT EXISTS idx_char_skill_char ON character_skill(character_id);

CREATE TABLE IF NOT EXISTS character_ability (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER,
  ability_id INTEGER,
  sort INTEGER,
  level INTEGER,
  name TEXT,
  desc TEXT,
  ability_type INTEGER,
  traits TEXT,
  UNIQUE(character_id, ability_id),
  FOREIGN KEY (character_id) REFERENCES character(id)
);
CREATE INDEX IF NOT EXISTS idx_char_ability_char ON character_ability(character_id);

CREATE TABLE IF NOT EXISTS supporter (
  id INTEGER PRIMARY KEY,
  rarity INTEGER,
  name TEXT,
  sort_name TEXT,
  desc TEXT,
  icon TEXT,
  max_hp_addition_value INTEGER,
  max_attack_addition_value INTEGER,
  limit_break_item_id INTEGER,
  acquisition_route INTEGER,
  obtained_word TEXT,
  tags TEXT,
  raw_path TEXT
);

CREATE TABLE IF NOT EXISTS supporter_growth (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level INTEGER,
  limit_break INTEGER,
  correction_rate REAL,
  UNIQUE(level, limit_break)
);

CREATE TABLE IF NOT EXISTS supporter_skill (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supporter_id INTEGER,
  limit_break_step INTEGER,
  skill_type TEXT,
  name TEXT,
  desc TEXT,
  rarity INTEGER,
  range_type INTEGER,
  effect_range TEXT,
  is_auto_usage INTEGER,
  traits TEXT,
  conditions TEXT,
  FOREIGN KEY (supporter_id) REFERENCES supporter(id)
);

CREATE TABLE IF NOT EXISTS stage (
  id INTEGER PRIMARY KEY,
  stage_type INTEGER,
  stage_category INTEGER,
  icon TEXT,
  name TEXT,
  is_space INTEGER, is_atmospheric INTEGER, is_ground INTEGER, is_surface INTEGER, is_underwater INTEGER,
  sortie_terrain INTEGER,
  stage_terrain INTEGER,
  has_guest INTEGER,
  drop_set INTEGER,
  drop_reward INTEGER,
  first_reward INTEGER,
  first_pickup_reward INTEGER,
  cp INTEGER,
  ap INTEGER,
  condition TEXT,
  map TEXT,
  raw_path TEXT
);

CREATE TABLE IF NOT EXISTS stage_map_npc (
  mid TEXT PRIMARY KEY,
  stage_id INTEGER,
  x INTEGER, y INTEGER,
  step_order INTEGER,
  direction INTEGER,
  battle_side INTEGER,
  is_initially_placed INTEGER,
  is_initially_on_warship INTEGER,
  cannot_capture INTEGER,
  is_story_event_boss INTEGER,
  npc_unique_name TEXT,
  unit_id INTEGER,
  level INTEGER,
  hp INTEGER, en INTEGER, exp INTEGER,
  attack INTEGER, defense INTEGER, mobility INTEGER, movement INTEGER,
  unit_name TEXT,
  FOREIGN KEY (stage_id) REFERENCES stage(id)
);
CREATE INDEX IF NOT EXISTS idx_map_npc_stage ON stage_map_npc(stage_id);

CREATE TABLE IF NOT EXISTS stage_map_npc_character (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mid TEXT,
  stage_id INTEGER,
  character_id INTEGER,
  level INTEGER,
  mp INTEGER,
  generalship INTEGER,
  ranged INTEGER, melee INTEGER, defense INTEGER, reaction INTEGER, awaken INTEGER,
  character_name TEXT,
  UNIQUE(mid),
  FOREIGN KEY (stage_id) REFERENCES stage(id)
);
CREATE INDEX IF NOT EXISTS idx_npc_char_stage ON stage_map_npc_character(stage_id);

CREATE TABLE IF NOT EXISTS story_event (
  event_id INTEGER PRIMARY KEY,
  series_id INTEGER,
  boss_item_id INTEGER,
  boss_skip_limit INTEGER,
  resource_id TEXT,
  medal_type INTEGER,
  medal_id INTEGER,
  reward_set_id INTEGER,
  raw_path TEXT
);

CREATE TABLE IF NOT EXISTS story_event_boss (
  stage_id INTEGER PRIMARY KEY,
  event_id INTEGER,
  difficulty_type INTEGER,
  is_rare_boss INTEGER,
  cost INTEGER,
  turn_limit INTEGER,
  hp_gauge_count INTEGER,
  name TEXT,
  npc TEXT,
  FOREIGN KEY (event_id) REFERENCES story_event(event_id)
);

CREATE TABLE IF NOT EXISTS tower_event (
  event_id INTEGER PRIMARY KEY,
  tower_event_stage_group_id INTEGER,
  sort INTEGER,
  resource_id TEXT,
  name TEXT
);

CREATE TABLE IF NOT EXISTS tower_stage (
  stage_id INTEGER PRIMARY KEY,
  tower_event_id INTEGER,
  floor_number INTEGER,
  floor_count INTEGER,
  tower_event_stage_type_index INTEGER,
  stage_name TEXT,
  FOREIGN KEY (tower_event_id) REFERENCES tower_event(event_id)
);
"""


def _conn() -> sqlite3.Connection:
    config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(config.DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _b(v) -> int | None:
    return None if v is None else (1 if v else 0)


def _i(v):
    return None if v is None else int(v)


def _load_json(path: Path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _series_id(rec) -> int | None:
    for ss in rec.get("series_set") or []:
        s = ss.get("series") or {}
        if s.get("id"):
            return _i(s["id"])
    return _i(rec.get("series"))


def _build_tag_map() -> dict[int, str]:
    """从机体/驾驶员原始数据汇总 tag_id -> tag_name 映射。"""
    tag_map: dict[int, str] = {}
    for p in sorted((config.RAW_DIR / "unit").glob("*.json")):
        if p.name == "min.json":
            continue
        try:
            u = _load_json(p)
        except Exception:
            continue
        if not isinstance(u, dict):
            continue
        for t in u.get("tags") or []:
            tag = t.get("tag") or {}
            tid = _i(tag.get("id"))
            if tid and tag.get("name"):
                tag_map.setdefault(tid, tag["name"])
    for c in _load_json(config.RAW_DIR / "character.json"):
        for t in c.get("tags") or []:
            tag = t.get("tag") or {}
            tid = _i(tag.get("id"))
            if tid and tag.get("name"):
                tag_map.setdefault(tid, tag["name"])
    return tag_map


def ingest_series_faction(conn):
    for s in _load_json(config.RAW_DIR / "series" / "v2.json"):
        conn.execute(
            """INSERT OR REPLACE INTO series
               (id, world_id, name, desc, icon, sort, schedule_id,
                scenario_stage_series_id, lane_number, difficulty_index,
                recommended_combat_power, raw_path)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (_i(s["id"]), _i(s.get("world_id")), s.get("name"), s.get("desc"),
             s.get("icon"), _i(s.get("sort")), _i(s.get("schedule_id")),
             _i(s.get("scenario_stage_series_id")),
             _i((s.get("scenario") or {}).get("lane_number")),
             _i((s.get("scenario") or {}).get("difficulty_index")),
             _i((s.get("scenario") or {}).get("recommended_combat_power")),
             "series/v2.json"),
        )
    for f in _load_json(config.RAW_DIR / "faction.json"):
        conn.execute("INSERT OR REPLACE INTO faction (id, name) VALUES (?,?)",
                     (_i(f["id"]), f.get("name")))


def ingest_units(conn, tag_map: dict[int, str]):
    n = 0
    series_by_id = {
        r[0]: r[1] for r in conn.execute("SELECT id, name FROM series").fetchall()
    }
    for p in sorted((config.RAW_DIR / "unit").glob("*.json")):
        if p.name == "min.json":
            continue
        u = _load_json(p)
        st = u.get("stats") or {}
        terrain = u.get("terrain") or {}
        tags = [t.get("tag", {}).get("name") for t in u.get("tags") or [] if t.get("tag")]
        series_ids = sorted({
            int(s["series_id"])
            for s in u.get("series_set") or []
            if s.get("series_id")
        })
        stat_bonuses: dict[str, int] = {}
        conditional_bonuses: list[dict] = []
        for a in u.get("abilities") or []:
            ab = a.get("ability") or {}
            ab_name = (ab.get("detail") or {}).get("name") or ab.get("name") or ""
            for t in ab.get("traits") or []:
                tr = t.get("trait") or t
                ub, cb = parse_ability_stat_bonuses(
                    tr.get("desc") or "",
                    "unit",
                    tr.get("active_condition"),
                    tag_map,
                    series_by_id,
                )
                for key, pct in ub.items():
                    stat_bonuses[key] = stat_bonuses.get(key, 0) + pct
                for item in cb:
                    item["name"] = ab_name
                    conditional_bonuses.append(item)
        conn.execute(
            """INSERT OR REPLACE INTO unit
               (id, rarity, name, short_name, models, desc, icon, series_id, series_ids, role,
                acquisition, area, body_type, tr, defend, evade, ult,
                hp, en, attack, defense, mobility, movement,
                max_hp, max_en, max_attack, max_defense, max_mobility, max_movement,
                sp_hp, sp_en, sp_attack, sp_defense, sp_mobility, sp_movement,
                sp_max_hp, sp_max_en, sp_max_attack, sp_max_defense, sp_max_mobility, sp_max_movement,
                ssp_hp, ssp_en, ssp_attack, ssp_defense, ssp_mobility, ssp_movement,
                ssp_max_hp, ssp_max_en, ssp_max_attack, ssp_max_defense, ssp_max_mobility, ssp_max_movement,
                terrain, tags, transform_to, mechanism_set, base_skill, main_unit,
                stat_bonuses, conditional_bonuses, raw_path)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (_i(u["id"]), _i(u.get("rarity")), u.get("name"), u.get("short_name"),
             u.get("models"), u.get("desc"), u.get("icon"), _series_id(u),
             json.dumps(series_ids, ensure_ascii=False),
             _i(u.get("role")), _i(u.get("acquisition")), _i(u.get("area")),
             _i(u.get("body_type")), _i(u.get("tr")), _b(u.get("defend")),
             _b(u.get("evade")), _b(u.get("ult")),
             _i(st.get("hp")), _i(st.get("en")), _i(st.get("attack")),
             _i(st.get("defense")), _i(st.get("mobility")), _i(st.get("movement")),
             _i(st.get("max_hp")), _i(st.get("max_en")), _i(st.get("max_attack")),
             _i(st.get("max_defense")), _i(st.get("max_mobility")), _i(st.get("max_movement")),
             _i(st.get("sp_hp")), _i(st.get("sp_en")), _i(st.get("sp_attack")),
             _i(st.get("sp_defense")), _i(st.get("sp_mobility")), _i(st.get("sp_movement")),
             _i(st.get("sp_max_hp")), _i(st.get("sp_max_en")), _i(st.get("sp_max_attack")),
             _i(st.get("sp_max_defense")), _i(st.get("sp_max_mobility")), _i(st.get("sp_max_movement")),
             _i(st.get("ssp_hp")), _i(st.get("ssp_en")), _i(st.get("ssp_attack")),
             _i(st.get("ssp_defense")), _i(st.get("ssp_mobility")), _i(st.get("ssp_movement")),
             _i(st.get("ssp_max_hp")), _i(st.get("ssp_max_en")), _i(st.get("ssp_max_attack")),
             _i(st.get("ssp_max_defense")), _i(st.get("ssp_max_mobility")), _i(st.get("ssp_max_movement")),
             json.dumps(terrain, ensure_ascii=False),
             json.dumps(tags, ensure_ascii=False),
             json.dumps(u.get("transform_to") or [], ensure_ascii=False),
             _i(u.get("mechanism_set")), _i(u.get("base_skill")),
             _i(u.get("main_unit")),
             json.dumps(stat_bonuses, ensure_ascii=False),
             json.dumps(conditional_bonuses, ensure_ascii=False),
             str(p.relative_to(config.RAW_DIR))),
        )
        for w in u.get("weapons") or []:
            wep = w.get("weapon") or {}
            ws = wep.get("weapon_status") or {}
            top = parse_weapon_max_level(ws)
            weapon_effects = top["effects"]
            conn.execute(
                """INSERT OR IGNORE INTO unit_weapon
                   (unit_id, weapon_id, sort, name, type, work_type, attack_attr,
                    weapon_attr, weapon_capability, weapon_effect, weapon_level_up_material,
                    range_min, range_max, power, en, hit_rate, critical_rate,
                    power_lv5, en_lv5, hit_lv5, crit_lv5,
                    weapon_max_level,
                    map_weapon_range, map_weapon_desc, map_weapon_trait,
                    map_weapon_can_use_after_move, is_full_animation, weapon_effects)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (_i(u["id"]), _i(wep.get("id") or ws.get("id")), _i(w.get("sort")),
                 wep.get("name"), _i(wep.get("type")), _i(wep.get("work_type")),
                 _i(wep.get("attack_attr")), _i(wep.get("weapon_attr")),
                 _i(wep.get("weapon_capability")), _i(wep.get("weapon_effect")),
                 _i(wep.get("weapon_level_up_material")),
                 _i(ws.get("range_min")), _i(ws.get("range_max")), _i(ws.get("power")),
                 _i(ws.get("en")), _i(ws.get("hit_rate")), _i(ws.get("critical_rate")),
                 _i(top["power"]), _i(top["en"]), _i(top["hit"]), _i(top["crit"]),
                 _i(top["level"]),
                 ws.get("map_weapon_effect_range"),
                 _i(ws.get("map_weapon_desc")), _i(ws.get("map_weapon_trait")),
                 _b(ws.get("map_weapon_can_use_after_move")), _b(wep.get("is_full_animation")),
                 json.dumps(weapon_effects, ensure_ascii=False)),
            )
        for a in u.get("abilities") or []:
            ab = a.get("ability") or {}
            detail = ab.get("detail") or {}
            traits = [t.get("trait") or t for t in ab.get("traits") or []]
            conn.execute(
                """INSERT OR IGNORE INTO unit_ability
                   (unit_id, ability_id, sort, name, desc, ability_type,
                    buff_debuff, is_stackable, stack_limit, traits)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (_i(u["id"]), _i(ab.get("id")), _i(a.get("sort")),
                 detail.get("name") or ab.get("name"), detail.get("desc"),
                 _i(ab.get("ability_type")), _i(detail.get("buff_debuff")),
                 _b(detail.get("is_stackable")), _i(detail.get("stack_limit")),
                 json.dumps(traits, ensure_ascii=False)),
            )
        for sk in u.get("skills") or []:
            skill = sk.get("skill") or {}
            traits = skill.get("trait_set") or []
            conn.execute(
                """INSERT OR IGNORE INTO unit_skill
                   (unit_id, skill_id, sort, name, desc, sp, duration, traits)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (_i(u["id"]), _i(skill.get("id")), _i(sk.get("sort")),
                 skill.get("name"), skill.get("desc"), _i(skill.get("sp")),
                 _i(skill.get("duration")), json.dumps(traits, ensure_ascii=False)),
            )
        n += 1
    print(f"机体入库 {n} 台")


def ingest_characters(conn, tag_map: dict[int, str]):
    chars = _load_json(config.RAW_DIR / "character.json")
    series_by_id = {
        r[0]: r[1] for r in conn.execute("SELECT id, name FROM series").fetchall()
    }
    for c in chars:
        st = c.get("stats") or {}
        tags = [t.get("tag", {}).get("name") for t in c.get("tags") or [] if t.get("tag")]
        stat_bonuses: dict[str, int] = {}
        conditional_bonuses: list[dict] = []
        for ab in c.get("abilities") or []:
            ability = ab.get("ability") or {}
            ab_name = (ability.get("detail") or {}).get("name") or ability.get("name") or ""
            for t in ability.get("traits") or []:
                tr = t.get("trait") or t
                ub, cb = parse_ability_stat_bonuses(
                    tr.get("desc") or "",
                    "character",
                    tr.get("active_condition"),
                    tag_map,
                    series_by_id,
                )
                for key, pct in ub.items():
                    stat_bonuses[key] = stat_bonuses.get(key, 0) + pct
                for item in cb:
                    item["name"] = ab_name
                    conditional_bonuses.append(item)
        series_id = None
        char_series_ids = set()
        for ss in c.get("series_set") or []:
            if ss.get("series_id"):
                series_id = ss["series_id"]
                char_series_ids.add(int(ss["series_id"]))
        conn.execute(
            """INSERT OR REPLACE INTO character
               (id, rarity, role, is_playable, name, sort_name, abbreviation, desc,
                icon, series_set_id, main_character_id, acquisition,
                acquisition_voice, killed_quote, voice_resource_id,
                ranged, melee, defense, reaction, awaken,
                max_ranged, max_melee, max_defense, max_reaction, max_awaken,
                sp_ranged, sp_melee, sp_defense, sp_reaction, sp_awaken,
                sp_max_ranged, sp_max_melee, sp_max_defense, sp_max_reaction, sp_max_awaken,
                series_id, series_ids, tags, stat_bonuses, conditional_bonuses, raw_path)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (_i(c["id"]), _i(c.get("rarity")), _i(c.get("role")),
             _b(c.get("is_playable")), c.get("name"), c.get("sort_name"),
             c.get("abbreviation"), c.get("desc"), c.get("icon"),
             _i(c.get("series_set_id")), _i(c.get("main_character_id")),
             _i(c.get("acquisition")), c.get("acquisition_voice"),
             c.get("killed_quote"), c.get("voice_resource_id"),
             _i(st.get("ranged")), _i(st.get("melee")), _i(st.get("defense")),
             _i(st.get("reaction")), _i(st.get("awaken")),
             _i(st.get("max_ranged")), _i(st.get("max_melee")),
             _i(st.get("max_defense")), _i(st.get("max_reaction")),
             _i(st.get("max_awaken")),
             _i(st.get("sp_ranged")), _i(st.get("sp_melee")),
             _i(st.get("sp_defense")), _i(st.get("sp_reaction")),
             _i(st.get("sp_awaken")),
             _i(st.get("sp_max_ranged")), _i(st.get("sp_max_melee")),
             _i(st.get("sp_max_defense")), _i(st.get("sp_max_reaction")),
             _i(st.get("sp_max_awaken")),
             series_id,
             json.dumps(sorted(char_series_ids), ensure_ascii=False),
             json.dumps(tags, ensure_ascii=False),
             json.dumps(stat_bonuses, ensure_ascii=False),
             json.dumps(conditional_bonuses, ensure_ascii=False),
             "character.json"),
        )
        for sk in c.get("skills") or []:
            skill = sk.get("skill") or {}
            traits = [t.get("trait") or t for t in skill.get("trait_set") or []]
            conn.execute(
                """INSERT OR IGNORE INTO character_skill
                   (character_id, character_skill_id, sort, level, name, desc, sp,
                    duration, is_auto_usage, auto_usage_priority, traits)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (_i(c["id"]), _i(skill.get("id")), _i(sk.get("sort")),
                 _i(sk.get("level")), skill.get("name"), skill.get("desc"),
                 _i(skill.get("sp")), _i(skill.get("duration")),
                 _b(skill.get("is_auto_usage")), _i(skill.get("auto_usage_priority")),
                 json.dumps(traits, ensure_ascii=False)),
            )
        for ab in c.get("abilities") or []:
            ability = ab.get("ability") or {}
            detail = ability.get("detail") or {}
            traits = [t.get("trait") or t for t in ability.get("traits") or []]
            conn.execute(
                """INSERT OR IGNORE INTO character_ability
                   (character_id, ability_id, sort, level, name, desc, ability_type, traits)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (_i(c["id"]), _i(ability.get("id")), _i(ab.get("sort")),
                 _i(ab.get("level")), detail.get("name") or ability.get("name"),
                 detail.get("desc"), _i(ability.get("ability_type")),
                 json.dumps(traits, ensure_ascii=False)),
            )
    print(f"驾驶员入库 {len(chars)} 人")


def ingest_supporters(conn, tag_map: dict[int, str]):
    supporters = _load_json(config.RAW_DIR / "supporter.json")
    series_by_id = {
        r[0]: r[1] for r in conn.execute("SELECT id, name FROM series").fetchall()
    }
    for s in supporters:
        lb_parsed: list[tuple[dict, list[dict], list[str]]] = []
        all_tags: set[str] = set()
        for lb in s.get("lb_skills") or []:
            leader = lb.get("leader_skill") or {}
            conditions, cond_tags = parse_supporter_conditions(
                leader.get("skills") or [], series_by_id, tag_map
            )
            lb_parsed.append((lb, conditions, cond_tags))
            all_tags.update(cond_tags)
        conn.execute(
            """INSERT OR REPLACE INTO supporter
               (id, rarity, name, sort_name, desc, icon, max_hp_addition_value,
                max_attack_addition_value, limit_break_item_id, acquisition_route,
                obtained_word, tags, raw_path)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (_i(s["id"]), _i(s.get("rarity")), s.get("name"), s.get("sort_name"),
             s.get("desc"), s.get("icon"), _i(s.get("max_hp_addition_value")),
             _i(s.get("max_attack_addition_value")), _i(s.get("limit_break_item_id")),
             _i(s.get("acquisition_route")), s.get("obtained_word"),
             json.dumps(sorted(all_tags), ensure_ascii=False), "supporter.json"),
        )
        for lb, lb_conditions, lb_tags in lb_parsed:
            leader = lb.get("leader_skill") or {}
            active = lb.get("active_skill") or {}
            conn.execute(
                """INSERT INTO supporter_skill
                   (supporter_id, limit_break_step, skill_type, name, desc, rarity,
                    range_type, effect_range, is_auto_usage, traits, conditions)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (_i(s["id"]), _i(lb.get("limit_break_step")), "leader",
                 leader.get("name") or "", leader.get("desc"), _i(leader.get("rarity")),
                 None, None, None,
                 json.dumps(leader.get("skills") or [], ensure_ascii=False),
                 json.dumps(lb_conditions, ensure_ascii=False)),
            )
            conn.execute(
                """INSERT INTO supporter_skill
                   (supporter_id, limit_break_step, skill_type, name, desc, rarity,
                    range_type, effect_range, is_auto_usage, traits, conditions)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (_i(s["id"]), _i(lb.get("limit_break_step")), "active",
                 active.get("name") or "", active.get("desc"), _i(active.get("rarity")),
                 _i(active.get("range_type")), active.get("effect_range"),
                 _b(active.get("is_auto_usage")), "[]", "[]"),
            )
    for g in _load_json(config.RAW_DIR / "supporter_growth.json"):
        conn.execute(
            "INSERT OR IGNORE INTO supporter_growth (level, limit_break, correction_rate) VALUES (?,?,?)",
            (_i(g.get("level")), _i(g.get("limit_break")), g.get("correction_rate")),
        )
    print(f"支援角色入库 {len(supporters)} 个")


def ingest_stages(conn):
    n = npc = npc_char = 0
    for p in sorted((config.RAW_DIR / "stage").glob("*.json")):
        st = _load_json(p)
        conn.execute(
            """INSERT OR REPLACE INTO stage
               (id, stage_type, stage_category, icon, name,
                is_space, is_atmospheric, is_ground, is_surface, is_underwater,
                sortie_terrain, stage_terrain, has_guest, drop_set, drop_reward,
                first_reward, first_pickup_reward, cp, ap, condition, map, raw_path)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (_i(st["id"]), _i(st.get("stage_type")), _i(st.get("stage_category")),
             st.get("icon"), st.get("name"),
             _b(st.get("is_space")), _b(st.get("is_atmospheric")), _b(st.get("is_ground")),
             _b(st.get("is_surface")), _b(st.get("is_underwater")),
             _i(st.get("sortie_terrain")), _i(st.get("stage_terrain")),
             _b(st.get("has_guest")), _i(st.get("drop_set")), _i(st.get("drop_reward")),
             _i(st.get("first_reward")), _i(st.get("first_pickup_reward")),
             _i(st.get("cp")), _i(st.get("ap")),
             json.dumps(st.get("condition") or [], ensure_ascii=False),
             json.dumps(st.get("map") or {}, ensure_ascii=False),
             str(p.relative_to(config.RAW_DIR))),
        )
        for m in (st.get("map") or {}).get("npcs") or []:
            npc_data = m.get("npc") or {}
            unit = npc_data.get("unit") or {}
            conn.execute(
                """INSERT OR REPLACE INTO stage_map_npc
                   (mid, stage_id, x, y, step_order, direction, battle_side,
                    is_initially_placed, is_initially_on_warship, cannot_capture,
                    is_story_event_boss, npc_unique_name, unit_id, level,
                    hp, en, exp, attack, defense, mobility, movement, unit_name)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (str(m.get("mid")), _i(st["id"]), _i(m.get("x")), _i(m.get("y")),
                 _i(m.get("step_order")), _i(m.get("direction")), _i(m.get("battle_side")),
                 _b(m.get("is_initially_placed")), _b(m.get("is_initially_on_warship")),
                 _b(m.get("cannot_capture")), _b(m.get("is_story_event_boss")),
                 m.get("npc_unique_name"), _i(npc_data.get("unit_id")),
                 _i(npc_data.get("level")), _i(npc_data.get("hp")), _i(npc_data.get("en")),
                 _i(npc_data.get("exp")), _i(npc_data.get("attack")),
                 _i(npc_data.get("defense")), _i(npc_data.get("mobility")),
                 _i(npc_data.get("movement")), unit.get("name")),
            )
            npc += 1
            ch = m.get("character") or {}
            base_ch = ch.get("character") or {}
            if ch:
                conn.execute(
                    """INSERT OR IGNORE INTO stage_map_npc_character
                       (mid, stage_id, character_id, level, mp, generalship,
                        ranged, melee, defense, reaction, awaken, character_name)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (str(m.get("mid")), _i(st["id"]), _i(ch.get("character_id")),
                     _i(ch.get("level")), _i(ch.get("mp")), _i(ch.get("generalship")),
                     _i(ch.get("ranged")), _i(ch.get("melee")), _i(ch.get("defense")),
                     _i(ch.get("reaction")), _i(ch.get("awaken")), base_ch.get("name")),
                )
                npc_char += 1
        n += 1
    print(f"关卡入库 {n} 个，敌方机体 {npc} 台，敌方驾驶员 {npc_char} 人")


def ingest_events(conn):
    story = _load_json(config.RAW_DIR / "event/story.json")
    for e in story:
        conn.execute(
            """INSERT OR REPLACE INTO story_event
               (event_id, series_id, boss_item_id, boss_skip_limit, resource_id,
                medal_type, medal_id, reward_set_id, raw_path)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (_i(e.get("event_id")), _i(e.get("series_id")), _i(e.get("boss_item_id")),
             _i(e.get("boss_skip_limit")), e.get("resource_id"),
             _i(e.get("medal_type")), _i(e.get("medal_id")), _i(e.get("reward_set_id")),
             "event/story.json"),
        )
    boss_total = 0
    for p in sorted((config.RAW_DIR / "event/story").glob("*.json")):
        if p.name == "story.json":
            continue
        e = _load_json(p)
        for b in e.get("boss") or []:
            conn.execute(
                """INSERT OR REPLACE INTO story_event_boss
                   (stage_id, event_id, difficulty_type, is_rare_boss, cost,
                    turn_limit, hp_gauge_count, name, npc)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (_i(b.get("stage_id")), _i(e.get("event_id")),
                 _i(b.get("difficulty_type")), _b(b.get("is_rare_boss")),
                 _i(b.get("cost")), _i(b.get("turn_limit")),
                 _i(b.get("hp_gauge_count")), b.get("name"),
                 json.dumps(b.get("npc") or {}, ensure_ascii=False)),
            )
            boss_total += 1
    tower = _load_json(config.RAW_DIR / "event/tower.json")
    for t in tower:
        conn.execute(
            """INSERT OR REPLACE INTO tower_event
               (event_id, tower_event_stage_group_id, sort, resource_id, name)
               VALUES (?,?,?,?,?)""",
            (_i(t.get("event_id")), _i(t.get("tower_event_stage_group_id")),
             _i(t.get("sort")), t.get("resource_id"),
             (t.get("stage_group") or {}).get("name")),
        )
        for st in (t.get("stage_group") or {}).get("stages") or []:
            conn.execute(
                """INSERT OR REPLACE INTO tower_stage
                   (stage_id, tower_event_id, floor_number, floor_count,
                    tower_event_stage_type_index, stage_name)
                   VALUES (?,?,?,?,?,?)""",
                (_i(st.get("stage_id")), _i(t.get("event_id")),
                 _i(st.get("id")), _i(st.get("floor_count")),
                 _i(st.get("tower_event_stage_type_index")), st.get("stage_name")),
            )
    print(f"剧情事件 {len(story)} 个（Boss {boss_total} 个），塔楼事件 {len(tower)} 个")


def build_db() -> None:
    conn = _conn()
    conn.executescript(SCHEMA)
    print("构建 tag_id -> tag_name 映射…")
    tag_map = _build_tag_map()
    conn.executemany(
        "INSERT OR REPLACE INTO tag (id, name) VALUES (?,?)",
        sorted(tag_map.items()),
    )
    ingest_series_faction(conn)
    ingest_units(conn, tag_map)
    ingest_characters(conn, tag_map)
    ingest_supporters(conn, tag_map)
    ingest_stages(conn)
    ingest_events(conn)
    built_at = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('built_at', ?)", (built_at,))
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('star_multipliers', ?)",
        (json.dumps({int(k): v for k, v in STAR_MULT.items()}, ensure_ascii=False),),
    )
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('star_labels', ?)",
        (json.dumps({int(k): v for k, v in STAR_LABEL.items()}, ensure_ascii=False),),
    )
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('star_formula', ?)",
        ("星级基础值=floor(基础值×倍率)；最终值=floor(星级基础值×(1+能力加成%))；倍率 0★=1.0/1★=1.2/2★=1.3/3★=1.4",),
    )
    conn.commit()
    conn.close()
    print(f"数据库已写入 {config.DB_PATH}（{built_at}）")
