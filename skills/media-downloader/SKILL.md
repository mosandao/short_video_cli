---
name: media-downloader
description: "多平台媒体下载工具（本地 yt-dlp 引擎，无远程 API）。支持 Bilibili、YouTube、抖音、TikTok、小红书、X、Instagram、微博、微信公众号等平台的视频/音频/字幕/合集/用户主页下载；专属登录浏览器提供持久登录态（login 一次自动注入），抖音走 --browser CDP 拦截；SQLite 下载历史，本地 ASR 转录与 LLM 润色。Use when user asks to download video/audio/captions from social platforms, list a profile or collection, log in to a platform for downloads, check download history, or transcribe media, or mentions 下载视频/下载音频/下载字幕/转录/登录."
license: MIT
compatibility: "适用于 ZCode、Claude Code、Codex 等支持 Agent Skills / AGENTS.md 的工具。需要 Node.js 18+、Python 3、ffmpeg。"
metadata:
  author: short_video_cli
  version: "1.0.0"
  language: zh-CN
  category: media-tools
  tags: "download, video, audio, captions, bilibili, douyin, youtube, yt-dlp, 媒体下载, 转录"
---

# 媒体下载器 (media-downloader)

从各大平台下载视频、音频、字幕、合集、用户主页。**引擎 = 本仓库 submodule 里的 yt-dlp 封装**（`external/galaxy-downloader-client/engine/main.py`），全本地运行，不依赖任何远程解析 API。

## 快速参考

| 场景 | 操作 |
|------|------|
| 用户提供视频链接 | `node dist/index.js "<url>"` （先 parse 看条目，再下载） |
| 下载音频 | 加 `--type audio`（引擎自动提取 m4a） |
| 下载字幕 | `captions <url>` 子命令 |
| 合集/主页/多P | 先 parse，再用 `--items 1,3-5` / `--part N` / `--all` 选择 |
| 抖音视频/主页/分享短链 | 自动浏览器模式（免 flag） |
| 需要登录的内容 | 先 `login <平台>` 登录一次，之后自动携带登录态 |
| 查看下载历史 | `history` 子命令（SQLite 记录） |
| 音频转文字稿 | `transcribe` 子命令（本地 ASR + 可选 LLM 润色） |
| 环境自检 | `status` 子命令（含登录浏览器状态） |

## 登录态（专属登录浏览器，galaxy 方案）

`svdl login douyin.com`（或 bilibili.com / youtube.com / xiaohongshu.com / weibo.com 等）打开**专属浏览器窗口**（独立 profile 在 `.browser-data/`，端口 9223）：登录一次（扫码/账密）后长期有效。

**自动登录提示（交互式终端）**：
- **抖音**：下载时检测到未登录 → 自动弹登录页，45 秒宽限内扫码则以登录态继续，超时匿名继续
- **B站等引擎平台**：普通视频匿名即可，只有撞上风控/权限错误且未登录时 → 弹登录页阻塞等待（≤5 分钟），登录后自动重试
- 非交互环境（agent/管道）不弹窗，报错引导 `svdl login`；`--anon` 彻底关闭登录提示与 cookie 注入
- 浏览器二进制自动探测：Edge → Chrome → Chromium → Brave（macOS），`GALAXY_BROWSER_EXECUTABLE` 可指定；Firefox/Safari 不支持（需 Chromium 系 CDP）

之后所有 parse/download/captions **自动注入**该域 cookie（`--anon` 可禁用）：
- 抖音浏览器模式登录后画质档更全（1080p）、主页枚举更稳
- B站用户空间 412/352 风控、大会员画质需要登录 cookie
- 引擎报"cookies needed / blocked by server"时会自动取 cookie 重试一次

`--browser` 模式自动复用该实例（默认无头），不再需要"杀 Edge + 复制 Profile"那套旧流程（旧流程保留为备选，见文末附录）。

## CLI 调用方式

从项目根目录运行（`npm run build` 后产物在 `dist/`）：

```bash
node dist/index.js <url> [选项]        # 下载（主命令）
node dist/index.js parse <url>         # 仅解析
node dist/index.js captions <url>      # 仅字幕
node dist/index.js history [关键词]     # 历史
node dist/index.js transcribe <目录>    # 转录
node dist/index.js status              # 环境自检
```

`npm link` 后可直接用 `svdl` 代替 `node dist/index.js`。

### 主要选项

| 选项 | 说明 | 默认 |
|------|------|------|
| `-t, --type` | video / audio / auto | auto |
| `-o, --output` | 输出目录 | ./downloads |
| `--folder <name>` | 子目录（按用户/系列隔离，**强烈建议**） | - |
| `-i, --items` | 列表条目选择 `"1,3-5"` | - |
| `-p, --part <N>` | 单个条目序号 | - |
| `--since <time>` | 发布时间范围起点（时间范围即选择器，免 --items） | - |
| `--until <time>` | 发布时间范围终点（默认当前时刻） | - |
| `--all` | 列表全部下载 | - |
| `--quality` | lowest / highest / ask | ask（非交互环境=highest） |
| `--format <id>` | 直接指定 yt-dlp 格式（parse 结果里的 format_id） | - |
| `--save-cover` | 同时保存封面 | - |
| `--browser` | 强制浏览器模式（抖音已自动路由，此标志用于其他平台兜底） | - |
| `--anon` | 禁用登录 cookie 注入（纯匿名） | - |
| `--json` | JSON 输出（进度走 stderr，stdout 恰好一个 JSON） | - |

**安全设计**：链接包含多个条目且未指定 `--items/--part/--all` 时，命令会**拒绝下载并列出条目**，而不是整包下载。这是刻意行为（防止误下整个主页/合集）。

## 标准工作流

1. **先看**：`node dist/index.js parse "<url>"` —— 列出条目（index/标题/时长）与画质格式表
2. **再下**：`node dist/index.js "<url>" --items <选择> --folder <系列名> --quality <画质>`（单视频无需 --items）
3. **音频**：`--type audio`（自动最低画质视频流 → 提取 m4a）
4. **字幕**：`node dist/index.js captions "<url>" -l zh` → srt/vtt 落到输出目录
5. **报告**：把产出文件路径告诉用户；`history` 可随时查记录

## SQLite 历史记录

所有下载自动记录到 `.data/short_video.db`（表 `media`：platform/username/title/video_url/media_path/transcript_text/published_at/downloaded_at）。

```bash
node dist/index.js history              # 最近 20 条
node dist/index.js history "关键词"       # 按标题搜
node dist/index.js history -p douyin    # 按平台筛
node dist/index.js history -n 50
```

- 下载前按 URL 去重：已下载且**本地文件仍在** → 跳过（文件被删会重新下载）
- `transcribe` 完成后自动回写 `transcript_text` 字段

## 转录流水线（transcribe）

```bash
# 视频目录直接转录（mp4/mkv/webm/mov 自动提取音轨，音轨与视频同目录可复用）
node dist/index.js transcribe ./downloads/<系列名> --outdir ./transcripts/<系列名>

# 指定格式 / 加 LLM 润色（.env 配置有效 api_key）
node dist/index.js transcribe ./downloads/<系列名> --outdir ./transcripts/<系列名> -f srt --polish
```

- 输入支持音频（mp3/wav/m4a/flac/ogg/aac）与视频容器（mp4/mkv/webm/mov）——**下载完直接对目录转录即可**，ffmpeg 自动提音轨（aac 无损 copy，非 aac 回退重编码），同名视频+音轨只算一条
- 默认本地常驻 ASR 服务（Qwen3-ASR，4 并发，端口 8300，冷启动 ~30-90s 加载模型），模型路径默认 `~/.omlx/models/Qwen3-ASR-0.6B-8bit`（`GALAXY_WHISPER_MODEL` 可覆盖）
- 转录完成自动回写数据库 `transcript_text`（`history` 里可见 ✅）
- 纯 BGM/无语音的短视频产出空文本属正常
- 润色输出 `<名>.polished.md`（Markdown 结构化），429 自动退避重试；润色 401 = .env 里的 LLM key 失效，需更新
- 也可 `--api <url> --api-key <key>` 走 OpenAI 兼容转录服务
- **并行策略**：下载与转录相互独立。批量场景用流水线——第 1 个视频下载完立即转录，同时继续下载后续视频

## 字幕文本提取（captions）

```bash
node dist/index.js captions "<url>" -l zh          # B站/YouTube 等有字幕/CC 的平台
```
- B站登录态下可拿 AI 字幕（实测 zh-Hans srt）；YouTube 走代理常遇 429
- 抖音无字幕体系——要文本就用 transcribe

## 按用户/系列隔离存放（必须遵守）

不同用户/系列的视频必须用 `--folder` 分目录，防止混淆：

```bash
node dist/index.js "<user-url>" --folder "用户名" --output ./downloads
node dist/index.js transcribe "./downloads/用户名" --outdir "./transcripts/用户名"
```

```
downloads/用户名/视频标题.mp4      ← 输出文件一律用真实标题命名
transcripts/用户名/视频标题.txt
```

## 抖音（自动浏览器模式，无需 --browser）

抖音链接（视频 `douyin.com/video/...`、主页 `douyin.com/user/...`、分享短链 `v.douyin.com/...`）**自动路由到浏览器模式**——引擎的抖音 extractor 未实现签名（上游限制），CLI 已内置路由，直接用即可：

```bash
node dist/index.js parse "<url>"              # 单视频：标题+已捕获流；主页：全部视频列表（含发布时间）
node dist/index.js "<video-url>" --folder X   # 单视频下载
node dist/index.js "<user-url>" --items 1-10 --folder "作者"   # 主页批量
# 按发布时间范围批量下载（抖音/B站空间通用）
node dist/index.js "<user-url>" --since "yesterday" --until "today 09:00" --folder "作者"
node dist/index.js "<user-url>" --since "7d" --folder "作者"          # 最近 7 天
node dist/index.js "<space-url>" --since "2026-11-01" --until "2026-11-13 23:59" --folder "作者"
```

**时间格式**：`YYYY-MM-DD`、`YYYY-MM-DD HH:mm`、`yesterday [HH:mm]`、`today [HH:mm]`、`Nd`（N 天前 00:00）、`3天前`；`--until` 缺省为当前时刻。B站空间含失效视频时自动逐条取日期（跳过死链，稍慢）；引擎侧单次最多扫描 100 条。

- **登录后默认无头运行**（实测登录态无头对抖音完全可用，无窗口打扰）；无头未成功时自动切可见窗口重试；`svdl login` 时才弹可见窗口
- **推荐先 `svdl login douyin.com`**：登录后画质档更全（实测多出 1080p）、主页枚举更稳、无头可用
- 分享短链（v.douyin.com）自动解析重定向后再路由
- **连续批量下载之间必须 `sleep 3`**（引擎自动加了间隔，手动循环时也注意）
- 抖音主页每次枚举有反爬阈值：优先下重要的，失败批次隔 10+ 分钟再补
- `--browser` 标志对其他平台仍可用（强制浏览器模式）

### 附录：复用日常 Edge 的旧流程（备选）

专属实例不可用时，可手动启动日常 Edge 的调试副本（端口 9222）：

```bash
pkill -9 -f "Microsoft Edge"
cp -r "$HOME/Library/Application Support/Microsoft Edge" "$HOME/Library/Application Support/Microsoft Edge Debug"
/Applications/Microsoft\ Edge.app/Contents/MacOS/Microsoft\ Edge \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/Library/Application Support/Microsoft Edge Debug" &
curl -s http://127.0.0.1:9222/json/version
```

### 抖音已知陷阱

- **渐进式反爬**：新 Profile 前 ~7 个请求成功率最高；每批间隔 10+ 分钟，批间重新复制 Profile
- **被拦截症状**："分享页面未找到视频链接"（返回 HTML 异常小）
- **优先下载最重要的视频**，失败批次隔时间再补

## 错误处理

| 现象 | 处理 |
|------|------|
| 提示 submodule/venv 缺失 | `git submodule update --init --recursive && npm run setup` |
| 提示 ffmpeg 缺失 | `brew install ffmpeg` |
| 引擎报 "Unsupported URL" | 平台不支持或需登录态；抖音已自动路由浏览器模式 |
| 抖音链接报错/画质缺失 | 确认 `svdl login douyin.com` 已登录；主页失败批次隔 10+ 分钟再补 |
| B站空间 352/412 风控 | 需登录态：`svdl login bilibili.com` 后自动带 SESSDATA 即可枚举 |
| "1080P 高码率 missing / become a premium member" | 该画质档需 B 站**大会员**账号权益，登录非会员账号也不会出现——平台权益限制，无法绕过 |
| YouTube 字幕报 HTTP 429 | 字幕端点限流（代理 IP 常见），稍后重试或跳过字幕 |
| 画质/条目信息不明 | 先 `parse` 看 formats 表和条目列表 |
| 429 / rate limit | 稍后再试；批量场景降低并发、加大间隔 |

**文件名说明**：标题中的 `/` 会被引擎转成 `⧸`（跨平台安全文件名），历史记录标题与文件名保持一致；属正常现象。

## 环境变量

| 变量 | 用途 | 默认 |
|------|------|------|
| `GALAXY_WHISPER_MODEL` | ASR 模型路径 | ~/.omlx/models/Qwen3-ASR-0.6B-8bit |
| `GALAXY_ASR_API` | 本地 ASR 服务地址 | http://127.0.0.1:8300 |
| `GALAXY_BROWSER_DEBUG_URL` | 专属登录浏览器调试地址 | http://127.0.0.1:9223 |
| `GALAXY_BROWSER_EXECUTABLE` | 浏览器二进制路径 | 自动探测 Edge→Chrome |
| `GALAXY_CHROME_DEBUG_URL` | --browser 连接的调试地址 | 专属实例或 9222 |
| `GALAXY_LLM_API_KEY/MODEL/BASE_URL` | 润色 LLM（优先于 .env） | - |

LLM 配置放根目录 `.env`（参照 `.env.example`）。

## 注意事项

1. **版权**：下载内容仅供个人使用
2. **登录墙**：需要登录的内容公开解析会失败（引擎协议预留 cookies 注入，v1 未实现）；抖音走 --browser
3. **大文件**：注意磁盘空间（`history` 可查已下载内容）
4. **海外平台**（TikTok/Instagram/X）可能需要网络环境
