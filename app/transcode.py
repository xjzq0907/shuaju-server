"""实时转码：客户端选了清晰度才转，ffmpeg 管道直出分片 MP4，不落盘、不预转。

时间戳说明（实测结论）：ffmpeg 的 mp4 muxer 一律把流起点重排到 0，
所以 t 参数表示"从内容第 t 秒开始转"，播放器看到的 currentTime 从 0 起算；
客户端负责「显示时间 = t + currentTime」的偏移换算，跳到未缓冲位置时换新 t 重开流。

资源约束：11G 主机上跑，限 3 路并发转码（超出排队）、每路 -threads 4；
短剧单集1~11分钟，veryfast 预设实测 3~6 倍速于实时，起播延迟约 1~2 秒。
"""
import logging
import subprocess
import threading
import time

log = logging.getLogger("transcode")

# 清晰度定义：参数值 → (输出高度, crf, 音频码率)；客户端用不到的键不要加
# 360P 是省流档：crf26 + 64k 音频，约原片 1/5 体积（短剧内嵌字幕仍可读）
QUALITIES = {
    "720p": {"h": 720, "crf": 24, "ab": "96k"},
    "480p": {"h": 480, "crf": 24, "ab": "96k"},
    "360p": {"h": 360, "crf": 26, "ab": "64k"},
}

_sem = threading.Semaphore(3)


def stream(src: str, qdef: dict, start: float = 0.0):
    """返回分片 MP4 字节流生成器；客户端断开时经 GeneratorExit/GC 关闭并杀掉 ffmpeg。"""
    def gen():
        proc = None
        t_wait = time.time()
        got = _sem.acquire(timeout=30)  # 排队等槽位；超时就直接转，宁可慢不拒绝
        waited = time.time() - t_wait
        if waited > 2:
            log.info("转码排队等待 %.1f 秒（3 路并发已满）", waited)
        try:
            cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error"]
            if start > 0.05:
                # 输入端 -ss：容器级秒 seek，免解码，起播快
                cmd += ["-ss", f"{start:.2f}"]
            cmd += [
                "-i", src,
                "-vf", f"scale=-2:{qdef['h']}",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", str(qdef["crf"]),
                "-g", "48",              # ~2s 一个关键帧，分片小、拖动粒度细
                "-threads", "4",
                "-c:a", "aac", "-b:a", qdef["ab"],
                "-movflags", "frag_keyframe+empty_moov+default_base_moof",
                "-f", "mp4", "-",
            ]
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            while True:
                chunk = proc.stdout.read(64 * 1024)
                if not chunk:
                    break
                yield chunk
            if proc.poll() not in (0, None):
                log.warning("转码异常退出 %s: rc=%s", src, proc.returncode)
        finally:
            if proc is not None:
                if proc.poll() is None:
                    proc.kill()
                proc.stdout.close()
            if got:
                _sem.release()

    return gen()
