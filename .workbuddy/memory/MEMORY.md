# MEMORY

## gundam 项目（高达 G 世纪永恒资料库）
- 位置：E:\lzf\1_study\gundam；纯 Python 标准库，soshage.com 抓取 + SQLite + Web 查看器
- 已备份至项目资产 tdrive gundam/（目录 ID：根 JhVfqBlgcDHE / src JemWODZvOGjA / scripts JruveOvEsDVQ / web JEWfuibsOKel），2026-08-17 上传，22 个文件
- data/ 目录（189MB 数据库 + 1827 JSON）未上传
- 爬取范围约定（2026-09-21 起）：点击「爬取数据」仅抓取并重建 机体/驾驶员/支援角色 三类（其技能/能力/效果为子表随主表入库）；**关卡敌人(stage)与事件(event)不再爬取**（前端 stages 标签页无数据，属预期）。进度经 on_progress 回调 + /api/crawl-status 轮询展示
- 组队页约定（2026-09-21 起）：
  - 敌方基准 `bench`/`customEnemy` **每支队伍各自持有**（随 `team.payload` 持久化），不是全局
  - 机体/驾驶员/支援角色 **全体队伍之间互斥**，选择器通过 `exclude` 参数自动屏蔽已占用项；服务端 exclude 走 `NOT IN` 写进 WHERE 以保证 total/分页一致
  - 类型（role 1/2/3 = 攻击/耐久/支援）色彩身份：`--type-atk` 红 / `--type-tank` 蓝 / `--type-sup` 绿，卡片=左侧色条+顶部色晕+类型胶囊
  - **删除队伍必须调 `POST /api/team/delete`（body `{team_id}`，不是 `{id}`）**：`saveTeamState()` 只是 upsert，不会删后端行；只改内存+localStorage 会让队伍刷新后被 `/api/team/list` 复原
  - `fetchTeamFromServer` 以服务端为准（含空数组）；「首次迁移」由一次性标记 `gundam.teams.migrated.v1` 守卫（否则删光队伍会被误判为迁移而写回）
- **数据库读写约定（2026-09-21 起，务必遵守）**：
  - 所有连库必须走 `src/dbutil.py`：只读 `connect_ro()`（`file:...?mode=ro` + busy_timeout）、读写 `connect_rw()`（WAL + foreign_keys）；webapp 内用 `_ro()`/`_rw()` 上下文管理器（自动 close）。**不要再写裸 `sqlite3.connect`**
  - **换库/覆盖主库文件**（导入、云端恢复、rollback）必须用 `dbutil.swap_db_file()`：先 checkpoint 再清 `-wal`/`-shm` 再 replace；裸 `os.replace` 在 Windows 下会因占用报 `WinError 5`（同进程其它线程持有连接也会失败）
  - **备份/导出快照**用 `dbutil.backup_db_file()`（SQLite 在线备份 API）；直接 `copy2` 主库会漏掉未 checkpoint 的 WAL 写入
  - **子表防重靠「入库前先 DELETE 再 INSERT」**，不能指望 UNIQUE：SQLite 的 UNIQUE/PK **对 NULL 不生效**，且 `CREATE TABLE IF NOT EXISTS` 不会给旧表补约束
  - 写操作用 POST（`refetch-unit-apply` / `refetch-char-apply` 已改 POST，GET 返 405）
- **技能/能力槽位含双来源**：原始 JSON 每槽有 `skill` 与 `skill_sp`（`ability` / `ability_sp`），入库必须经 `_slot_variants` 展开（同 id 为镜像去重，id 不同都入库）；漏读会丢 SP 技能（曾丢约 1800 行）
- **`unit_ability.desc` 是空的，能力正文在 `traits` JSON 里**（`trait_type` 编码语义：79=武装属性减伤、14=损伤减轻/阈值无效、9=防御力提升、7=攻击力提升、5=EN恢复；驾驶员侧 17=造成损伤提升、46=MP提升、19=额外行动、23=格斗值提升；技能侧 4=MP提升、7=移动力提升、8=损伤提升）；`traits.active_condition_set_id` 非 0 表示该条带条件
- **`/api/team/score` 的 `pairs[].weapon_id` 用 `unit_weapon.id`（行主键），不是 `unit_weapon.weapon_id`（游戏武器 ID）**；传错返回 `weapon: null`
- **伤害类型映射已补齐（2026-09-21，**修好了**）**：`weapon_attr` → `weapon_attrs`（伤害类型集合）= `1/2/3` 单类型、**`4`=光束+物理`[1,2]`、`5`=物理+特殊`[1,3]`、`6`=光束+特殊`[2,3]`**（常量 `src/db.py: WEAPON_ATTR_EXPAND`，与 `scripts/migrate_weapon_attack_attr.py` 一致）。旧规则把 5/6 清空、4 记成 `[3]` 会丢多类型；已用 `scripts/migrate_weapon_attrs_v2.py` 回填（103 把，残留 0）。展示名用 `labels.DAMAGE_TYPE_NAMES`（1=**物理**；`WEAPON_ATTR` 在伤害计算器里把 1 显示为「实弹」，同属性不同语境）
- **MAP 武器判据**：`IFNULL(map_weapon_range,'') NOT IN ('','null','0')`（全库 224 把）
- **`pairing` 模块级缓存要能失效**：`_build_pilots()` 缓存按「库路径 + character 行数 + 最大 id」指纹自动重建（原先一次性缓存，导致 `build_db()` 重建库后评分配不到驾驶员）；`pairing.reset_caches()` 可显式清空，webapp 已在爬取结束/同步结束/导入换库后调用
- 队伍状态摘要（`team_score` 返回的 `insights`：攻击/支援/防御/匹配/missing）见 CODE_WIKI 10.9.2；规划文档 `TEAM_STATUS_PLAN.md`（P0–P3 已实施，P4 整队协同评分待定）
  - **驾驶员协同的括号文案口径**：只看「机体侧条件」（搭乘单位 id/标签/系列/类型）—— 能触发写「条件已满足」，不能写「不能触发」，依赖敌方写「视敌方而定」，无条件不显示括号。**战意/HP%/特定行动等时机类条件不参与判定**（在条目正文里体现即可），否则会把"本机能触发"误标成待定
  - 耐久段另展示 `pilot_mechanics`（支援防御/支援攻击次数、反击援防、额外行动，取自 `_build_pilots` 的 `base_mech`，剔除主动技能）
- 7 张关卡/事件表（stage/stage_map_npc/story_event/tower_event 等，27480 行）为**已归档**历史快照，不再随爬取更新，前端已标注
- 测试命令：`python -m unittest discover -s tests -t . -p "test_*.py"`（Python 层）+ `node tests/js/team_render_smoke.js`（前端渲染冒烟，无需浏览器）
- **批量改写用 python 脚本 + `assert s.count(old)==expect` 后写入**，并 grep 复核落盘；本环境的 Edit 工具出现过「报成功但未写入」

## 队伍及格线规则（用户口径，2026-09-21 确认，务必按此判定）
> 实现在 `src/pairing.py: TEAM_BASELINE` + `_baseline_report()`，随 `insights.baseline` 返回
> （`{items, bonuses, passed, total, bonus_count, ok}`）。
> **改动阈值只改 `TEAM_BASELINE` 一处**，后端判定与前端展示同步生效。

| 检查项 | 适用 | 及格线 | 超过即加分 | key |
|---|---|---|---|---|
| 移动力 | **任意类型，全队合并为一条**（逐台明细在 `units`） | 最差 ≥ 5 | 最高 ≥ 6 | `movement` |
| 支援型特效射程 | 支援型（role 3）**对攻击型生效**的特效，不含 MAP | ≥ 5 | > 5 | `support_range` |
| 支援攻击次数 | 支援型槽位的**驾驶员** | ≥ 2 次 | > 2 次 | `support_attack` |
| UR 防御型 | **UR（rarity 5）防御型（role 2）** 槽位 | 支援防御 ≥ 2 次 **或** 能反击援防 | 两者兼具 | `defense_support` |

- **移动力必须合成一条**（用户明确要求）：`actual`=全队最差值（定 `ok`）、`best`=最高值（定 `bonus`），
  逐台放 `units`。不要退回"每台一条"——卡片会变成一排 `移动力 5/5`，看不出"全队都达标"。
- **支援射程只看「对攻击型生效」的特效**（`_effect_used_for()` 切出的 `used`），不是机体最大射程；
  没有则退回该机全部损伤提升特效，再没有才退回全部特效。
- `items[].detail` 是**可直接展示的说明句**（如「全队移动力均为 5，达到及格线」），前端优先渲染它。
- `bonuses[]`（不参与及格线计数，前端单列一行「加分项」）：
  - `support_extra`：攻击型之外的支援特效（条数+名称）
  - `support_extra_match`：额外特效**能命中队伍里其它机体**的伤害类型（进一步加分）
    —— 需要 `ins` 里的 `unit_attrs`（该机全部非 MAP 武器的伤害类型并集，`_unit_attr_ids()`）
  - `defense_mitigation`：防御减伤覆盖哪些伤害类型 + 阈值无效 + **可触发的**特殊能力
    （排除 `conditional` 为真、以及名称含「条件」的条目）

- 支援次数来自 `character.support_info` = `{"attack":{count,cond},"defense":{...},"extra":{...}}`；
  `pairing` 在 `_build_pilots()` 里把它放进 pilot 字典（键 `support_info`），
  insight 侧用 `_support_counts()` 归一成 `{attack:{count,conditional}, ...}`
- 全库分布参考：支援攻击 2 次 178 人 / 1 次 19 人 / 3 次 3 人；支援防御 2 次 135 人 / 1 次 35 人；
  额外行动 1 次 34 人；**反击援防仅 7 人**（所以「支援防御≥2 或 反击援防」这条门槛对多数 UR 防御型是「支援防御 2 次」）
- ⚠️ **不要用精简后的 pilot 字典重算支援次数**：`insights` 里的 `pilot` 只有 `{id,name,rarity}`，
  取值要用同一条目里预算好的 `support_counts`（曾因此把刹那的支援防御 2 次误判为 0）

## 机体能力的条件判定（cond_ok / cond_text）
> `insights.defense.boosts[]` 每项带 `cond_ok` / `cond_text`；实现 `_unit_cond_verdict()` + `_cond_clause()`。

- `cond_ok`：`True` 无条件或机体侧条件已满足 / `False` 机体侧条件明确不满足 /
  `None` 只依赖战况或敌方（战意、HP·EN、距离、回合、敌方武器属性）→ **不能当"未达成"**。
- 判定入口以 **`active_condition_set_id`** 为「这条带条件」的权威标志（0 = 无条件）。
  ⚠️ **不能用「有没有 `active_condition` 对象」判断**：无条件条目也带一个字段全空的对象。
- ⚠️ **不要按能力名称含「条件」二字来判断**：实测「（常态＆战意条件）攻击力提升 LV2」
  有两个变体，一个是无条件（`active_condition_set_id=0`），按名称判会误伤。
- `cond_text` 从 `desc` 切条件子句：「…时，效果…」→「…时」（如
  `自身战意为“超一击”以上时`）。无条件条目为空串。
- **展示口径（用户要求）**：加分项里不许再写「另有 N 条需条件的能力」，
  必须列出**具体能力名 + 条件**：
  `条件能力（可达成）：名称 ｜ 条件` / `条件能力（未达成）：名称 ｜ 需 条件`。
- 📌 全库 801 条带条件的机体能力**全部**依赖战况/敌方，没有针对自身标签的
  ⇒ 「未达成」分支在现有数据里不会触发（是防御性分支）。
- 踩坑：`_unit_ctx()` 依赖 `_TAG_ID`（由 `_build_pilots()` 填充），
  缓存未建时直接调会抛 `TypeError: NoneType is not iterable`；`_unit_defense_insight()`
  里已加「未建则先建」的守卫。

## 多台攻击型（一支队伍可能不止一台）
- `insights.attacks` 是**列表**（按最高伤害武器伤害降序）；`insights.attack` 保留为
  「伤害最高的那台」以兼容旧调用/旧前端。**前端必须遍历 attacks 逐台展示**，
  不能只看 attack（曾经因此只显示一台）。
- `insights.match.groups` 与 attacks 一一对应，每组含
  `{unit, pilot, weapon, damage, attrs, rows, covered, missed, hit_count, total,
    defense_hit_count, defense_total, missing_types}`；
  match 上另有全队口径：`attack_count` / `total_hit_count` / `total_types` /
  `union_attrs` / `full_count` / `none_count` /
  `defense_rows`（**按类型去重**）/ `defense_hit_total` / `defense_types`。
  旧的单台字段（`attack_attrs` / `rows` / `covered` / `hit_count` …）= `groups[0]`。
- 协同 `detail` 多台时按台汇总并点名缺口：
  `…2 台攻击型中 0 台完全覆盖，2 台仍有缺口（「神高达 (EX)」缺少 特殊 损伤提升；…）：合计 1/4`。
- ⚠️ `support_range` 的 `want` 必须取**全部攻击型**最高伤害武器类型的**并集**，
  否则只服务第二台的特效会被误判成「额外特效」（`_effect_used_for()` 的 used/extra 分组）。

## 队伍状态的配色语义（务必遵守）
> 样式在 `web/style.css`，用语义令牌（`--success/--error/--warning` 及其 `-container`），别硬编码色值。

| 语义 | 背景填充 | 用在 |
|---|---|---|
| 达标 / 命中 / 已满足 | 绿（`--success-container`） | `.ts-chip.ok`、`.ts-line.ok` |
| **减分项**（未达标 / 未命中 / 未覆盖 / 缺特效） | 红（`--error-container`） | `.ts-chip.bad`、`.ts-line.bad` |
| 加分项（超出及格线 / 额外收益） | 琥珀（`--warning-container`） | `.ts-chip.bonus`、`.ts-chip.bonusall` |
| 无法判定 / 中性 | 面板灰（`--surface-variant`） | `.ts-line.na`、`.ts-chip.mut` |

- **减分项必须和及格线、加分项一样有背景色填充**（用户 2026-09-21 明确要求）：
  协同结论句与「防御覆盖」句统一走 `.ts-line` 系列（带底、圆角、`✓`/`✗` 前缀），**不要裸文字**。
- 协同 `level` 非 `full` 即减分项（`partial`/`none`/`neutral` → 红）；`unknown` → 中性底。
- 防御覆盖用后端给的 `synergy.defense_state`（`full`/`partial`/`none`/`na`）着色，
  **前端不解析文案**（改文案不该弄坏颜色）。
- `.ts-chip.down`（敌方「防御力减少」特效）与 `.ts-chip.bad`（减分项）**曾共用琥珀色**，
  会让人把减分项误读成加分项 —— 已拆成两套，不要再合并。

## 整队协同结论（insights.synergy）
- `level`：`full` 完全匹配 / `partial` 部分匹配 / `none` 支援未命中 / `neutral` 支援无增伤特效 / `unknown` 缺机体无法判定
- `detail`：可直接展示的说明句。**只要没覆盖全，就必须点名缺的是哪几类损伤提升**，例如
  - none：`支援提供 光束损伤提升，但攻击型最高伤害武器「洗牌同盟拳 EX」为 物理、特殊，无法匹配：0/2（缺少 物理、特殊 损伤提升）`
  - neutral（一条增伤特效都没有）：`支援型未提供「损伤提升」类特效；攻击型最高伤害武器「洗牌同盟拳 EX」为 物理、特殊，缺少 物理、特殊 损伤提升：0/2`
    —— 不要再写「不影响攻击型伤害类型」这种含糊话（用户已明确纠正）
  - partial：`支援提供 物理损伤提升，攻击武器「洗牌同盟拳 EX」为 物理、特殊；命中 物理，未命中 特殊：1/2`
  - full：`…完全覆盖攻击武器「…」的 物理、特殊：2/2`
- **伤害类型匹配要把「支援型 + 防御型」一起纳入**：`match.rows` 逐类型给出
  `support_hit/support_by`（能否加成、来源特效）与 `defense_hit/defense_by`（能否减伤、来源能力）；
  `defense_detail` 单独成句（`防御型对 物理 有减伤，未覆盖 特殊`）。
  支援覆盖度定 `level`，防御覆盖度**不混算**，只放 `defense_detail`。
- 伤害类型展示名统一用 `labels.DAMAGE_TYPE_NAMES`（1=**物理**/2=光束/3=特殊）

## tdrive 上传经验（长期有效）
- COS 临时密钥易失效（InvalidAccessKeyId），必须单文件串行：file_upload → 立即 curl -T → complete；不要批量申请
- file_upload 有 5 秒限流；curl 必须用 -T（流式），严禁 --data-binary 不带 @
