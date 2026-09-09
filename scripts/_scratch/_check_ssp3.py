import json
from pathlib import Path

raw_dir = Path('data/raw/zh-CN/unit')
# 找一个有完整SSP数据的机体
for f in list(raw_dir.glob('*.json'))[:100]:
    with open(f, encoding='utf-8') as fh:
        u = json.load(fh)
    if u.get('ssp_config'):
        name = u.get('name')
        uid = u.get('id')
        rarity = u.get('rarity')
        print(f'=== 机体: {name}, 稀有度: {rarity}, ID: {uid} ===')

        # 1. stats 中的 ssp 字段（之前代码读取的）
        st = u.get('stats', {})
        print(f'\n[stats] 顶层stats中的ssp字段:')
        for k, v in st.items():
            if 'ssp' in k:
                print(f'  {k} = {v}')
        for k, v in st.items():
            if 'sp' in k and 'ssp' not in k:
                print(f'  {k} = {v}')

        # 2. ssp_config.stats 中的数据
        sc = u.get('ssp_config', {})
        sst = sc.get('stats', {})
        print(f'\n[ssp_config.stats] SSP配置中的stats:')
        for k, v in sst.items():
            print(f'  {k} = {v}')

        # 3. ssp_config 中的其他重要字段
        print(f'\n[ssp_config] 顶层字段: {[k for k in sc.keys() if k not in ("stats", "cores")]}')
        for k in sc.keys():
            if k in ('terrain', 'ability_set', 'abilities', 'terrain_set'):
                print(f'  {k}: {json.dumps(sc[k], ensure_ascii=False)[:300]}')

        # 4. ssp_weapon 完整结构
        sw = u.get('ssp_weapon', [])
        print(f'\n[ssp_weapon] 数量: {len(sw)}')
        for i, w in enumerate(sw[:2]):
            print(f'  [{i}] keys: {list(w.keys())}')
            # 看看weapon子对象
            for key in ('weapon', 'after_weapon'):
                if key in w and w[key]:
                    wp = w[key]
                    print(f'      {key}.name = {wp.get("name")}')
                    if wp.get('weapon_status'):
                        ws = wp['weapon_status']
                        print(f'        power={ws.get("power")}, en={ws.get("en")}, range={ws.get("range_min")}-{ws.get("range_max")}')
                    # 检查weapon下的terrain字段
                    for tkey in ('terrain', 'capability'):
                        if wp.get(tkey):
                            print(f'        {tkey}: {json.dumps(wp[tkey], ensure_ascii=False)[:200]}')

        # 5. ssp_config.cores 中的武器变更和能力变更
        cores = sc.get('cores', [])
        print(f'\n[ssp_config.cores] 数量: {len(cores)}')
        for i, core in enumerate(cores[:1]):
            print(f'  [{i}] level={core.get("level")}, releases数: {len(core.get("releases", []))}')
            for j, rel in enumerate(core.get('releases', [])[:3]):
                rtype = rel.get('release_function_type_index')
                print(f'    [{j}] type={rtype}', end='')
                if rtype == 5:  # weapon change
                    wc = rel.get('weapon_change', {})
                    aft = wc.get('weapon', {})
                    print(f' 武器变更: before={wc.get("before_weapon_id")} -> after={wc.get("after_weapon_id")} ({aft.get("name","?")})')
                elif rtype in (1, 2, 3, 4):
                    print(f' ({rel.get("release_function_type_index")})')
                    # 打印完整release
                    print(f'       {json.dumps(rel, ensure_ascii=False)[:400]}')
                else:
                    print()

        # 6. 是否有单独的ssp_terrain字段？在整个u中搜索
        print(f'\n[全量搜索] 在u中搜索terrain/ability相关的ssp字段:')
        def find_keys(obj, prefix=''):
            if isinstance(obj, dict):
                for k, v in obj.items():
                    lk = k.lower()
                    if ('terrain' in lk or 'abilit' in lk or 'weapon' in lk) and ('ssp' in lk or 'sp' in prefix.lower()):
                        print(f'  {prefix}.{k} = {json.dumps(v, ensure_ascii=False)[:200]}')
                    find_keys(v, f'{prefix}.{k}')
            elif isinstance(obj, list):
                for i, item in enumerate(obj):
                    find_keys(item, f'{prefix}[{i}]')
        find_keys(u, 'u')

        print('\\n' + '='*60)
        break
