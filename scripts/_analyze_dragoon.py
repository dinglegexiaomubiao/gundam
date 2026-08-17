"""分析「攻击型龙骑兵突击高达」的 ssp_config 完整结构。

目标：
1. 确认 rarity、ssp_config.stats 的字段名
2. 搞清 weapon_change 的真实语义（替换 vs 修改属性）
3. 找到 SSP 新增被动能力的存储位置
4. 找到「龙骑兵系统 SSP」武器的来源
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))
from src import config
from src.db import _load_json


def main():
    # 搜索名称含「龙骑兵」的机体
    import sqlite3
    conn = sqlite3.connect(config.DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT id, name, rarity, raw_path FROM unit WHERE name LIKE '%龙骑兵%' OR name LIKE '%攻击型%'"
    ).fetchall()
    print(f"匹配机体: {len(rows)}")
    for r in rows:
        print(f"  id={r['id']}  rarity={r['rarity']}  {r['name']}  raw={r['raw_path']}")
    conn.close()

    if not rows:
        return

    # 取第一台分析
    target = rows[0]
    print(f"\n{'='*70}")
    print(f"分析: id={target['id']}  {target['name']}  rarity={target['rarity']}")
    print(f"{'='*70}")

    raw = _load_json(config.RAW_DIR / target["raw_path"])

    # 1. 顶层 stats
    st = raw.get("stats") or {}
    print(f"\n--- 顶层 stats ---")
    for k in sorted(st.keys()):
        print(f"  {k} = {st[k]}")

    # 2. ssp_config.stats
    sc = raw.get("ssp_config") or {}
    sst = sc.get("stats") or {}
    print(f"\n--- ssp_config.stats ---")
    for k in sorted(sst.keys()):
        print(f"  {k} = {sst[k]}")

    # 3. ssp_config.cores 结构
    print(f"\n--- ssp_config.cores (release_function_type_index 含义) ---")
    for ci, core in enumerate(sc.get("cores") or []):
        print(f"\n  [core #{ci}]")
        for ri, rel in enumerate(core.get("releases") or []):
            t = rel.get("release_function_type_index")
            keys = list(rel.keys())
            print(f"    [release #{ri}] type={t}  keys={keys}")
            # 武器变更
            if t == 5:
                wc = rel.get("weapon_change") or {}
                print(f"      weapon_change keys: {list(wc.keys())}")
                print(f"      before_weapon_id={wc.get('before_weapon_id')}  after_weapon_id={wc.get('after_weapon_id')}")
                wep = wc.get("weapon") or {}
                ws = wep.get("weapon_status") or {}
                print(f"      weapon.name={wep.get('name')}  weapon.id={wep.get('id')}")
                print(f"      weapon_status: range_min={ws.get('range_min')} range_max={ws.get('range_max')} power={ws.get('power')} en={ws.get('en')}")
            # 能力变更
            if "ability_change" in rel or "ability_add" in rel or "ability" in rel:
                ac = rel.get("ability_change") or rel.get("ability_add") or {}
                ab = ac.get("ability") or rel.get("ability") or {}
                detail = ab.get("detail") or {}
                print(f"      ability_change/add: before={ac.get('before_ability_id')} after={ac.get('after_ability_id')}")
                print(f"      ability.name={detail.get('name') or ab.get('name')}  desc={detail.get('desc')}")
            # 地形变更
            if t == 4:
                tr = rel.get("terrain") or {}
                print(f"      terrain={tr}")
            # 其他 type 的 release 也打印 keys
            if t not in (4, 5):
                # 打印所有非空子节点的 keys
                for k in keys:
                    if k in ("release_function_type_index", "sort_order"):
                        continue
                    v = rel.get(k)
                    if isinstance(v, dict):
                        print(f"      {k} keys: {list(v.keys())}")

    # 4. initial_release
    ir = sc.get("initial_release") or {}
    print(f"\n--- ssp_config.initial_release ---")
    print(f"  keys: {list(ir.keys())}")
    ac = ir.get("ability_change") or {}
    if ac:
        print(f"  ability_change: before={ac.get('before_ability_id')} after={ac.get('after_ability_id')}")
        ab = ac.get("ability") or {}
        detail = ab.get("detail") or {}
        print(f"  ability.name={detail.get('name') or ab.get('name')}")
        print(f"  ability.desc={detail.get('desc')}")

    # 5. 顶层 ssp_weapon 列表
    sw_list = raw.get("ssp_weapon") or []
    print(f"\n--- 顶层 ssp_weapon ({len(sw_list)} 条) ---")
    for sw in sw_list:
        print(f"  {sw}")

    # 6. 数据库里这台机体的 unit_weapon
    conn = sqlite3.connect(config.DB_PATH)
    conn.row_factory = sqlite3.Row
    wrows = conn.execute(
        "SELECT weapon_id, name, range_min, range_max, power, sort FROM unit_weapon WHERE unit_id=? ORDER BY sort",
        (target["id"],),
    ).fetchall()
    print(f"\n--- 数据库 unit_weapon ({len(wrows)} 条) ---")
    for w in wrows:
        print(f"  id={w['weapon_id']}  name={w['name']}  range={w['range_min']}~{w['range_max']}  power={w['power']}")
    conn.close()


if __name__ == "__main__":
    main()
