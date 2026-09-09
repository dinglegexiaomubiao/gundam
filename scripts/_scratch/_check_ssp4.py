import json
import sqlite3
from pathlib import Path

print('=== 1. 更详细了解ssp_config中的完整结构 ===')
raw_dir = Path('data/raw/zh-CN/unit')
for f in list(raw_dir.glob('*.json'))[:50]:
    with open(f, encoding='utf-8') as fh:
        u = json.load(fh)
    if u.get('ssp_config'):
        sc = u.get('ssp_config', {})
        print(f'机体: {u.get("name")}')
        print(f'  ssp_config顶层keys: {list(sc.keys())}')
        ir = sc.get('initial_release', {})
        print(f'  initial_release keys: {list(ir.keys())}')
        for k, v in ir.items():
            if 'ability' in k.lower() or 'terrain' in k.lower() or 'status' in k.lower() or 'change' in k.lower():
                if isinstance(v, dict):
                    print(f'    {k} keys: {list(v.keys())}')
                    # ability_change
                    if 'ability' in k.lower():
                        ab = v.get('ability', {})
                        detail = ab.get('detail', {})
                        print(f'      ability: id={ab.get("id")}, name={detail.get("name")}')
                        b4 = v.get('before_ability_id')
                        print(f'      替换: {b4} -> {v.get("after_ability_id")}')
        # 查看所有cores的release_function_type_index分布
        type_counts = {}
        ability_changes = []
        terrain_changes = []
        for core in sc.get('cores', []):
            for rel in core.get('releases', []):
                t = rel.get('release_function_type_index')
                type_counts[t] = type_counts.get(t, 0) + 1
                if t in (2, 3, 4, 6, 7, 8):
                    # 可能是能力/地形变更
                    for k in rel.keys():
                        if 'abilit' in k.lower() or 'terrain' in k.lower() or 'trait' in k.lower():
                            ability_changes.append(f'type={t}: {k}={json.dumps(rel[k], ensure_ascii=False)[:200]}')
        print(f'  cores releases类型统计: {type_counts}')
        if ability_changes:
            print(f'  疑似能力/地形变更:')
            for a in ability_changes[:3]:
                print(f'    {a}')

        # 检查sp_config结构 (如果有的话)
        spc = u.get('sp_config')
        if spc:
            print(f'  sp_config存在: keys={list(spc.keys())}')
            sst = spc.get('stats')
            if sst:
                print(f'    sp_config.stats: {list(sst.keys())}')

        print()
        break

print('\\n=== 2. 查看webapp.py后端给前端返回的weapons/abilities/terrain是否区分form ===')
db = sqlite3.connect('data/db/gundam.db')
# 查看unit_weapon中有没有ssp武器（weapon_id是否有90结尾之类的）
cur = db.execute("""
SELECT u.id, u.name, COUNT(w.weapon_id), 
       SUM(CASE WHEN w.name LIKE '%SSP%' THEN 1 ELSE 0 END) as ssp_wp_name
FROM unit u
LEFT JOIN unit_weapon w ON u.id = w.unit_id
WHERE u.rarity < 5
GROUP BY u.id
HAVING ssp_wp_name > 0
LIMIT 5
""")
rows = cur.fetchall()
print(f'unit_weapon中包含SSP名称武器的机体数: {len(rows)}')
for r in rows:
    print(f'  ID={r[0]}, name={r[1]}, 总武器={r[2]}, SSP名武器={r[3]}')

# 现在查一个机体: unit 1001000100 的所有武器
print(f'\\n机体1001000100的武器列表:')
cur = db.execute("SELECT weapon_id, name, power, en FROM unit_weapon WHERE unit_id=1001000100")
for r in cur.fetchall():
    print(f'  id={r[0]}, name={r[1]}, power={r[2]}, en={r[3]}')

# 查这个机体的能力列表
print(f'\\n机体1001000100的能力列表:')
cur = db.execute("SELECT ability_id, name FROM unit_ability WHERE unit_id=1001000100")
for r in cur.fetchall():
    print(f'  id={r[0]}, name={r[1]}')

db.close()
