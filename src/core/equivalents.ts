import { DEFAULT_PROVIDERS, PROVIDER_IDS } from './providers/types.ts';
import { deriveEquivalentRows } from './matrix.ts';
import type { EquivalentRow } from './matrix.ts';
import { EFFORTS } from './config.ts';
import type { AgentName, Effort } from './config.ts';
import { Problems, isObject } from './util.ts';

/** An agent setting as the table writes it: `model/effort`. */
export interface ModelEffort {
  model: string;
  effort: Effort;
}

/** A pair of settings considered interchangeable between the providers. */
export interface Equivalent {
  claude: ModelEffort;
  codex: ModelEffort;
  kimi?: ModelEffort;
  class?: 'light' | 'medium' | 'strong';
}

/** The order as written in a spec, or the result of translating it. */
export interface Order extends ModelEffort {
  agent: AgentName;
}

/**
 * The built-in table: derived from data/model-matrix.yaml (src/core/matrix.ts), one row per non-explicit class.
 * Fable and restricted models (gpt-6-astra, k3.1-pro*) are deliberately absent: they have no counterpart.
 */
export function defaultEquivalentRows(): EquivalentRow[] {
  return deriveEquivalentRows();
}

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

export function parseEquivalents(v: unknown, where: string, p: Problems, ids: readonly AgentName[] = DEFAULT_PROVIDERS): Equivalent[] {
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
      if (key !== 'class' && !(ids as readonly string[]).includes(key)) p.add(`${at}: unknown key "${key}" (allowed: ${ids.join(', ')})`);
    }
    const present = ids.filter(id => entry[id] !== undefined);
    const columns = ids.length === 2 ? ids : present;
    if (present.length < 2 && ids.length > 2) p.add(`${at} requires at least two provider columns`);
    if (entry.class !== undefined && !['light', 'medium', 'strong'].includes(String(entry.class))) p.add(`${at}.class must be light, medium or strong`);
    const fields = columns.map(id => [id, parseModelEffort(entry[id], `${at}.${id}`, p)] as const);
    if (fields.every(([, value]) => value)) pairs.push({ ...Object.fromEntries(fields), ...(entry.class ? { class: entry.class } : {}) } as unknown as Equivalent);
  });
  return pairs;
}

export function defaultEquivalents(ids: readonly AgentName[] = DEFAULT_PROVIDERS): Equivalent[] {
  const p = new Problems();
  const table = parseEquivalents(deriveEquivalentRows(), 'DEFAULT_EQUIVALENTS', p, PROVIDER_IDS);
  if (ids.includes('kimi')) return table;
  return table.map((row) => {
    const { kimi: _kimi, ...rest } = row;
    return rest as Equivalent;
  });
}

export type Translation = { ok: true; order: Order } | { ok: false; message: string; hint: string };

/**
 * Translate an order to the other provider through the table (it works in both directions;
 * the first pair that matches wins, so user pairs listed first override the defaults).
 */
export function translate(order: Order, target: AgentName, table: Equivalent[]): Translation {
  if (order.agent === target) return { ok: true, order };
  const here = formatModelEffort(order);
  const pair = table.find((e) => e[order.agent] && e[target] && formatModelEffort(e[order.agent]!) === here);
  if (pair) return { ok: true, order: { agent: target, ...pair[target]! } };

  if (order.model.includes('fable') || order.effort === 'max') {
    return {
      ok: false,
      message: `${order.agent} ${here} has no equivalent in ${target}: fable and effort max are not mapped between providers`,
      hint: `Run it on ${order.agent} as ordered (pin: true, no --agent), or add a pair you trust to "equivalents" in your config.`,
    };
  }
  const placeholder = '<model>/<effort>';
  const line = `{${(target === 'kimi' || order.agent === 'kimi' ? PROVIDER_IDS : DEFAULT_PROVIDERS).map(id => `${id}: "${id === order.agent ? here : placeholder}"`).join(', ')}}`;
  return {
    ok: false,
    message: `no ${target} equivalent for ${order.agent} ${here}`,
    hint: `Add a line under "equivalents:" in your config (~/.agentctl/config.yaml):\n  - ${line}`,
  };
}
