import json
from pathlib import Path

raw_dir = Path('data/raw/zh-CN/unit')
# 找多个有SSP的机体分析
ssp_count = 0
type_idx_map = {}
terrain_in_ssp = 0
sp_config_count = 0
sp_terrain_seen = False

for f in list(raw_dir.glob('*.json')):
    with open(f, encoding='utf-8') as fh:
        u = json.load(fh)
    rarity = u.get('rarity', 5)
    if rarity >= 5:
        continue
    ssp_cfg = u.get('ssp_config')
    if not ssp_cfg:
        continue
    ssp_count += 1
    # 统计所有release_function_type_index
    for core in ssp_cfg.get('cores', []):
        for rel in core.get('releases', []):
            t = rel.get('release_function_type_index')
            # 收集这个类型的实际出现过的key
            keys = [k for k in rel.keys() if k not in (
                'unit_ssp_custom_core_release_function_set_id', 'sort_order',
                'release_function_type_index', 'target_id'
            )]
            if t not in type_idx_map:
                type_idx_map[t] = {'count': 0, 'keys': set(), 'samples': []}
            type_idx_map[t]['count'] += 1
            for k in keys:
                type_idx_map[t]['keys'].add(k)
            if len(type_idx_map[t]['samples']) < 2:
                type_idx_map[t]['samples'].append({k: rel[k] for k in keys[:3]})

    # 检查initial_release是否有地形变更
    ir = ssp_cfg.get('initial_release') or {}
    ir_keys = [k for k in ir.keys() if 'terrain' in k.lower()]
    if ir_keys:
        terrain_in_ssp += 1
        print(f'[initial_release] 地形字段: {ir_keys}')

    # 检查ssp_config中是否有terrain相关
    for k in ssp_cfg.keys():
        if 'terrain' in k.lower():
            terrain_in_ssp += 1
            print(f'[ssp_config] 地形字段 {k}: {ssp_cfg[k]}')

    # 检查cores里的type有terrain相关内容吗
    for core in ssp_cfg.get('cores', []):
        for rel in core.get('releases', []):
            for k, v in rel.items():
                if isinstance(v, dict) and any('terrain' in str(x).lower() for x in v.keys()):
                    terrain_in_ssp += 1
                    if terrain_in_ssp < 3:
                        print(f'[release] 疑似地形变更: {k}={json.dumps(v, ensure_ascii=False)[:200]}')

    # 检查sp_config
    if u.get('sp_config'):
        sp_config_count += 1
        spc = u['sp_config']
        # sp_config中如果有terrain相关字段就记一下
        if not sp_terrain_seen:
            def walk(obj, path=''):
                global sp_terrain_seen
                if isinstance(obj, dict):
                    for k, v in obj.items():
                        p = f'{path}.{k}'
                        if 'terrain' in k.lower():
                            print(f'[sp_config]{p}: {json.dumps(v, ensure_ascii=False)[:200]}')
                            sp_terrain_seen = True
                        walk(v, p)
            walk(spc, '')

    # 只分析前30个有ssp的机体
    if ssp_count >= 30:
        break

print(f'\\n共分析 {ssp_count} 台有SSP配置的机体')
print(f'其中发现地形相关内容的次数: {terrain_in_ssp}')
print(f'发现sp_config存在: {sp_config_count}')
print()
print('=== release_function_type_index 完整分析 ===')
for t in sorted(type_idx_map.keys()):
    info = type_idx_map[t]
    print(f'Type {t}: 出现{info["count"]}次, keys={sorted(info["keys"])}')
    for i, s in enumerate(info['samples']):
        print(f'  示例{i+1}: {json.dumps(s, ensure_ascii=False)[:300]}')
