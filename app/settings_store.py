"""页面可配置项：存 settings 表，启动时覆盖 config 模块属性。

环境变量是出厂默认值，数据库值优先；所有消费方（pipeline/sync/clients）
均在调用时读 config.X，运行时改属性立即生效。
"""
import logging
import time

from . import config
from .db import get_db

log = logging.getLogger("settings")

# 页面可编辑项：key -> (config 属性名, 类型)。类型仅 str/int。
EDITABLE = {
    "LIB_ROOT": ("LIB_ROOT", "str"),
    "ARIA2_RPC": ("ARIA2_RPC", "str"),
    "QUARK_AUTOSAVE_URL": ("QUARK_AUTOSAVE_URL", "str"),
    "SAVE_ROOT": ("SAVE_ROOT", "str"),
    "BATCH_SIZE": ("BATCH_SIZE", "int"),
}

# 模块首次导入时的 env 原值（此时 load_into_config 尚未跑），用于"恢复默认"
ENV_DEFAULTS = {k: getattr(config, attr) for k, (attr, _) in EDITABLE.items()}


def load_into_config():
    """启动时把数据库里的值覆盖到 config 属性（在 full_sync 之前调用）。"""
    with get_db() as c:
        rows = {r["key"]: r["value"] for r in c.execute("SELECT key, value FROM settings")}
    n = 0
    for k, (attr, typ) in EDITABLE.items():
        if k in rows:
            try:
                setattr(config, attr, int(rows[k]) if typ == "int" else rows[k])
                n += 1
            except ValueError:
                log.warning("settings表 %s 值非法，忽略: %r", k, rows[k])
    if n:
        log.info("已从数据库加载 %d 项运行配置", n)


def get_settings() -> dict:
    """当前生效值（含未覆盖的 env 默认）。"""
    return {k: getattr(config, attr) for k, (attr, _) in EDITABLE.items()}


def clear_settings():
    """清空页面配置，恢复环境变量默认值。"""
    with get_db() as c:
        c.execute("DELETE FROM settings")
    for k, v in ENV_DEFAULTS.items():
        setattr(config, EDITABLE[k][0], v)
    log.info("运行配置已恢复环境默认")


def save_settings(data: dict) -> dict:
    """校验并保存（仅 data 中出现的键），立即应用到 config。返回新值。"""
    now = int(time.time())
    updates = {}
    for k, v in data.items():
        if k not in EDITABLE or v is None:
            continue
        attr, typ = EDITABLE[k]
        if typ == "int":
            try:
                v = int(v)
            except (TypeError, ValueError):
                raise ValueError(f"{k} 必须是整数")
            if not (1 <= v <= 500):
                raise ValueError(f"{k} 需在 1~500 之间")
        else:
            v = str(v).strip()
            if not v:
                raise ValueError(f"{k} 不能为空")
            if k in ("ARIA2_RPC", "QUARK_AUTOSAVE_URL") and not v.startswith(("http://", "https://")):
                raise ValueError(f"{k} 必须以 http:// 或 https:// 开头")
            if k == "LIB_ROOT" and not v.startswith("/"):
                raise ValueError(f"{k} 必须是绝对路径")
        updates[k] = v
    if not updates:
        raise ValueError("没有可保存的配置")
    with get_db() as c:
        for k, v in updates.items():
            c.execute(
                "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                (k, str(v), now),
            )
    for k, v in updates.items():
        setattr(config, EDITABLE[k][0], v)
    log.info("运行配置已保存: %s", ", ".join(updates))
    return get_settings()
