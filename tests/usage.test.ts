import { describe, expect, it, vi } from 'vitest';
import { compactWithUsage, curlInvocation, register, resolveHookConfig, type HookFetch } from '../hooks/fast-jev.ts';
import { addUsage, BALANCE_URL, balanceDelta, emptyUsage, formatUsageReport, parseBalance } from '../hooks/usage.ts';
import { collectToolCalls, fitState } from '../src/state.js';
import type { Message } from '../src/types.js';

const common = (amount = 10) => JSON.stringify({ success: true, data: {
  gateway_type: 'common', account_balance_cny: amount, voucher_balance_cny: 2,
  gateway_voucher_balance_cny: 3, cash_balance_cny: 8, credit_limit_cny: 100, locked_balance_cny: 0,
} });
const enterprise = (consumed = 1, start = '2026-09-01', unlimited = false) => JSON.stringify({ success: true, data: {
  gateway_type: 'enterprise', scope: 'account_in_project', project_id: 1, ram_user_id: 2,
  budget_kind: 'monthly', period_kind: 'monthly', period_start: start, period_end: '2026-10-01',
  period_consumed_cny: consumed, period_limit_cny: unlimited ? null : 20, unlimited,
} });
const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'test-key' };
function transcript(): Message[] {
  const messages: Message[] = [{ role: 'user', text: 'Fix tests', toolUses: [] }];
  for (let i = 0; i < 2; i++) {
    messages.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: `t${i}`, tool: 'Read', input: { path: 'a.ts' } }] });
    messages.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `t${i}`, text: 'old '.repeat(1000) }] });
  }
  messages.push({ role: 'user', text: 'Continue', toolUses: [] });
  return messages;
}
function answers(body: string, usage: unknown = { input_tokens: 123, output_tokens: 10 }) {
  const questions = JSON.parse(body).questions;
  return JSON.stringify({ answers: Object.fromEntries(Object.keys(questions).map(key => [key, { noul: 0.1 }])), usage });
}
function fakeFetch(options: { balanceFails?: boolean; missingUsage?: boolean } = {}) {
  let balanceCalls = 0;
  return vi.fn<HookFetch>(async (url, init) => {
    if (url === BALANCE_URL) {
      balanceCalls++;
      if (options.balanceFails) throw new Error('balance timeout');
      return { status: 200, ok: true, text: common(balanceCalls === 1 ? 10 : 9.999) };
    }
    return { status: 200, ok: true, text: answers(init!.body!, options.missingUsage ? null : undefined) };
  });
}

describe('reported tokens and balances', () => {
  it('adds real usage and marks missing or invalid counters incomplete', () => {
    const usage = emptyUsage();
    addUsage(usage, '{"usage":{"input_tokens":123,"output_tokens":45}}');
    addUsage(usage, '{"usage":{"input_tokens":0,"output_tokens":0}}');
    addUsage(usage, '{"usage":{"input_tokens":-1,"output_tokens":"99"}}');
    addUsage(usage, '{}');
    addUsage(usage, 'bad json');
    expect(usage).toMatchObject({ inputTokens: 123, outputTokens: 45, reportedRequests: 2 });
  });

  it('does not double-count cash/vouchers or add credit/preauthorizations', () => {
    expect(parseBalance(common())).toEqual({ kind: 'common', amount: 13, locked: 0 });
    expect(balanceDelta(parseBalance(common(10)), parseBalance(common(9)))).toBe(1);
    expect(balanceDelta(parseBalance(common(10)), parseBalance(common(11)))).toBe(-1);
  });

  it('compares enterprise consumption only within the same project and period', () => {
    expect(balanceDelta(parseBalance(enterprise(1)), parseBalance(enterprise(1.5)))).toBe(0.5);
    expect(balanceDelta(parseBalance(enterprise(1)), parseBalance(enterprise(1.5, '2026-10-01')))).toBeUndefined();
    expect(parseBalance(enterprise(1, '2026-09-01', true))).toMatchObject({ consumed: 1, remaining: undefined });
  });

  it('treats failed or incomplete balance responses as unavailable', () => {
    for (const text of ['oops', '{}', '{"success":false}', '{"success":true,"data":{"gateway_type":"common"}}']) {
      expect(parseBalance(text)).toBeUndefined();
    }
  });

  it('uses a short timeout for optional balance queries', () => {
    const invocation = curlInvocation(BALANCE_URL, { timeoutMs: 3000 });
    expect(invocation.stdin).toContain('max-time = 3\n');
    expect(invocation.timeoutMs).toBe(4000);
  });
});

describe('compaction usage report', () => {
  it('reports request/question counts, actual tokens, reduction and qualified money delta', async () => {
    const fetch = fakeFetch();
    const report = await compactWithUsage(transcript(), config, fetch);
    expect(report.applied).toBe(true);
    expect(report.usage).toEqual({ requests: 1, questions: 4, inputTokens: 123, outputTokens: 10, reportedRequests: 1 });
    expect(fetch.mock.calls.map(call => call[0])).toEqual([BALANCE_URL, 'https://router.shengsuanyun.com/api/v1/decisions', BALANCE_URL]);
    const display = formatUsageReport(report);
    expect(display.status).toContain('133 tokens');
    expect(display.lines.join('\n')).toContain('期间模力减少 ¥0.001000（非单次账单）');
    expect(display.lines.join('\n')).toContain('不代表本次 Jev 精确费用');
  });

  it('makes no network calls for no candidates and reports genuine zero usage', async () => {
    const fetch = fakeFetch();
    const report = await compactWithUsage([transcript()[0]!], config, fetch);
    expect(fetch).not.toHaveBeenCalled();
    expect(report.usage.requests).toBe(0);
    expect(report.applied).toBe(false);
    expect(formatUsageReport(report).lines).toContain('模力消耗 0（未调用 Jev）');
  });

  it('keeps the successful compaction when balance queries fail', async () => {
    const report = await compactWithUsage(transcript(), config, fakeFetch({ balanceFails: true }));
    expect(report.applied).toBe(true);
    expect(report.usage.inputTokens).toBe(123);
    expect(formatUsageReport(report).lines).toContain('期间模力变化：暂不可用');
  });

  it('does not present absent usage or unchanged balance as free', async () => {
    const report = await compactWithUsage(transcript(), config, fakeFetch({ missingUsage: true }));
    report.after = report.before;
    expect(formatUsageReport(report).status).toContain('token 未完整返回');
    expect(formatUsageReport(report).lines).toContain('期间模力变化：暂未观测到扣费');
  });

  it('retains tokens when reduction is insufficient and Claude must take over', async () => {
    const report = await compactWithUsage(transcript(), { ...config, minReductionRatio: 1 }, fakeFetch());
    expect(report.applied).toBe(false);
    expect(report.usage.inputTokens).toBe(123);
    expect(formatUsageReport(report).status).toContain('Jev 未接管');
  });

  it('waits for concurrent batches after one fails, counting the late successful usage', async () => {
    const messages = transcript();
    const fitted = fitState(messages, collectToolCalls(messages, 1), { maxStateTokens: 25000, preserveRecentMessages: 1, goal: '' });
    let requests = 0;
    let completePeer: (() => void) | undefined;
    const fetch: HookFetch = async (url, init) => {
      if (url === BALANCE_URL) return { status: 200, ok: true, text: common() };
      requests++;
      if (requests === 1) return { status: 500, ok: false, text: 'down' };
      await new Promise<void>(resolve => { completePeer = resolve; });
      return { status: 200, ok: true, text: answers(init!.body!) };
    };
    let done = false;
    const pending = compactWithUsage(messages, { ...config, maxRequestTokens: fitted.tokens + 150 }, fetch).then(report => { done = true; return report; });
    await vi.waitFor(() => expect(completePeer).toBeTypeOf('function'));
    expect(done).toBe(false);
    completePeer!();
    const report = await pending;
    expect(report.applied).toBe(false);
    expect(report.usage.requests).toBe(2);
    expect(report.usage.inputTokens).toBe(123);
    expect(report.usage.reportedRequests).toBe(1);
  });

  it('registers a details command and publishes the report after fallback finishes', async () => {
    const handlers = new Map<string, (...args: any[]) => any>();
    const on = (event: string, ...args: any[]) => { handlers.set(event, args.at(-1)); };
    register(on as any, { apiKey: 'test-key' });
    const ui = { log: vi.fn(), toast: vi.fn(), status: vi.fn() };
    const host = { ui, command: { register: vi.fn() } };
    await handlers.get('session.start')!(host, {}, async () => ({}));
    expect(host.command.register).toHaveBeenCalledWith(expect.objectContaining({ name: 'jev-usage' }));
    const next = vi.fn(async () => { ui.log.mockClear(); return { messages: [] }; });
    await handlers.get('session.compact')!(host, { messages: [transcript()[0]!] }, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(ui.log).toHaveBeenCalledWith(expect.stringContaining('Jev 请求 0 次'));
    expect(ui.status).toHaveBeenLastCalledWith(expect.stringContaining('/jev-usage'));
    expect(handlers.get('command.run')!().text).toContain('已使用 Claude 内置压缩');
  });

  it('runs the registered hook over the curl transport and pins successful usage', async () => {
    const handlers = new Map<string, (...args: any[]) => any>();
    register(((event: string, ...args: any[]) => { handlers.set(event, args.at(-1)); }) as any, {
      apiKey: 'test-key', preserveRecentMessages: 1,
    });
    const ui = { log: vi.fn(), toast: vi.fn(), status: vi.fn() };
    const run = vi.fn(async (_argv, init) => {
      const text = init.stdin.includes(BALANCE_URL) ? common() : JSON.stringify({
        answers: Object.fromEntries(['call_t1', 'result_t1', 'call_t2', 'result_t2'].map(key => [key, { noul: 0.1 }])),
        usage: { input_tokens: 500, output_tokens: 20 },
      });
      return { exitCode: 0, stdout: `${text}\n__JEV_HTTP_STATUS__:200`, stderr: '' };
    });
    const next = vi.fn();
    const output = await handlers.get('session.compact')!({ ui, process: { run } }, { messages: transcript() }, next);
    expect(next).not.toHaveBeenCalled();
    expect(output.messages).toHaveLength(2);
    expect(run).toHaveBeenCalledTimes(3);
    expect(ui.status).toHaveBeenLastCalledWith(expect.stringContaining('520 tokens'));
    expect(handlers.get('command.run')!().text).toContain('Jev 压缩完成');
  });

  it('does not retry failed built-in compaction or hide the last Jev report', async () => {
    const handlers = new Map<string, (...args: any[]) => any>();
    register(((event: string, ...args: any[]) => { handlers.set(event, args.at(-1)); }) as any, { apiKey: 'test-key' });
    const ui = { log: vi.fn(), toast: vi.fn(), status: vi.fn() };
    const next = vi.fn(async () => { throw new Error('core unavailable'); });
    await expect(handlers.get('session.compact')!({ ui }, { messages: [transcript()[0]!] }, next)).rejects.toThrow('core unavailable');
    expect(next).toHaveBeenCalledTimes(1);
    expect(handlers.get('command.run')!().text).toContain('Claude 内置压缩也未完成');
  });
});
