import os
import re

# 集数文件名的多种常见格式（只处理 mp4，封面/简介不动）：
#   1.mp4 / 001.mp4 / 第1集.mp4 / 剧名 第10集.mp4 / 001.第1集.mp4 / (1).mp4
PAT_EP_PATTERNS = [
    re.compile(r"^(\d+)\.mp4$"),
    re.compile(r"^第(\d+)集\.mp4$"),
    re.compile(r"^.*?第(\d+)集\.mp4$"),
    re.compile(r"^[（(](\d+)[）)]\.mp4$"),
]
PAT_EPISODES = re.compile(r"[（(](\d+)集")


def is_episode_name(name: str) -> bool:
    """文件名是否是剧集文件（任一集数命名模式匹配，模式均已限定 .mp4）。"""
    return any(p.match(name) for p in PAT_EP_PATTERNS)


def expected_episodes(title: str):
    m = PAT_EPISODES.search(title)
    return int(m.group(1)) if m else None


def episode_map(folder: str) -> dict:
    """{集数: 文件名}，兼容多种命名（1.mp4 / 第1集.mp4 / 剧名 第N集.mp4 / (N).mp4 / 补零）。"""
    eps = {}
    try:
        entries = os.listdir(folder)
    except FileNotFoundError:
        return eps
    for f in entries:
        if not f.lower().endswith(".mp4"):
            continue
        for pat in PAT_EP_PATTERNS:
            m = pat.match(f)
            if m:
                eps.setdefault(int(m.group(1)), f)
                break
    return eps


def cover_file(folder: str):
    try:
        entries = os.listdir(folder)
    except OSError:
        return None
    for f in sorted(entries):
        if f.lower().endswith((".jpg", ".jpeg", ".png", ".webp")):
            return f
    return None


def pad_folder(folder: str) -> int:
    """把文件夹里的集数文件名补零到相同位数（按该剧最大集数定宽）。返回重命名数。"""
    eps = episode_map(folder)
    if not eps:
        return 0
    width = len(str(max(eps)))
    renamed = 0
    for n, f in eps.items():
        new = f"{n:0{width}d}.mp4" if PAT_EP_PATTERNS[0].match(f) else f"第{n:0{width}d}集.mp4"
        if new != f:
            os.rename(os.path.join(folder, f), os.path.join(folder, new))
            renamed += 1
    return renamed


def folder_stats(folder: str):
    """返回 (mp4集数, 总大小MB)。"""
    eps = episode_map(folder)
    size = 0.0
    try:
        for f in os.listdir(folder):
            fp = os.path.join(folder, f)
            try:
                size += os.path.getsize(fp)
            except OSError:
                pass
    except FileNotFoundError:
        return 0, 0.0
    return len(eps), round(size / 1048576, 1)
