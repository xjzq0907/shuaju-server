import csv
import json
import logging
import os
import time

from . import config
from .db import get_db
from .util import expected_episodes, folder_stats

log = logging.getLogger("sync")


def import_csv():
    """导入 all-cleaned.csv 全量索引（按 share_url upsert）。返回导入行数。"""
    if not os.path.exists(config.CSV_PATH):
        log.warning("CSV 不存在: %s", config.CSV_PATH)
        return 0
    now = int(time.time())
    with get_db() as conn:
        bl_urls = {
            r["share_url"]
            for r in conn.execute("SELECT share_url FROM blacklist WHERE share_url IS NOT NULL")
        }
    rows = []
    with open(config.CSV_PATH, encoding="utf-8-sig") as f:
        for name, url, date in csv.reader(f):
            if name == "短剧名称" or not url.startswith("http"):
                continue
            if url.strip() in bl_urls:
                continue
            rows.append(
                (name.strip(), url.strip(), expected_episodes(name), date.strip(), now, now)
            )
    with get_db() as conn:
        conn.executemany(
            """
            INSERT INTO dramas (title, share_url, episodes_expected, updated_date, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(share_url) DO UPDATE SET
              title=excluded.title,
              episodes_expected=excluded.episodes_expected,
              updated_date=excluded.updated_date,
              updated_at=excluded.updated_at
            """,
            rows,
        )
    log.info("CSV 导入 %d 条", len(rows))
    return len(rows)


def mirror_state():
    """把 import_state.json 的转存结果镜像进 dramas.drive_state。返回更新数。"""
    if not os.path.exists(config.STATE_PATH):
        return 0
    state = json.loads(open(config.STATE_PATH, encoding="utf-8").read())
    updates = []
    for url, info in state.items():
        result = info.get("result", "")
        if result in ("saved", "up_to_date"):
            drive = "saved"
        elif result in ("dead", "banned"):
            drive = "dead"
        else:
            continue
        updates.append((drive, url.rstrip("/")))
    with get_db() as conn:
        conn.executemany(
            "UPDATE dramas SET drive_state=?, updated_at=strftime('%s','now') WHERE rtrim(share_url,'/')=?",
            updates,
        )
    log.info("state 镜像 %d 条", len(updates))
    return len(updates)


def scan_local():
    """扫描本地短剧库目录，以磁盘为准更新集数/大小/下载状态。返回扫描剧数。"""
    root = config.LIB_ROOT
    if not os.path.isdir(root):
        log.warning("本地库目录不存在: %s", root)
        return 0
    now = int(time.time())
    seen_titles = set()
    count = 0
    with get_db() as conn:
        bl_titles = {r["title"] for r in conn.execute("SELECT title FROM blacklist")}
        for entry in sorted(os.scandir(root), key=lambda e: e.name):
            if not entry.is_dir():
                continue
            title = entry.name
            seen_titles.add(title)
            eps, size_mb = folder_stats(entry.path)
            if eps == 0:
                continue
            # 匹配任意同名行（优先 CSV 关联行）。原条件带 share_url IS NOT NULL 会
            # 匹配不到本函数自己插入的行（share_url 为 NULL），导致每次扫描都重复 INSERT
            row = conn.execute(
                "SELECT id FROM dramas WHERE title=? ORDER BY (share_url IS NULL), id LIMIT 1",
                (title,),
            ).fetchone()
            # 拉黑只拦"库里已无同名行"的复活；重复链接被拉黑后留下的同名在库行照常更新
            if row is None and title in bl_titles:
                continue
            count += 1
            if row:
                conn.execute(
                    """UPDATE dramas SET local_dir=?, episodes_local=?, size_mb=?,
                       download_state='done', trim_checked=0, updated_at=? WHERE id=?""",
                    (entry.path, eps, size_mb, now, row["id"]),
                )
            else:
                conn.execute(
                    """INSERT INTO dramas
                       (title, local_dir, episodes_local, size_mb, download_state, created_at, updated_at)
                       VALUES (?, ?, ?, ?, 'done', ?, ?)""",
                    (title, entry.path, eps, size_mb, now, now),
                )
        # 本地目录已消失的剧，重置下载状态
        stale = conn.execute(
            "SELECT id, local_dir FROM dramas WHERE download_state='done' AND local_dir IS NOT NULL"
        ).fetchall()
        for r in stale:
            if not os.path.isdir(r["local_dir"]):
                conn.execute(
                    "UPDATE dramas SET download_state='none', episodes_local=0, local_dir=NULL, updated_at=? WHERE id=?",
                    (now, r["id"]),
                )
    log.info("本地扫描 %d 部", count)
    return count


def scan_one(drama_id: int) -> dict:
    """重扫单部剧的本地文件夹：以磁盘为准刷新集数/大小；文件夹消失则清空本地信息。"""
    now = int(time.time())
    with get_db() as conn:
        r = conn.execute("SELECT * FROM dramas WHERE id=?", (drama_id,)).fetchone()
        if not r:
            return {"ok": False, "reason": "not_found"}
        folder = r["local_dir"] if (r["local_dir"] and os.path.isdir(r["local_dir"])) else os.path.join(config.LIB_ROOT, r["title"])
        if not os.path.isdir(folder):
            conn.execute(
                "UPDATE dramas SET download_state='none', episodes_local=0, local_dir=NULL, updated_at=? WHERE id=?",
                (now, drama_id),
            )
            return {"ok": True, "episodes": 0, "folder_missing": True}
        eps, size_mb = folder_stats(folder)
        conn.execute(
            """UPDATE dramas SET local_dir=?, episodes_local=?, size_mb=?,
               download_state=?, trim_checked=0, updated_at=? WHERE id=?""",
            (folder, eps, size_mb, "done" if eps else "none", now, drama_id),
        )
        return {"ok": True, "episodes": eps, "size_mb": size_mb}


def full_sync():
    import_csv()
    mirror_state()
    scan_local()
