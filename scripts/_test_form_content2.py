"""找几个能体现 SSP 武器/地形/能力全面变更的机体样本。"""
from __future__ import annotations

import json
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))
from src import webapp as wa
from src import config


def find_samples(limit=20):
    conn = wa._conn()
    rows = conn.execute(
        "SELECT id, name, rarity FROM unit "
        "WHERE rarity < 5 AND (ssp_terrain IS NOT NULL AND ssp_terrain <> '' AND ssp_terrain <> '{}') "
        "LIMIT ?",
        (limit,),
    ).fetchall()
    print(f"有 ssp_terrain 列非空的低稀有度机体（前{limit}台）:")
    for r in rows:
        print(f"  id={r['id']}  rarity={r['rarity']}  {r['name']}")
    conn.close()
    return [r["id"] for r in rows]


def main():
    uids = find_samples(10)
    sys.stdout.flush()

    for uid in uids:
        print(f"\n========= unit_id={uid} =========")
        detail = wa.api_unit_detail(uid)
        if not detail:
            print("  不存在")
            continue
        print(f"  {detail['name']}  rarity={detail['rarity']}")
        fc = detail.get("form_content") or {}
        d = fc.get("default") or {}
        s = fc.get("ssp") or {}
        if not s:
            continue
        dw = [w.get("name") for w in (d.get("weapons") or [])]
        sw = [w.get("name") for w in (s.get("weapons") or [])]
        da = [a.get("name") for a in (d.get("abilities") or [])]
        sa = [a.get("name") for a in (s.get("abilities") or [])]
        dt = d.get("terrain") or {}
        st = s.get("terrain") or {}
        print(f"  地形: default={dt}")
        print(f"  地形: ssp    ={st}")
        if dw != sw:
            print(f"  武器变化: {dw} -> {sw}")
        else:
            print(f"  武器数不变: {len(dw)} 个")
        if da != sa:
            print(f"  能力变化: {da} -> {sa}")
        else:
            print(f"  能力数不变: {len(da)} 个")


if __name__ == "__main__":
    main()
