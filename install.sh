#!/usr/bin/env bash

set -euo pipefail
umask 077

MARKETPLACE_SOURCE="DM010727/jev-claudecode-ssy"
MARKETPLACE_NAME="jev-claudecode-ssy"
PLUGIN_ID="jev-claudecode-ssy@jev-claudecode-ssy"

if ! command -v claude >/dev/null 2>&1; then
  echo "未找到 Claude Code。请先安装：https://claude.ai/install" >&2
  exit 1
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "此安装脚本目前用于 macOS；Windows 请使用 README 中的 npx 命令。" >&2
  exit 1
fi

echo "Jev Claude Code · 胜算云版：开始一键接入"
echo "正在检查 Claude Code 更新…"
claude update || echo "Claude Code 自动更新未完成，将继续尝试安装插件。"

CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SETTINGS_FILE="$CONFIG_DIR/settings.json"
mkdir -p "$CONFIG_DIR"

if [[ -f "$SETTINGS_FILE" ]]; then
  if ! /usr/bin/plutil -lint "$SETTINGS_FILE" >/dev/null; then
    echo "无法解析 $SETTINGS_FILE；为避免覆盖现有设置，安装已停止。" >&2
    exit 1
  fi
  cp "$SETTINGS_FILE" "$SETTINGS_FILE.jev-ssy-$(date +%Y%m%d%H%M%S).bak"
else
  printf '{}\n' > "$SETTINGS_FILE"
fi

if ! /usr/bin/plutil -extract env json -o - "$SETTINGS_FILE" >/dev/null 2>&1; then
  /usr/bin/plutil -insert env -json '{}' "$SETTINGS_FILE"
fi
if /usr/bin/plutil -extract env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS raw -o - "$SETTINGS_FILE" >/dev/null 2>&1; then
  /usr/bin/plutil -replace env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS -string '1' "$SETTINGS_FILE"
else
  /usr/bin/plutil -insert env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS -string '1' "$SETTINGS_FILE"
fi
echo "已启用函数钩子：$SETTINGS_FILE"

printf '请输入胜算云 API Key（输入内容会隐藏，按 Enter 确认）：' > /dev/tty
IFS= read -r -s API_KEY < /dev/tty
printf '\n' > /dev/tty
if [[ -z "$API_KEY" ]]; then
  echo "API Key 不能为空。" >&2
  exit 1
fi

echo "正在注册并更新 marketplace…"
claude plugin marketplace add "$MARKETPLACE_SOURCE" --scope user >/dev/null 2>&1 || true
claude plugin marketplace update "$MARKETPLACE_NAME"

echo "正在安装插件并写入 API Key…"
claude plugin uninstall "$PLUGIN_ID" --scope user >/dev/null 2>&1 || true
claude plugin install "$PLUGIN_ID" --scope user --config "apiKey=$API_KEY"
unset API_KEY

echo
echo "接入完成。重启 Claude Code，或在当前会话执行 /reload-plugins。"

