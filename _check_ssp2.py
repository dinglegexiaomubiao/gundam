import json
from pathlib import Path

raw_dir = Path('data/raw/zh-CN/unit')
# 找有ssp_config数据的机体
for f in list(raw_dir.glob('*.json'))[:100]:
    with open(f, encoding='utf-8') as fh:
        u = json.load(fh)
    if u.get('ssp_config') or u.get('ssp_weapon'):
        print(f'=== 机体: {u.get("name")}, 稀有度: {u.get("rarity")}, ID: {u.get("id")} ===')
        print(f'ssp_config: {json.dumps(u.get("ssp_config"), ensure_ascii=False, indent=2)[:1500]}')
        print()
        ssp_w = u.get('ssp_weapon')
        if ssp_w:
            print(f'ssp_weapon类型: {type(ssp_w).__name__}')
            if isinstance(ssp_w, list):
                print(f'ssp_weapon数量: {len(ssp_w)}')
                if ssp_w:
                    w = ssp_w[0]
                    print(f'第一个SSP武器字段: {list(w.keys())}')
                    if w.get('weapon'):
                        print(f'  weapon子字段: {list(w["weapon"].keys())[:15]}')
                        ws = w['weapon'].get('weapon_status')
                        if ws:
                            print(f'    weapon_status: power={ws.get("power")}, en={ws.get("en")}, range={ws.get("range_min")}-{ws.get("range_max")}')
            elif isinstance(ssp_w, dict):
                print(f'ssp_weapon字段: {list(ssp_w.keys())}')
        # 检查是否还有其他ssp字段
        for k, v in u.items():
            if 'ssp' in k.lower() and k not in ('ssp_config', 'ssp_weapon'):
                print(f'其他SSP字段 {k}: {json.dumps(v, ensure_ascii=False)[:500]}')
        # 检查是否有sp_config, sp_weapon
        if u.get('sp_config'):
            print(f'sp_config存在: {json.dumps(u.get("sp_config"), ensure_ascii=False)[:500]}')
        if u.get('sp_weapon'):
            print(f'sp_weapon存在')
        print('---')
        # 看几个就够了
        break
