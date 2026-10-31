"""相邻集重叠自动检测：低分辨率帧指纹比对。

原理：片源切集不干净时，第 N+1 集开头的 L 秒内容与第 N 集结尾完全相同。
用 ffmpeg 把「N+1 集开头 20s」和「N 集结尾 25s」降采样成 16x16 灰度帧序列
（2fps，每帧 256 字节），逐帧找最佳匹配：若 x 时刻的头部帧与 t 时刻的尾部帧
一致，则重叠 L ≈ durN - t + x；多帧结果取中位数，要求匹配帧数足够且离散度小。

全剧逐边界检测取中位数 → skip_head = skip_tail = L（0~30s，无重叠为 0）。
耗时约每边界 1~3 秒（低分辨率解码），由后台线程在扫描后异步跑。
"""
import logging
import statistics
import subprocess

from . import config
from .db import get_db
from .util import episode_map

log = logging.getLogger("trim")

FRAME = 16 * 16          # 16x16 灰度
FPS = 2
HEAD_SEC = 20            # 取 N+1 集开头这么多秒
TAIL_SEC = 25            # 取 N 集结尾这么多秒
MAX_SKIP = 30            # 重叠上限（与 PATCH clamp 一致）
MATCH_MAE = 14           # 单帧平均绝对误差阈值（0~255），低于视为同一帧
MIN_MATCH_FRAMES = 6     # 至少这么多帧 confident 匹配才认定有重叠
MAX_STDEV = 1.5          # 各帧推出的 L 值标准差上限（秒），要求一致


def _frames(path: str, head: bool) -> tuple[list[float], list[bytes]]:
    """返回 (时间戳秒列表, 帧列表)。head=True 取开头 HEAD_SEC，否则结尾 TAIL_SEC。"""
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error"]
    if not head:
        cmd += ["-sseof", f"-{TAIL_SEC}"]
    cmd += [
        "-i", path,
        "-t", str(HEAD_SEC if head else TAIL_SEC),
        "-vf", f"fps={FPS},scale=16:16,format=gray",
        "-f", "rawvideo", "-",
    ]
    r = subprocess.run(cmd, capture_output=True, timeout=60)
    data = r.stdout
    n = len(data) // FRAME
    start = 0.0 if head else None
    if not head:
        # 尾窗口起点：总时长 - TAIL_SEC（ffprobe 取整秒即可，误差被中位数吸收）
        try:
            p = subprocess.run(
                ["ffprobe", "-v", "error", "-show_entries", "format=duration",
                 "-of", "csv=p=0", path],
                capture_output=True, timeout=10,
            )
            dur = float(p.stdout.decode().strip())
        except Exception:  # noqa: BLE001
            dur = 0.0
        start = max(0.0, dur - TAIL_SEC)
    ts = [start + (i + 0.5) / FPS for i in range(n)]
    frames = [data[i * FRAME:(i + 1) * FRAME] for i in range(n)]
    return ts, frames


def _mae(a: bytes, b: bytes) -> float:
    return sum(abs(x - y) for x, y in zip(a, b)) / FRAME


def overlap_seconds(path_prev: str, path_next: str, dur_prev: float) -> float | None:
    """检测相邻两集的重叠秒数；无重叠或置信不足返回 None。"""
    ts_n, fr_n = _frames(path_prev, head=False)   # 上一集结尾
    ts_x, fr_x = _frames(path_next, head=True)    # 下一集开头
    if not ts_n or not ts_x:
        return None
    cands = []
    for j, fx in enumerate(fr_x):
        best, best_mae = None, 999.0
        for k, fn in enumerate(fr_n):
            m = _mae(fx, fn)
            if m < best_mae:
                best, best_mae = k, m
        if best is None or best_mae > MATCH_MAE:
            continue
        # 内容等式：next 的 x 时刻 == prev 的 (dur_prev - L + x) 时刻 → L = dur_prev - t + x
        L = dur_prev - ts_n[best] + ts_x[j]
        if 1.0 <= L <= MAX_SKIP:
            cands.append(L)
    if len(cands) < MIN_MATCH_FRAMES:
        return None
    med = statistics.median(cands)
    if len(cands) >= 4 and statistics.pstdev(cands) > MAX_STDEV:
        return None
    # 中位数附近（±2s）的候选才算同一重叠，过滤掉零星巧合
    tight = [c for c in cands if abs(c - med) <= 2.0]
    if len(tight) < MIN_MATCH_FRAMES:
        return None
    return round(statistics.median(tight))


def _probe_duration(path: str) -> float:
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", path],
            capture_output=True, timeout=10,
        )
        return float(r.stdout.decode().strip())
    except Exception:  # noqa: BLE001
        return 0.0


def detect_drama(drama_id: int) -> dict:
    """分析一部剧的全部相邻边界，写库（skip_head=skip_tail=中位重叠，trim_checked=1）。"""
    with get_db() as conn:
        r = conn.execute("SELECT * FROM dramas WHERE id=?", (drama_id,)).fetchone()
        if not r or not r["local_dir"]:
            return {"ok": False, "reason": "not_found"}
        eps = episode_map(r["local_dir"])
        nums = sorted(eps)
        if len(nums) < 2:
            conn.execute("UPDATE dramas SET trim_checked=1 WHERE id=?", (drama_id,))
            return {"ok": True, "skip_head": 0, "skip_tail": 0, "boundaries": 0}
        vals = []
        import os
        for a, b in zip(nums, nums[1:]):
            pa = os.path.join(r["local_dir"], eps[a])
            pb = os.path.join(r["local_dir"], eps[b])
            dur = _probe_duration(pa)
            if dur <= 0:
                continue
            try:
                L = overlap_seconds(pa, pb, dur)
            except subprocess.TimeoutExpired:
                log.warning("trim 超时 %s ep%s->%s", r["title"], a, b)
                continue
            if L:
                vals.append(L)
        skip = round(statistics.median(vals)) if vals else 0
        skip = max(0, min(MAX_SKIP, skip))
        conn.execute(
            "UPDATE dramas SET skip_head=?, skip_tail=?, trim_checked=1, updated_at=strftime('%s','now') WHERE id=?",
            (skip, skip, drama_id),
        )
    log.info("trim 检测 %s：%d/%d 边界有重叠 → %d 秒", r["title"], len(vals), len(nums) - 1, skip)
    return {"ok": True, "skip_head": skip, "skip_tail": skip, "boundaries": len(vals), "total": len(nums) - 1}


def trim_worker():
    """后台线程：循环挑一部未分析的已下载剧（≥2集）做检测。空闲时休眠。"""
    import time
    while True:
        try:
            with get_db() as conn:
                r = conn.execute(
                    "SELECT id FROM dramas WHERE download_state='done' AND local_dir IS NOT NULL"
                    " AND episodes_local >= 2 AND trim_checked = 0"
                    " ORDER BY episodes_local ASC LIMIT 1"  # 短剧优先，快速见效
                ).fetchone()
            if r:
                detect_drama(r["id"])
                time.sleep(2)  # 批量分析时留点喘息
                continue
        except Exception:  # noqa: BLE001
            log.exception("trim worker 异常")
        time.sleep(60)
