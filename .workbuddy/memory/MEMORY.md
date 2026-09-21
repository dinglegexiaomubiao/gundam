# MEMORY

## gundam 项目（高达 G 世纪永恒资料库）
- 位置：E:\lzf\1_study\gundam；纯 Python 标准库，soshage.com 抓取 + SQLite + Web 查看器
- 已备份至项目资产 tdrive gundam/（目录 ID：根 JhVfqBlgcDHE / src JemWODZvOGjA / scripts JruveOvEsDVQ / web JEWfuibsOKel），2026-08-17 上传，22 个文件
- data/ 目录（189MB 数据库 + 1827 JSON）未上传
- 爬取范围约定（2026-09-21 起）：点击「爬取数据」仅抓取并重建 机体/驾驶员/支援角色 三类（其技能/能力/效果为子表随主表入库）；**关卡敌人(stage)与事件(event)不再爬取**（前端 stages 标签页无数据，属预期）。进度经 on_progress 回调 + /api/crawl-status 轮询展示

## tdrive 上传经验（长期有效）
- COS 临时密钥易失效（InvalidAccessKeyId），必须单文件串行：file_upload → 立即 curl -T → complete；不要批量申请
- file_upload 有 5 秒限流；curl 必须用 -T（流式），严禁 --data-binary 不带 @
