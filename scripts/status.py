"""查看后台抓取状态：进程是否存活、进度、日志尾部。"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src import config  # noqa: E402


def _count(rel: str) -> int:
    p = config.RAW_DIR / rel
    return len(list(p.glob("*.json"))) if p.exists() else 0


def _manifest_totals() -> dict:
    """从 manifest.json 读取上次抓取的各类总数（无 manifest 时用估算值）。"""
    fallback = {"unit": 1210, "stage": 594, "event/story": 14}
    try:
        with open(config.MANIFEST_PATH, encoding="utf-8") as fh:
            counts = json.load(fh).get("counts", {})
        totals = {
            "unit": counts.get("unit", fallback["unit"]),
            "stage": counts.get("stage", fallback["stage"]),
            "event/story": counts.get("event/story", fallback["event/story"]),
        }
    except (OSError, ValueError):
        totals = fallback
    return totals


def _process_alive(pid: int) -> bool:
    try:
        out = subprocess.check_output(
            ["tasklist", "/FI", f"PID eq {pid}"], text=True, errors="ignore"
        )
        return str(pid) in out
    except Exception as exc:
        print(f"（进程查询受限：{exc}）")
        return True  # 无法查询时按存活处理，以进度增长为准


def main() -> None:
    pid_file = config.META_DIR / "fetch.pid"
    if not pid_file.exists():
        print("无抓取记录（data/meta/fetch.pid 不存在）")
        return
    pid = int(pid_file.read_text().strip())
    alive = _process_alive(pid)
    print(f"进程: PID {pid} {'运行中' if alive else '已结束'}")

    unit = _count("unit") - (1 if (config.RAW_DIR / "unit" / "min.json").exists() else 0)
    stage = _count("stage")
    story_event = _count("event/story") - (1 if (config.RAW_DIR / "event" / "story" / "story.json").exists() else 0)
    totals = _manifest_totals()
    t_unit, t_stage, t_story = totals["unit"], totals["stage"], totals["event/story"]
    print(f"机体详情: {unit} / {t_unit} ({unit / max(t_unit, 1) * 100:.1f}%)")
    print(f"关卡详情: {stage} / {t_stage} ({stage / max(t_stage, 1) * 100:.1f}%)")
    print(f"剧情事件详情: {story_event} / {t_story}")

    out_log = config.META_DIR / "fetch_out.log"
    err_log = config.META_DIR / "fetch_err.log"
    for name, log in (("stdout", out_log), ("stderr", err_log)):
        if log.exists() and log.stat().st_size:
            lines = log.read_text(encoding="utf-8", errors="ignore").splitlines()
            print(f"--- {name} 末尾 {min(8, len(lines))} 行 ---")
            for line in lines[-8:]:
                print("  " + line)


if __name__ == "__main__":
    main()
