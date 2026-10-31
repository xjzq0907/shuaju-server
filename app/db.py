import os
import sqlite3
from contextlib import contextmanager

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS dramas (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  share_url TEXT UNIQUE,
  episodes_expected INTEGER,
  updated_date TEXT,
  drive_state TEXT NOT NULL DEFAULT 'pending',
  download_state TEXT NOT NULL DEFAULT 'none',
  local_dir TEXT,
  episodes_local INTEGER NOT NULL DEFAULT 0,
  size_mb REAL NOT NULL DEFAULT 0,
  watch_state TEXT NOT NULL DEFAULT 'unwatched',
  last_episode INTEGER NOT NULL DEFAULT 0,
  favorite INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dramas_title ON dramas(title);
CREATE INDEX IF NOT EXISTS idx_dramas_download ON dramas(download_state);
CREATE INDEX IF NOT EXISTS idx_dramas_drive ON dramas(drive_state);

CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY,
  drama_id INTEGER NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  batch_id INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_queue_status ON queue(status);

CREATE TABLE IF NOT EXISTS blacklist (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  share_url TEXT UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'running',
  total INTEGER NOT NULL DEFAULT 0,
  saved INTEGER NOT NULL DEFAULT 0,
  up_to_date INTEGER NOT NULL DEFAULT 0,
  dead INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  files_pushed INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  log TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
"""


def init_db():
    os.makedirs(config.DATA_DIR, exist_ok=True)
    with get_db() as conn:
        conn.executescript(SCHEMA)
        # 老库迁移：收藏列
        cols = {r[1] for r in conn.execute("PRAGMA table_info(dramas)")}
        if "favorite" not in cols:
            conn.execute(
                "ALTER TABLE dramas ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0"
            )
        # 老库迁移：按剧裁边（片头跳过/片尾提前秒数，0=不裁）
        if "skip_head" not in cols:
            conn.execute("ALTER TABLE dramas ADD COLUMN skip_head INTEGER NOT NULL DEFAULT 0")
        if "skip_tail" not in cols:
            conn.execute("ALTER TABLE dramas ADD COLUMN skip_tail INTEGER NOT NULL DEFAULT 0")


@contextmanager
def get_db():
    conn = sqlite3.connect(config.DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()
