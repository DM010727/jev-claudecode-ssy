import type { CompactResult } from '../src/types.js';

export const BALANCE_URL = 'https://router.shengsuanyun.com/api/v1/balance';

export interface JevUsage {
  requests: number;
  questions: number;
  inputTokens: number;
  outputTokens: number;
  reportedRequests: number;
}

export function emptyUsage(): JevUsage {
  return { requests: 0, questions: 0, inputTokens: 0, outputTokens: 0, reportedRequests: 0 };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function number(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function tokens(value: unknown): value is number {
  return number(value) && Number.isSafeInteger(value) && value >= 0;
}

/** Count only reported usage, never the compactor's state-size estimate. */
export function addUsage(total: JevUsage, text: string): void {
  try {
    const usage = record(record(JSON.parse(text))?.usage);
    const input = usage?.input_tokens;
    const output = usage?.output_tokens;
    if (tokens(input)) total.inputTokens += input;
    if (tokens(output)) total.outputTokens += output;
    if (tokens(input) && tokens(output)) total.reportedRequests += 1;
  } catch { /* Missing usage is unknown, not zero. */ }
}

export type Balance =
  | { kind: 'common'; amount: number; locked: number }
  | { kind: 'enterprise'; scope: string; consumed: number; remaining?: number };

/** Amounts are CNY as documented; no undocumented "points" conversion. */
export function parseBalance(text: string): Balance | undefined {
  try {
    const body = record(JSON.parse(text));
    const data = record(body?.data);
    if (body?.success !== true || !data) return undefined;
    if (data.gateway_type === 'common') {
      if (!number(data.account_balance_cny) || !number(data.gateway_voucher_balance_cny)
        || !number(data.locked_balance_cny)) return undefined;
      // account_balance already contains the general voucher and cash balances.
      return { kind: 'common', amount: data.account_balance_cny + data.gateway_voucher_balance_cny,
        locked: data.locked_balance_cny };
    }
    if (data.gateway_type === 'enterprise') {
      if (!number(data.period_consumed_cny)) return undefined;
      const scope = [data.scope, data.project_id, data.ram_user_id, data.budget_kind,
        data.period_kind, data.period_start, data.period_end];
      if (scope.some(value => value === undefined || value === null)) return undefined;
      if (data.unlimited !== true && !number(data.period_limit_cny)) return undefined;
      return { kind: 'enterprise', scope: JSON.stringify(scope), consumed: data.period_consumed_cny,
        remaining: data.unlimited === true ? undefined
          : (data.period_limit_cny as number) - data.period_consumed_cny };
    }
  } catch { /* A balance outage must not fail compaction. */ }
  return undefined;
}

export function balanceDelta(before?: Balance, after?: Balance): number | undefined {
  if (before?.kind === 'common' && after?.kind === 'common') {
    return before.amount - after.amount;
  }
  if (before?.kind === 'enterprise' && after?.kind === 'enterprise' && before.scope === after.scope) {
    return after.consumed - before.consumed;
  }
  return undefined;
}

function money(amount: number): string {
  return `¥${amount.toFixed(6)}`;
}

export interface UsageReport {
  usage: JevUsage;
  result?: CompactResult;
  applied: boolean;
  reason?: string;
  before?: Balance;
  after?: Balance;
  ms: number;
}

export function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/SSY_API_KEY/.test(message)) return '未配置胜算云 API Key';
  if (/\b401\b|\b403\b/.test(message)) return 'API Key 无效或无访问权限';
  if (/\b429\b/.test(message)) return '接口限流或额度不足';
  if (/too large|no room/.test(message)) return '待评估内容超过 Jev 请求上限';
  if (/curl|timeout|network/i.test(message)) return '网络连接失败或请求超时';
  return 'Jev 请求失败或返回数据异常';
}

export function formatUsageReport(report: UsageReport): { lines: string[]; status: string } {
  const { usage, result, after } = report;
  const total = usage.inputTokens + usage.outputTokens;
  const complete = usage.reportedRequests === usage.requests;
  const tokenText = complete
    ? `${total} tokens（输入 ${usage.inputTokens} / 输出 ${usage.outputTokens}）`
    : `token 用量未完整返回（已知输入 ${usage.inputTokens} / 输出 ${usage.outputTokens}；完整回报 ${usage.reportedRequests}/${usage.requests} 次）`;
  const delta = balanceDelta(report.before, after);
  const moneyText = usage.requests === 0 ? '模力消耗 0（未调用 Jev）'
    : delta === undefined ? '期间模力变化：暂不可用'
    : delta === 0 ? '期间模力变化：暂未观测到扣费'
    : delta < 0 ? `期间模力余额增加 ${money(-delta)}`
    : `期间模力减少 ${money(delta)}（非单次账单）`;
  const heading = report.applied ? 'Jev 压缩完成 · 保留原始对话'
    : `Jev 未接管 · ${report.reason ?? '改用 Claude 内置压缩'}`;
  const lines = [heading];
  if (report.applied && result) {
    const s = result.stats;
    const ratio = s.charsBefore > 0 ? Math.round((1 - s.charsAfter / s.charsBefore) * 100) : 0;
    lines.push(`消息 ${s.messagesBefore} → ${s.messagesAfter}；内容字符减少 ${ratio}%；移除 ${s.callsDropped} 项工具调用，截短 ${s.resultsDropped} 项结果`);
  }
  lines.push(`Jev 请求 ${usage.requests} 次 · 判断 ${usage.questions} 项 · 耗时 ${(report.ms / 1000).toFixed(1)} 秒`);
  lines.push(`Jev ${tokenText}`, moneyText);
  if (after?.kind === 'common') {
    lines.push(`模力余额 ${money(after.amount)}（账户余额 + 网关券，不含授信）；待扣/预扣 ${money(after.locked)}`);
  } else if (after?.kind === 'enterprise') {
    lines.push(`项目周期消费 ${money(after.consumed)}；剩余预算 ${after.remaining === undefined ? '不限额' : money(after.remaining)}`);
  }
  if (usage.requests > 0) {
    lines.push('模力金额单位为人民币元；余额变化可能包含其他请求、充值和延迟结算，不代表本次 Jev 精确费用。');
  }
  const status = `Jev ${report.applied ? '已压缩' : '未接管'} · ${usage.requests} 次 · ${complete ? `${total} tokens` : 'token 未完整返回'} · ${moneyText} · /jev-usage 查看详情`;
  return { lines, status };
}
