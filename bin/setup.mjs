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
    ...options,
  });
}

function runClaude(args, label = 'Claude Code command') {
  const result = commandResult(args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? 'unknown'}`);
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

export function pluginInstallArgs(apiKey) {
  return [
    'plugin',
    'install',
    PLUGIN_ID,
    '--scope',
    'user',
    '--config',
    `apiKey=${apiKey}`,
  ];
}

/** Reads a secret from an interactive terminal while echoing only mask characters. */
export function promptSecret({ input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    return Promise.reject(
      new Error('当前环境无法安全输入 API Key；请在 PowerShell、CMD、Bash 或 Zsh 终端中运行安装命令'),
    );
  }

  output.write('请输入胜算云 API Key（输入内容会隐藏，按 Enter 确认）：');
  return new Promise((resolve, reject) => {
    let secret = '';

    const cleanup = () => {
      input.removeListener('data', onData);
      input.setRawMode(false);
      input.pause?.();
    };
    const finish = () => {
      cleanup();
      output.write('\n');
      const value = secret.trim();
      if (!value) reject(new Error('API Key 不能为空'));
      else resolve(value);
    };
    const cancel = () => {
      cleanup();
      output.write('\n');
      reject(new Error('用户取消了安装'));
    };
    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === '\r' || character === '\n') {
          finish();
          return;
        }
        if (character === '\u0003') {
          cancel();
          return;
        }
        if (character === '\u0008' || character === '\u007f') {
          if (secret.length > 0) {
            secret = secret.slice(0, -1);
            output.write('\b \b');
          }
          continue;
        }
        const code = character.codePointAt(0) ?? 0;
        if (code >= 32 && code !== 127 && secret.length < 4096) {
          secret += character;
          output.write('*');
        }
      }
    };

    input.setEncoding?.('utf8');
    input.setRawMode(true);
    input.resume?.();
    input.on('data', onData);
  });
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

  const apiKey = process.env.SSY_API_KEY?.trim() || await promptSecret();

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
    console.log('检测到旧安装，正在重装以写入 API Key…');
    runClaude(['plugin', 'uninstall', PLUGIN_ID, '--scope', 'user'], 'Plugin uninstall');
  }
  console.log('正在安装插件并安全写入 API Key…');
  runClaude(pluginInstallArgs(apiKey), 'Plugin install');

  console.log('\n接入完成。重启 Claude Code，或在当前会话执行 /reload-plugins。');
  console.log('API Key 已由 Claude Code 作为敏感 userConfig 保存，不会写入本项目。');
}

export function printHelp() {
  console.log(`Jev Claude Code · 胜算云版

用法:
  npx --yes github:DM010727/jev-claudecode-ssy

自动检查 Claude Code 版本、启用函数钩子、注册 marketplace 并安装插件。
安装过程中会用掩码提示输入 API Key，并交给 Claude Code 的敏感 userConfig 保存。`);
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
