"""查看后台抓取状态：进程是否存活、进度、日志尾部。"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src import config  # noqa: E402


def _count(rel: str) -> int:
    p = config.RAW_DIR / rel
    return len(list(p.glob("*.json"))) if p.exists() else 0


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
    print(f"机体详情: {unit} / 1210 ({unit / 1210 * 100:.1f}%)")
    print(f"关卡详情: {stage} / 594 ({stage / 594 * 100:.1f}%)")
    print(f"剧情事件详情: {story_event} / 14")

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
