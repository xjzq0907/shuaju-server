import logging
import os
import random
import re
import secrets
import shutil
import subprocess
import threading
import time

from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config, pipeline, settings_store, sync, transcode, trim, util
from .clients import Aria2Client
from .db import get_db, init_db

logging.basicConfig(level=logging.INFO, format="[%(asctime)s][%(levelname)s] %(message)s")
log = logging.getLogger("main")

app = FastAPI(title="duanju-manager")

STATIC_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static")


# ---------- 访问令牌 ----------

@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    """AUTH_TOKEN 非空时保护 /api/*（含视频流与封面）；静态壳与 /healthz 不拦。

    浏览器 <img>/<video> 无法带自定义头，故同时接受 ?token= 查询参数。
    """
    token = config.AUTH_TOKEN
    if token and request.url.path.startswith("/api/"):
        supplied = request.headers.get("x-auth-token") or request.query_params.get("token") or ""
        if not secrets.compare_digest(supplied, token):
            return JSONResponse({"detail": "未授权：缺少或错误的访问令牌"}, status_code=401)
    return await call_next(request)


# ---------- 启动 ----------

@app.on_event("startup")
def startup():
    init_db()
    settings_store.load_into_config()  # DB 运行配置覆盖 env 默认（须在 full_sync 之前）

    def boot():
        try:
            sync.full_sync()
        except Exception:
            log.exception("启动同步失败")
        pipeline.start_worker()
        # 扫描后异步分析相邻集重叠（自动裁边），常驻线程循环消化 trim_checked=0 的剧
        threading.Thread(target=trim.trim_worker, name="trim", daemon=True).start()

    threading.Thread(target=boot, name="boot", daemon=True).start()


# ---------- 剧库 ----------

def drama_to_dict(r):
    d = dict(r)
    d["has_cover"] = bool(r["local_dir"]) and util.cover_file(r["local_dir"]) is not None
    # 本地扫描入库的剧 episodes_expected 为空，用实际下载集数兜底（否则前端全显示 0）
    if not d.get("episodes_expected"):
        d["episodes_expected"] = d.get("episodes_local") or 0
    return d


@app.get("/api/stats")
def stats():
    with get_db() as c:
        q = lambda sql, *a: c.execute(sql, a).fetchone()[0]
        data = {
            "total": q("SELECT COUNT(*) FROM dramas"),
            "downloaded": q("SELECT COUNT(*) FROM dramas WHERE download_state='done'"),
            "queued": q("SELECT COUNT(*) FROM queue WHERE status IN ('pending','running')"),
            "dead": q("SELECT COUNT(*) FROM dramas WHERE drive_state='dead'"),
            "size_mb": q("SELECT COALESCE(SUM(size_mb),0) FROM dramas WHERE download_state='done'"),
        }
    try:
        st = os.statvfs(config.LIB_ROOT)
        data["disk_free_gb"] = round(st.f_bavail * st.f_frsize / 2**30, 1)
        data["disk_total_gb"] = round(st.f_blocks * st.f_frsize / 2**30, 1)
    except OSError:
        data["disk_free_gb"] = None
        data["disk_total_gb"] = None
    return data


@app.get("/api/dramas")
def list_dramas(
    q: str = "",
    state: str = "done",
    sort: str = "updated",
    page: int = 1,
    page_size: int = Query(24, le=100),
    watch_state: str = "",
    favorite: bool = False,
):
    where, args = [], []
    if q:
        where.append("title LIKE ?")
        args.append(f"%{q}%")
    if watch_state:
        if watch_state not in ("unwatched", "watching", "watched"):
            raise HTTPException(400, "watch_state must be unwatched/watching/watched")
        where.append("watch_state=?")
        args.append(watch_state)
    if favorite:
        where.append("favorite=1")
    state_sql = {
        "done": "download_state='done'",
        "queued": "download_state IN ('queued','downloading')",
        "not_downloaded": "download_state IN ('none','failed') AND share_url IS NOT NULL",
        "dead": "drive_state='dead'",
        "all": "1=1",
    }.get(state)
    if state_sql:
        where.append(state_sql)
    order = {
        "updated": "updated_date DESC, id DESC",
        "size": "size_mb DESC",
        "title": "title",
        "episodes": "episodes_expected DESC",
    }.get(sort, "updated_date DESC")
    sql = f"SELECT * FROM dramas WHERE {' AND '.join(where) or '1=1'} ORDER BY {order} LIMIT ? OFFSET ?"
    args += [page_size, (page - 1) * page_size]
    with get_db() as c:
        rows = c.execute(sql, args).fetchall()
        total = c.execute(
            f"SELECT COUNT(*) FROM dramas WHERE {' AND '.join(where) or '1=1'}", args[:-2]
        ).fetchone()[0]
    return {"total": total, "page": page, "items": [drama_to_dict(r) for r in rows]}


def _feed_key(title: str) -> str:
    """发现流去重键：去括号注释、前导序号、标点空白；保留季/部（S1/S2 是不同剧）。"""
    t = re.sub(r"[（(][^）)]*[）)]", "", title or "")
    t = re.sub(r"^\d{1,4}(?:\(\d+\))?[.、\-]\s*", "", t)
    return re.sub(r"[\s：:，,、！!。.·＆&]", "", t)


@app.get("/api/dramas/random")
def random_dramas(
    n: int = Query(5, le=20),
    exclude: str = "",
    seed: int | None = None,
    offset: int = Query(0, ge=0),
):
    """发现流随机剧：seed+offset 确定性洗牌分页 + 未看加权 + 归一化剧名去重。

    - 不带 seed：自生成种子，exclude 生效（旧客户端兼容，只保留最近 300 个防 URL 膨胀）
    - 带 seed：同 seed 同序列，按 offset 翻页；响应带 pool/offset/exhausted，
      exhausted=true 表示本轮洗牌刷完（客户端换新种子重开一轮即可无缝循环）
    - 加权：未看剧权重 1.0、已看 0.35（Efraimidis-Spirakis 序，同 seed 完全确定）
    """
    with get_db() as c:
        rows = c.execute(
            "SELECT * FROM dramas WHERE download_state='done' AND local_dir IS NOT NULL"
            " AND episodes_local > 0 ORDER BY id"
        ).fetchall()
    # 同剧变体只留一部（优先未看的代表；服务端去重后客户端无需跨批过滤）
    groups: dict = {}
    for r in rows:
        k = _feed_key(r["title"])
        g = groups.get(k)
        if g is None or (g["watch_state"] != "unwatched" and r["watch_state"] == "unwatched"):
            groups[k] = r
    pool = list(groups.values())
    if seed is None:
        ids = [int(x) for x in exclude.split(",") if x.strip().isdigit()]
        if len(ids) > 300:
            ids = ids[-300:]
        if ids:
            banned = set(ids)
            pool = [r for r in pool if r["id"] not in banned]
        seed = random.randrange(1 << 31)
    rng = random.Random(seed)
    scored = []
    for r in pool:
        w = 1.0 if r["watch_state"] == "unwatched" else 0.35
        scored.append((rng.random() ** (1.0 / w), r))
    scored.sort(key=lambda x: x[0], reverse=True)
    ordered = [r for _, r in scored]
    items = ordered[offset : offset + n]
    end = offset + len(items)
    return {
        "items": [drama_to_dict(r) for r in items],
        "seed": seed,
        "offset": end,
        "pool": len(ordered),
        "exhausted": end >= len(ordered),
    }


@app.get("/api/dramas/{drama_id}")
def drama_detail(drama_id: int):
    with get_db() as c:
        r = c.execute("SELECT * FROM dramas WHERE id=?", (drama_id,)).fetchone()
    if not r:
        raise HTTPException(404)
    d = drama_to_dict(r)
    eps = util.episode_map(r["local_dir"]) if r["local_dir"] else {}
    expected = r["episodes_expected"] or (max(eps) if eps else 0)
    d["episodes_expected"] = expected
    d["episodes"] = [
        {
            "ep": n,
            "file": eps[n],
            "size_mb": round(
                os.path.getsize(os.path.join(r["local_dir"], eps[n])) / 1048576, 1
            ),
        }
        for n in sorted(eps)
    ]
    d["missing"] = [n for n in range(1, expected + 1) if n not in eps] if expected else []
    return d


_SEASON_PAT = re.compile(r"第[一二三四五六七八九十百千零\d]+[季部期]")


def _series_key(title: str) -> str:
    """剧名归一化成系列键：去集数括注、季数、前导序号，用于匹配同系列连季。"""
    t = re.sub(r"[（(][^）)]*集[^）)]*[）)]", "", title or "")
    t = _SEASON_PAT.sub("", t)
    t = re.sub(r"^\d{1,4}[.、\-]\s*", "", t)
    return re.sub(r"\s+", "", t).strip(" ：:")


@app.get("/api/dramas/{drama_id}/similar")
def similar_dramas(drama_id: int, limit: int = Query(10, le=30)):
    """相似/同系列剧集（按归一化剧名匹配），用于找连续的季。"""
    with get_db() as c:
        me = c.execute("SELECT * FROM dramas WHERE id=?", (drama_id,)).fetchone()
        if not me:
            raise HTTPException(404)
        key = _series_key(me["title"])
        # 系列键太短（<4字）匹配意义不大
        if len(key) < 4:
            return {"items": [], "base": me["title"]}
        rows = c.execute(
            "SELECT * FROM dramas WHERE download_state='done' AND local_dir IS NOT NULL"
        ).fetchall()
    items = []
    for r in rows:
        if r["id"] == drama_id:
            continue
        rk = _series_key(r["title"])
        # 同系列：归一化后互为前缀（容差到前6字，兼容"xxx"与"xxx那些事"等变体）
        n = min(len(key), len(rk), 6)
        if n >= 4 and (rk.startswith(key[:n]) or key.startswith(rk[:n])):
            items.append(drama_to_dict(r))
    items.sort(key=lambda x: x["title"])
    return {"items": items[:limit], "base": me["title"]}


class WatchPatch(BaseModel):
    watch_state: str | None = None
    last_episode: int | None = None
    favorite: bool | None = None
    skip_head: int | None = None  # 片头跳过秒数（0~30，现由服务端自动检测写入）
    skip_tail: int | None = None  # 片尾提前秒数（0~30）
    trim_enabled: bool | None = None  # 自动裁边开关（用户可关）


@app.patch("/api/dramas/{drama_id}")
def patch_drama(drama_id: int, body: WatchPatch):
    sets, args = [], []
    if body.watch_state in ("unwatched", "watching", "watched"):
        sets.append("watch_state=?")
        args.append(body.watch_state)
    if body.last_episode is not None:
        sets.append("last_episode=?")
        args.append(body.last_episode)
    if body.favorite is not None:
        sets.append("favorite=?")
        args.append(1 if body.favorite else 0)
    for k in ("skip_head", "skip_tail"):
        v = getattr(body, k)
        if v is not None:
            sets.append(f"{k}=?")
            args.append(max(0, min(30, int(v))))
    if body.trim_enabled is not None:
        sets.append("trim_enabled=?")
        args.append(1 if body.trim_enabled else 0)
    if sets:
        with get_db() as c:
            c.execute(f"UPDATE dramas SET {', '.join(sets)} WHERE id=?", args + [drama_id])
    return {"ok": True}


# ---------- 媒体流（手动 Range，兼容所有播放器） ----------

CHUNK = 64 * 1024


def stream_mp4(path: str, range_header: str | None):
    file_size = os.path.getsize(path)
    start, end = 0, file_size - 1
    status = 200
    if range_header:
        m = re.match(r"bytes=(\d*)-(\d*)", range_header)
        if m:
            if m.group(1):
                start = int(m.group(1))
                if m.group(2):
                    end = min(int(m.group(2)), file_size - 1)
            elif m.group(2):  # bytes=-N 后缀范围
                start = max(file_size - int(m.group(2)), 0)
            status = 206

    def iterfile():
        with open(path, "rb") as f:
            f.seek(start)
            left = end - start + 1
            while left > 0:
                data = f.read(min(CHUNK, left))
                if not data:
                    break
                left -= len(data)
                yield data

    headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(end - start + 1),
    }
    if status == 206:
        headers["Content-Range"] = f"bytes {start}-{end}/{file_size}"
    return StreamingResponse(iterfile(), status_code=status, media_type="video/mp4", headers=headers)


def _episode_path(drama: dict, ep: int) -> str:
    if not drama["local_dir"]:
        raise HTTPException(404, "未下载")
    eps = util.episode_map(drama["local_dir"])
    if ep not in eps:
        raise HTTPException(404, "集数不存在")
    return os.path.join(drama["local_dir"], eps[ep])


@app.get("/api/dramas/{drama_id}/episodes/{ep}")
def play_episode(drama_id: int, ep: int, request: Request, q: str = "", t: float = 0.0):
    """q 为空 = 原画直读文件（支持 Range）；q=720p/480p = ffmpeg 实时转码流（t 为起点秒数）。"""
    with get_db() as c:
        r = c.execute("SELECT * FROM dramas WHERE id=?", (drama_id,)).fetchone()
    if not r:
        raise HTTPException(404)
    src = _episode_path(dict(r), ep)
    height = transcode.QUALITIES.get(q)
    if height:
        return StreamingResponse(
            transcode.stream(src, height, max(0.0, t)),
            media_type="video/mp4",
            # 转码流不可拖动寻址（Seek 靠客户端换 t 重开流）
            headers={"Accept-Ranges": "none", "Cache-Control": "no-store"},
        )
    return stream_mp4(src, request.headers.get("range"))


_dur_cache: dict = {}


def _probe_duration(path: str) -> float:
    """原片时长（秒）。转码流的 mvhd 时长是 0，客户端进度条只能靠这个真值。"""
    d = _dur_cache.get(path)
    if d:
        return d
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
            capture_output=True, timeout=10,
        )
        d = float(r.stdout.decode().strip())
    except Exception:  # noqa: BLE001
        d = 0.0
    _dur_cache[path] = d
    return d


@app.get("/api/dramas/{drama_id}/episodes/{ep}/meta")
def episode_meta(drama_id: int, ep: int):
    with get_db() as c:
        r = c.execute("SELECT * FROM dramas WHERE id=?", (drama_id,)).fetchone()
    if not r:
        raise HTTPException(404)
    path = _episode_path(dict(r), ep)
    return {"size_mb": round(os.path.getsize(path) / 1048576, 1), "duration": _probe_duration(path)}


@app.get("/api/dramas/{drama_id}/cover")
def drama_cover(drama_id: int):
    with get_db() as c:
        r = c.execute("SELECT local_dir FROM dramas WHERE id=?", (drama_id,)).fetchone()
    if not (r and r["local_dir"]):
        raise HTTPException(404)
    cover = util.cover_file(r["local_dir"])
    if not cover:
        raise HTTPException(404)
    ext = cover.rsplit(".", 1)[-1].lower()
    media = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp"}[ext]
    return FileResponse(os.path.join(r["local_dir"], cover), media_type=media)


@app.post("/api/dramas/{drama_id}/rescan")
def rescan_drama(drama_id: int):
    """单剧重扫：以本地文件夹为准刷新集数/大小；文件夹消失则清空本地信息。"""
    with get_db() as c:
        if not c.execute("SELECT id FROM dramas WHERE id=?", (drama_id,)).fetchone():
            raise HTTPException(404)
    return sync.scan_one(drama_id)


@app.post("/api/dramas/{drama_id}/trim/detect")
def trim_detect(drama_id: int):
    """立即重跑该剧相邻集重叠检测（后台异步分析通常自动完成，这里是手动触发）。"""
    with get_db() as c:
        if not c.execute("SELECT id FROM dramas WHERE id=?", (drama_id,)).fetchone():
            raise HTTPException(404)
    threading.Thread(target=trim.detect_drama, args=(drama_id,), daemon=True).start()
    return {"ok": True, "started": True}


@app.get("/api/trim/stats")
def trim_stats():
    """裁边分析进度（设置页面板用）。"""
    with get_db() as c:
        q = lambda sql: c.execute(sql).fetchone()[0]  # noqa: E731
        return {
            "total": q("SELECT COUNT(*) FROM dramas WHERE download_state='done' AND episodes_local >= 2"),
            "checked": q("SELECT COUNT(*) FROM dramas WHERE trim_checked=1"),
            "detected": q("SELECT COUNT(*) FROM dramas WHERE trim_checked=1 AND skip_head > 0"),
            "disabled": q("SELECT COUNT(*) FROM dramas WHERE trim_checked=1 AND trim_enabled=0"),
        }


@app.post("/api/trim/reset")
def trim_reset():
    """清空全部分析结果，让后台线程全库重跑（算法升级后重测用）。"""
    with get_db() as c:
        n = c.execute("UPDATE dramas SET trim_checked=0 WHERE trim_checked=1").rowcount
    log.info("trim 全部重置：%d 部待重新分析", n)
    return {"reset": n}


@app.get("/api/qr.png")
def qr_png(data: str = Query(..., max_length=300), scale: int = Query(8, ge=2, le=16)):
    """二维码 PNG（纯标准库编码，从 qrcode 矩阵直接画点，无 SVG 缩放歧义）。"""
    import struct
    import zlib

    import qrcode

    qr = qrcode.QRCode(
        error_correction=qrcode.constants.ERROR_CORRECT_M, border=2
    )
    qr.add_data(data)
    qr.make(fit=True)
    matrix = qr.get_matrix()  # list[list[bool]]，含静区
    n = len(matrix)
    size = n * scale

    raw = bytearray()
    for row in matrix:
        line = bytearray()
        for v in row:
            line.extend((b"\x00\x00\x00" if v else b"\xff\xff\xff") * scale)
        for _ in range(scale):
            raw.append(0)
            raw.extend(line)

    def chunk(tag: bytes, d: bytes) -> bytes:
        c = struct.pack(">I", len(d)) + tag + d
        return c + struct.pack(">I", zlib.crc32(tag + d) & 0xFFFFFFFF)

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )
    return Response(content=png, media_type="image/png")


@app.get("/api/about")
def about():
    """版本与运行环境信息（设置页展示；不含任何敏感值）。"""
    return {
        "name": "shuaju-server",
        "version": os.environ.get("GIT_REV", "unknown"),
        "auth_enabled": bool(config.AUTH_TOKEN),
        "csv_ready": os.path.exists(config.CSV_PATH),
        "lib_exists": os.path.isdir(config.LIB_ROOT),
        # 部署级路径（容器挂载决定，页面不可改，仅展示）
        "quark_links_dir": config.QUARK_LINKS_DIR,
        "data_dir": config.DATA_DIR,
        "quark_cfg": config.QUARK_CFG,
    }


class SettingsBody(BaseModel):
    LIB_ROOT: str | None = None
    ARIA2_RPC: str | None = None
    ARIA2_LIB_PATH: str | None = None
    QUARK_AUTOSAVE_URL: str | None = None
    SAVE_ROOT: str | None = None
    BATCH_SIZE: int | None = None


@app.get("/api/settings")
def get_settings():
    """当前生效的运行配置（数据库值优先于环境变量默认）。"""
    return settings_store.get_settings()


@app.put("/api/settings")
def put_settings(body: SettingsBody):
    """保存运行配置：部分更新、立即生效、持久化到 settings 表。"""
    try:
        return settings_store.save_settings(body.dict(exclude_none=True))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.delete("/api/settings")
def reset_settings():
    """清空页面配置，恢复环境变量默认值。"""
    settings_store.clear_settings()
    return settings_store.get_settings()


# ---------- 全库索引 ----------

@app.get("/api/index/search")
def index_search(q: str = "", page: int = 1, page_size: int = Query(20, le=100)):
    if not q.strip():
        return {"total": 0, "page": page, "items": []}
    with get_db() as c:
        rows = c.execute(
            """SELECT id, title, share_url, episodes_expected, updated_date,
                      drive_state, download_state
               FROM dramas WHERE share_url IS NOT NULL AND title LIKE ?
               ORDER BY updated_date DESC LIMIT ? OFFSET ?""",
            (f"%{q}%", page_size, (page - 1) * page_size),
        ).fetchall()
        total = c.execute(
            "SELECT COUNT(*) FROM dramas WHERE share_url IS NOT NULL AND title LIKE ?",
            (f"%{q}%",),
        ).fetchone()[0]
    return {"total": total, "page": page, "items": [dict(r) for r in rows]}


# ---------- 队列 / 批次 ----------

class QueueAdd(BaseModel):
    dramas: list[int]
    force: bool = False  # 允许对 dead 的剧强制重试


@app.post("/api/queue")
def queue_add(body: QueueAdd):
    now = int(time.time())
    added = 0
    with get_db() as c:
        for did in body.dramas:
            d = c.execute("SELECT id, share_url, drive_state FROM dramas WHERE id=?", (did,)).fetchone()
            if not (d and d["share_url"]):
                continue
            if d["drive_state"] == "dead" and not body.force:
                continue
            # 清掉已完结的旧记录（failed/dead/done），pending/running 保持唯一约束
            c.execute(
                "DELETE FROM queue WHERE drama_id=? AND status IN ('failed','dead','done')",
                (did,),
            )
            cur = c.execute(
                "INSERT OR IGNORE INTO queue (drama_id, created_at) VALUES (?, ?)", (did, now)
            )
            if cur.rowcount == 0:
                continue  # 已在队列中
            c.execute(
                "UPDATE dramas SET download_state='queued', updated_at=? WHERE id=? AND download_state!='done'",
                (now, did),
            )
            added += 1
    return {"added": added}


@app.get("/api/queue")
def queue_list():
    with get_db() as c:
        rows = c.execute(
            """SELECT q.*, d.title, d.episodes_expected, d.drive_state
               FROM queue q JOIN dramas d ON d.id=q.drama_id
               WHERE q.status IN ('pending','running')
               ORDER BY q.id"""
        ).fetchall()
    return {"items": [dict(r) for r in rows]}


@app.delete("/api/queue/{qid}")
def queue_delete(qid: int):
    with get_db() as c:
        r = c.execute("SELECT * FROM queue WHERE id=?", (qid,)).fetchone()
        if not r:
            raise HTTPException(404)
        if r["status"] == "running":
            raise HTTPException(400, "批次执行中，无法删除")
        c.execute("DELETE FROM queue WHERE id=?", (qid,))
        c.execute(
            "UPDATE dramas SET download_state='none', updated_at=strftime('%s','now') WHERE id=? AND download_state='queued'",
            (r["drama_id"],),
        )
    return {"ok": True}


# ---------- 黑名单（删除并拉黑） ----------

class BlacklistBody(BaseModel):
    delete_files: bool = True  # 同时删除本地文件


@app.post("/api/dramas/{drama_id}/blacklist")
def blacklist_drama(drama_id: int, body: BlacklistBody):
    with get_db() as c:
        d = c.execute("SELECT * FROM dramas WHERE id=?", (drama_id,)).fetchone()
        if not d:
            raise HTTPException(404)
        r = c.execute(
            "SELECT status FROM queue WHERE drama_id=?", (drama_id,)
        ).fetchone()
        if r and r["status"] == "running":
            raise HTTPException(400, "该剧正在批次执行中，稍后再试")
        now = int(time.time())
        c.execute(
            "INSERT OR IGNORE INTO blacklist (title, share_url, created_at) VALUES (?, ?, ?)",
            (d["title"], d["share_url"], now),
        )
        c.execute("DELETE FROM queue WHERE drama_id=?", (drama_id,))
        freed_mb = 0.0
        files_deleted = False
        if body.delete_files and d["local_dir"]:
            lib = os.path.realpath(config.LIB_ROOT)
            target = os.path.realpath(d["local_dir"])
            if target.startswith(lib + os.sep) and os.path.isdir(target):
                freed_mb = d["size_mb"] or 0.0
                shutil.rmtree(target)
                files_deleted = True
        c.execute("DELETE FROM dramas WHERE id=?", (drama_id,))
    return {"ok": True, "files_deleted": files_deleted, "freed_mb": round(freed_mb, 1)}


@app.get("/api/blacklist")
def blacklist_list(page: int = 1, page_size: int = Query(50, le=200)):
    with get_db() as c:
        rows = c.execute(
            "SELECT * FROM blacklist ORDER BY id DESC LIMIT ? OFFSET ?",
            (page_size, (page - 1) * page_size),
        ).fetchall()
        total = c.execute("SELECT COUNT(*) FROM blacklist").fetchone()[0]
    return {"total": total, "items": [dict(r) for r in rows]}


@app.delete("/api/blacklist/{bid}")
def blacklist_remove(bid: int):
    """恢复：仅移出黑名单，剧目在下次同步时回到索引（文件不会恢复）。"""
    with get_db() as c:
        r = c.execute("SELECT id FROM blacklist WHERE id=?", (bid,)).fetchone()
        if not r:
            raise HTTPException(404)
        c.execute("DELETE FROM blacklist WHERE id=?", (bid,))
    return {"ok": True}


@app.get("/api/pipeline")
def pipeline_status():
    stat = None
    try:
        stat = Aria2Client().stat()
    except Exception:
        pass
    with get_db() as c:
        batch = None
        r = c.execute("SELECT * FROM batches WHERE status='running' ORDER BY id DESC LIMIT 1").fetchone()
        if r:
            batch = dict(r)
            batch["log_lines"] = (r["log"] or "").splitlines()[-15:]
    return {
        "running": batch is not None,
        "paused": pipeline._paused.is_set(),
        "aria2": stat,
        "batch": batch,
    }


class PauseBody(BaseModel):
    paused: bool


@app.post("/api/pipeline/pause")
def pipeline_pause(body: PauseBody):
    if body.paused:
        pipeline._paused.set()
    else:
        pipeline._paused.clear()
    return {"paused": body.paused}


@app.get("/api/batches")
def batches(page: int = 1, page_size: int = Query(20, le=100)):
    with get_db() as c:
        rows = c.execute(
            "SELECT * FROM batches ORDER BY id DESC LIMIT ? OFFSET ?",
            (page_size, (page - 1) * page_size),
        ).fetchall()
        total = c.execute("SELECT COUNT(*) FROM batches").fetchone()[0]
    items = []
    for r in rows:
        d = dict(r)
        d.pop("log", None)
        items.append(d)
    return {"total": total, "items": items}


@app.get("/api/batches/{bid}")
def batch_detail(bid: int):
    with get_db() as c:
        r = c.execute("SELECT * FROM batches WHERE id=?", (bid,)).fetchone()
    if not r:
        raise HTTPException(404)
    d = dict(r)
    d["log_lines"] = (d.pop("log") or "").splitlines()
    return d


# ---------- 同步 ----------

class SyncBody(BaseModel):
    scope: str = "all"


@app.post("/api/sync")
def do_sync(body: SyncBody):
    result = {}
    if body.scope in ("all", "csv"):
        result["csv"] = sync.import_csv()
    if body.scope in ("all", "state"):
        result["state"] = sync.mirror_state()
    if body.scope in ("all", "local"):
        result["local"] = sync.scan_local()
    return result


# ---------- 页面 ----------

@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.get("/w")
def watch_page():
    """移动端短剧播放页（PWA 入口）。"""
    return FileResponse(os.path.join(STATIC_DIR, "watch.html"))


@app.get("/manifest.json")
def pwa_manifest():
    return FileResponse(
        os.path.join(STATIC_DIR, "manifest.json"), media_type="application/manifest+json"
    )


@app.get("/sw.js")
def service_worker():
    return FileResponse(
        os.path.join(STATIC_DIR, "sw.js"),
        media_type="text/javascript",
        headers={"Service-Worker-Allowed": "/", "Cache-Control": "no-cache"},
    )


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
