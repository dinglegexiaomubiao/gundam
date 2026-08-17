"""一次性脚本：回填 unit 表 ssp_* 属性字段。

原因：src/db.py ingest_units 之前从 u['stats'] 读取 ssp_hp 等字段，
但原始 JSON 中 u['stats'] 根本没有 ssp_* 字段（只有 sp_*）。
SSP 属性实际位于 u['ssp_config']['stats']。

此脚本读取对应 raw JSON，修正所有低稀有度机体的 ssp_* 字段。
同时会 ALTER TABLE unit 增加 ssp_terrain 列（JSON），如果不存在则创建。
"""
from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

# 允许直接运行（脚本方式）
_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))
from src.db import _conn, _i, _load_json
from src import config


def add_ssp_terrain_column(conn):
    """如果 unit 表缺少 ssp_terrain 列则添加。"""
    cols = [r[1] for r in conn.execute('PRAGMA table_info(unit)').fetchall()]
    if 'ssp_terrain' not in cols:
        conn.execute('ALTER TABLE unit ADD COLUMN ssp_terrain TEXT')
        print('已添加列: unit.ssp_terrain')
    else:
        print('列已存在: unit.ssp_terrain')


def collect_ssp_info(u: dict) -> dict:
    """从 raw JSON 提取 SSP 属性、地形、移动力增量。"""
    out = {
        'stats': {},
        'terrain': None,
    }
    sc = u.get('ssp_config') or {}
    sst = sc.get('stats') or {}
    for k, v in sst.items():
        if k != 'id':
            out['stats'][k] = v
    # cores -> releases
    for core in sc.get('cores') or []:
        for rel in core.get('releases') or []:
            t = rel.get('release_function_type_index')
            if t == 4:  # 地形替换
                tr = rel.get('terrain')
                if tr and isinstance(tr, dict):
                    out['terrain'] = {
                        'space': tr.get('space'),
                        'atmospheric': tr.get('atmospheric'),
                        'ground': tr.get('ground'),
                        'surface': tr.get('surface'),
                        'underwater': tr.get('underwater'),
                    }
            elif t == 3:  # status_up: 移动力等属性增量
                su = rel.get('status_up') or {}
                idx = su.get('unit_status_type_index')
                val = su.get('effect_value') or 0
                if idx == 6 and val:  # movement
                    out['stats']['ssp_movement'] = val
                    out['stats']['ssp_max_movement'] = val
    return out


def main():
    if not config.DB_PATH.exists():
        print(f'数据库不存在: {config.DB_PATH}')
        return 1

    conn = _conn()
    add_ssp_terrain_column(conn)

    # 获取所有机体 raw_path
    rows = conn.execute('SELECT id, rarity, raw_path FROM unit').fetchall()
    total = len(rows)
    print(f'共 {total} 台机体')

    updated = 0
    ssp_terrain_count = 0
    errors = []

    for uid, rarity, raw_path in rows:
        try:
            p = config.RAW_DIR / raw_path
            if not p.exists():
                continue
            u = _load_json(p)
            info = collect_ssp_info(u)
            sst = info['stats']
            if not sst and info['terrain'] is None:
                continue
            # UPDATE 相关字段
            fields = []
            params = []
            for dbk, jsk in [
                ('ssp_hp', 'ssp_hp'), ('ssp_en', 'ssp_en'),
                ('ssp_attack', 'ssp_attack'), ('ssp_defense', 'ssp_defense'),
                ('ssp_mobility', 'ssp_mobility'), ('ssp_movement', 'ssp_movement'),
                ('ssp_max_hp', 'ssp_max_hp'), ('ssp_max_en', 'ssp_max_en'),
                ('ssp_max_attack', 'ssp_max_attack'), ('ssp_max_defense', 'ssp_max_defense'),
                ('ssp_max_mobility', 'ssp_max_mobility'), ('ssp_max_movement', 'ssp_max_movement'),
            ]:
                if jsk in sst:
                    fields.append(f'{dbk}=?')
                    params.append(_i(sst[jsk]))
            if info['terrain'] is not None:
                fields.append('ssp_terrain=?')
                params.append(json.dumps(info['terrain'], ensure_ascii=False))
                ssp_terrain_count += 1
            if fields:
                params.append(uid)
                conn.execute(f'UPDATE unit SET {", ".join(fields)} WHERE id=?', params)
                updated += 1
                if updated % 100 == 0:
                    conn.commit()
                    print(f'  已处理 {updated}/{total}（有SSP地形: {ssp_terrain_count}）')
        except Exception as exc:
            errors.append((uid, str(exc)))
            if len(errors) < 5:
                print(f'[WARN] uid={uid}: {exc}')

    conn.commit()

    # 验证
    cur = conn.execute("""
        SELECT COUNT(*) FROM unit WHERE rarity < 5
    """)
    total_low = cur.fetchone()[0]
    cur = conn.execute("""
        SELECT COUNT(*) FROM unit
        WHERE rarity < 5 AND (ssp_max_hp > 0 OR ssp_max_en > 0 OR ssp_max_attack > 0)
    """)
    ssp_has = cur.fetchone()[0]
    cur = conn.execute("SELECT COUNT(*) FROM unit WHERE ssp_terrain IS NOT NULL AND ssp_terrain <> '' AND ssp_terrain <> '{}'")
    terr_has = cur.fetchone()[0]
    conn.close()

    print(f'\\n完成！')
    print(f'  低稀有度机体（rarity<5）: {total_low}')
    print(f'  已更新SSP属性的机体: {updated}')
    print(f'  当前数据库有SSP属性数据(非0): {ssp_has}')
    print(f'  有SSP地形数据的机体: {terr_has}')
    if errors:
        print(f'  错误数量: {len(errors)}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
