# Shuaju 刷剧 · Server

自托管短剧库管理系统：网盘资源搜索 → 夸克转存 → 本地下载 → 刮削入库 → 网页 / App 在线播放。
FastAPI + SQLite，前端为无构建 SPA + PWA，同时为 [Shuaju Android App](https://github.com/xjzq0907/shuaju-app) 提供 HTTP API。

## 功能

- **资源流水线**：约 6.5 万条短剧索引全量搜索 → 排队 → [quark-auto-save](https://github.com/Cp0204/quark-auto-save) 转存夸克网盘 → aria2 下载落盘 → 自动入库
- **剧库管理**：SQLite 存储，本地目录扫描同步，集数识别兼容花式文件名（`1.mp4` / `第1集.mp4` / `001.第1集.mp4` 等）
- **在线播放**：原画 Range 流（续播 / 连播 / 选集），720p / 480p ffmpeg **实时转码**（管道直出、不落盘、不预转）
- **PWA 手机端**（`/w`）：继续观看横滑区、筛选、无限滚动；播放器支持长按 2 倍速、双击快进退、上下滑切集、断点续播
- **发现流**：`/api/dramas/random` 随机刷剧（剧名归一化去重，同剧变体只出一部），`/similar` 连季推荐
- **收藏 / 拉黑**：拉黑可只删记录保留文件，链接进黑名单后同步不会复活

## 工作流程

```
索引 CSV（quark-links） → 网页搜索排队 → quark-auto-save 转存
    → aria2 下载到短剧库 → scan 入库 → FastAPI → 浏览器 PWA / Android App
```

## 快速开始

```bash
cp .env.example .env   # 修改路径等配置
GIT_REV=$(git rev-parse --short HEAD) docker compose up -d --build   # GIT_REV 可选，设置后「设置页」显示版本
```

服务监听 `15006` 端口（`network_mode: host`，可用 `PORT` 改）：

- `/` 管理首页（搜索、队列、批次、黑名单）
- `/w` 手机 PWA 播放端
- `/api/*` HTTP API

### 访问令牌（可选）

在 `.env` 设置 `AUTH_TOKEN` 后，所有 `/api/*`（含视频流与封面）需带 `X-Auth-Token` 请求头或 `?token=` 查询参数；网页端首次访问会弹令牌输入框，App 在设置里填同一个值。留空 = 不鉴权。静态页面壳与 `/healthz` 不受令牌保护（数据与视频都在 `/api` 下）。

## 数据卷

| 宿主路径（示例） | 容器路径 | 说明 |
|---|---|---|
| `…/workspace/quark-links` | `/data/quark-links` | 索引 CSV + import_state.json（与 CLI 工具共用，读写） |
| `…/ad/短剧库` | `/media-lib` | 本地短剧文件（扫描 + 播放） |
| `…/duanju-manager` | `/data/duanju` | SQLite 数据库与运行数据 |
| `…/quark-auto-save/config/quark_config.json` | `/config/quark_config.json` | 夸克工具 WebUI 配置（只读，用于计算 token） |

## 配置

配置分两层：**设置页可改（存数据库，重启保留、立即生效）** 与 **部署级环境变量（.env，改完需重建容器）**。

设置页「运行配置」面板可改（数据库 `settings` 表持久化，环境变量是出厂默认）：

| 配置项 | 说明 |
|---|---|
| `LIB_ROOT` 短剧库目录 | 扫描/播放/下载落盘/拉黑校验的根目录 |
| `ARIA2_RPC` | aria2 JSON-RPC 地址 |
| `QUARK_AUTOSAVE_URL` | quark-auto-save WebUI 地址 |
| `SAVE_ROOT` | 夸克网盘内的保存根目录 |
| `BATCH_SIZE` | 单批转存部数（1~500） |

部署级（容器挂载相关，只在 `.env` 配置，设置页只读展示路径）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `QUARK_LINKS_DIR` | 必填 | 索引与导入状态目录（与 CLI 工具共用） |
| `DATA_DIR` | 必填 | SQLite 所在目录 |
| `QUARK_CFG` | 必填 | quark-auto-save 配置文件（只读） |
| `AUTH_TOKEN` | 空（不鉴权） | 访问令牌，见「访问令牌」一节 |
| `PORT` | `15006` | 服务监听端口 |

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/stats` | 剧库统计 |
| GET | `/api/dramas` | 剧列表（搜索、`watch_state=`、`favorite=true`、分页） |
| GET | `/api/dramas/random?n=&exclude=` | 发现流随机剧（须注册在 `/{id}` 之前） |
| GET | `/api/dramas/{id}` | 剧详情（集列表、观看进度） |
| GET | `/api/dramas/{id}/similar` | 连季推荐（剧名归一化前缀匹配） |
| PATCH | `/api/dramas/{id}` | 更新收藏 / 观看进度 |
| GET | `/api/dramas/{id}/episodes/{ep}?q=&t=` | 播放流：`q` 空 = 原画 Range 流；`720p`/`480p` = 实时转码，`t` = 起点秒 |
| GET | `/api/dramas/{id}/episodes/{ep}/meta` | 单集元信息（含真实时长 `duration`） |
| GET | `/api/dramas/{id}/cover` | 封面 |
| POST | `/api/dramas/{id}/blacklist` | 拉黑（`delete_files=false` 只删记录留文件） |
| GET/DELETE | `/api/blacklist`、`/api/blacklist/{bid}` | 黑名单查询 / 移除 |
| GET | `/api/index/search?q=` | 索引搜索 |
| GET/POST/DELETE | `/api/queue`、`/api/queue/{qid}` | 下载队列管理 |
| GET | `/api/pipeline`、POST `/api/pipeline/pause` | 流水线状态 / 暂停 |
| GET | `/api/batches`、`/api/batches/{bid}` | 批次记录 |
| POST | `/api/sync` | 触发本地库扫描同步（`{"scope":"local"}`） |
| GET | `/healthz` | 健康检查 |

## 实时转码说明

- 客户端显式选择清晰度才转码，ffmpeg 管道直出分片 MP4（`frag_keyframe+empty_moov`），不落盘、不预转。
- 全机限 **3 路并发**（超出排队 30s），每路 4 线程，`veryfast crf24`，输入端 `-ss` 秒级定位，起播约 1~2s。
- ffmpeg 的 mp4 muxer 会把流起点重排到 0：客户端需自行维护偏移（显示时间 = `t` + 播放位置），深跳未缓冲位置时换新 `t` 重开流；转码流无 `Accept-Ranges`，不支持 Range 拖动。
- 排障：容器内 `pgrep ffmpeg` 查看活跃转码。

## 开发注意

- 前端 `static/` 是 `COPY` 进镜像的，**改前端必须 rebuild**。
- 同一个 SQLite 写事务内禁止再开第二个连接写库（会 `database is locked` 回滚）。
- 与 `quark-links` 目录下的 CLI 工具通过 `.batch-lock` flock 互斥，双入口状态一致。
- 宿主重启存在竞态：数据盘未挂载时容器会 `Exited(255)` 且不自动重试，需手动 `docker start`。

## 相关

- [shuaju-app](https://github.com/xjzq0907/shuaju-app) — Android 客户端
