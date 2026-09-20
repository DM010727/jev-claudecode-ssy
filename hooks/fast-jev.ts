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
export const PLUGIN_VERSION = '1.1.5';

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
  const lines = [
    'silent',
    'show-error',
    `url = ${curlConfigValue(url)}`,
    `request = ${curlConfigValue(init.method ?? 'GET')}`,
    'max-time = 60',
  ];
  for (const [name, value] of Object.entries(init.headers ?? {})) {
    if (/[\r\n]/.test(name)) throw new Error('Jev request header name contains a newline');
    lines.push(`header = ${curlConfigValue(`${name}: ${value}`)}`);
  }
  if (init.body !== undefined) lines.push(`data-binary = ${curlBodyValue(init.body)}`);
  lines.push(`write-out = ${curlBodyValue(`\n${CURL_STATUS_MARKER}%{http_code}`)}`);

  return {
    stdin: `${lines.join('\n')}\n`,
    timeoutMs: 75_000,
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

  on('session.start', ($, event, next) => {
    $.ui.log(startupMessage());
    return next(event);
  });

  on('session.compact', async ($, event, next) => {
    try {
      const envApiKey = configured.apiKey ? undefined : await $.env.get('SSY_API_KEY');
      const settingsApiKey =
        configured.apiKey || envApiKey
          ? undefined
          : apiKeyFromSettings(await $.settings.read());
      const config = { ...configured, apiKey: configured.apiKey ?? envApiKey ?? settingsApiKey };
      const { result, messages } = await compactSession(
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
      for (const line of decisionLogLines(result)) $.ui.log(line);
      if (reductionRatio(result) < config.minReductionRatio) {
        const text = `fallback to built-in summary (below ${percent(config.minReductionRatio)} minimum: ${summarize(result)})`;
        $.ui.log(text);
        $.ui.toast(text, { timeoutMs: 15_000 });
        return next(event);
      }
      const text = `kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result)})`;
      $.ui.log(text);
      $.ui.toast(text, { timeoutMs: 15_000 });
      return { messages };
    } catch (error) {
      const text = `fallback to built-in summary (${error instanceof Error ? error.message : String(error)})`;
      $.ui.log(text);
      $.ui.toast(text, { timeoutMs: 15_000 });
      return next(event);
    }
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
