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
  cp "$SETTINGS_FILE" "$SETTINGS_FILE.jev-ssy-$(date +%Y%m%d%H%M%S).bak"
else
  printf '{}\n' > "$SETTINGS_FILE"
fi

# Some macOS releases only parse property lists with plutil and reject JSON at
# its first "{". JXA is built into macOS and gives us a real JSON parser without
# requiring Node.js, Python or jq.
if ! /usr/bin/osascript -l JavaScript - "$SETTINGS_FILE" <<'JXA'
ObjC.import('Foundation');

function run(argv) {
  const settingsPath = argv[0];
  const source = $.NSString.stringWithContentsOfFileEncodingError(
    $(settingsPath),
    $.NSUTF8StringEncoding,
    null,
  );
  if (!source) throw new Error(`无法读取 ${settingsPath}`);

  const raw = ObjC.unwrap(source).replace(/^\uFEFF/, '');
  let settings;
  try {
    settings = JSON.parse(raw || '{}');
  } catch (error) {
    throw new Error(`无法解析 ${settingsPath}: ${error.message}`);
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error(`${settingsPath} 的顶层必须是 JSON 对象`);
  }
  if (settings.env === undefined) settings.env = {};
  if (!settings.env || typeof settings.env !== 'object' || Array.isArray(settings.env)) {
    throw new Error(`${settingsPath} 中的 env 必须是 JSON 对象`);
  }

  settings.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS = '1';
  const output = `${JSON.stringify(settings, null, 2)}\n`;
  const written = $(output).writeToFileAtomicallyEncodingError(
    $(settingsPath),
    true,
    $.NSUTF8StringEncoding,
    null,
  );
  if (!written) throw new Error(`无法写入 ${settingsPath}`);
}
JXA
then
  echo "无法安全更新 $SETTINGS_FILE；原文件未被覆盖，安装已停止。" >&2
  exit 1
fi
chmod 600 "$SETTINGS_FILE"
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

REVIEW_CONFIG_DIR="$HOME/.jev-claudecode-ssy"
mkdir -p "$REVIEW_CONFIG_DIR"
chmod 700 "$REVIEW_CONFIG_DIR"
printf '%s\n' "$API_KEY" > "$REVIEW_CONFIG_DIR/api-key"
chmod 600 "$REVIEW_CONFIG_DIR/api-key"
unset API_KEY

echo
echo "接入完成。重启 Claude Code，或在当前会话执行 /reload-plugins。"
echo "Jev 并行审查工具也已配置完成。"
