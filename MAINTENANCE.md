# 维护手册（MAINTENANCE）

本项目的定位是**定期维护更新的游戏资料库**。本手册定义日常维护流程，全部手动触发。

## 一图流

| 频率 | 做什么 | 命令 |
|---|---|---|
| 每周（或版本更新后） | 增量更新：抓新增机体/驾驶员/关卡 + 重建库 + 变更报告 | `python scripts/pipeline.py update` |
| 每月一次 | 全量刷新：重抓所有详情，覆盖已有条目的数值改动 | `python scripts/pipeline.py update --full` |
| **动过算法/正则后** | **跑回归测试**（伤害公式、文案解析、配对排名） | `python -m unittest discover -s tests -t .` |
| 每月一次 | 把最新数据库传到项目资产（tdrive）| 对布丁说"把 gundam.db 传到项目资产" |
| 随时 | 手动快照当前库 | `python scripts/pipeline.py backup` |
| 随时 | 看抓取进度 | `python scripts/status.py` |

npm 别名：`npm run update` / `npm run update:full` / `npm run backup`。

## update 命令做了什么

```
快照当前库 -> data/backup/gundam_YYYYmmdd_HHMMSS.db（滚动保留最近 3 份）
  -> fetch（增量：已存在的详情跳过；--full 则全部重抓）
  -> build（INSERT OR REPLACE，手工编辑 unit_edit_log 不受影响）
  -> verify（数量与抽样校验）
  -> 变更报告（各表行数增减 / 新增机体名单 / 机体·驾驶员数值变更条目）
```

- **build 阶段抛异常会自动用快照回滚**，旧库不会丢。
- fetch 触发站点限流（403/429）会自动终止保护 IP，已完成部分保留，下次运行自动续传。
- 抓取节流配置在 `src/config.py`（当前约 0.5 请求/秒 + 批次间 120s 暂停，
  全量重抓 1800+ 详情约需 1~2 小时，属正常）。

## 回归测试

```powershell
python -m unittest discover -s tests -t .
```

- **零第三方依赖**：用标准库 `unittest`，不装 pytest 也能跑（装了 pytest 也能直接收集）。
- **约 1 秒跑完 68 条**，改完代码随手跑一次。
- 需要数据库的用例（配对排名）在无 `data/db/gundam.db` 时会自动跳过。

三个模块各有分工，改哪里就该看哪里：

| 文件 | 锁的是什么 | 典型翻车场景 |
|---|---|---|
| `tests/test_damage.py` | 伤害公式链、战意/暴击/护盾档位、向上取整语义 | 把 `ceil` 改成 `round`，伤害普遍少 1 |
| `tests/test_labels.py` | 星级倍率换算、11 组效果正则、武器最高级换算 | 改 `CRIT_DMG_RE` 导致爆击损伤被重复计入 |
| `tests/test_pairing.py` | 文案→效果字典、配对排名顺序与稳定性 | 「攻击力及防御力提升15%」被算成两次变 30% |

其中 `test_labels.py::TestRegexAgainstRealCorpus` 会拿数据库里的**真实**能力文案
给每条正则做体检——某条正则一个都匹配不到时直接失败，防止改正则时把一整类
效果悄悄漏掉。

## 为什么每月要跑一次 --full

增量模式只抓**新增**条目；游戏平衡性调整会改动**已有**机体的数值，
这些改动只有全量重抓才会进库。每月一次 `update --full` 兜底即可。

## 备份约定

- 本地：`data/backup/` 滚动保留最近 **3** 份快照（可在 `src/maintain.py` 的
  `KEEP_BACKUPS` 调整），单份约 24 MB（09-10 移除 `stage.map` 后由 190 MB 降下来）。
- 网盘：每月把最新一份快照上传到项目资产（tdrive）`gundam/backup/`，
  历史快照按 `gundam_YYYYmmdd.db` 命名，保留最近 2 份。
- 云端 Neon（如已配置 `NEON_DB_URL`）：update 完成后可手动同步
  （Web 概览页「上传本地到服务器」，或 `python scripts/migrate_cloud.py`）。

## 数据来源与礼貌抓取

- 来源：`https://soshage.com/ggetapi/zh-CN/...`（仅 zh-CN）。
- 保持低频访问，不要调大并发/降低间隔；限流终止是保护机制，别绕过。
- 数据仅供个人研究使用。

## 故障排查

| 症状 | 处理 |
|---|---|
| update 中途限流终止 | 正常，直接重跑同一命令，续传 |
| build 失败已回滚 | 看报错；多为原始 JSON 缺失，先重跑 fetch |
| 库被改坏 | `data/backup/` 里最近的快照复制回 `data/db/gundam.db` |
| Web 打开是空库 | 概览页「导入数据库」或「爬取数据」，或 `pipeline.py restore` 从云端恢复 |
| **update 报 `HTTP 404 for GET /ggetapi/...`** | **数据源失效**，不是本项目的问题。先确认 `https://soshage.com/gget/` 能否打开：若站点本身报 500，则是站点故障或改版，只能等它恢复（或人工找到新 API 路径后改 `src/config.py` 的 `API_BASE`）。现有数据不受影响，查/算/配都能正常用 |
| 测试失败 | 先看是哪个模块；若是你有意改了公式或正则，更新对应期望值并确认口径变化 |
