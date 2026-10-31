"""相邻集重叠自动检测（快速版：音频包络对齐 + 边界抽样，目标每部剧 ≤5 秒）。

原理：片源切集不干净时，第 N+1 集开头的 L 秒与第 N 集结尾内容相同（音频同样重复）。
把两段窗口解码成 1kHz 单声道 PCM，按 50ms 帧计算 RMS 包络并按各自峰值归一化，
然后做包络对齐搜索：把「N+1 集开头包络」滑动对齐到「N 集结尾包络」的每个位置，
平均绝对差最小且峰值尖锐（明显优于次优）的位置即重叠对齐点，L = durN - 对齐点。

为什么用包络而非波形：粗暴切分的片源音频帧往往错位几毫秒，波形比对全废；
RMS 包络对毫秒级错位免疫，且归一化后大小声可比。静音段包络平坦 → 对齐曲线
无尖峰，被"峰值尖锐度"检验拒绝，不会误报。

每部剧只抽样 5 个边界（首/四分之一/中/四分之三/尾）取中位数：重叠是片源级
一致的，抽样足以定值，混合结果偏保守（宁可少裁不误裁）。
"""
import array
import logging
import os
import statistics
import subprocess

from .db import get_db
from .util import episode_map

log = logging.getLogger("trim")

AR = 1000              # 采样率 1kHz
ENV_FRAME_MS = 50      # 包络帧长
HEAD_SEC = 20          # 取 N+1 集开头这么多秒
TAIL_SEC = 25          # 取 N 集结尾这么多秒
MAX_SKIP = 30          # 重叠上限
BEST_MAE = 0.10        # 最佳对齐点的平均绝对差上限（归一化包络 0~1）
PEAK_GAP = 0.015       # 最佳与次佳的差距下限（尖峰检验，静音/相似段平坦曲线会被拒）
VALLEY_W = 0.8         # 谷底宽度上限（秒）：真对齐谷窄，静音长平台宽 → 拒绝
MAX_STDEV = 1.2        # 多个可信对齐点推出的 L 值标准差上限（秒）
SAMPLE_BOUNDARIES = 3  # 每部剧抽样检测的边界数（首/中/尾；大码率文件解码是 I/O 瓶颈）


def _envelope(path: str, start: float, dur: float) -> tuple[float, list[float]]:
    """解码 [start, start+dur] 的 1kHz 包络。返回 (起始时间戳, 归一化RMS列表/50ms)。"""
    step = ENV_FRAME_MS / 1000
    n_pts = int(dur / step)
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-ss", f"{max(0.0, start):.2f}", "-t", f"{dur:.2f}", "-noaccurate_seek",
        "-i", path,
        "-vn", "-ac", "1", "-ar", str(AR), "-f", "s16le", "-",
    ]
    r = subprocess.run(cmd, capture_output=True, timeout=30)
    data = r.stdout
    n_samp = len(data) // 2
    samples = array.array("h", data[: n_samp * 2])
    per = AR * ENV_FRAME_MS // 1000
    env = []
    for i in range(min(n_pts, n_samp // per)):
        seg = samples[i * per:(i + 1) * per]
        env.append((sum(x * x for x in seg) / per) ** 0.5)
    peak = max(env) if env else 0.0
    if peak > 0:
        env = [e / peak for e in env]
    return max(0.0, start), env


def overlap_seconds(path_prev: str, path_next: str, dur_prev: float) -> float | None:
    """检测相邻两集的重叠秒数；无重叠或置信不足返回 None。"""
    step = ENV_FRAME_MS / 1000
    _, tail = _envelope(path_prev, max(0.0, dur_prev - TAIL_SEC), TAIL_SEC)
    tail_t0 = max(0.0, dur_prev - TAIL_SEC)
    _, head = _envelope(path_next, 0.0, HEAD_SEC)
    if len(tail) < int(1.5 / step) or len(head) < int(1.5 / step):
        return None
    # 滑动对齐：head[0] 对到 tail 的第 i 帧 → L = dur_prev - 对齐时刻
    best_i, best_mae, second_mae = -1, 9e9, 9e9
    maes: list[float] = []
    for i in range(len(tail) - int(1.0 / step)):
        olap = min(len(head), len(tail) - i)
        mae = sum(abs(head[j] - tail[i + j]) for j in range(olap)) / olap
        maes.append(mae)
        if mae < best_mae:
            second_mae = best_mae
            best_mae, best_i = mae, i
        elif mae < second_mae:
            second_mae = mae
    if best_i < 0 or best_mae > BEST_MAE or (second_mae - best_mae) < PEAK_GAP:
        return None  # 无重叠 / 静音或相似段平坦无尖峰
    # 谷宽检验：真对齐谷底窄（内容快速变化），静音/相似段平台宽 → 拒绝
    floor = best_mae + 0.02
    lo = best_i
    while lo > 0 and maes[lo - 1] <= floor:
        lo -= 1
    hi = best_i
    while hi < len(maes) - 1 and maes[hi + 1] <= floor:
        hi += 1
    if (hi - lo) * step > VALLEY_W:
        return None
    # 抛物线插值精化谷底（对齐 plateau 内 50ms 格点精度不够，插值到亚帧）
    align_t = tail_t0 + best_i * step
    if 0 < best_i < len(maes) - 1:
        m0, m1, m2 = maes[best_i - 1], maes[best_i], maes[best_i + 1]
        denom = m0 - 2 * m1 + m2
        if abs(denom) > 1e-9:
            delta = max(-1.0, min(1.0, 0.5 * (m0 - m2) / denom))
            align_t = tail_t0 + (best_i + delta) * step
    L = dur_prev - align_t
    if not (1.0 <= L <= MAX_SKIP):
        return None
    return round(L * 2) / 2  # 0.5s 粒度


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


def _sample_pairs(nums: list[int]) -> list[tuple[int, int]]:
    """抽样边界：首/四分之一/中/四分之三/尾，去重。"""
    n = len(nums) - 1
    if n <= SAMPLE_BOUNDARIES:
        idxs = list(range(n))
    else:
        step = n / (SAMPLE_BOUNDARIES - 1)
        idxs = sorted({min(n - 1, round(i * step)) for i in range(SAMPLE_BOUNDARIES)})
    return [(nums[i], nums[i + 1]) for i in idxs]


def detect_drama(drama_id: int) -> dict:
    """抽样分析一部剧的相邻边界，写库（skip_head=skip_tail=检出重叠，trim_checked=1）。"""
    with get_db() as conn:
        r = conn.execute("SELECT * FROM dramas WHERE id=?", (drama_id,)).fetchone()
        if not r or not r["local_dir"]:
            return {"ok": False, "reason": "not_found"}
        title = r["title"]
        eps = episode_map(r["local_dir"])
        nums = sorted(eps)
        if len(nums) < 2:
            conn.execute("UPDATE dramas SET trim_checked=1 WHERE id=?", (drama_id,))
            return {"ok": True, "skip_head": 0, "skip_tail": 0, "boundaries": 0}
        pairs = _sample_pairs(nums)
        vals = []
        for a, b in pairs:
            pa = os.path.join(r["local_dir"], eps[a])
            pb = os.path.join(r["local_dir"], eps[b])
            try:
                L = overlap_seconds(pa, pb, _probe_duration(pa))
            except subprocess.TimeoutExpired:
                log.warning("trim 超时 %s ep%s->%s", title, a, b)
                continue
            if L:
                vals.append(L)
        skip = round(statistics.median(vals)) if vals else 0
        skip = max(0, min(MAX_SKIP, skip))
        conn.execute(
            "UPDATE dramas SET skip_head=?, skip_tail=?, trim_checked=1, updated_at=strftime('%s','now') WHERE id=?",
            (skip, skip, drama_id),
        )
    log.info("trim 检测 %s：%d/%d 抽样边界有重叠 → %d 秒", title, len(vals), len(pairs), skip)
    return {"ok": True, "skip_head": skip, "skip_tail": skip, "boundaries": len(vals), "total": len(pairs)}


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
                time.sleep(1)
                continue
        except Exception:  # noqa: BLE001
            log.exception("trim worker 异常")
        time.sleep(60)
