#!/usr/bin/env bash
# 初始化 short_video_cli 运行环境：
#   1. git submodule（galaxy-downloader-client 引擎源码）
#   2. .venv-engine（yt-dlp Python 环境）
#   3. npm 依赖 + TypeScript 构建
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> [1/4] 引擎 submodule"
if [ ! -f external/galaxy-downloader-client/engine/main.py ]; then
  # GitHub 直连不稳定时走系统代理（macOS 常见 7897/7890 端口）
  if [ -z "${HTTPS_PROXY:-}" ] && [ -n "$(scutil --proxy 2>/dev/null | awk '/HTTPSEnable : 1/{f=1} f && /HTTPSPort/{print $3; exit}')" ]; then
    PORT=$(scutil --proxy | awk '/HTTPSEnable : 1/{f=1} f && /HTTPSPort/{print $3; exit}')
    export HTTPS_PROXY="http://127.0.0.1:${PORT}"
    echo "    使用系统代理 ${HTTPS_PROXY}"
  fi
  git submodule update --init --recursive
else
  echo "    已存在"
fi

echo "==> [2/4] Python venv（.venv-engine）"
if [ ! -x .venv-engine/bin/python ]; then
  python3 -m venv .venv-engine
fi
# 与引擎 requirements 对齐；pyinstaller 仅打包桌面端需要，CLI 场景跳过
.venv-engine/bin/pip install --quiet --upgrade 'yt-dlp[default]==2026.8.19'

echo "==> [3/4] npm 依赖"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> [4/4] TypeScript 构建"
npm run build

echo ""
echo "完成。自检: node dist/index.js status"
