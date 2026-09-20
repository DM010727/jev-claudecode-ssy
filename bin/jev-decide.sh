#!/usr/bin/env bash

set -euo pipefail

INPUT=""
OUTPUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --input) INPUT="${2:-}"; shift 2 ;;
    --output) OUTPUT="${2:-}"; shift 2 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

if [[ -z "$INPUT" || ! -f "$INPUT" ]]; then
  echo "用法：jev-decide.sh --input <request.json> [--output <response.json>]" >&2
  exit 2
fi

KEY_FILE="${JEV_SSY_KEY_FILE:-$HOME/.jev-claudecode-ssy/api-key}"
if [[ -f "$KEY_FILE" ]]; then
  API_KEY="$(tr -d '\r\n' < "$KEY_FILE")"
elif [[ -n "${SSY_API_KEY:-}" ]]; then
  API_KEY="$SSY_API_KEY"
else
  echo "未找到胜算云 API Key；请重新运行插件的一键安装命令" >&2
  exit 1
fi

if [[ -z "$API_KEY" ]]; then
  echo "胜算云 API Key 为空" >&2
  exit 1
fi

if [[ -n "$OUTPUT" ]]; then
  curl -fsS 'https://router.shengsuanyun.com/api/v1/decisions' \
    -H "Authorization: Bearer $API_KEY" \
    -H 'Content-Type: application/json' \
    --data-binary "@$INPUT" \
    -o "$OUTPUT"
else
  curl -fsS 'https://router.shengsuanyun.com/api/v1/decisions' \
    -H "Authorization: Bearer $API_KEY" \
    -H 'Content-Type: application/json' \
    --data-binary "@$INPUT"
fi

unset API_KEY
