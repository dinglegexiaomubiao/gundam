"""数据库连接与库文件操作的安全封装。

把三件容易被各模块各写一份、且容易写错的事收敛到一处：

1. **只读连接**：统一走 ``file:...?mode=ro`` URI（物理上杜绝误写）+ 统一
   ``timeout``（即 SQLite 的 busy_timeout）。默认 30s，爬取/云端同步与
   前端保存并发时不再直接抛 ``database is locked``。
2. **可写连接**：统一开 WAL + ``foreign_keys=ON`` + 同样的 timeout。
3. **整库文件替换**：``swap_db_file()`` 会先 checkpoint、清边车再 replace，
   并把 Windows 下 ``WinError 5``（文件被占用）转成可读提示；
   ``backup_db_file()`` 用 SQLite 在线备份 API 生成**一致快照**
   （自动包含已提交但尚未 checkpoint 的 WAL 内容）。

依赖极简（仅标准库），任何模块都可以安全导入，不会产生循环依赖。
"""
from __future__ import annotations

import os
import sqlite3
from pathlib import Path

DEFAULT_TIMEOUT = 30.0
SIDECAR_SUFFIXES = ("-wal", "-shm")


def connect_ro(db_path, timeout: float = DEFAULT_TIMEOUT, row_factory=sqlite3.Row) -> sqlite3.Connection:
    """只读连接：物理防写 + 统一 busy_timeout。

    ``row_factory=None`` 可保留默认的元组行（供按位置解包/直接打印的调用方）。
    """
    conn = sqlite3.connect(
        f"file:{Path(db_path)}?mode=ro", uri=True, timeout=timeout
    )
    conn.row_factory = row_factory
    return conn


def connect_rw(db_path, timeout: float = DEFAULT_TIMEOUT) -> sqlite3.Connection:
    """可写连接：WAL + 外键 + 统一 busy_timeout。"""
    p = Path(db_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(p, timeout=timeout)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def checkpoint_and_clear(db_path) -> None:
    """把 WAL 内容合并回主库并删除 ``-wal`` / ``-shm`` 边车。

    整库替换前的必要准备：否则替换成功后残留的陈旧 WAL 会被当成
    新库的「未合并事务」，造成脏读甚至损坏。
    """
    p = Path(db_path)
    if p.exists():
        try:
            conn = sqlite3.connect(p, timeout=DEFAULT_TIMEOUT)
            try:
                conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                conn.commit()
            finally:
                conn.close()
        except sqlite3.Error:
            # 库损坏或不可写时也要继续清理边车，交由调用方后续处理。
            pass
    _drop_sidecars(p)


def _drop_sidecars(db_path: Path) -> None:
    for suffix in SIDECAR_SUFFIXES:
        try:
            Path(str(db_path) + suffix).unlink(missing_ok=True)
        except OSError:
            pass


def swap_db_file(src, dst) -> None:
    """用 ``src`` 原子替换主库 ``dst``，并清理两侧边车。

    Windows 下若主库仍被其它进程**或本进程其它线程**打开，
    ``os.replace`` 会抛 ``PermissionError(WinError 5)``；这里转成
    可操作的提示，而不是让用户对着「拒绝访问」猜原因。
    """
    src, dst = Path(src), Path(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    checkpoint_and_clear(dst)
    try:
        os.replace(src, dst)
    except PermissionError as exc:
        raise PermissionError(
            f"无法替换数据库文件（{dst}）：文件仍被占用。"
            "请先停止其它正在运行的 serve / 爬取进程后重试。"
        ) from exc
    # 新库自带的数据之外，任何残留边车都必须清掉。
    _drop_sidecars(dst)
    _drop_sidecars(src)


def backup_db_file(src, dst) -> None:
    """用 SQLite 在线备份 API 生成一致快照。

    相比 ``shutil.copy2`` 直接拷文件，它不会漏掉尚未 checkpoint 的 WAL
    内容，也不会拷到「数据库头是新的、WAL 没跟上」的半截状态。
    """
    src, dst = Path(src), Path(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        dst.unlink()
    # 源库以读写方式打开：只读方式打开 WAL 库依赖 -shm 是否可创建，
    # 这里只做读取、不写数据，读写打开最稳妥。
    source = sqlite3.connect(src, timeout=DEFAULT_TIMEOUT)
    try:
        dest = sqlite3.connect(dst, timeout=DEFAULT_TIMEOUT)
        try:
            source.backup(dest)
        finally:
            dest.close()
    finally:
        source.close()
