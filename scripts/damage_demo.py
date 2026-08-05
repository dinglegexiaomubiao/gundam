"""伤害计算器命令行演示（纯本地，无需网络）。"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.damage import CombatantStats, DamageContext, calculate_damage  # noqa: E402


def main() -> int:
    attacker = CombatantStats(
        unit_attack=3000,
        unit_defense=2000,
        character_attack=800,
        character_defense=700,
    )
    defender = CombatantStats(
        unit_attack=2500,
        unit_defense=2800,
        character_attack=600,
        character_defense=750,
    )
    ctx = DamageContext(
        weapon_power=5000,
        terrain_correction=1.0,
        attacker_vigor="high",
        critical=True,
    )
    result = calculate_damage(attacker, defender, ctx)
    for k, v in result.items():
        print(f"{k:34s} {v}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
