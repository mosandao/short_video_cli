# short_video_cli

多平台短视频/媒体下载 CLI。解析与下载引擎是 [galaxy-downloader-client](https://github.com/bhwa233/galaxy-downloader-client) 的 **yt-dlp 封装**（`engine/main.py`），以 git submodule 源码级引入并直接驱动——**全本地运行，不依赖任何远程解析 API**。

命令面与增值层（SQLite 历史、本地 ASR 转录 + LLM 润色、抖音 Edge 登录态浏览器模式）移植自 galaxy-downloader fork 的 CLI。

## 支持能力

| 能力 | 说明 |
|------|------|
| 视频下载 | Bilibili、YouTube、TikTok、X、Instagram、微博、微信公众号、小红书等 yt-dlp 支持的 1000+ 站点 |
| **持久登录态** | `svdl login <平台>` 打开专属浏览器登录一次（galaxy 方案），之后下载/解析自动注入 cookie；解抖音引擎路径、B站空间风控、会员画质；`--anon` 可禁用 |
| 音频下载 | `--type audio`（引擎提取 m4a） |
| 字幕下载 | `captions` 子命令（含自动生成字幕） |
| 合集/多P/用户空间 | 先 `parse` 看条目，`--items 1,3-5` / `--part N` / `--all` 选择 |
| 抖音视频/主页/分享短链 | **自动浏览器模式**（免 flag）：CDP 翻页枚举 + 拦截视频流；登录后画质档更全、主页更稳 |
| 下载历史 | SQLite（`.data/short_video.db`），自动去重，`history` 查询 |
| 转录 | 本地 Qwen3-ASR 常驻服务（4 并发）→ txt/srt/vtt/json，`--polish` LLM 润色为 Markdown |

## 安装

```bash
git clone --recurse-submodules <repo-url> && cd short_video_cli
npm run setup     # submodule 初始化 + .venv-engine(yt-dlp) + npm install + tsc build
```

依赖：Node.js ≥18、Python 3、ffmpeg（`brew install ffmpeg`）。

可选：`npm link` 后全局 `svdl` 命令可用。

## 使用

```bash
# 解析（看条目与画质，不下载）
node dist/index.js parse "https://www.bilibili.com/video/BV..."

# 下载单个视频（按系列分目录）
node dist/index.js "https://www.bilibili.com/video/BV..." --folder "系列名"

# 下载音频
node dist/index.js "https://v.douyin.com/..." --type audio --folder "作者"

# 合集：选择条目
node dist/index.js "https://www.youtube.com/playlist?list=..." --items 1,3-5

# 字幕
node dist/index.js captions "https://www.youtube.com/watch?v=..." -l zh

# 抖音用户主页（需 Edge 9222，见 SKILL.md 启动手册）
node dist/index.js "https://www.douyin.com/user/xxx" --browser --part 1 --folder "作者"

# 历史 / 转录 / 自检
node dist/index.js history
node dist/index.js transcribe ./downloads/作者 --outdir ./transcripts/作者 --polish
node dist/index.js status
```

`--json` 输出机器可读结果（stdout 恰好一个 JSON 对象，进度走 stderr），agent/skill 用法见 **AGENTS.md** 与 **skills/media-downloader/SKILL.md**（`.zcode/skills/`、`.claude/skills/` 已建 symlink，ZCode / Claude Code / Codex 等 harness 通用）。

## 架构

```
src/engine/driver.ts   引擎驱动：spawn .venv-engine/bin/python
                       external/galaxy-downloader-client/engine/main.py
                       （stdin 一个 JSON 请求 → stdout NDJSON 事件流 → result/error 收尾）
src/commands/          download / parse / captions / transcribe / browserDownload
src/browser.ts         Edge 9222 CDP 模式（puppeteer-core 可选依赖）
src/db.ts              SQLite 历史
scripts/               asr_server.py / transcribe.py / setup.sh
external/              引擎 submodule（git submodule update --remote 可升级）
```

环境变量（均可选）：`GALAXY_WHISPER_MODEL`、`GALAXY_ASR_API`、`GALAXY_CHROME_DEBUG_URL`、`GALAXY_LLM_API_KEY/MODEL/BASE_URL`（LLM 润色，或根目录 `.env`，见 `.env.example`）。

## 来源与许可证

- 引擎：[bhwa233/galaxy-downloader-client](https://github.com/bhwa233/galaxy-downloader-client)（AGPL-3.0）——以 git submodule 独立子进程方式调用，不修改不分发其源码
- 命令面/转录链路：源自本地 galaxy-downloader fork（mosandao/galaxy-downloader）的 `cli/`，解析层已替换为上述引擎
- 本项目自身代码：MIT
