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

log = logging.getLogger("transcode")

# 清晰度定义：参数值 → 输出高度；客户端用不到的键不要加
QUALITIES = {"720p": 720, "480p": 480}

_sem = threading.Semaphore(3)


def stream(src: str, height: int, start: float = 0.0):
    """返回分片 MP4 字节流生成器；客户端断开时经 GeneratorExit/GC 关闭并杀掉 ffmpeg。"""
    def gen():
        proc = None
        got = _sem.acquire(timeout=30)  # 排队等槽位；超时就直接转，宁可慢不拒绝
        try:
            cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error"]
            if start > 0.05:
                # 输入端 -ss：容器级秒 seek，免解码，起播快
                cmd += ["-ss", f"{start:.2f}"]
            cmd += [
                "-i", src,
                "-vf", f"scale=-2:{height}",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "24",
                "-g", "48",              # ~2s 一个关键帧，分片小、拖动粒度细
                "-threads", "4",
                "-c:a", "aac", "-b:a", "96k",
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
