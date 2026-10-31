import hashlib
import json
import logging
import re
import time
import urllib.parse
import urllib.request

from . import config

log = logging.getLogger("clients")

QUARK_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "quark-cloud-drive/3.14.2 Chrome/112.0.5615.165 Electron/24.1.3.8 Safari/537.36 Channel/pckk_other_ch"
)


def load_quark_cfg() -> dict:
    with open(config.QUARK_CFG, encoding="utf-8") as f:
        return json.load(f)


class QuarkAutoSave:
    """quark-auto-save WebUI 客户端（token 认证 + run_script_now SSE）。"""

    def __init__(self):
        cfg = load_quark_cfg()
        w = cfg["webui"]
        self.token = hashlib.md5(
            f"token{w['username']}{w['password']}+-*/".encode()
        ).hexdigest()[8:24]

    def run_script_now(self, tasklist: list, timeout: int = 3600) -> list:
        """一次性执行任务（不持久化），返回解析出的输出行。"""
        url = f"{config.QUARK_AUTOSAVE_URL}/run_script_now?token={self.token}"
        payload = json.dumps({"tasklist": tasklist}).encode()
        req = urllib.request.Request(
            url, data=payload, headers={"Content-Type": "application/json"}
        )
        lines = []
        with urllib.request.urlopen(req, timeout=timeout) as r:
            for raw in r:
                line = raw.decode("utf-8", "replace").strip()
                if line.startswith("data: "):
                    line = line[6:]
                if line == "[DONE]":
                    break
                if line:
                    lines.append(line)
        return lines


class Aria2Client:
    def __init__(self):
        self.url = config.ARIA2_RPC
        self.secret = load_quark_cfg().get("plugins", {}).get("aria2", {}).get(
            "secret"
        ) or "yourtoken"

    def _rpc(self, method, params=None, timeout=15):
        body = {"jsonrpc": "2.0", "id": str(time.time()), "method": method,
                "params": [f"token:{self.secret}"] + (params or [])}
        req = urllib.request.Request(
            self.url,
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            resp = json.loads(r.read())
        if "error" in resp:
            raise RuntimeError(f"aria2 error: {resp['error']}")
        return resp["result"]

    def stat(self) -> dict:
        s = self._rpc("aria2.getGlobalStat")
        return {
            "active": int(s["numActive"]),
            "waiting": int(s["numWaiting"]),
            "stopped": int(s["numStopped"]),
            "speed": int(s["downloadSpeed"]),
        }

    def wait_idle(self, timeout: int = 7200, on_tick=None, poll: int = 15) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                s = self.stat()
            except Exception as e:  # 网络抖动不算失败
                log.warning("aria2 查询失败: %s", e)
                time.sleep(poll)
                continue
            if s["active"] + s["waiting"] == 0:
                return True
            if on_tick:
                on_tick(s)
            time.sleep(poll)
        return False

    def add_uri(self, url: str, out: str, dir_: str, headers: list):
        self._rpc(
            "aria2.addUri",
            [[url], {"header": headers, "out": out, "dir": dir_}],
        )


class QuarkDrive:
    """夸克网盘直连的最小子集：路径查 fid、列目录、取下载直链。

    用于"已在网盘但未下载"的补推场景（quark-auto-save 插件只对新转存触发）。
    """

    BASE = "https://drive-pc.quark.cn"

    def __init__(self):
        self.cookie = load_quark_cfg()["cookie"][0]

    def _send(self, method, path, params=None, json_body=None):
        url = f"{self.BASE}{path}"
        if params:
            url += "?" + urllib.parse.urlencode(params)
        data = json.dumps(json_body).encode() if json_body is not None else None
        req = urllib.request.Request(
            url,
            data=data,
            method=method,
            headers={
                "cookie": self.cookie,
                "content-type": "application/json",
                "user-agent": QUARK_UA,
            },
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())

    def get_fid(self, path: str):
        resp = self._send(
            "POST",
            "/1/clouddrive/file/info/path_list",
            params={"pr": "ucpro", "fr": "pc"},
            json_body={"file_path": [path], "namespace": "0"},
        )
        if resp.get("code") == 0 and resp.get("data"):
            return resp["data"][0]["fid"]
        return None

    def ls_dir(self, pdir_fid: str) -> list:
        items, page = [], 1
        while True:
            resp = self._send(
                "GET",
                "/1/clouddrive/file/sort",
                params={
                    "pr": "ucpro", "fr": "pc", "uc_param_str": "",
                    "pdir_fid": pdir_fid, "_page": page, "_size": "50",
                    "_fetch_total": "1", "_fetch_sub_dirs": "0",
                    "_sort": "file_type:asc,updated_at:desc",
                    "fetch_all_file": 1, "fetch_risk_file_name": 1,
                },
            )
            if resp.get("code") != 0:
                raise RuntimeError(f"列目录失败: {resp.get('message')}")
            batch = resp["data"]["list"]
            items += batch
            if not batch or len(items) >= resp["metadata"]["_total"]:
                return items
            page += 1

    def download_urls(self, fids: list):
        """返回 (download_urls 列表, 下载用 cookie 串)。urls 顺序与 fids 一致。"""
        url = f"{self.BASE}/1/clouddrive/file/download?pr=ucpro&fr=pc&uc_param_str="
        req = urllib.request.Request(
            url,
            data=json.dumps({"fids": fids}).encode(),
            method="POST",
            headers={
                "cookie": self.cookie,
                "content-type": "application/json",
                "user-agent": QUARK_UA,
            },
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            resp = json.loads(r.read())
            set_cookies = r.headers.get_all("Set-Cookie") or []
        if resp.get("code") != 0:
            raise RuntimeError(f"获取直链失败: {resp.get('message')}")
        extra = "; ".join(c.split(";")[0] for c in set_cookies)
        urls = [item["download_url"] for item in resp["data"]]
        return urls, extra
