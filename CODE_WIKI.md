# 高达 G 世纪永恒资料库 · Code Wiki

> 本文档是对 `gundam` 仓库的完整代码梳理，覆盖项目整体架构、主要模块职责、关键类与函数说明、依赖关系、数据库设计、API 接口、运行方式以及核心业务规则。

---

## 目录

- [1. 项目概述](#1-项目概述)
- [2. 项目架构](#2-项目架构)
- [3. 目录结构](#3-目录结构)
- [4. 主要模块职责](#4-主要模块职责)
- [5. 关键类与函数说明](#5-关键类与函数说明)
- [6. 数据库设计](#6-数据库设计)
- [7. 依赖关系](#7-依赖关系)
- [8. API 接口参考](#8-api-接口参考)
- [9. 项目运行方式](#9-项目运行方式)
- [10. 核心业务规则](#10-核心业务规则)
- [11. 故障排查与维护](#11-故障排查与维护)

---

## 1. 项目概述

### 1.1 项目定位

**高达 G 世纪永恒资料库**（GGE 资料库）是一个面向个人研究的游戏资料库项目，用于抓取 [soshage.com/gget](https://soshage.com/gget/) 站点的数据（仅 `zh-CN` 语言），并提供机体 / 驾驶员 / 支援角色配对与伤害计算能力。

### 1.2 技术栈

| 层级 | 技术 |
|---|---|
| 语言 | Python 3.10+（使用 `from __future__ import annotations` 与类型注解） |
| 标准库依赖 | `urllib` / `http.client` / `sqlite3` / `concurrent.futures` / `http.server` / `ssl` / `threading` / `dataclasses` — **无任何第三方依赖** |
| 可选依赖 | `psycopg`（仅云端 PostgreSQL 同步时延迟导入） |
| 存储 | 本地 SQLite（`data/db/gundam.db`）+ 可选云端 PostgreSQL（Neon） |
| 前端 | 原生 HTML / CSS / JavaScript（无构建工具） |
| 入口 | `scripts/pipeline.py` 命令行 / `python -m src.cloud` 子进程 |

### 1.3 数据来源

- 站点自带 JSON API：`https://soshage.com/ggetapi/zh-CN/...`
- 覆盖范围：机体（1210）、驾驶员（568）、支援角色（84）、系列（108）、主线关卡（476）、剧情事件（14，含 78 个 Boss 关卡）、塔楼（4，40 层）。
- 敌人数据位于关卡详情 `stage/{id}` 的 `map.npcs` 中。

---

## 2. 项目架构

### 2.1 分层架构

```
┌─────────────────────────────────────────────────────────────┐
│                      命令行入口 / Web 入口                      │
│        scripts/pipeline.py        scripts/migrate_cloud.py    │
│        scripts/status.py          scripts/migrate_schema.py   │
│        scripts/damage_demo.py                                  │
└──────────────┬──────────────────────────────────┬────────────┘
               │                                  │
       ┌───────▼────────┐               ┌────────▼────────┐
       │  抓取/构建/校验  │               │   Web 服务层     │
       │  fetch/build/   │               │  src/webapp.py  │
       │  verify/maintain│               │ (HTTP + JSON)   │
       └───────┬────────┘               └────────┬────────┘
               │                                  │
   ┌───────────┴──────────────┐         ┌─────────┴──────────┐
   │  src/api.py  src/fetch.py│         │ src/pairing.py     │
   │  (HTTP 客户端 + 抓取编排) │         │ src/damage.py      │
   └───────────┬──────────────┘         │ (配对引擎+伤害计算) │
               │                        └─────────┬──────────┘
               │                                  │
       ┌───────▼────────┐               ┌──────────▼─────────┐
       │  src/db.py     │               │  src/labels.py     │
       │  (JSON→SQLite) │◄──────────────│  (标签/数值解析)    │
       └───────┬────────┘               └────────────────────┘
               │
       ┌───────▼────────┐
       │  src/cloud.py  │
       │  (PostgreSQL)   │
       └────────────────┘
               │
       ┌───────▼────────┐
       │  data/          │
       │  raw/ db/ meta/ │
       └────────────────┘
```

### 2.2 数据流

```
站点 API ──http_get_json──> 原始 JSON (data/raw/zh-CN/)
                                   │
                                   ▼
                            build_db() ──INSERT OR REPLACE──> SQLite (data/db/gundam.db)
                                   │
                                   ▼
                            verify() / diff_report()
                                   │
              ┌────────────────────┴────────────────────┐
              ▼                                         ▼
       Web 服务 (webapp.py)                      云端同步 (cloud.py)
       只读查询 + 配对 + 伤害计算                  上传 / 恢复 / 差异对比
```

### 2.3 启动兜底链

本地数据库（`data/db/gundam.db`）不进 git，新 clone 后没有数据。启动时按以下顺序兜底：

1. **本地已有数据库** → 直接使用；
2. **本地缺失** → 尝试从云端 PostgreSQL（Neon）恢复（设置 `NEON_DB_URL`，`pipeline.py serve` 自动恢复）；
3. **云端也没有/不可用** → 不自动爬取，直接在空库状态下启动，可在概览页「导入数据库」恢复，或点击「爬取数据」按钮手动全量抓取。

---

## 3. 目录结构

```
gundam/
├── src/                        # 代码库
│   ├── __init__.py             # 包标识
│   ├── config.py               # 路径与抓取配置（含 .env 读取）
│   ├── api.py                  # HTTP JSON 客户端（节流/限流/重试）
│   ├── fetch.py                # 全量抓取编排（断点续传）
│   ├── db.py                   # 原始 JSON → SQLite 规范化入库
│   ├── labels.py               # 显示标签映射与数值解析
│   ├── cloud.py                # 云端 PostgreSQL 数据源（Neon）
│   ├── verify.py               # 数量与抽样校验
│   ├── maintain.py             # 数据库快照 / 变更报告 / 一键 update
│   ├── damage.py               # 伤害计算器（formulas.docx 公式实现）
│   ├── pairing.py              # 配对推荐引擎（机体↔驾驶员）
│   └── webapp.py               # 本地 Web 查看器（HTTP 服务 + API）
├── scripts/                    # 命令行入口
│   ├── pipeline.py             # 主流水线入口（fetch/build/verify/update/serve…）
│   ├── migrate_cloud.py        # 本地 → 云端迁移
│   ├── migrate_schema.py       # 本地数据库结构升级（幂等）
│   ├── status.py               # 查看抓取进度
│   └── damage_demo.py          # 伤害计算命令行演示
├── web/                        # 前端静态资源
│   ├── index.html              # 单页应用（8 个 Tab）
│   ├── app.js                  # 前端逻辑（~ 大量异步函数）
│   └── style.css               # 样式
├── data/                       # 运行时数据（git 忽略）
│   ├── raw/zh-CN/              # 原始 JSON 抓取产物
│   ├── db/gundam.db            # SQLite 规范化数据库
│   ├── meta/manifest.json      # 抓取元信息
│   └── backup/                 # 快照备份（滚动保留 3 份）
├── .env.example                # NEON_DB_URL 模板
├── .gitignore
├── README.md                   # 用户文档
├── MAINTENANCE.md              # 维护手册
├── formulas.docx               # 伤害公式原始文档
├── requirements.txt            # 仅说明：无第三方依赖
└── package.json                # npm 别名（仅 scripts）
```

---

## 4. 主要模块职责

### 4.1 `src/config.py` — 项目配置中心

- 读取项目根目录 `.env`（被 git 忽略），已存在的环境变量优先；
- 定义所有路径常量：`PROJECT_ROOT` / `DATA_DIR` / `RAW_DIR` / `META_DIR` / `DB_PATH` / `MANIFEST_PATH`；
- 定义抓取节流参数：`MIN_REQUEST_INTERVAL`（1.8s）、`JITTER_MAX`（0.4s）、`BATCH_SIZE`（200）、`BATCH_PAUSE`（120s）、`MAX_WORKERS`（1，单线程）、`MAX_RETRIES`（5）；
- 定义 API 基址与 UA。

### 4.2 `src/api.py` — 极简健壮的 HTTP JSON 客户端

- 基于 `http.client` 实现，每个线程一条 keep-alive 连接，避免重复 TLS 握手；
- 全局最小请求间隔节流（`_throttle`）+ 随机抖动；
- 403/429 视为限流：关闭连接、设置全局 `_rate_limit_hit` 标记，后续请求直接抛 `RateLimitAbort` 终止整个抓取任务；
- 5xx 与网络错误指数退避重试（`RETRY_BACKOFF = (3, 6, 12, 24, 48)`）；
- `atomic_write_json` 原子写 JSON（先写 `.tmp` 再 `replace`），避免中断产生半个文件。

### 4.3 `src/fetch.py` — 全量抓取编排

- 5 步抓取流程：系列与阵营 → 机体 → 驾驶员 → 支援角色 → 事件与关卡；
- `_fetch_many` 分批并发抓取（实际单线程），已存在则跳过（断点续传），`refresh=True` 时全量重抓；
- 批次间长暂停（`BATCH_PAUSE`）让限流窗口计数回落；
- `collect_stage_ids` 从系列 / 事件数据汇总所有需抓取的关卡 ID；
- `write_manifest` 生成 `manifest.json` 记录抓取时间、各类计数与失败项；
- 限流终止时保留已完成部分，下次运行自动续传。

### 4.4 `src/db.py` — 原始 JSON → SQLite 入库

- 定义全部表结构的 `SCHEMA` 字符串（20+ 张表，含外键、索引）；
- `build_db()` 主流程：建表 → 构建 `tag` 映射 → 逐类 ingest → 写入 `meta` 表（`built_at` / `star_multipliers` / `star_labels` / `star_formula`）；
- 各 `ingest_*` 函数解析原始 JSON 并 `INSERT OR REPLACE` / `INSERT OR IGNORE`；
- 解析能力（abilities）中的属性百分比加成，拆分为无条件加成（`stat_bonuses`）与条件加成（`conditional_bonuses`）；
- 解析武器最高级数值（`parse_weapon_max_level`）与最高级特效；
- 解析支援角色队长技条件（`parse_supporter_conditions`）。

### 4.5 `src/labels.py` — 显示标签与数值解析辅助

- 稀有度、星级倍率、攻击属性、武器属性、角色类型等枚举映射；
- `star_value(base, pct, star)` 实现升星公式：`星级基础值 = floor(基础值 × 倍率)`，`最终值 = floor(星级基础值 × (1 + 能力加成%))`；
- `parse_ability_stat_bonuses` 从能力描述解析属性百分比加成（区分无条件 / 条件）；
- `parse_weapon_max_level` 计算武器最高级数值与最高级特效；
- `resolve_trait_text` 把效果文本里的「上述"标签/系列"」占位符替换为实际名称；
- `support_label` 生成支援次数标签（如「无条件支援防御2次」）。

### 4.6 `src/cloud.py` — 云端 PostgreSQL 数据源（Neon）

- 本地数据库缺失时的兜底链：本地 SQLite → 云端恢复 → 爬取；
- `TABLE_ORDER` 定义 21 张表的写入顺序（父表在前，外键依赖）；
- `_translate_ddl` / `_translate_index` 把 SQLite DDL 翻译为 PostgreSQL DDL（类型映射、引号包裹）；
- `upload_local_db_to_cloud` 把本地 SQLite 全量重建到云端（覆盖），逐表校验行数；
- `restore_local_db_from_cloud` 从云端重建本地 SQLite，**带断点续传**（已恢复表不重复下载，失败表最多重试 3 轮），每张表由独立子进程拉取并带 180s 硬超时；
- `cloud_diff` 对比本地与云端各表行数、构建时间与本地完整性；
- `unit_sync_diff` / `unit_sync_push` 单机体级别的差异对比与推送；
- `direct_cloud_url` 把 Neon 池化地址转为直连地址（批量读写更快）；
- `_friendly_cloud_error` 把常见云端连接错误转为可操作的中文提示；
- 支持 `python -m src.cloud fetch-table <table> <outfile>` 子进程入口。

### 4.7 `src/verify.py` — 数量与抽样校验

- 统计原始 JSON 文件数与大小；
- 统计 SQLite 各表行数；
- 抽样检查机体、驾驶员（阿姆罗/夏亚）、支援角色、最强敌人；
- 检查敌方机体中不在机体表里的数量（外键完整性）；
- `manifest_summary` 读取 `manifest.json` 概要。

### 4.8 `src/maintain.py` — 定期维护

- `backup_db` 快照当前数据库到 `data/backup/`，滚动保留最近 `KEEP_BACKUPS`（3）份；
- `rollback` 用快照覆盖当前数据库（`update` 失败时调用）；
- `diff_report` 对比更新前后的数据库：各表行数增减、新增机体名单、机体/驾驶员行级变更；
- `run_update` 一键更新：快照 → fetch → build → verify → 报告；**build 失败自动回滚**。

### 4.9 `src/damage.py` — 伤害计算器

- 实现 `formulas.docx` 中的 GGE 伤害公式链；
- 两个 dataclass：`CombatantStats`（参战者数值）、`DamageContext`（修正参数）；
- `calculate_damage` 按公式链逐段计算，返回每一步中间值（便于排查与展示）；
- 战意加成：`normal=0%` / `high=+10%` / `max=+20%` / `supercharged=+30%`；
- 暴击修正：`normal=+10%` / `high/max=+20%` / `supercharged=+30%`；
- 数值四舍五入按「向上取整」（`math.ceil`）。

### 4.10 `src/pairing.py` — 配对推荐引擎

- 机体 → 驾驶员推荐，支持攻击模式与防御模式；
- **攻击模式得分** = 六层伤害公式计算的单次伤害（非暴击）；武器有暴击率时同时给出暴击伤害；
- **防御模式得分** = 满级防御值 + 减伤% + 特殊机制加权，并通过逐次伤害模拟计算可承受攻击次数；
- 解析能力描述中的增伤/减伤/攻击/防御/暴击/属性百分比加成；
- 能力条件分类：`counted`（已触发）/ `potential`（可能触发）/ `impossible`（不能触发）；
- 同一 `group_id` 的多 trait 按「并集」处理：命中任一即触发，同效果只取最高，避免重复叠加；
- 驾驶员属性：UR 用默认形态满级；非 UR 用 SP 形态满级（100 级）；
- 支持「反击援防」「额外行动」「HP恢复」「叠层防御」等特殊机制识别；
- `_apply_pair_filters` 支持驾驶员搜索筛选（名称/稀有度/类型/系列/标签/技能/支援）与多字段排序。

### 4.11 `src/webapp.py` — 本地 Web 查看器

- 基于 `http.server.ThreadingHTTPServer`，默认监听 `127.0.0.1:8765`；
- 提供 40+ 个 JSON API 端点（详见 [第 8 节](#8-api-接口参考)）；
- 静态文件服务（`web/` 目录）；
- 手动爬取任务（`_crawl_lock` / `_crawl_state`，仅由概览页「爬取数据」按钮触发，禁止自动爬取）；
- 云端同步任务（`_sync_lock` / `_sync_state`，上传/下载方向）；
- 机体编辑（`api_unit_edit`，校验 + 差异对比 + 写库 + `unit_edit_log`）；
- 数据库导入（`/api/import`，流式写入临时文件 + 校验 + 替换）；
- 数据库导出（`/api/export`，下载 `gundam.db`）。

### 4.12 `scripts/` — 命令行入口

| 脚本 | 作用 |
|---|---|
| [pipeline.py](file:///e:/lzf/1_study/gundam/scripts/pipeline.py) | 主入口：`fetch` / `build` / `verify` / `manifest` / `update` / `backup` / `restore` / `serve` / `all` |
| [migrate_cloud.py](file:///e:/lzf/1_study/gundam/scripts/migrate_cloud.py) | 本地 → 云端全量迁移（依赖 `NEON_DB_URL`） |
| [migrate_schema.py](file:///e:/lzf/1_study/gundam/scripts/migrate_schema.py) | 本地数据库结构升级（武器 lv9 列、编辑历史表，幂等） |
| [status.py](file:///e:/lzf/1_study/gundam/scripts/status.py) | 查看抓取进度（进程状态 + 文件计数 + 日志尾部） |
| [damage_demo.py](file:///e:/lzf/1_study/gundam/scripts/damage_demo.py) | 伤害计算命令行演示 |

### 4.13 `web/` — 前端单页应用

- `index.html`：8 个 Tab（概览 / 机体 / 驾驶员 / 支援角色 / 关卡敌人 / 技能·能力·效果 / 伤害计算 / 配对）；
- `app.js`：原生 JavaScript，通过 `fetch` 调用后端 API，包含 `api(path)`、`loadSummary()`、`openSyncDiff(direction)` 等大量异步函数；
- `style.css`：样式表。

---

## 5. 关键类与函数说明

### 5.1 `src/damage.py`

#### `CombatantStats`（dataclass）
参战者数值，单位=机体，角色=驾驶员。

| 字段 | 类型 | 说明 |
|---|---|---|
| `unit_attack` | float | 机体攻击 |
| `unit_defense` | float | 机体防御 |
| `character_attack` | float | 驾驶员攻击（射击/格斗取与武器对应的一项） |
| `character_defense` | float | 驾驶员防御 |

#### `DamageContext`（dataclass）
伤害计算所需的修正参数。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `weapon_power` | float | 1000.0 | 武器威力 |
| `terrain_correction` | float | 1.0 | 地形修正 |
| `defensive_correction` | float | 1.0 | 护盾时 0.8 |
| `attacker_damage_dealt_percent` | list[float] | [] | 攻击方增伤百分比列表 |
| `attacker_crit_damage_dealt_percent` | list[float] | [] | 攻击方暴击伤害增伤 |
| `defender_damage_taken_percent` | list[float] | [] | 防御方受伤百分比 |
| `attacker_vigor` | str | "normal" | 战意：normal/high/max/supercharged |
| `critical` | bool | False | 是否暴击 |
| `attacker_vigor_damage_bonus` | float \| None | None | 显式覆盖战意增伤 |
| `critical_correction_percent` | float \| None | None | 显式覆盖暴击修正 |

#### `calculate_damage(attacker, defender, ctx) -> dict`
按公式链逐段计算，返回包含 14 个中间值的字典：
`character_stat_ratio` / `unit_stat_ratio` / `character_sigmoid` / `unit_sigmoid` / `base_damage` / `attacker_combined_stat` / `target_combined_stat` / `damage_correction` / `battle_damage` / `total_damage_multiplier_percent` / `scaled_damage` / `combined_damage` / `critical_correction_percent` / `final_damage`。

**公式速览**（详见 `formulas.docx`）：
```
characterStatRatio = max(0, 攻角攻 - 防角防) / 5000
unitStatRatio      = max(0, roundUp(攻机攻/10 - 防机防/10)) / 5000
characterSigmoid   = 1 / (exp((250*(防角防-攻角攻))/100000) + 1)
unitSigmoid        = 1 / (exp((25*(防机防-攻机攻))/100000) + 1)
baseDamage         = roundUp((四者之和) × 武器威力)
… 攻击/防御修正、地形修正、战意/暴击/护盾修正 …
```

### 5.2 `src/pairing.py`

#### `match_pilot(unit_id, action, weapon_id, bench, enemy, filters) -> dict`
配对推荐主入口。

- `action`: `"attack"` 或 `"defense"`；
- `bench`: `"low"`（低防本）/ `"mid"`（中防本）；
- `enemy`: 敌方配置（攻击力、武器属性、标签、系列、战意、暴击率、护盾等）；
- `filters`: 驾驶员筛选与排序；
- 返回包含 `pilots`（前 50 名）、`unit`、`weapon`、`enemy_cfg`、`unit_mechanics` 等的字典。

#### `_score_attack(pilot, unit_ctx, weapon_row, bench, unit_row, unit_tot, cfg) -> dict`
攻击模式评分：计算单次伤害（非暴击）+ 暴击伤害；`crit_rate >= 100` 时取暴击伤害为得分。

#### `_score_defense(pilot, unit_ctx, unit_row, enemy_cfg, unit_abilities, ext) -> dict`
防御模式评分：通过 `run_sim(critical)` 逐次伤害模拟，计算可承受攻击次数（含叠层防御、HP 恢复），按敌方暴击率加权期望。

#### `_parse_ability(name, traits_raw, tag_name, series_name) -> dict`
把一条能力的多个 trait 按 `group_id` 分组解析，多阶段能力按「效果结束时」拆分。

#### `_apply_ability(ability, unit_ctx, mode) -> tuple[dict, list, list, list]`
返回 `(效果合计, 触发项, 有可能触发, 不能触发)`。同一 group 内并集：命中任一即触发，同效果取最高。

#### `default_enemy() -> dict`
默认敌方：能天使高达(EX) 满星满级 + 刹那·F·清英 + GN剑 EX。

### 5.3 `src/db.py`

#### `SCHEMA`
完整的 SQLite 建表语句字符串，包含 `PRAGMA foreign_keys = ON` 与所有表/索引定义。

#### `build_db() -> None`
主入库流程：
1. 连接 SQLite，开启 WAL 模式与外键；
2. 执行 `SCHEMA`；
3. 构建 `tag_id → tag_name` 映射（`_build_tag_map`）；
4. 依次调用 `ingest_series_faction` / `ingest_units` / `ingest_characters` / `ingest_supporters` / `ingest_stages` / `ingest_events`；
5. 写入 `meta` 表（`built_at` / `star_multipliers` / `star_labels` / `star_formula`）。

#### `ingest_units(conn, tag_map)`
解析每个机体 JSON：
- 提取属性（基础/max/sp/ssp 形态）；
- 解析能力中的 `stat_bonuses`（无条件）与 `conditional_bonuses`（条件）；
- 入库 `unit` / `unit_weapon` / `unit_ability` / `unit_skill`；
- 武器最高级数值由 `parse_weapon_max_level` 计算。

#### `ingest_characters(conn, tag_map)`
解析驾驶员 JSON，额外计算 `_support_info`（支援防御/攻击/额外行动次数）。

#### `ingest_supporters(conn, tag_map)`
解析支援角色，使用 `parse_supporter_conditions` 解析队长技条件。

### 5.4 `src/api.py`

#### `http_get_json(path, params) -> obj`
GET 站点 JSON API 并解析为 Python 对象（带节流、限流冷却与重试）。

#### `RateLimitAbort(RuntimeError)`
连续触发限流时抛出，主动终止整个抓取任务，避免加剧封禁。

#### `atomic_write_json(path, obj) -> Path`
写 JSON 到临时文件后原子替换，避免中断产生半个文件。

### 5.5 `src/fetch.py`

#### `fetch_all(limit, refresh) -> dict[str, list]`
全量抓取编排，返回各类失败项字典。5 步流程：系列与阵营 → 机体 → 驾驶员 → 支援角色 → 事件与关卡。

#### `_fetch_many(kind, ids, path_prefix, refresh) -> list[tuple[int, str]]`
分批并发抓取某类详情，已存在则跳过；批次间长暂停；限流时整体终止。

#### `collect_stage_ids() -> list[int]`
从系列 / 事件数据中汇总所有需要抓取详情的关卡 ID。

### 5.6 `src/labels.py`

#### `star_value(base, pct, star) -> tuple[int, int]`
返回 `(最终值, 能力加成部分)`。
```
星级基础值 = floor(基础值 × 倍率)
最终值 = floor(星级基础值 × (1 + 能力加成%))
```

#### `STAR_MULT = {0: (1, 1), 1: (6, 5), 2: (13, 10), 3: (7, 5)}`
升星倍率（分子/分母）：0★=×1.0 / 1★=×1.2 / 2★=×1.3 / 3★=×1.4。

#### `parse_ability_stat_bonuses(desc, kind, active_condition, tag_map, series_by_id) -> tuple[dict, list[dict]]`
从能力效果描述解析属性百分比加成，返回 `(无条件加成 {stat: pct}, 条件加成 [{name, stat, pct, condition}])`。

#### `parse_weapon_max_level(weapon_status) -> dict`
从 `weapon_status` 计算武器最高级数值与最高级特效。属性取 `stats_change` 最高级修正（`floor(基础值 × 修正率 / 100)`），特效取最高级槽位。

#### `parse_supporter_conditions(skills, series_by_id, tag_by_id) -> tuple[list[dict], list[str]]`
解析支援角色队长技的 `trait_condition`，返回 `(条件描述列表, 可搜索标签列表)`。

### 5.7 `src/cloud.py`

#### `TABLE_ORDER`
21 张表的写入顺序列表（父表在前，外键依赖），恢复/迁移时按此顺序写入。

#### `upload_local_db_to_cloud(url) -> dict`
把本地 SQLite 全量重建到云端（覆盖），逐表校验行数后返回结果。

#### `restore_local_db_from_cloud(url, db_path) -> bool`
从云端 PostgreSQL 重建本地 SQLite。**带断点续传**：已恢复表不重复下载，失败表最多重试 3 轮；每张表由独立子进程拉取并带 180s 硬超时。

#### `cloud_diff(url) -> dict`
对比本地与云端的各表行数、构建时间与本地完整性（`PRAGMA quick_check`）。

#### `unit_sync_diff(unit_id) -> dict` / `unit_sync_push(unit_id) -> dict`
单机体级别的差异对比与推送（覆盖该机体的 unit / weapons / abilities）。

#### `direct_cloud_url(url) -> str`
把 Neon 池化地址（`-pooler.`）转为直连地址，批量读写更快。

### 5.8 `src/webapp.py`

#### `Handler(BaseHTTPRequestHandler)`
HTTP 请求处理器，实现：
- `_send_json(obj, status)` — 发送 JSON 响应；
- `_send_file_download(path, filename)` — 发送文件下载；
- `_read_upload(max_bytes)` — 流式读取上传内容到临时文件；
- `_handle_api(path, q)` — 路由 GET API；
- `_handle_static(path)` — 静态文件服务（带路径穿越防护）；
- `do_GET` / `do_POST` — 入口。

#### `run_server(port=8765) -> None`
启动 `ThreadingHTTPServer`，监听 `127.0.0.1:{port}`。

#### `start_crawl(preserve) -> dict` / `crawl_status() -> dict`
手动爬取任务（后台线程，保留指定机体编辑）。

#### `start_sync(direction) -> dict` / `sync_status() -> dict`
云端同步任务（`direction = "upload" | "download"`）。

#### `api_summary() -> dict`
概览数据：各表行数、构建时间、数据库大小、完整性。

#### `api_unit_edit(payload, preview) -> dict`
机体编辑：校验 + 差异对比；`preview=False` 时写库并记录 `unit_edit_log`。

#### `api_damage(q) -> dict` / `api_damage_sim(q) -> dict` / `api_damage_bonus(...) -> dict`
伤害计算接口：单次计算 / 多次模拟 / 含能力加成的完整计算。

### 5.9 `src/maintain.py`

#### `run_update(full, limit) -> int`
一键更新：快照 → fetch → build → verify → 报告；**build 失败自动回滚**。

#### `backup_db() -> str | None`
快照当前数据库到 `data/backup/`，滚动保留最近 3 份。

#### `diff_report(old_db, new_db) -> None`
对比更新前后的数据库：各表行数增减、新增机体名单、机体/驾驶员行级变更。

---

## 6. 数据库设计

数据库为 SQLite（`data/db/gundam.db`），开启 WAL 模式与外键。共 21 张表，按外键依赖排序：

### 6.1 字典表

| 表 | 主键 | 说明 |
|---|---|---|
| `meta` | `key` | 元信息（`built_at` / `star_multipliers` / `star_labels` / `star_formula`） |
| `tag` | `id` | 标签字典（`id → name`） |
| `faction` | `id` | 阵营字典 |
| `series` | `id` | 系列表（含 `scenario` 剧情信息） |

### 6.2 实体表

| 表 | 主键 | 外键 | 说明 |
|---|---|---|---|
| `unit` | `id` | `series_id → series` | 机体（含基础/max/sp/ssp 四形态属性、`stat_bonuses`、`conditional_bonuses`、`tags`、`terrain` 等） |
| `character` | `id` | `series_id → series` | 驾驶员（含四形态属性、`support_info`） |
| `supporter` | `id` | — | 支援角色（含 `tags`） |

### 6.3 实体子表

| 表 | 外键 | 说明 |
|---|---|---|
| `unit_weapon` | `unit_id → unit` | 机体武器（含 `power_lv5` / `power_lv9`、`weapon_effects`、`map_weapon_*`） |
| `unit_ability` | `unit_id → unit` | 机体能力 |
| `unit_skill` | `unit_id → unit` | 机体技能 |
| `character_skill` | `character_id → character` | 驾驶员技能 |
| `character_ability` | `character_id → character` | 驾驶员能力 |
| `supporter_growth` | — | 支援角色成长表 |
| `supporter_skill` | `supporter_id → supporter` | 支援角色技能（`leader` / `active`，含 `conditions`） |

### 6.4 关卡与事件表

| 表 | 主键 | 外键 | 说明 |
|---|---|---|---|
| `stage` | `id` | — | 关卡（含 `map` JSON、地形标志） |
| `stage_map_npc` | `mid` | `stage_id → stage` | 关卡敌方机体实例 |
| `stage_map_npc_character` | `id` | `stage_id → stage` | 关卡敌方驾驶员实例 |
| `story_event` | `event_id` | `series_id → series` | 剧情事件 |
| `story_event_boss` | `stage_id` | `event_id → story_event` | 剧情 Boss |
| `tower_event` | `event_id` | — | 塔楼事件 |
| `tower_stage` | `stage_id` | `tower_event_id → tower_event` | 塔楼关卡 |

### 6.5 编辑表

| 表 | 主键 | 说明 |
|---|---|---|
| `unit_edit_log` | `id` | 本地机体编辑历史（`unit_id` / `field` / `old_value` / `new_value` / `edited_at` / `source`），`build_db` 不会清空此表 |

### 6.6 关键索引

- `idx_unit_weapon_unit` / `idx_unit_ability_unit` / `idx_char_skill_char` / `idx_char_ability_char`
- `idx_map_npc_stage` / `idx_npc_char_stage`
- `idx_edit_log_unit`

### 6.7 JSON 存储字段

部分字段以 JSON 文本存储，需在应用层解析：
- `unit.tags` / `unit.series_ids` / `unit.terrain` / `unit.stat_bonuses` / `unit.conditional_bonuses` / `unit.transform_to`
- `unit_weapon.weapon_attrs` / `unit_weapon.weapon_effects` / `unit_weapon.map_weapon_range`
- `*_ability.traits` / `*_skill.traits`
- `supporter_skill.traits` / `supporter_skill.conditions`
- `stage.condition` / `stage.map`
- `character.support_info` / `character.stat_bonuses` / `character.conditional_bonuses`

---

## 7. 依赖关系

### 7.1 模块间依赖

```
config.py            （无依赖，被所有模块导入）
   ↑
api.py               （依赖 config）
   ↑
fetch.py             （依赖 api, config）
   ↑
labels.py            （无内部依赖，纯解析）
   ↑
db.py                （依赖 config, labels）
   ↑
verify.py            （依赖 config）
maintain.py          （依赖 config, db, fetch, labels, verify）
cloud.py             （依赖 config, db.SHEMA；延迟导入 psycopg）
damage.py            （无内部依赖，纯计算）
   ↑
pairing.py           （依赖 config, damage, labels）
   ↑
webapp.py            （依赖 config, cloud, damage, pairing, db, fetch, labels）
   ↑
scripts/pipeline.py  （依赖 src.* 多个模块）
```

### 7.2 外部依赖

| 依赖 | 用途 | 必需性 |
|---|---|---|
| Python 3.10+ | 运行环境 | 必需 |
| `psycopg` | 云端 PostgreSQL 同步 | 可选（仅 `cloud.py` 延迟导入） |
| 站点 API | 数据来源 | 抓取时必需 |
| Neon PostgreSQL | 云端备份 | 可选 |

### 7.3 前端依赖

无任何前端依赖，纯原生 HTML/CSS/JS。

---

## 8. API 接口参考

Web 服务默认监听 `http://127.0.0.1:8765`。所有 API 返回 JSON，`Cache-Control: no-store`。

### 8.1 GET 接口

#### 概览与元信息
- `GET /api/summary` — 数据概览（各表行数、构建时间、数据库大小）
- `GET /api/series` — 系列列表
- `GET /api/tags?kind=unit|character|supporter` — 标签列表
- `GET /api/skillnames` — 驾驶员技能名列表
- `GET /api/support-labels` — 支援标签列表
- `GET /api/supporter-skillnames` — 支援角色主动技名列表
- `GET /api/weapon-effects` — 武器特效列表
- `GET /api/abilities` — 能力列表
- `GET /api/supporter-panel` — 支援角色面板

#### 列表查询
- `GET /api/units?q=&rarity=&acq=&series=&type=&tags=&tag_mode=&match=&wfx=&wfx_mode=&cond=&sort=&order=&limit=&offset=`
- `GET /api/characters?q=&rarity=&series=&type=&tags=&tag_mode=&match=&skills=&skill_mode=&support=&sort=&order=&limit=&offset=`
- `GET /api/supporters?q=&tags=&tag_mode=&skills=&skill_mode=&sort=&order=&limit=&offset=`
- `GET /api/stages?q=&limit=&offset=`
- `GET /api/search?type=&q=&kind=&sort=&order=&limit=&offset=` — 技能/能力/效果搜索
- `GET /api/picker/units?q=&source=library|enemy&rarity=&type=&series=&tags=&sort=&order=&limit=&offset=` — 伤害计算器机体选择器
- `GET /api/picker/pilots?...` — 驾驶员选择器

#### 详情
- `GET /api/units/{id}` — 机体详情
- `GET /api/characters/{id}` — 驾驶员详情
- `GET /api/supporters/{id}` — 支援角色详情
- `GET /api/stages/{id}` — 关卡详情（含敌方机体/驾驶员）

#### 配对与伤害
- `GET /api/pairing/match?unit_id=&action=attack|defense&weapon_id=&bench=low|mid&...` — 配对推荐
- `GET /api/pairing/default-enemy` — 默认敌方
- `GET /api/damage?aua=&aca=&dud=&dcd=&wp=&terrain=&vigor=&critical=&buff=&debuff=...` — 单次伤害计算
- `GET /api/damage-sim?...` — 多次伤害模拟
- `GET /api/damage-bonus?atk_uid=&atk_pid=&def_uid=&def_pid=&weapon_attr=&attack_attr=...` — 含能力加成的完整伤害计算

#### 爬取与同步状态
- `GET /api/crawl-status` — 爬取任务状态
- `GET /api/crawl-edits` — 有本地编辑的机体列表
- `GET /api/edit-history?limit=` — 编辑历史
- `GET /api/sync-status` — 同步任务状态
- `GET /api/sync-diff` — 本地与云端差异对比
- `GET /api/unit-sync-diff?unit_id=` — 单机体云端差异

#### 导出
- `GET /api/export` — 下载 `gundam.db`

### 8.2 POST 接口

- `POST /api/crawl` — 启动爬取任务（body: `{"preserve": [unit_id, ...]}`，保留指定机体编辑）
- `POST /api/sync` — 启动云端同步（body: `{"direction": "upload|download"}`）
- `POST /api/unit-edit?preview=0|1` — 机体编辑（`preview=1` 仅预览差异，`preview=0` 写库）
- `POST /api/unit-sync` — 单机体推送到云端（body: `{"unit_id": ...}`）
- `POST /api/import` — 导入数据库文件（流式上传，最大 512MB，校验后替换）

### 8.3 静态资源

- `GET /` → `web/index.html`
- `GET /style.css` / `/app.js` → `web/` 下文件（带路径穿越防护）

---

## 9. 项目运行方式

### 9.1 环境准备

```powershell
# 1. 克隆仓库
git clone <repo>
cd gundam

# 2. 无需安装依赖（仅使用 Python 标准库）
# 仅在需要云端同步时安装 psycopg：
pip install psycopg-binary  # 或 psycopg[binary]
```

### 9.2 环境变量

可选，仅云端同步需要。复制 `.env.example` 为 `.env` 并填入：

```
NEON_DB_URL=postgresql://user:password@host/database?sslmode=require
```

或在 PowerShell 临时设置：

```powershell
$env:NEON_DB_URL = "postgresql://user:pass@host/db?sslmode=require"
```

### 9.3 命令行入口

所有命令通过 `scripts/pipeline.py` 执行：

```powershell
python scripts/pipeline.py update           # 日常：快照+增量抓取+构建+校验+变更报告
python scripts/pipeline.py update --full    # 每月：全量重抓，刷新已有数值改动
python scripts/pipeline.py fetch            # 仅抓取（增量，断点续传）
python scripts/pipeline.py fetch --refresh  # 仅抓取（全量重抓已有详情）
python scripts/pipeline.py fetch --limit 10 # 冒烟测试：每类详情只抓 10 条
python scripts/pipeline.py build            # 原始 JSON → SQLite
python scripts/pipeline.py verify            # 数量与抽样校验
python scripts/pipeline.py backup           # 手动快照（data/backup/，保留 3 份）
python scripts/pipeline.py all              # fetch + build + verify
python scripts/pipeline.py restore          # 从云端 PostgreSQL 恢复本地数据库
python scripts/pipeline.py serve --port 8765 # 启动本地 Web 查看器
python scripts/pipeline.py manifest         # 查看 manifest.json 概要
```

### 9.4 npm 别名

```json
{
  "scripts": {
    "dev": "python scripts/pipeline.py serve --port 8765",
    "update": "python scripts/pipeline.py update",
    "update:full": "python scripts/pipeline.py update --full",
    "backup": "python scripts/pipeline.py backup",
    "build": "python scripts/pipeline.py build",
    "fetch": "python scripts/pipeline.py fetch",
    "verify": "python scripts/pipeline.py verify"
  }
}
```

使用：`npm run dev` / `npm run update` / `npm run update:full` 等。

### 9.5 启动 Web 服务

```powershell
# 方式 1：直接命令
python scripts/pipeline.py serve --port 8765

# 方式 2：npm 别名
npm run dev
```

启动后浏览器打开 <http://127.0.0.1:8765>，可浏览：
- 概览（数据概览、导入/导出、爬取、云端同步）
- 机体 / 驾驶员 / 支援角色 / 关卡敌人
- 技能·能力·效果搜索
- 伤害计算器（公式来自 `formulas.docx`）
- 配对（机体 → 驾驶员 / 驾驶员 → 机体）

**启动兜底**：本地无数据库时，`serve` 会自动尝试从云端恢复；失败则在空库状态下启动，可在概览页「导入数据库」或点击「爬取数据」。

### 9.6 云端同步

```powershell
# 上传本地到云端（重建全部表并覆盖）
python scripts/migrate_cloud.py

# 或在 Web 概览页点击「上传本地到服务器」
```

### 9.7 数据库结构升级

```powershell
# 幂等升级：补齐 unit_weapon 的 lv9 列、weapon_attrs 列、unit_edit_log 表
python scripts/migrate_schema.py
```

### 9.8 查看抓取进度

```powershell
python scripts/status.py
```

### 9.9 伤害计算演示

```powershell
python scripts/damage_demo.py
```

---

## 10. 核心业务规则

### 10.1 类型与稀有度

- **类型**（`role`）：1=攻击型、2=耐久型、3=支援型（依据属性分布推断）。
- **稀有度**（`rarity`）：5=UR、4=SSR、3=SR、2=R、1=N。
- **等级上限**：UR=100、SSR=90、SR=80、R=70、N=60。
- **多系列归属**：机体/驾驶员可同时属于多个系列（`series_set`），系列筛选按全量匹配。

### 10.2 星级计算

- **星级**：仅机体有星级（0/1/2/3 四档），驾驶员没有星级；
- **倍率**：0★=×1.0、1★=×1.2、2★=×1.3、3★=×1.4；
- **作用范围**：机体星级作用于 HP/EN/攻击力/防御力/机动力；驾驶员作用于射击/格斗/防御/反应/觉醒；
- **公式**：
  ```
  星级基础值 = floor(基础值 × 倍率)
  最终值 = floor(星级基础值 × (1 + 能力加成%))
  ```
  界面绿色 `+N` = `最终值 − 星级基础值`（即能力加成部分）。
- **终极标签机体**：带「终极」标签的机体不能 SP、不能升星，一律使用无 SP、0 星数据。
- **SP / SSP**：非 UR 机体需 SP 才能升到满级 100；SSP（以 SP 为前提）直接显示最终属性；数据未收录 SSP 时按 SP 数值显示并提示。
- 公式记录在数据库 `meta` 表（`star_multipliers` / `star_labels` / `star_formula`）。

### 10.3 武器等级

- 所有武器直接显示最高级（普通武器 LV5，SSP 武器特效到 LV9）；
- 属性取属性成长最高档（1~5 级）修正值：`floor(基础值 × 修正率 / 100)`；
- 特效取最高级对应槽位的特效名 + 完整效果文本。

### 10.4 能力加成

- **无条件能力加成**（如「最大HP提升15%」）直接并入属性显示（`stat_bonuses`）；
- **有条件能力加成**（需达成标签/系列/HP/战意等条件）存入 `conditional_bonuses`，可在属性栏点击「查看条件加成」查看。

### 10.5 配对评分（满分 100）

| 项 | 分值 | 说明 |
|---|---|---|
| 属性契合 | 30 | 驾驶员射击/格斗/觉醒属性与机体武器属性（`attack_attr` 1=射击、2=格斗、3=觉醒）匹配度 |
| 驾驶员加成 | 50 | 技能（0.7 权重）/能力（1.0 权重）中可作用于该机体的伤害与属性加成，含系列/标签条件 |
| 同系列 | 6 | 驾驶员与机体同属一个系列 |
| 支援加成 | 20 | 支援队长技对该机体系列/标签条件的加成 |

**新版本（`pairing.py`）** 改为基于伤害公式计算：
- **攻击模式**：单次伤害（非暴击）+ 暴击伤害；`crit_rate >= 100` 时取暴击伤害为得分；
- **防御模式**：满级防御值 + 减伤% + 特殊机制加权，通过逐次伤害模拟计算可承受攻击次数。

### 10.6 伤害公式链

详见 `formulas.docx` 与 [5.1 节](#51-srcdamagepy)。关键修正：
- **战意加成**：强势 +10%、超强势 +20%、超一击 +30%（战意不产生暴击）；
- **暴击修正**：一般 +10%、强势/超强势 +20%、超一击 +30%；
- **护盾修正**（`defensive_correction`）：默认 1.0，有护盾时 0.8；
- **防御模式**（`GUARD_CORRECTION`）：不防御=1.0、防御不带盾=0.8、防御且带盾=0.6。

### 10.7 抓取节流

- 全局最小请求间隔 1.8s（约 0.5 请求/秒）+ 0.4s 随机抖动；
- 单线程串行（`MAX_WORKERS=1`）；
- 每批次 200 条，批次间暂停 120s；
- 403/429 限流时关闭连接、设置全局标记，后续请求直接抛 `RateLimitAbort` 终止任务；
- 全量重抓 1800+ 详情约需 1~2 小时。

### 10.8 断点续传

- 抓取：已存在的详情文件自动跳过，可随时中断重跑；
- 云端恢复：已恢复表不重复下载，失败表最多重试 3 轮；
- 原子写：JSON 先写 `.tmp` 再 `replace`，避免中断产生半个文件。

---

## 11. 故障排查与维护

### 11.1 常见问题

| 症状 | 处理 |
|---|---|
| `update` 中途限流终止 | 正常，直接重跑同一命令，续传 |
| `build` 失败已回滚 | 看报错；多为原始 JSON 缺失，先重跑 `fetch` |
| 库被改坏 | `data/backup/` 里最近的快照复制回 `data/db/gundam.db` |
| Web 打开是空库 | 概览页「导入数据库」或「爬取数据」，或 `pipeline.py restore` 从云端恢复 |
| 云端连接被拦截（10013） | 在普通终端运行，或放行防火墙/安全软件后重试同步 |
| 云端连接超时 | 检查网络；`restore_local_db_from_cloud` 单表 180s 硬超时，超时直接杀子进程 |

### 11.2 维护节奏

| 频率 | 做什么 | 命令 |
|---|---|---|
| 每周（或版本更新后） | 增量更新 | `python scripts/pipeline.py update` |
| 每月一次 | 全量刷新 | `python scripts/pipeline.py update --full` |
| 随时 | 手动快照 | `python scripts/pipeline.py backup` |
| 随时 | 看抓取进度 | `python scripts/status.py` |

### 11.3 备份约定

- **本地**：`data/backup/` 滚动保留最近 3 份快照（`KEEP_BACKUPS`，单份约 190 MB）；
- **网盘**：每月把最新快照上传到项目资产（tdrive）`gundam/backup/`，历史快照按 `gundam_YYYYmmdd.db` 命名，保留最近 2 份；
- **云端 Neon**：`update` 完成后可手动同步（Web 概览页「上传本地到服务器」，或 `python scripts/migrate_cloud.py`）。

### 11.4 `update` 命令做了什么

```
快照当前库 → data/backup/gundam_YYYYmmdd_HHMMSS.db（滚动保留最近 3 份）
  → fetch（增量：已存在的详情跳过；--full 则全部重抓）
  → build（INSERT OR REPLACE，手工编辑 unit_edit_log 不受影响）
  → verify（数量与抽样校验）
  → 变更报告（各表行数增减 / 新增机体名单 / 机体·驾驶员数值变更条目）
```

- **build 阶段抛异常会自动用快照回滚**，旧库不会丢；
- fetch 触发站点限流（403/429）会自动终止保护 IP，已完成部分保留，下次运行自动续传。

### 11.5 数据礼貌

- 来源：`https://soshage.com/ggetapi/zh-CN/...`（仅 zh-CN）；
- 保持低频访问，不要调大并发/降低间隔；限流终止是保护机制，别绕过；
- 数据仅供个人研究使用，请注明来源。

---

## 附录：关键文件快速索引

| 文件 | 行数 | 说明 |
|---|---|---|
| [src/webapp.py](file:///e:/lzf/1_study/gundam/src/webapp.py) | ~2995 | Web 服务（最大文件） |
| [src/pairing.py](file:///e:/lzf/1_study/gundam/src/pairing.py) | ~1402 | 配对推荐引擎 |
| [src/db.py](file:///e:/lzf/1_study/gundam/src/db.py) | ~929 | JSON → SQLite 入库 |
| [src/cloud.py](file:///e:/lzf/1_study/gundam/src/cloud.py) | ~764 | 云端 PostgreSQL |
| [src/labels.py](file:///e:/lzf/1_study/gundam/src/labels.py) | ~415 | 标签与数值解析 |
| [src/fetch.py](file:///e:/lzf/1_study/gundam/src/fetch.py) | ~192 | 抓取编排 |
| [src/webapp.py](file:///e:/lzf/1_study/gundam/src/damage.py) | ~155 | 伤害计算 |
| [src/maintain.py](file:///e:/lzf/1_study/gundam/src/maintain.py) | ~162 | 维护流程 |
| [src/api.py](file:///e:/lzf/1_study/gundam/src/api.py) | ~135 | HTTP 客户端 |
| [src/verify.py](file:///e:/lzf/1_study/gundam/src/verify.py) | ~90 | 校验 |
| [src/config.py](file:///e:/lzf/1_study/gundam/src/config.py) | ~51 | 配置 |

---

*本文档由代码静态分析生成，最后更新于项目当前状态。如有疑问请参阅 [README.md](file:///e:/lzf/1_study/gundam/README.md) 与 [MAINTENANCE.md](file:///e:/lzf/1_study/gundam/MAINTENANCE.md)。*
