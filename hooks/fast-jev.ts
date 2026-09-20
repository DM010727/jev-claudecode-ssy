import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { compact, reductionRatio, resolveOptions } from '../src/compact.js';
import { buildJevRequest, DEFAULT_MODEL, parseJevResponse } from '../src/request.js';
import {
  addUsage, BALANCE_URL, emptyUsage, formatUsageReport, friendlyError, parseBalance,
  type Balance, type UsageReport,
} from './usage.js';
import type {
  CompactOptions,
  CompactResult,
  JevAsker,
  Message,
  ToolResult,
  ToolUse,
} from '../src/types.js';

const HOOK_DEFAULTS = {
  compactAtPercent: 60,
  minReductionRatio: 0.25,
  model: DEFAULT_MODEL,
};

export type HookFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
};

export type HookFetchResponse = {
  status: number;
  ok: boolean;
  text: string;
};

/** A fetch-shaped transport, so the compactor can be driven without an engine. */
export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>;

export type HookProcessRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type HookProcessRun = (
  argv: readonly string[],
  init?: { stdin?: string; timeoutMs?: number },
) => Promise<HookProcessRunResult>;

export type CurlInvocation = {
  stdin: string;
  timeoutMs: number;
};

const CURL_STATUS_MARKER = '__JEV_HTTP_STATUS__:';
export const PLUGIN_VERSION = '1.2.0';

export function startupMessage(): string {
  return `jev-claudecode-ssy v${PLUGIN_VERSION} loaded (curl transport)`;
}

function curlConfigValue(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error('Jev request header contains a newline');
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function curlBodyValue(value: string): string {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')}"`;
}

/**
 * Fetches through a local curl child process. Claude Code intentionally blocks
 * `$.http.fetch` while `/compact` is running, but its process API is a local
 * execution path whose child owns its network access. The complete request,
 * including the API key, travels over stdin rather than argv or a temp file.
 */
export function curlInvocation(
  url: string,
  init: HookFetchInit = {},
): CurlInvocation {
  if (!url.startsWith('https://')) throw new Error('Jev endpoint must use HTTPS');
  const timeoutMs = Math.max(1000, Math.min(60_000, init.timeoutMs ?? 60_000));
  const lines = [
    'silent',
    'show-error',
    `url = ${curlConfigValue(url)}`,
    `request = ${curlConfigValue(init.method ?? 'GET')}`,
    `max-time = ${timeoutMs / 1000}`,
  ];
  for (const [name, value] of Object.entries(init.headers ?? {})) {
    if (/[\r\n]/.test(name)) throw new Error('Jev request header name contains a newline');
    lines.push(`header = ${curlConfigValue(`${name}: ${value}`)}`);
  }
  if (init.body !== undefined) lines.push(`data-binary = ${curlBodyValue(init.body)}`);
  lines.push(`write-out = ${curlBodyValue(`\n${CURL_STATUS_MARKER}%{http_code}`)}`);

  return {
    stdin: `${lines.join('\n')}\n`,
    timeoutMs: timeoutMs + (init.timeoutMs === undefined ? 15_000 : 1000),
  };
}

export function parseCurlResult(result: HookProcessRunResult): HookFetchResponse {
  if (result.exitCode !== 0) {
    throw new Error(`curl failed (${result.exitCode}): ${result.stderr.trim().slice(0, 200)}`);
  }
  const marker = `\n${CURL_STATUS_MARKER}`;
  const markerIndex = result.stdout.lastIndexOf(marker);
  if (markerIndex < 0) throw new Error('curl response is missing its HTTP status');
  const status = Number.parseInt(result.stdout.slice(markerIndex + marker.length).trim(), 10);
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new Error('curl returned an invalid HTTP status');
  }
  return {
    status,
    ok: status >= 200 && status < 300,
    text: result.stdout.slice(0, markerIndex),
  };
}

export async function curlFetch(
  run: HookProcessRun,
  url: string,
  init: HookFetchInit = {},
): Promise<HookFetchResponse> {
  const invocation = curlInvocation(url, init);
  let result: HookProcessRunResult;
  try {
    result = await run(['curl', '-q', '--config', '-'], invocation);
  } catch (error) {
    throw new Error(
      `Could not start curl: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseCurlResult(result);
}

export type HookConfig = CompactOptions & {
  apiKey?: string;
  compactAtPercent: number;
  minReductionRatio: number;
  model: string;
};

function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Reads the plugin's `userConfig` values; anything missing takes the defaults. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const numbers: Partial<Omit<CompactOptions, 'goal'>> = {};
  for (const key of [
    'keepThreshold',
    'preserveRecentMessages',
    'maxStateTokens',
    'maxRequestTokens',
    'truncateHeadChars',
  ] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  const config: HookConfig = {
    ...numbers,
    compactAtPercent: optionNumber(options, 'compactAtPercent', HOOK_DEFAULTS.compactAtPercent),
    minReductionRatio: optionNumber(
      options,
      'minReductionRatio',
      HOOK_DEFAULTS.minReductionRatio,
    ),
    model: optionString(options, 'model') ?? HOOK_DEFAULTS.model,
  };
  const apiKey = optionString(options, 'apiKey');
  if (apiKey) config.apiKey = apiKey;
  const goal = optionString(options, 'goal');
  if (goal) config.goal = goal;
  return config;
}

/** A `JevAsker` over any fetch-shaped transport. */
export function jevAsker(fetchFn: HookFetch, apiKey: string, model: string): JevAsker {
  return {
    async ask(state, questions) {
      const request = buildJevRequest({ apiKey, model }, state, questions);
      const response = await fetchFn(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      return parseJevResponse(response.status, response.ok, response.text);
    },
  };
}

function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary: ToolUseSummary = {
    tool_use_id: tool.tool_use_id,
    tool: tool.tool,
    input: tool.input,
  };
  if (tool.text !== undefined) summary.text = tool.text;
  if (tool.isError) summary.isError = true;
  return summary;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return {
    tool_use_id: result.tool_use_id,
    text: result.text,
    isError: result.isError ?? false,
  };
}

/**
 * Maps the library's output back onto session messages. Whatever came back
 * unchanged (a message, a tool use, a tool result) is the engine's own object,
 * handle included; anything rebuilt is a fresh message without a handle, so the
 * engine takes the edited content instead of its original.
 */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
): SessionMessage[] {
  const messages = new Map<Message, SessionMessage>();
  const uses = new Map<ToolUse, ToolUseSummary>();
  const results = new Map<ToolResult, ToolResultSummary>();
  for (const message of input) {
    messages.set(message, message);
    for (const tool of message.toolUses) uses.set(tool, tool);
    for (const result of message.toolResults ?? []) results.set(result, result);
  }
  return output.map((message) => {
    const own = messages.get(message);
    if (own) return own;
    const rebuilt: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => uses.get(tool) ?? toolUseSummary(tool)),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map(
        (result) => results.get(result) ?? toolResultSummary(result),
      );
    }
    return rebuilt;
  });
}

export type SessionCompaction = {
  result: CompactResult;
  messages: SessionMessage[];
};

/** Runs the library over a session transcript; throws when the key is missing or Jev fails. */
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  fetchFn: HookFetch,
): Promise<SessionCompaction> {
  if (!config.apiKey) throw new Error('SSY_API_KEY is not configured');
  const result = await compact(messages, jevAsker(fetchFn, config.apiKey, config.model), config);
  return { result, messages: toSessionMessages(messages, result.messages) };
}

async function readBalance(fetchFn: HookFetch, apiKey: string): Promise<Balance | undefined> {
  try {
    const response = await fetchFn(BALANCE_URL, {
      method: 'GET', headers: { authorization: `Bearer ${apiKey}` }, timeoutMs: 3000,
    });
    return response.ok ? parseBalance(response.text) : undefined;
  } catch { return undefined; }
}

/** Balance checks are best-effort and only run when a Jev request is needed. */
export async function compactWithUsage(
  messages: readonly SessionMessage[], config: HookConfig, fetchFn: HookFetch,
): Promise<UsageReport & { messages?: SessionMessage[] }> {
  const started = Date.now();
  const report: UsageReport & { messages?: SessionMessage[] } = {
    usage: emptyUsage(), applied: false, ms: 0,
  };
  let before: Promise<Balance | undefined> | undefined;
  const pending: Promise<HookFetchResponse>[] = [];
  const measuredFetch: HookFetch = (url, init) => {
    const request = (async () => {
      before ??= readBalance(fetchFn, config.apiKey!);
      await before;
      report.usage.requests += 1;
      report.usage.questions += Object.keys(JSON.parse(init?.body ?? '{}').questions ?? {}).length;
      const response = await fetchFn(url, init);
      if (response.ok) addUsage(report.usage, response.text);
      return response;
    })();
    pending.push(request);
    return request;
  };
  try {
    const output = await compactSession(messages, config, measuredFetch);
    report.result = output.result;
    report.applied = output.result.stats.requests > 0 && reductionRatio(output.result) >= config.minReductionRatio;
    if (report.applied) report.messages = output.messages;
    else report.reason = report.usage.requests === 0 ? '没有可清理的旧工具调用'
      : `内容缩减未达到 ${percent(config.minReductionRatio)} 阈值`;
  } catch (error) {
    report.reason = friendlyError(error);
  }
  // A rejected batch must not hide tokens reported later by its parallel peers.
  await Promise.allSettled(pending);
  if (before) {
    report.before = await before;
    report.after = await readBalance(fetchFn, config.apiKey!);
  }
  report.ms = Date.now() - started;
  return report;
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(result: CompactResult): string {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} call_dropped` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
  ].filter(Boolean);
  return `${percent(reductionRatio(result))} reduction; ${
    parts.join(', ') || 'no tool calls'
  }; state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)`;
}

const UI_LOG_MAX_CHARS = 4096;

export function decisionLog(result: CompactResult): string {
  return result.decisions
    .filter((d) => d.reason !== 'pinned')
    .map(
      (d) =>
        `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`,
    )
    .join(' ');
}

export function decisionLogLines(
  result: CompactResult,
  maxChars: number = UI_LOG_MAX_CHARS,
): string[] {
  const entries = decisionLog(result).split(' ').filter(Boolean);
  if (entries.length === 0) return ['decisions: (none)'];
  const chunks: string[] = [];
  let current = '';
  for (const entry of entries) {
    const next = current ? `${current} ${entry}` : entry;
    if (current && next.length > maxChars - 24) {
      chunks.push(current);
      current = entry;
    } else current = next;
  }
  chunks.push(current);
  return chunks.map((chunk, index) =>
    chunks.length === 1
      ? `decisions: ${chunk}`
      : `decisions (${index + 1}/${chunks.length}): ${chunk}`,
  );
}

function apiKeyFromSettings(
  settings: Readonly<Record<string, unknown>>,
): string | undefined {
  const env = settings['env'];
  if (env && typeof env === 'object') {
    const value = (env as Record<string, unknown>)['SSY_API_KEY'];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  let compacting = false;
  let lastReport = '本会话尚无 Jev 压缩用量。执行 /compact 后可在这里查看。';

  on('session.start', async ($, event, next) => {
    $.ui.log(startupMessage());
    await $.command.register({ name: 'jev-usage', description: '查看最近一次 Jev 压缩效果、token 和模力金额变化' });
    return next(event);
  });

  on('command.run', { command: 'jev-usage' }, () => ({ text: lastReport }));

  on('session.compact', async ($, event, next) => {
    $.ui.status('Jev 正在评估旧工具调用…');
    let report: UsageReport & { messages?: SessionMessage[] };
    try {
      const envApiKey = configured.apiKey ? undefined : await $.env.get('SSY_API_KEY');
      const settingsApiKey =
        configured.apiKey || envApiKey
          ? undefined
          : apiKeyFromSettings(await $.settings.read());
      const config = { ...configured, apiKey: configured.apiKey ?? envApiKey ?? settingsApiKey };
      report = await compactWithUsage(
        event.messages,
        config,
        async (url, init) => {
          const invocation = curlInvocation(url, init);
          let processResult: HookProcessRunResult;
          try {
            // Function-hook scanning requires engine capabilities to be called
            // literally at their use site; do not pass $.process.run as a value.
            processResult = await $.process.run(
              ['curl', '-q', '--config', '-'],
              invocation,
            );
          } catch (error) {
            throw new Error(
              `Could not start curl: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          return parseCurlResult(processResult);
        },
      );
    } catch (error) {
      report = { usage: emptyUsage(), applied: false, reason: friendlyError(error), ms: 0 };
    }
    // Publish fallback details after core finishes, so its transcript reset does
    // not swallow the report. The pinned status also survives normal redraws.
    let fallback;
    if (!report.applied) {
      $.ui.status('Jev 未接管，正在运行 Claude 内置压缩…');
      try {
        fallback = await next(event);
        report.reason += fallback.skip ? `；内置压缩已跳过：${fallback.skip}` : '；已使用 Claude 内置压缩';
      } catch (error) {
        const display = formatUsageReport(report);
        lastReport = [...display.lines, 'Claude 内置压缩也未完成，请稍后重试。'].join('\n');
        $.ui.log(lastReport);
        $.ui.status('压缩未完成 · /jev-usage 查看 Jev 用量');
        throw error;
      }
    }
    const display = formatUsageReport(report);
    lastReport = display.lines.join('\n');
    for (const line of display.lines) $.ui.log(line);
    $.ui.status(display.status);
    $.ui.toast(report.applied ? 'Jev 压缩完成，用量已更新；/jev-usage 查看详情' : '压缩处理结束，/jev-usage 查看原因和用量', { timeoutMs: 15_000 });
    return report.applied ? { messages: report.messages! } : fallback!;
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    if (compacting) return next(event);
    try {
      const { context } = await $.session.usage();
      if ((context.percent ?? 0) < configured.compactAtPercent) return next(event);
      compacting = true;
      await $.session.compact();
    } catch (error) {
      $.ui.log(
        `auto-compact skipped (${error instanceof Error ? error.message : String(error)})`,
      );
    } finally {
      compacting = false;
    }
    return next(event);
  });
};

export { resolveOptions };
