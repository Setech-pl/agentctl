import { EFFORTS } from './config.ts';
import type { AgentName, Effort } from './config.ts';
import { Problems, isObject } from './util.ts';

/** An agent setting as the table writes it: `model/effort`. */
export interface ModelEffort {
  model: string;
  effort: Effort;
}

/** A pair of settings considered interchangeable between the two providers. */
export interface Equivalent {
  claude: ModelEffort;
  codex: ModelEffort;
}

/** The order as written in a spec, or the result of translating it. */
export interface Order extends ModelEffort {
  agent: AgentName;
}

/** Built-in table. Fable and effort `max` are deliberately absent: they have no counterpart. */
export const DEFAULT_EQUIVALENTS: { claude: string; codex: string }[] = [
  { claude: 'haiku/low', codex: 'gpt-6-luna/medium' },
  { claude: 'haiku/medium', codex: 'gpt-6-luna/high' },
  { claude: 'sonnet/medium', codex: 'gpt-6.1-sol/medium' },
  { claude: 'sonnet/high', codex: 'gpt-6.1-sol/high' },
  { claude: 'opus/high', codex: 'gpt-6-astra/medium' },
  { claude: 'opus/xhigh', codex: 'gpt-6-astra/xhigh' },
];

export function formatModelEffort(m: ModelEffort): string {
  return `${m.model}/${m.effort}`;
}

/** Parse "model/effort"; the effort is everything after the last slash. */
export function parseModelEffort(value: unknown, where: string, p: Problems): ModelEffort | undefined {
  if (typeof value !== 'string' || !value.includes('/')) {
    p.add(`${where} must look like "model/effort", e.g. "opus/high"`);
    return undefined;
  }
  const cut = value.lastIndexOf('/');
  const model = value.slice(0, cut).trim();
  const effort = value.slice(cut + 1).trim();
  if (!model) {
    p.add(`${where}: the model is empty in ${JSON.stringify(value)}`);
    return undefined;
  }
  if (!(EFFORTS as readonly string[]).includes(effort)) {
    p.add(`${where}: effort must be one of ${EFFORTS.join(', ')} (got ${JSON.stringify(effort)})`);
    return undefined;
  }
  return { model, effort: effort as Effort };
}

export function parseEquivalents(v: unknown, where: string, p: Problems): Equivalent[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    p.add(`${where} must be a list of {claude: "model/effort", codex: "model/effort"} pairs`);
    return [];
  }
  const pairs: Equivalent[] = [];
  v.forEach((entry: unknown, i: number) => {
    const at = `${where}[${i}]`;
    if (!isObject(entry)) return p.add(`${at} must be a {claude, codex} mapping`);
    for (const key of Object.keys(entry)) {
      if (key !== 'claude' && key !== 'codex') p.add(`${at}: unknown key "${key}" (allowed: claude, codex)`);
    }
    const claude = parseModelEffort(entry.claude, `${at}.claude`, p);
    const codex = parseModelEffort(entry.codex, `${at}.codex`, p);
    if (claude && codex) pairs.push({ claude, codex });
  });
  return pairs;
}

export function defaultEquivalents(): Equivalent[] {
  const p = new Problems();
  return parseEquivalents(DEFAULT_EQUIVALENTS, 'DEFAULT_EQUIVALENTS', p);
}

export type Translation = { ok: true; order: Order } | { ok: false; message: string; hint: string };

/**
 * Translate an order to the other provider through the table (it works in both directions;
 * the first pair that matches wins, so user pairs listed first override the defaults).
 */
export function translate(order: Order, target: AgentName, table: Equivalent[]): Translation {
  if (order.agent === target) return { ok: true, order };
  const here = formatModelEffort(order);
  const pair = table.find((e) => formatModelEffort(e[order.agent]) === here);
  if (pair) return { ok: true, order: { agent: target, ...pair[target] } };

  if (order.model === 'fable' || order.effort === 'max') {
    return {
      ok: false,
      message: `${order.agent} ${here} has no equivalent in ${target}: fable and effort max are not mapped between providers`,
      hint: `Run it on ${order.agent} as ordered (pin: true, no --agent), or add a pair you trust to "equivalents" in your config.`,
    };
  }
  const placeholder = '<model>/<effort>';
  const line = order.agent === 'claude' ? `{claude: "${here}", codex: "${placeholder}"}` : `{claude: "${placeholder}", codex: "${here}"}`;
  return {
    ok: false,
    message: `no ${target} equivalent for ${order.agent} ${here}`,
    hint: `Add a line under "equivalents:" in your config (~/.agentctl/config.yaml):\n  - ${line}`,
  };
}
