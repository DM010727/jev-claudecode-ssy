#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENDPOINT = 'https://router.shengsuanyun.com/api/v1/decisions';
const DEFAULT_KEY_PATH = path.join(homedir(), '.jev-claudecode-ssy', 'api-key');

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export function validatePayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('请求必须是 JSON object');
  }
  if (!('state' in value)) throw new Error('请求缺少 state');
  if (!value.questions || typeof value.questions !== 'object' || Array.isArray(value.questions)) {
    throw new Error('请求缺少 questions object');
  }
  const count = Object.keys(value.questions).length;
  if (count === 0) throw new Error('questions 不能为空');
  return {
    model: typeof value.model === 'string' && value.model ? value.model : 'jev-latest',
    state: value.state,
    questions: value.questions,
  };
}

export async function loadApiKey(keyPath = process.env.JEV_SSY_KEY_FILE || DEFAULT_KEY_PATH) {
  try {
    const value = (await readFile(keyPath, 'utf8')).trim();
    if (value) return value;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const fromEnvironment = process.env.SSY_API_KEY?.trim();
  if (fromEnvironment) return fromEnvironment;
  throw new Error('未找到胜算云 API Key；请重新运行插件的一键安装命令');
}

export async function decide({ inputPath, outputPath, fetchFn = fetch, keyPath } = {}) {
  if (!inputPath) throw new Error('用法：jev-decide.mjs --input <request.json> [--output <response.json>]');
  const payload = validatePayload(JSON.parse(await readFile(inputPath, 'utf8')));
  const apiKey = await loadApiKey(keyPath);
  const response = await fetchFn(ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Jev 请求失败 (${response.status}): ${text.slice(0, 200)}`);
  const parsed = JSON.parse(text);
  if (!parsed?.answers || typeof parsed.answers !== 'object') {
    throw new Error('Jev 响应缺少 answers');
  }
  const formatted = `${JSON.stringify(parsed, null, 2)}\n`;
  if (outputPath) await writeFile(outputPath, formatted, 'utf8');
  else process.stdout.write(formatted);
  return parsed;
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
  decide({ inputPath: argument('--input'), outputPath: argument('--output') }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
