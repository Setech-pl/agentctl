import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Context } from './context.ts';
import { historyPath } from './history.ts';
import { allRecords, collectTaskUsage, openReader } from './usage.ts';
import { archiveDir, readTaskPrompt } from './taskstore.ts';
import type { TaskRecord } from './taskstore.ts';
import { readReportText } from './report-path.ts';
import { inspectReport } from './report-state.ts';
import { dependencyVerdict, readOutputs } from './outputs.ts';
import { secretRedactor } from './secret-redaction.ts';
import { AgentctlError, cohortKey, isObject } from './util.ts';
import { parseAge } from './archive.ts';

export interface DatasetOptions {
  since?: string; until?: string; cohort?: string; agent?: string;
  format?: string; out?: string; includePrompts?: boolean; includeReports?: boolean;
}
type Data = Record<string, unknown>;
interface Summary { data: Data; times: Map<string, number>; events: Set<string>; mark: unknown; markAt: number; sources: Set<string> }
const text = (x: unknown): string | null => typeof x === 'string' && x !== 'unknown' ? x : null;
const number = (x: unknown): number | null => typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null;
const order = (x: unknown, provider?: string | null) => {
  const o = isObject(x) ? x : {};
  return { provider: text(o.agent ?? o.provider ?? provider), model: text(o.model), effort: text(o.effort) };
};
const identity = (o: Data): string => JSON.stringify([o.task, o.started ?? null, o.attempt_id ?? o.attemptId ?? null]);
function add(rows: Map<string, Summary>, key: string, data: Data, source: string): Summary {
  let s = rows.get(key);
  if (!s) { s = { data: {}, times: new Map(), events: new Set(), mark: null, markAt: -Infinity, sources: new Set() }; rows.set(key, s); }
  const at = Date.parse(String(data.at ?? data.started));
  const time = Number.isFinite(at) ? at : -Infinity;
  for (const [k, v] of Object.entries(data)) if (v !== null && v !== undefined && (!s.times.has(k) || time >= s.times.get(k)!)) { s.data[k] = v; s.times.set(k, time); }
  if (typeof data.event === 'string') s.events.add(data.event);
  if (data.event === 'mark' && time >= s.markAt) { s.mark = { result: text(data.result), note: text(data.note), at: text(data.at) }; s.markAt = time; }
  s.sources.add(source);
  return s;
}
/** Incremental JSONL reader: no readFile, split or array of history events. Retains only one summary per attempt. */
export async function* datasetHistory(file: string): AsyncGenerator<Data> {
  if (!fs.existsSync(file)) return;
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const o: unknown = JSON.parse(line);
        if (isObject(o) && (o.v === 1 || o.v === 2) && typeof o.task === 'string' && typeof o.at === 'string') yield o;
      } catch { /* partial or malformed append: ignored, never repaired */ }
    }
  } finally { lines.close(); input.destroy(); }
}
function boundary(input: string | undefined, now: number): number | undefined {
  if (input === undefined) return undefined;
  if (/^\d+(?:s|m|h|d|w)$/.test(input)) return now - parseAge(input);
  const time = Date.parse(input);
  if (!Number.isFinite(time)) throw new AgentctlError(`Invalid dataset time: ${input}`, 'Use an ISO date/time or an age such as 7d.');
  return time;
}

/** Reads state, history and usage without save(), receipt, migration or tmux calls. */
export async function* datasetRecords(ctx: Context, opts: DatasetOptions = {}): AsyncGenerator<Data> {
  const now = ctx.runner.now(), since = boundary(opts.since, now), until = boundary(opts.until, now);
  if (since !== undefined && until !== undefined && since > until) throw new AgentctlError('--since must be before --until');
  const rows = new Map<string, Summary>();
  for await (const h of datasetHistory(historyPath(ctx.config))) {
    const labels = h.v === 1 ? text(h.project) ? [h.project] : [] : Array.isArray(h.repo_labels) ? h.repo_labels : text(h.repo_label) ? [h.repo_label] : [];
    add(rows, identity(h), { ...h, canonical_project: h.v === 2 ? h.project : null, normalized_repo_labels: labels.length ? labels : null }, 'history');
  }
  const records = allRecords(ctx.config);
  // The collector itself is read-only. Do not call taskTokenMap/readPlans or reader.save().
  const usage = collectTaskUsage(ctx.config, openReader(ctx.config), records, now);
  const states = new Map<Summary, TaskRecord>();
  for (const r of records) {
    const candidates = [...rows.values()].filter(s => s.data.task === r.task && (r.attemptId ? (s.data.attempt_id ?? s.data.attemptId) === r.attemptId || (!(s.data.attempt_id ?? s.data.attemptId) && s.data.started === r.started) : s.data.started === r.started));
    // Legacy history never recorded resumes. Do not attach current content to an indistinguishable previous attempt.
    const exact = candidates.find(s => (s.data.attempt_id ?? s.data.attemptId) === r.attemptId && !!r.attemptId);
    const match = exact ?? (r.attempt === undefined || r.attempt <= 1 ? candidates[0] : undefined);
    const d = { task: r.task, started: r.started, attempt_id: r.attemptId, attempt: r.attempt };
    const s = match ?? add(rows, identity(d), d, 'state');
    s.sources.add('state'); states.set(s, r);
  }
  for (const s of rows.values()) {
    const h = s.data, r = states.get(s), u = r ? usage.get(r.task) : undefined;
    const start = r?.attemptStarted ?? text(h.attempt_started) ?? r?.started ?? text(h.started);
    const filterTime = Date.parse(start ?? text(h.at) ?? '');
    if ((since !== undefined && (!Number.isFinite(filterTime) || filterTime < since)) || (until !== undefined && (!Number.isFinite(filterTime) || filterTime > until))) continue;
    const cohort = r?.cohort ?? text(h.cohort);
    if (opts.cohort && (!cohort || cohortKey(cohort) !== cohortKey(opts.cohort))) continue;
    const requested = order(r?.requested ?? h.requested);
    const resolved = order(r ? { agent: r.agent, model: r.model, effort: r.effort } : h.resolved ?? h.effective);
    if (opts.agent && resolved.provider !== opts.agent) continue;
    const observed = order((r?.attempt ?? 1) <= 1 ? u?.observed ?? r?.observed ?? h.observed : r?.observed ?? h.observed, text((isObject(h.observed) ? h.observed : {}).provider));
    // Older observed records carry no provider. A requested/resolved provider is not observation evidence.
    const reportState = r ? inspectReport(ctx.config, r, now, !r.attemptId) : null;
    const outputs = r ? await readOutputs(ctx, r) : null;
    const ended = (reportState?.ready && reportState.mtime !== undefined ? new Date(reportState.mtime).toISOString() : null) ?? text(h.reportAt) ?? r?.cancelledAt ?? text(h.cancelledAt) ?? r?.closedAt ?? text(h.closedAt);
    const duration = start && ended && Date.parse(ended) >= Date.parse(start) ? Date.parse(ended) - Date.parse(start) : number(h.durationMs);
    const attemptNumber = r?.attempt ?? number(h.attempt);
    const tokensSource = (attemptNumber ?? 1) > 1 ? null : isObject(h.tokens) ? h.tokens : r && u && u.sessions > 0 ? u.total : null;
    const t = tokensSource ?? {};
    const prompt = opts.includePrompts && r && (r.attempt ?? 1) <= 1 ? readTaskPrompt(ctx.config, r.window) ?? readTaskPrompt({ ...ctx.config, stateDir: archiveDir(ctx.config) }, r.window) ?? null : null;
    let report: string | null = null;
    if (opts.includeReports && r && reportState?.ready) { try { report = readReportText(ctx.config, r, r.report); } catch { /* unavailable */ } }
    const repoLabels = r?.repos.length ? r.repos.map(repo => path.basename(repo.path)) : (Array.isArray(h.normalized_repo_labels) ? h.normalized_repo_labels : []);
    const row: Data = {
      dataset_schema: 1, instance_id: path.basename(path.dirname(ctx.config.path)), project: text(h.canonical_project),
      task: h.task, attempt_id: r?.attemptId ?? text(h.attempt_id ?? h.attemptId), attempt: r?.attempt ?? number(h.attempt),
      relation: { continues: r?.continues ?? text(h.movedFrom), continued_by: r?.supersededBy ?? text(h.movedTo), review_of: r?.reviewOf ?? text(h.review_of) },
      cohort, repo_label: repoLabels[0] ?? null, repo_labels: repoLabels,
      requested, resolved, observed,
      cli_versions: { agent: text(r?.agentCliVersion ?? h.agent_cli_version ?? ((r?.attempt ?? 1) <= 1 ? u?.observed?.cliVersion : undefined)), agentctl: text(h.agentctl_version) },
      started_at: start, ended_at: ended, duration_ms: duration,
      tokens: { input: number(t.input), output: number(t.output), cache_read: number(t.cacheRead), cache_write: number(t.cacheWrite), reasoning: number(t.reasoning_output_tokens) },
      self_verdict: outputs?.outputs?.verdict ?? text(h.self_verdict) ?? (text(h.verdict) ? dependencyVerdict(`Verdict: ${h.verdict}`) ?? null : null), human_mark: s.mark,
      cancellation: { cancelled: r?.cancelled ?? s.events.has('cancelled'), at: r?.cancelledAt ?? text(h.cancelledAt), reason: r?.cancelReason ?? text(h.cancelReason), source: r?.cancelSource ?? null },
      move: { moved: s.events.has('moved') || !!r?.supersededBy || !!h.movedTo, to: r?.supersededBy ?? text(h.movedTo), switched_by: r?.switchedBy ?? null },
      outputs: { valid: outputs?.outputs_valid ?? null, pending: outputs?.outputs_pending ?? null, errors: outputs?.outputs_errors ?? [], checks: outputs?.outputs?.checks ?? [] },
      commits: outputs?.outputs?.commits ?? [],
      provenance: { sources: [...s.sources], project: text(h.canonical_project) ? 'explicit' : 'unknown', tokens: tokensSource ? isObject(h.tokens) ? 'history' : 'usage' : 'unknown', identity: r?.attemptId || h.attempt_id || h.attemptId ? 'explicit' : 'legacy_task_started', outputs: outputs ? 'report_git_validation' : 'unknown' },
      unknown: [] as string[],
      ...(opts.includePrompts ? { prompt_text: prompt } : {}), ...(opts.includeReports ? { report_text: report } : {}),
    };
    const unknown = row.unknown as string[];
    for (const key of ['project', 'attempt_id', 'attempt', 'started_at', 'ended_at', 'duration_ms', 'self_verdict', 'human_mark']) if (row[key] === null) unknown.push(key);
    for (const [group, data] of Object.entries({ requested, resolved, observed, cli_versions: row.cli_versions as Data, tokens: row.tokens as Data })) for (const [key, v] of Object.entries(data)) if (v === null) unknown.push(`${group}.${key}`);
    if (!r) unknown.push('state_and_content_unavailable');
    if (!row.attempt_id) unknown.push('legacy_attempt_boundaries_unavailable');
    if ((attemptNumber ?? 1) > 1) unknown.push('usage_not_partitioned_by_attempt', 'initial_prompt_not_attempt_specific');
    if (!outputs) unknown.push('outputs', 'commits', 'checks');
    if (!r?.reviewOf && !h.review_of) unknown.push('relation.review_of');
    if (opts.includePrompts && prompt === null) unknown.push('prompt_text');
    if (opts.includeReports && report === null) unknown.push('report_text');
    if (repoLabels.length === 0) unknown.push('repo_labels');
    // Redact text leaves, not field names such as tokens/cache_write (the shared object walker treats those as secrets).
    const strings = (v: unknown): string[] => typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : isObject(v) ? Object.values(v).flatMap(strings) : [];
    const redact = secretRedactor([r?.env ?? {}, prompt, report, strings(row)], new Set([String(h.task)]));
    const clean = (v: unknown): unknown => typeof v === 'string' ? redact(v) : Array.isArray(v) ? v.map(clean) : isObject(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)])) : v;
    yield { ...clean(row) as Data, provenance: row.provenance, unknown: row.unknown };
  }
}

export const CSV_COLUMNS = ['dataset_schema', 'instance_id', 'project', 'task', 'attempt_id', 'attempt', 'cohort', 'repo_label', 'relation.continues', 'relation.continued_by', 'relation.review_of', 'requested.provider', 'requested.model', 'requested.effort', 'resolved.provider', 'resolved.model', 'resolved.effort', 'observed.provider', 'observed.model', 'observed.effort', 'cli_versions.agent', 'cli_versions.agentctl', 'started_at', 'ended_at', 'duration_ms', 'tokens.input', 'tokens.output', 'tokens.cache_read', 'tokens.cache_write', 'tokens.reasoning', 'self_verdict', 'human_mark.result', 'cancellation.cancelled', 'move.moved', 'outputs.valid', 'unknown'];
const csv = (v: unknown): string => v === null || v === undefined ? '' : `"${String(v).replace(/"/g, '""')}"`;
export async function exportDataset(ctx: Context, opts: DatasetOptions, write: (chunk: string) => void | Promise<void>): Promise<void> {
  const format = opts.format ?? 'jsonl';
  if (!['jsonl', 'csv'].includes(format)) throw new AgentctlError('--format must be jsonl or csv');
  if (format === 'csv' && (opts.includePrompts || opts.includeReports)) throw new AgentctlError('CSV is content-free; use JSONL for content');
  // Validate filters before emitting a header.
  const since = boundary(opts.since, ctx.runner.now()), until = boundary(opts.until, ctx.runner.now());
  if (since !== undefined && until !== undefined && since > until) throw new AgentctlError('--since must be before --until');
  await write(format === 'csv' ? `${CSV_COLUMNS.join(',')}\r\n` : `${JSON.stringify({ dataset_schema: 1, type: 'header', content_included: { prompts: !!opts.includePrompts, reports: !!opts.includeReports }, redaction: 'shared secret redactor; review before sharing' })}\n`);
  for await (const row of datasetRecords(ctx, opts)) {
    if (format === 'jsonl') await write(`${JSON.stringify(row)}\n`);
    else await write(`${CSV_COLUMNS.map(key => csv(key.split('.').reduce<unknown>((v, part) => isObject(v) ? v[part] : null, row))).join(',')}\r\n`);
  }
}
