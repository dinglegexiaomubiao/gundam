"""找有SSP武器(名字带「SSP」或unit_weapon中SSP武器编号90结尾)的机体进行验证。"""
from __future__ import annotations

import json
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))
from src import webapp as wa
from src import config


def main():
    conn = wa._conn()
    rows = conn.execute(
        """
        SELECT DISTINCT u.id, u.name, u.rarity
        FROM unit u JOIN unit_weapon w ON w.unit_id = u.id
        WHERE u.rarity < 5 AND (
          w.name LIKE '%SSP%'
          OR w.weapon_id % 100 IN (90, 91, 92, 93, 94, 95)
        )
        LIMIT 10
        """,
    ).fetchall()
    conn.close()
    print(f"带 SSP 武器编号的机体: {len(rows)} 台")
    for r in rows:
        print(f"  id={r['id']}  rarity={r['rarity']}  {r['name']}")

    for r in rows[:5]:
        uid = r["id"]
        print(f"\n========= unit_id={uid}: {r['name']} =========")
        detail = wa.api_unit_detail(uid)
        if not detail:
            continue
        fc = detail.get("form_content") or {}
        d = fc.get("default") or {}
        s = fc.get("ssp") or {}
        dw = [(w.get("weapon_id"), w.get("name")) for w in (d.get("weapons") or [])]
        sw = [(w.get("weapon_id"), w.get("name")) for w in (s.get("weapons") or [])]
        print(f"  default武器: {dw}")
        print(f"  ssp武器:     {sw}")
        if dw != sw:
            print("  -> 武器列表有变化!")


if __name__ == "__main__":
    main()
