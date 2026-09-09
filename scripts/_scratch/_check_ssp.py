import json
import sqlite3
from pathlib import Path

# 1. 找一个低稀有度的机体，查看原始JSON中SSP相关字段
raw_dir = Path('data/raw/zh-CN/unit')
files = list(raw_dir.glob('*.json'))
print(f'机体文件总数: {len(files)}')

# 找一个rarity<5的机体
found = None
for f in files[:50]:
    with open(f, encoding='utf-8') as fh:
        u = json.load(fh)
    if u.get('rarity', 5) < 5:
        found = u
        print(f'\n=== 机体: {u.get("name")}, 稀有度: {u.get("rarity")}, ID: {u.get("id")} ===')
        st = u.get('stats', {})
        ssp_stat_keys = [k for k in st.keys() if 'ssp' in k]
        print(f'stats中的SSP字段: {ssp_stat_keys}')
        # 检查是否有ssp_terrain, ssp_weapons, ssp_abilities
        top_ssp = [k for k in u.keys() if 'ssp' in k.lower()]
        print(f'顶层SSP字段: {top_ssp}')
        terrain_keys = [k for k in u.keys() if 'terrain' in k.lower()]
        print(f'地形相关字段: {terrain_keys}')
        weapon_keys = [k for k in u.keys() if 'weapon' in k.lower()]
        print(f'武器相关字段: {weapon_keys}')
        ability_keys = [k for k in u.keys() if 'abilit' in k.lower()]
        print(f'能力相关字段: {ability_keys}')
        if ssp_stat_keys:
            print(f'SSP stat示例: ssp_hp={st.get("ssp_hp")}, ssp_max_hp={st.get("ssp_max_hp")}')
        # 打印terrain
        print(f'地形数据: {json.dumps(u.get("terrain", {}), ensure_ascii=False)}')
        # 检查weapons数组中的每个武器是否有form字段
        weapons = u.get('weapons', [])
        if weapons:
            w = weapons[0]
            print(f'\n第一个武器的字段: {list(w.keys())}')
            print(f'weapon子字段: {list((w.get("weapon") or {}).keys())[:20]}')
        break

# 2. 查询数据库中的SSP数据情况
print('\n\n=== 数据库查询 ===')
db = sqlite3.connect('data/db/gundam.db')
# 查询有多少机体的ssp字段有非零值
cur = db.execute("SELECT COUNT(*) FROM unit WHERE rarity < 5")
total = cur.fetchone()[0]
print(f'稀有度<5的机体总数: {total}')

cur = db.execute("""
SELECT COUNT(*) FROM unit 
WHERE rarity < 5 AND (ssp_max_hp > 0 OR ssp_max_en > 0 OR ssp_max_attack > 0)
""")
has_ssp = cur.fetchone()[0]
print(f'有SSP属性数据的机体数: {has_ssp}')

# 检查unit_weapon和unit_ability表是否有form字段
cur = db.execute('PRAGMA table_info(unit_weapon)')
cols = [r[1] for r in cur.fetchall()]
print(f'\nunit_weapon字段数: {len(cols)}')
form_cols = [c for c in cols if 'form' in c.lower() or 'ssp' in c.lower() or 'sp' in c.lower()]
print(f'unit_weapon中form/ssp/sp相关字段: {form_cols}')

cur = db.execute('PRAGMA table_info(unit_ability)')
cols = [r[1] for r in cur.fetchall()]
print(f'\nunit_ability字段数: {len(cols)}')
form_cols = [c for c in cols if 'form' in c.lower() or 'ssp' in c.lower() or 'sp' in c.lower()]
print(f'unit_ability中form/ssp/sp相关字段: {form_cols}')

# 检查unit表的terrain字段和是否有ssp_terrain
cur = db.execute('PRAGMA table_info(unit)')
cols = [r[1] for r in cur.fetchall()]
print(f'\nunit表中terrain相关字段: {[c for c in cols if "terrain" in c.lower()]}')

# 查一个具体有SSP数据的机体
if has_ssp > 0:
    cur = db.execute("""
    SELECT id, name, rarity, 
           ssp_hp, ssp_max_hp, ssp_attack, ssp_max_attack
    FROM unit 
    WHERE rarity < 5 AND ssp_max_hp > 0
    LIMIT 1
    """)
    row = cur.fetchone()
    if row:
        print(f'\n有SSP数据的机体示例: ID={row[0]}, 名称={row[1]}, 稀有度={row[2]}')
        print(f'  ssp_hp={row[3]}, ssp_max_hp={row[4]}, ssp_attack={row[5]}, ssp_max_attack={row[6]}')
        # 查这个机体的武器数量
        uid = row[0]
        cur2 = db.execute("SELECT COUNT(*) FROM unit_weapon WHERE unit_id=?", (uid,))
        print(f'  武器数量: {cur2.fetchone()[0]}')
        cur2 = db.execute("SELECT COUNT(*) FROM unit_ability WHERE unit_id=?", (uid,))
        print(f'  能力数量: {cur2.fetchone()[0]}')

db.close()
