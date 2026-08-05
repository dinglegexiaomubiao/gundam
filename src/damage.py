"""伤害计算器：实现 formulas.docx 中的 GGE 伤害公式链。

公式速览（详见 formulas.docx）：
  characterStatRatio      = max(0, 攻击方角色攻击 - 防御方角色防御) / 5000
  unitStatRatio           = max(0, roundUp(攻击方机体攻/10 - 防御方机体防/10)) / 5000
  characterSigmoidAdjust  = 1 / (exp((250*(防角防-攻角攻))/100000) + 1)
  unitSigmoidAdjust       = 1 / (exp((25*(防机防-攻机攻))/100000) + 1)
  baseDamage              = roundUp((四者之和) * 武器威力)
  ... 攻击/防御修正、地形修正、战意/暴击/护盾修正 ...

说明：
- 数值四舍五入按「向上取整」（RoundUp）。
- terrainCorrection 来自武器在地形上的伤害倍率（如 100 表示 1.0）。
- 战意加成：高战意 +10%，最高 +20%，超一击 +30%。
- 暴击修正：中战意 +10%，高/最高 +20%，超一击 +30%。
- defensiveCorrection：默认 1.0；有护盾时为 0.8。
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field


def _round_up(x: float) -> int:
    return math.ceil(x)


def _max0(x: float) -> float:
    return max(0.0, x)


@dataclass
class CombatantStats:
    """参战者数值（单位=机体，角色=驾驶员）。"""

    unit_attack: float = 0.0    # 机体攻击
    unit_defense: float = 0.0   # 机体防御
    character_attack: float = 0.0  # 驾驶员攻击（射击/格斗取与武器对应的一项）
    character_defense: float = 0.0 # 驾驶员防御


@dataclass
class DamageContext:
    """伤害计算所需的修正参数。"""

    weapon_power: float = 1000.0
    terrain_correction: float = 1.0
    defensive_correction: float = 1.0          # 护盾时 0.8
    attacker_damage_dealt_percent: list[float] = field(default_factory=list)
    attacker_crit_damage_dealt_percent: list[float] = field(default_factory=list)
    defender_damage_taken_percent: list[float] = field(default_factory=list)
    attacker_vigor: str = "normal"              # normal / high / max / supercharged
    critical: bool = False
    attacker_vigor_damage_bonus: float | None = None   # 显式覆盖战意增伤
    critical_correction_percent: float | None = None   # 显式覆盖暴击修正


VIGOR_DAMAGE_BONUS = {
    "normal": 0.0,
    "high": 10.0,
    "max": 20.0,
    "supercharged": 30.0,
}

CRITICAL_CORRECTION = {
    "normal": 0.0,
    "mid": 10.0,
    "high": 20.0,
    "max": 20.0,
    "supercharged": 30.0,
}


def calculate_damage(
    attacker: CombatantStats,
    defender: CombatantStats,
    ctx: DamageContext,
) -> dict[str, float | int]:
    """按公式链逐段计算，返回每一步的中间值，便于排查与展示。"""
    a_char, d_char = attacker.character_attack, defender.character_defense
    a_unit, d_unit = attacker.unit_attack, defender.unit_defense

    character_stat_ratio = _max0(a_char - d_char) / 5000.0
    unit_stat_ratio = _max0(
        _round_up((a_unit / 10.0) - (d_unit / 10.0))
    ) / 5000.0
    character_sigmoid = 1.0 / (
        math.exp((250.0 * (d_char - a_char)) / 100000.0) + 1.0
    )
    unit_sigmoid = 1.0 / (
        math.exp((25.0 * (d_unit - a_unit)) / 100000.0) + 1.0
    )
    base_damage = _round_up(
        (
            character_stat_ratio
            + unit_stat_ratio
            + character_sigmoid
            + unit_sigmoid
        )
        * ctx.weapon_power
    )

    attacker_combined = _round_up((a_unit + 2 * a_char) / 10.0)
    target_combined = _round_up((d_unit + 2 * d_char) / 10.0)
    offense_exp = ((5000 - attacker_combined) * 30) / 100000.0
    defense_exp = ((5000 - target_combined) * 3) / 100000.0
    offense_component = (10000 / 100.0) / (math.exp(offense_exp) + 1.0)
    defense_component = (-4000 / 100.0) / (math.exp(defense_exp) + 1.0)
    damage_correction = (
        offense_component + defense_component
    ) * base_damage
    battle_damage = _round_up(
        (base_damage + damage_correction) * ctx.terrain_correction
    )

    vigor_bonus = (
        ctx.attacker_vigor_damage_bonus
        if ctx.attacker_vigor_damage_bonus is not None
        else VIGOR_DAMAGE_BONUS[ctx.attacker_vigor]
    )
    total_multiplier = (
        sum(ctx.attacker_damage_dealt_percent)
        + sum(ctx.attacker_crit_damage_dealt_percent)
        + vigor_bonus
        - sum(ctx.defender_damage_taken_percent)
    )
    scaled_damage = _round_up((total_multiplier * battle_damage) / 100.0)
    combined_damage = (battle_damage + scaled_damage) * ctx.defensive_correction

    crit_correction = (
        ctx.critical_correction_percent
        if ctx.critical_correction_percent is not None
        else (
            CRITICAL_CORRECTION[ctx.attacker_vigor] if ctx.critical else 0.0
        )
    )
    final_damage = _max0(
        _round_up(combined_damage * ((crit_correction + 100.0) / 100.0))
    )

    return {
        "character_stat_ratio": character_stat_ratio,
        "unit_stat_ratio": unit_stat_ratio,
        "character_sigmoid": character_sigmoid,
        "unit_sigmoid": unit_sigmoid,
        "base_damage": base_damage,
        "attacker_combined_stat": attacker_combined,
        "target_combined_stat": target_combined,
        "damage_correction": damage_correction,
        "battle_damage": battle_damage,
        "total_damage_multiplier_percent": total_multiplier,
        "scaled_damage": scaled_damage,
        "combined_damage": combined_damage,
        "critical_correction_percent": crit_correction,
        "final_damage": final_damage,
    }
