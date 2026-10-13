#!/usr/bin/env bash
# Chrome Bridge 一键安装: 装依赖、注册到 Claude Code、打开 Chrome 扩展页并定位扩展目录.
# 用法: ./install.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
CONNECTOR="$ROOT/connector/index.js"

command -v node >/dev/null || { echo "需要 Node.js 18+: https://nodejs.org"; exit 1; }
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 18 ] || { echo "Node.js 版本太旧 ($(node -v)), 需要 18+"; exit 1; }

echo "1/3 安装连接器依赖"
(cd "$ROOT/connector" && npm install --no-fund --no-audit --silent)

echo "2/3 注册到 Claude Code"
if command -v claude >/dev/null; then
  if claude mcp get chrome-bridge >/dev/null 2>&1; then
    claude mcp remove -s user chrome-bridge >/dev/null 2>&1 || true
  fi
  claude mcp add -s user chrome-bridge -- node "$CONNECTOR" >/dev/null
  echo "    已注册 (所有项目可用)"
else
  echo "    没找到 claude 命令, 跳过。其他 MCP 客户端请手动添加:"
  echo "    command: node   args: [\"$CONNECTOR\"]"
fi

echo "3/3 在 Chrome 里加载扩展"
if [ "$(uname)" = "Darwin" ]; then
  open -a "Google Chrome" "chrome://extensions" 2>/dev/null || true
  open -R "$ROOT/extension/manifest.json"
fi
cat <<EOF

    在刚打开的 chrome://extensions 页面:
      ① 右上角打开「开发者模式」
      ② 点「加载已解压的扩展程序」, 选这个文件夹 (已在访达里选中):
         $ROOT/extension
    已经加载过的话, 点扩展卡片上的刷新按钮 ↻ 即可。

完成后新开一个 Claude 会话, 说「用 Chrome 打开 xxx」。
第一次会给你一个 8 位配对码, 点 Chrome 工具栏的 Chrome Bridge 图标输入, 以后不用再配。
EOF
