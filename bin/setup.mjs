#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIN_CLAUDE_VERSION = '2.1.274';
export const MARKETPLACE_SOURCE = 'DM010727/jev-claudecode-ssy';
export const MARKETPLACE_NAME = 'jev-claudecode-ssy';
export const PLUGIN_ID = 'jev-claudecode-ssy@jev-claudecode-ssy';

export function extractVersion(text) {
  return text.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
}

export function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function enableFunctionHooks(settings) {
  const source = settings && typeof settings === 'object' && !Array.isArray(settings)
    ? settings
    : {};
  const currentEnv = source.env;
  const env = currentEnv && typeof currentEnv === 'object' && !Array.isArray(currentEnv)
    ? currentEnv
    : {};
  return {
    ...source,
    env: {
      ...env,
      CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1',
    },
  };
}

function commandResult(args, options = {}) {
  return spawnSync('claude', args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    ...options,
  });
}

function runClaude(args) {
  const result = commandResult(args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`claude ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}`);
  }
}

function parseLastJsonLine(text) {
  const lines = text.trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    try {
      return JSON.parse(line);
    } catch {
      // Claude may print a human-readable preamble before the final JSON value.
    }
  }
  return undefined;
}

function claudeJson(args) {
  const result = commandResult([...args, '--json']);
  if (result.error || result.status !== 0) return undefined;
  return parseLastJsonLine(result.stdout ?? '');
}

export function jsonContains(value, needle) {
  if (typeof value === 'string') return value.toLowerCase().includes(needle.toLowerCase());
  if (Array.isArray(value)) return value.some((item) => jsonContains(item, needle));
  if (value && typeof value === 'object') {
    return Object.values(value).some((item) => jsonContains(item, needle));
  }
  return false;
}

export async function configureClaudeSettings(configDir) {
  const directory = configDir || process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude');
  const settingsPath = path.join(directory, 'settings.json');
  await mkdir(directory, { recursive: true });

  let raw;
  let settings = {};
  try {
    raw = await readFile(settingsPath, 'utf8');
    settings = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new Error(`Cannot safely update ${settingsPath}: ${error.message}`);
    }
  }

  const updated = enableFunctionHooks(settings);
  const next = `${JSON.stringify(updated, null, 2)}\n`;
  if (raw === next) return { settingsPath, changed: false };

  if (raw !== undefined) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await copyFile(settingsPath, `${settingsPath}.jev-ssy-${stamp}.bak`);
  }
  await writeFile(settingsPath, next, { encoding: 'utf8', mode: 0o600 });
  return { settingsPath, changed: true };
}

function installedClaudeVersion() {
  const result = commandResult(['--version']);
  if (result.error?.code === 'ENOENT' || result.status !== 0) {
    throw new Error('Claude Code was not found. Install it first: https://claude.ai/install');
  }
  const version = extractVersion(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  if (!version) throw new Error('Could not determine the installed Claude Code version');
  return version;
}

export async function install() {
  console.log('Jev Claude Code · 胜算云版：开始一键接入');

  let version = installedClaudeVersion();
  if (compareVersions(version, MIN_CLAUDE_VERSION) < 0) {
    console.log(`Claude Code ${version} 过旧，正在升级到 ${MIN_CLAUDE_VERSION} 或更高版本…`);
    runClaude(['update']);
    version = installedClaudeVersion();
    if (compareVersions(version, MIN_CLAUDE_VERSION) < 0) {
      throw new Error(`Claude Code 仍为 ${version}；请手动升级到 ${MIN_CLAUDE_VERSION} 或更高版本`);
    }
  }

  const configured = await configureClaudeSettings();
  console.log(`${configured.changed ? '已写入' : '已存在'}函数钩子开关：${configured.settingsPath}`);

  const marketplaces = claudeJson(['plugin', 'marketplace', 'list']);
  if (jsonContains(marketplaces, MARKETPLACE_SOURCE) || jsonContains(marketplaces, MARKETPLACE_NAME)) {
    console.log('正在更新现有 marketplace…');
    runClaude(['plugin', 'marketplace', 'update', MARKETPLACE_NAME]);
  } else {
    console.log('正在注册 marketplace…');
    runClaude(['plugin', 'marketplace', 'add', MARKETPLACE_SOURCE, '--scope', 'user']);
  }

  const plugins = claudeJson(['plugin', 'list']);
  if (jsonContains(plugins, PLUGIN_ID)) {
    console.log('插件已安装，正在更新…');
    runClaude(['plugin', 'update', PLUGIN_ID, '--scope', 'user']);
  } else {
    console.log('正在安装插件；请在提示框中粘贴胜算云 API Key…');
    runClaude(['plugin', 'install', PLUGIN_ID, '--scope', 'user']);
  }

  console.log('\n接入完成。重启 Claude Code，或在当前会话执行 /reload-plugins。');
  console.log('API Key 由 Claude Code 作为敏感 userConfig 保存，不会写入本项目。');
}

export function printHelp() {
  console.log(`Jev Claude Code · 胜算云版

用法:
  npx --yes github:DM010727/jev-claudecode-ssy

自动检查 Claude Code 版本、启用函数钩子、注册 marketplace 并安装插件。
API Key 通过 Claude Code 的敏感 userConfig 输入，不接受命令行明文参数。`);
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
  } else {
    install().catch((error) => {
      console.error(`\n安装失败：${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
  }
}
