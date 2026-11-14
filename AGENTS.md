# short_video_cli

多平台短视频/媒体下载 CLI。**引擎为本地 yt-dlp 封装**（git submodule：`external/galaxy-downloader-client/engine`，源码级依赖、无远程解析 API），在 galaxy-downloader fork 的命令面基础上改造：下载/解析/字幕/历史/本地转录。

任何 agent harness（ZCode / Claude Code / Codex / dsh 等）处理"下载视频/音频/字幕/转录"类请求时，按本文与 `skills/media-downloader/SKILL.md` 驱动本 CLI。

## 快速开始

```bash
git clone --recurse-submodules <repo> && cd short_video_cli
npm run setup        # submodule + .venv-engine(yt-dlp) + npm install + build
node dist/index.js status   # 自检：引擎/ffmpeg/venv
```

更新引擎：`git submodule update --remote external/galaxy-downloader-client`

## 命令速查（`svdl` = `node dist/index.js`，npm link 后可用）

```bash
svdl "<url>"                          # 下载（视频/音频/主页，自动识别）
svdl parse "<url>"                    # 只解析：条目列表 + 画质格式表
svdl captions "<url>" -l zh           # 只下载字幕
svdl "<url>" --items 1,3-5            # 列表选择条目（--part N / --all）
svdl "<url>" --type audio --folder X  # 音频(m4a)，按系列分目录
svdl login douyin.com                 # 打开专属浏览器登录一次（长期有效）
svdl "<douyin-url>"                   # 抖音自动走浏览器模式（视频/主页/短链）
svdl history [-p 平台] [关键词]        # SQLite 下载历史
svdl transcribe <目录> [--polish]     # 转录（视频目录直接可喂，自动提音轨）+ 可选 LLM 润色
svdl status / platforms
```

通用选项：`--json`（stdout 恰好一个 JSON 对象，进度走 stderr）、`--quality lowest|highest`、`--format <format_id>`、`-o/--output`、`--folder`、`--anon`（禁用登录 cookie）。

## Agent 使用要点

1. **先 parse 后 download**：parse 给出条目 index（对应 `--items`）与 format_id（对应 `--format`）
2. **多条目安全闸**：列表链接未指定 `--items/--part/--all` 时命令拒绝执行并列出条目——不要绕过，让用户选择
3. **隔离存放**：不同用户/系列必须 `--folder` 分目录；转录用对应 `--outdir`
4. **登录态**：抖音下载未登录时 CLI 会自动弹登录页（交互终端，45s 宽限）；引擎平台撞风控/权限错误且未登录时弹页等待后自动重试。agent 环境（非 TTY）不弹窗——让用户跑 `svdl login <平台>`（一次长期有效）；`--anon` 可禁用一切登录提示
5. **抖音**：链接自动路由浏览器模式（视频/主页/分享短链，免 --browser），parse 一样可用；批量条目用 `--items/--part`；连续批量注意间隔
6. 去重是自动的：URL 已下载且文件仍在 → 跳过；`history` 查状态
7. 输出文件用真实标题命名；转录文本自动回写数据库 `transcript_text` 字段

## 架构

```
src/index.ts                 CLI 入口（commander）
src/engine/driver.ts         引擎驱动：spawn .venv-engine python engine/main.py
                            （stdin JSON 请求 → stdout NDJSON 事件流）
src/loginBrowser.ts          专属登录浏览器（.browser-data profile，端口 9223）
src/cookies.ts               CDP cookie 桥（读 jar/匿名访问种 cookie → 引擎格式）
src/commands/                download / parse / captions / transcribe / browserDownload
src/browser.ts               CDP 拦截模式（抖音主页/单视频，连专属实例）
src/db.ts                    SQLite 历史（.data/short_video.db）
scripts/                     asr_server.py（常驻 ASR）、transcribe.py、setup.sh
skills/media-downloader/     跨 harness skill（.zcode/.claude 下有 symlink）
external/galaxy-downloader-client/   引擎 submodule（AGPL，只调用不修改）
```

依赖：Node ≥18、Python 3、ffmpeg（系统安装）。LLM 润色配置见 `.env.example`。

## 许可证

本项目代码 MIT。`external/galaxy-downloader-client` 为 AGPL-3.0 的独立子进程依赖（不修改、不分发其源码，仅通过 stdin/stdout 协议调用）。
