import fcntl
import json
import logging
import os
import re
import threading
import time
from contextlib import contextmanager

from . import config, sync, util
from .clients import Aria2Client, QUARK_UA, QuarkAutoSave, QuarkDrive
from .db import get_db

log = logging.getLogger("pipeline")

# 应用内 + 跨进程（CLI 共用）的批次锁
_batch_guard = threading.Lock()
_paused = threading.Event()
_current_batch_id = None


@contextmanager
def batch_lock(timeout: int = 10):
    """flock quark-links/.batch-lock，与 import_batch.py 共享。"""
    deadline = time.time() + timeout
    fd = os.open(config.BATCH_LOCK, os.O_CREAT | os.O_RDWR, 0o666)
    try:
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.time() > deadline:
                    raise RuntimeError("批次锁被占用（CLI 正在跑批？）")
                time.sleep(1)
        os.ftruncate(fd, 0)
        os.write(fd, str(os.getpid()).encode())
        yield
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def update_state_json(entries: dict):
    """按 import_batch.py 的格式回写 import_state.json（持锁期间调用）。"""
    state = {}
    if os.path.exists(config.STATE_PATH):
        state = json.loads(open(config.STATE_PATH, encoding="utf-8").read())
    state.update(entries)
    tmp = config.STATE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=1)
    os.replace(tmp, config.STATE_PATH)


def parse_batch_results(tasks: list, lines: list) -> dict:
    """按 #N--- 分块解析每部剧的结果，与 import_batch.py 相同逻辑。"""
    blocks, current = {}, None
    for line in lines:
        m = re.match(r"#(\d+)-+$", line)
        if m:
            idx = int(m.group(1)) - 1
            current = tasks[idx]["taskname"] if idx < len(tasks) else None
            blocks.setdefault(current, [])
        elif current:
            blocks[current].append(line)
    results = {}
    for task in tasks:
        name = task["taskname"]
        block = "\n".join(blocks.get(name, []))
        if "添加追更" in block:
            results[name] = "saved"
        elif "没有新的转存任务" in block:
            results[name] = "up_to_date"
        elif "❌" in block or "分享为空" in block:
            results[name] = "dead"
        elif not block:
            results[name] = "no_output"
        else:
            results[name] = "unknown"
    return results


def push_existing_drive_files(drama: dict, aria2: Aria2Client) -> int:
    """已在网盘但没有触发下载插件时，直连夸克取直链推给 aria2。返回推送文件数。"""
    drive = QuarkDrive()
    fid = drive.get_fid(f"{config.SAVE_ROOT}/{drama['title']}")
    if not fid:
        raise RuntimeError("网盘目录不存在")
    items = drive.ls_dir(fid)
    eps_files = []
    for it in items:
        if it.get("dir"):
            continue
        if util.is_episode_name(it["file_name"]):
            eps_files.append(it)
    if not eps_files:
        raise RuntimeError("网盘目录内没有剧集文件")
    out_dir = os.path.join(config.LIB_ROOT, drama["title"])
    os.makedirs(out_dir, exist_ok=True)
    # aria2 容器的挂载点与 manager 不同，推给它的必须是 aria2 侧路径
    aria2_dir = os.path.join(config.ARIA2_LIB_PATH, drama["title"])
    pushed = 0
    ua = f"User-Agent: {QUARK_UA}"
    for i in range(0, len(eps_files), 20):
        chunk = eps_files[i : i + 20]
        urls, extra_cookie = drive.download_urls([x["fid"] for x in chunk])
        headers = [f"Cookie: {extra_cookie}".strip(), ua]
        for item, durl in zip(chunk, urls):
            aria2.add_uri(durl, item["file_name"], aria2_dir, headers)
            pushed += 1
    return pushed


def _append_batch_log(batch_id: int, text: str, conn=None):
    """追加批次日志。传入 conn 时复用调用方事务（同事务内绝不能另开连接写库）。"""
    if conn is not None:
        row = conn.execute("SELECT log FROM batches WHERE id=?", (batch_id,)).fetchone()
        log_text = (row["log"] if row else "") + text + "\n"
        conn.execute("UPDATE batches SET log=? WHERE id=?", (log_text[-20000:], batch_id))
        return
    with get_db() as own:
        row = own.execute("SELECT log FROM batches WHERE id=?", (batch_id,)).fetchone()
        log_text = (row["log"] if row else "") + text + "\n"
        own.execute("UPDATE batches SET log=? WHERE id=?", (log_text[-20000:], batch_id))


def run_batch(batch_id: int, items: list):
    """items: [{queue_id, drama}]，已完成批次记录创建。"""
    tasks = []
    for it in items:
        d = it["drama"]
        tasks.append(
            {
                "taskname": d["title"],
                "enabled": 1,
                "shareurl": d["share_url"],
                "savepath": f"{config.SAVE_ROOT}/{d['title']}",
                "addition": {
                    "aria2": {
                        "auto_download": True,
                        "download_subdir": False,
                        "save_path": "",
                        "pause": False,
                    }
                },
            }
        )
    now = int(time.time())
    quark = QuarkAutoSave()
    aria2 = Aria2Client()
    try:
        lines = quark.run_script_now(tasks, timeout=3600)
    except Exception as e:
        _append_batch_log(batch_id, f"❌ 执行失败: {e}")
        with get_db() as conn:
            for it in items:
                conn.execute(
                    "UPDATE queue SET status='failed', error=?, finished_at=? WHERE id=?",
                    (str(e), now, it["queue_id"]),
                )
                conn.execute(
                    "UPDATE dramas SET download_state='failed', updated_at=? WHERE id=?",
                    (now, it["drama"]["id"]),
                )
            conn.execute(
                "UPDATE batches SET status='failed', finished_at=? WHERE id=?",
                (now, batch_id),
            )
        return

    results = parse_batch_results(tasks, lines)
    pushed_total = sum(1 for l in lines if "📥" in l)
    state_entries = {}
    counts = {"saved": 0, "up_to_date": 0, "dead": 0, "failed": 0}
    retry_push = []  # up_to_date 且本地缺失，需要补推的剧
    with get_db() as conn:
        for it in items:
            d = it["drama"]
            r = results.get(d["title"], "unknown")
            if r in ("saved", "up_to_date"):
                counts["saved" if r == "saved" else "up_to_date"] += 1
                state_entries[d["share_url"]] = {
                    "name": d["title"],
                    "result": r,
                    "ts": int(time.time()),
                }
                conn.execute(
                    "UPDATE dramas SET drive_state='saved', download_state='downloading', updated_at=? WHERE id=?",
                    (now, d["id"]),
                )
                conn.execute(
                    "UPDATE queue SET status='running', batch_id=? WHERE id=?",
                    (batch_id, it["queue_id"]),
                )
                # 本地没有任何剧集文件才补推（目录存在但为空也算缺失——失败重试会留下空目录）
                if r == "up_to_date" and not util.episode_map(
                    os.path.join(config.LIB_ROOT, d["title"])
                ):
                    retry_push.append((it["queue_id"], d))
            elif r == "dead":
                counts["dead"] += 1
                state_entries[d["share_url"]] = {
                    "name": d["title"],
                    "result": "dead",
                    "ts": int(time.time()),
                }
                conn.execute(
                    "UPDATE dramas SET drive_state='dead', download_state='failed', updated_at=? WHERE id=?",
                    (now, d["id"]),
                )
                conn.execute(
                    "UPDATE queue SET status='dead', batch_id=?, error='分享失效', finished_at=? WHERE id=?",
                    (batch_id, now, it["queue_id"]),
                )
            else:
                counts["failed"] += 1
                conn.execute(
                    "UPDATE dramas SET download_state='failed', updated_at=? WHERE id=?",
                    (now, d["id"]),
                )
                conn.execute(
                    "UPDATE queue SET status='failed', batch_id=?, error=?, finished_at=? WHERE id=?",
                    (batch_id, f"转存结果: {r}", now, it["queue_id"]),
                )
            _append_batch_log(batch_id, f"{'✅' if r in ('saved','up_to_date') else '❌'} {d['title']}: {r}", conn=conn)

    update_state_json(state_entries)

    # 补推：已在网盘但插件没触发的剧
    for queue_id, d in retry_push:
        try:
            n = push_existing_drive_files(d, aria2)
            pushed_total += n
            _append_batch_log(batch_id, f"📤 补推 {d['title']}: {n} 个文件")
        except Exception as e:
            _append_batch_log(batch_id, f"⚠️ 补推失败 {d['title']}: {e}")

    with get_db() as conn:
        conn.execute(
            "UPDATE batches SET saved=?, up_to_date=?, dead=?, failed=?, files_pushed=? WHERE id=?",
            (counts["saved"], counts["up_to_date"], counts["dead"], counts["failed"],
             pushed_total, batch_id),
        )

    if pushed_total:
        _append_batch_log(batch_id, f"等待 aria2 下载 {pushed_total} 个文件...")

        def on_tick(s):
            _append_batch_log(
                batch_id,
                f"aria2: active={s['active']} waiting={s['waiting']} speed={s['speed']/1048576:.1f}MB/s",
            )

        aria2.wait_idle(timeout=7200, on_tick=on_tick)

    # 重扫落库（2026-10-27 起不再补零改名，播放器按集数解析原始文件名）
    sync.scan_local()
    done_at = int(time.time())
    with get_db() as conn:
        for it in items:
            d = it["drama"]
            row = conn.execute(
                "SELECT download_state FROM dramas WHERE id=?", (d["id"],)
            ).fetchone()
            if row and row["download_state"] == "downloading":
                # 扫描后仍是 downloading → 本地没有文件，判失败
                conn.execute(
                    "UPDATE dramas SET download_state='failed', updated_at=? WHERE id=?",
                    (done_at, d["id"]),
                )
                conn.execute(
                    "UPDATE queue SET status='failed', error='下载未落盘', finished_at=? WHERE id=?",
                    (done_at, it["queue_id"]),
                )
            elif row and row["download_state"] == "done":
                conn.execute(
                    "UPDATE queue SET status='done', finished_at=? WHERE id=? AND status!='dead'",
                    (done_at, it["queue_id"]),
                )
    with get_db() as conn:
        conn.execute(
            "UPDATE batches SET status='done', finished_at=? WHERE id=?", (done_at, batch_id)
        )
    _append_batch_log(batch_id, "批次完成")


def worker_loop():
    log.info("队列 worker 启动")
    while True:
        time.sleep(3)
        if _paused.is_set():
            continue
        if _batch_guard.locked():
            continue
        with get_db() as conn:
            rows = conn.execute(
                """SELECT q.id AS queue_id, d.*
                   FROM queue q JOIN dramas d ON d.id = q.drama_id
                   WHERE q.status='pending' AND d.share_url IS NOT NULL
                   ORDER BY q.id LIMIT ?""",
                (config.BATCH_SIZE,),
            ).fetchall()
            if not rows:
                continue
            items = [
                {"queue_id": r["queue_id"], "drama": dict(r)}
                for r in rows
                if r["share_url"]
            ]
            # drama dict 带 queue_id 键污染，重建干净结构
            for it in items:
                it["drama"] = {
                    k: it["drama"][k]
                    for k in it["drama"]
                    if k != "queue_id"
                }
        if not items:
            continue
        batch_id = None
        with _batch_guard:
            try:
                with batch_lock(timeout=5):
                    now = int(time.time())
                    with get_db() as conn:
                        cur = conn.execute(
                            "INSERT INTO batches (status, total, started_at) VALUES ('running', ?, ?)",
                            (len(items), now),
                        )
                        batch_id = cur.lastrowid
                        for it in items:
                            conn.execute(
                                "UPDATE queue SET status='running', batch_id=? WHERE id=?",
                                (batch_id, it["queue_id"]),
                            )
                    global _current_batch_id
                    _current_batch_id = batch_id
                    try:
                        run_batch(batch_id, items)
                    finally:
                        _current_batch_id = None
            except Exception as e:
                log.exception("批次执行异常: %s", e)
                # 兜底：不让批次/队列卡在 running，标失败供 UI 重试
                if batch_id:
                    try:
                        with get_db() as conn:
                            conn.execute(
                                "UPDATE batches SET status='failed', finished_at=strftime('%s','now') WHERE id=? AND status='running'",
                                (batch_id,),
                            )
                            conn.execute(
                                "UPDATE queue SET status='failed', error=?, finished_at=strftime('%s','now') WHERE batch_id=? AND status='running'",
                                (str(e), batch_id),
                            )
                    except Exception:
                        log.exception("标记批次失败时又出错")


def start_worker():
    t = threading.Thread(target=worker_loop, name="duanju-worker", daemon=True)
    t.start()
    return t
