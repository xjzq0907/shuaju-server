import os

# 访问令牌：非空时 /api/* 需带 X-Auth-Token 头或 ?token= 查询参数；空串 = 不鉴权
AUTH_TOKEN = os.environ.get("AUTH_TOKEN", "").strip()

QUARK_LINKS_DIR = os.environ.get("QUARK_LINKS_DIR", "/data/quark-links")
LIB_ROOT = os.environ.get("LIB_ROOT", "/media-lib")
DATA_DIR = os.environ.get("DATA_DIR", "/data/duanju")
QUARK_CFG = os.environ.get("QUARK_CFG", "/config/quark_config.json")
QUARK_AUTOSAVE_URL = os.environ.get("QUARK_AUTOSAVE_URL", "http://127.0.0.1:15005")
ARIA2_RPC = os.environ.get("ARIA2_RPC", "http://127.0.0.1:16800/jsonrpc")
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", "20"))

DB_PATH = os.path.join(DATA_DIR, "duanju.db")
CSV_PATH = os.path.join(QUARK_LINKS_DIR, "all-cleaned.csv")
STATE_PATH = os.path.join(QUARK_LINKS_DIR, "import_state.json")
BATCH_LOCK = os.path.join(QUARK_LINKS_DIR, ".batch-lock")
SAVE_ROOT = "/短剧库"  # 夸克网盘内的保存根目录
