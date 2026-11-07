import { readReportText } from './report-path.ts';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import type { Context } from './context.ts';
import type { TaskRecord } from './taskstore.ts';
import { inspectReport } from './report-state.ts';
import { recordJournal, readJournal } from './journal.ts';
import { withFileLock } from './file-lock.ts';
import { findRecordAnywhere } from './taskstore.ts';
import { plural, resolvePath } from './util.ts';

const countText = (n: number, one: string, few: string, many: string): string => `${n} ${plural(n, one, few, many)}`;

export const VERDICTS = ['PASS', 'PARTIAL', 'FAIL', 'BLOCKED'] as const;
export type OutputVerdict = typeof VERDICTS[number];
const ref = z.object({ repo: z.string().min(1), branch: z.string().min(1), sha: z.string().regex(/^[a-f0-9]{7,40}$/i) }).strict();
const integrateRef = ref.extend({ note: z.string().optional() });
const decision = z.string().min(1);
const action = z.object({ title: z.string().min(1), shell: z.string().min(1) }).strict();
export const CHECK_RESULTS = ['PASS', 'FAIL', 'WARN', 'SKIP'] as const;
/** One check as the report author may write it; `normalizeCheck` turns every form into `{ name, result?, note? }`. */
const checkInput = z.union([
  z.string().min(1),
  z.object({ name: z.string().min(1), result: z.union([z.string(), z.number(), z.boolean()]).optional(), note: z.string().optional() }).strict(),
  z.record(z.string().min(1), z.union([z.string(), z.number(), z.boolean(), z.null()])).refine(o => Object.keys(o).length === 1, 'a check map has exactly one key: {name: result}'),
]);
export interface Check { name: string; result?: string; note?: string }
export const outputsSchema = z.object({
  version: z.literal(1), verdict: z.enum(VERDICTS),
  commits: z.array(ref).default([]),
  integrate: z.array(integrateRef).default([]),
  decisions: z.array(decision).default([]),
  actions: z.array(action).default([]),
  checks: z.array(checkInput).default([]), preview: z.url().optional(), notes: z.array(z.string()).default([]),
}).strict();
export interface Outputs {
  version: 1; verdict: OutputVerdict;
  commits: z.infer<typeof ref>[]; integrate: z.infer<typeof integrateRef>[];
  decisions: string[]; actions: z.infer<typeof action>[]; checks: Check[];
  preview?: string; notes: string[];
}
/** `outputs_valid`: everything was accepted. `outputs_partial`: `outputs` holds the valid part of a block that had bad entries (listed in `outputs_errors`). */
export interface OutputData { outputs: Outputs | null; outputs_valid: boolean; outputs_errors: string[]; outputs_partial?: boolean; /** The report is not finished yet (no report-end / not settled): the block is not judged. */ outputs_pending?: boolean }

const knownResult = (value: string): string => (CHECK_RESULTS as readonly string[]).includes(value.trim().toUpperCase()) ? value.trim().toUpperCase() : value.trim();
/** A check in any accepted form: text ("unit: PASS"), a one-key map ({unit: PASS}) or {name, result, note}. PASS/FAIL/WARN/SKIP in any letter case. */
export function normalizeCheck(input: z.infer<typeof checkInput>): Check {
  if (typeof input === 'string') {
    const m = /^(.+?)\s*:\s*(pass|fail|warn|skip)\b[\s,;:–—-]*(.*)$/i.exec(input.trim());
    return m ? { name: m[1]!.trim(), result: m[2]!.toUpperCase(), ...(m[3]!.trim() ? { note: m[3]!.trim() } : {}) } : { name: input.trim() };
  }
  const withName = typeof (input as { name?: unknown }).name === 'string';
  if (withName) {
    const { name, result, note } = input as { name: string; result?: string | number | boolean; note?: string };
    return { name: name.trim(), ...(result !== undefined && String(result).trim() ? { result: knownResult(String(result)) } : {}), ...(note ? { note } : {}) };
  }
  const [name, result] = Object.entries(input as Record<string, string | number | boolean | null>)[0]!;
  return { name: name.trim(), ...(result !== null && String(result).trim() ? { result: knownResult(String(result)) } : {}) };
}

const issues = (section: string, index: number | undefined, error: z.ZodError): string[] => error.issues.map(i => `${[section, ...(index === undefined ? [] : [index]), ...i.path].join('.')}: ${i.message}`);
/** Per section, per entry: a bad entry is dropped with a warning, everything else stays. */
function takeList<T>(raw: unknown, section: string, item: z.ZodType<T>, errors: string[]): T[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) { errors.push(`${section}: expected a list`); return []; }
  const kept: T[] = [];
  raw.forEach((entry, index) => {
    const parsed = item.safeParse(entry);
    if (parsed.success) kept.push(parsed.data); else errors.push(...issues(section, index, parsed.error));
  });
  return kept;
}

const OUTPUT_KEYS = ['version', 'verdict', 'commits', 'integrate', 'decisions', 'actions', 'checks', 'preview', 'notes'];

/** Only a top-level fenced block before the report-end directive is report data. */
export function parseOutputs(text: string): OutputData {
  const blocks: string[] = [];
  let fence: string | undefined, lines: string[] = [], target = false;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (!fence && line.trim() === '<!-- agentctl:report-end -->') break;
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence && open) { fence = open[1]!; target = open[2]!.trim() === 'agentctl-outputs'; lines = []; continue; }
    if (fence && new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(line)) {
      if (target) blocks.push(lines.join('\n'));
      fence = undefined; target = false; continue;
    }
    if (fence && target) lines.push(line);
  }
  const invalid = (message: string): OutputData => ({ outputs: null, outputs_valid: false, outputs_errors: [message], outputs_partial: false });
  if (blocks.length !== 1) return invalid(blocks.length ? 'multiple agentctl-outputs blocks' : 'missing agentctl-outputs block (schema version: 1)');
  let data: unknown;
  try { data = YAML.parse(blocks[0]!, { maxAliasCount: 50 }); } catch (e) { return invalid(`invalid outputs YAML: ${e instanceof Error ? e.message : String(e)}`); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return invalid('the agentctl-outputs block must be a YAML mapping');
  const d = data as Record<string, unknown>, errors: string[] = [];
  // Without a known version and verdict nothing can be interpreted (a dependent task gates on the verdict): the block is refused as a whole.
  if (d.version !== 1) errors.push(`version: expected 1, got ${JSON.stringify(d.version)}`);
  const verdict = z.enum(VERDICTS).safeParse(d.verdict);
  if (!verdict.success) errors.push(`verdict: expected one of ${VERDICTS.join(', ')}`);
  if (errors.length) return { outputs: null, outputs_valid: false, outputs_errors: errors, outputs_partial: false };
  for (const key of Object.keys(d)) if (!OUTPUT_KEYS.includes(key)) errors.push(`${key}: unknown field (ignored)`);
  const commits = takeList(d.commits, 'commits', ref, errors), integrate = takeList(d.integrate, 'integrate', integrateRef, errors);
  const decisions = takeList(d.decisions, 'decisions', decision, errors), actions = takeList(d.actions, 'actions', action, errors);
  const checks = takeList(d.checks, 'checks', checkInput, errors).map(normalizeCheck);
  let preview: string | undefined;
  if (d.preview !== undefined && d.preview !== null) { const u = z.url().safeParse(d.preview); if (u.success) preview = u.data; else errors.push('preview: expected a URL (ignored)'); }
  const notes = takeList(d.notes, 'notes', z.string(), errors);
  const outputs: Outputs = { version: 1, verdict: verdict.data!, commits, integrate, decisions, actions, checks, ...(preview ? { preview } : {}), notes };
  return { outputs, outputs_valid: errors.length === 0, outputs_errors: errors, outputs_partial: errors.length > 0 };
}

const asPath = (value: string): string => { try { return resolvePath(value); } catch { return value; } };
const samePath = (a: string, b: string): boolean => { try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return path.resolve(a) === path.resolve(b); } };

export interface RepoResolution { repo?: TaskRecord['repos'][number]; allowed: string[]; problem?: 'missing' | 'ambiguous' }
/**
 * What the `repo` field of commits/integrate may say: the repo's name (basename of its path), the path of the repository, or the path of
 * the task's worktree (path or directory name). A review may also use the author's worktree, the author's repository path or the author's branch. `allowed` lists
 * every accepted spelling for the error message.
 */
export function resolveOutputRepo(record: Pick<TaskRecord, 'repos'>, name: string, author?: Pick<TaskRecord, 'repos'> | undefined): RepoResolution {
  const ids = new Map<TaskRecord['repos'][number], { names: string[]; paths: string[] }>();
  for (const r of record.repos) ids.set(r, { names: [path.basename(r.path), ...(r.worktree ? [path.basename(r.worktree)] : [])], paths: [r.path, r.worktree] });
  // The author's checkout and branch lead to the reviewer's repo of the same repository.
  for (const a of author?.repos ?? []) {
    const mine = record.repos.find((r) => samePath(r.path, a.path));
    if (!mine) continue;
    const entry = ids.get(mine)!;
    entry.paths.push(a.path, a.worktree);
    if (a.branch) entry.names.push(a.branch);
  }
  const wanted = asPath(name);
  const hits = record.repos.filter((r) => { const id = ids.get(r)!; return id.names.includes(name) || id.paths.some((p) => p === name || (path.isAbsolute(wanted) && samePath(p, wanted))); });
  const allowed = [...new Set([...ids.values()].flatMap((id) => [...id.names, ...id.paths]))];
  if (hits.length === 1) return { repo: hits[0]!, allowed };
  return { allowed, problem: hits.length === 0 ? 'missing' : 'ambiguous' };
}

/** The record a review's repo spellings are read against: its author (current or archived). */
export const outputAuthor = (ctx: Context, record: Pick<TaskRecord, 'reviewOf'>): TaskRecord | undefined => (record.reviewOf ? findRecordAnywhere(ctx.config, record.reviewOf) : undefined);

/** The one canonicalisation of the `repo` of a commit/integrate reference: validation (readOutputs) and base refs resolve it the same way. */
export function resolveRefRepo(ctx: Context, record: TaskRecord, name: string): RepoResolution {
  return resolveOutputRepo(record, name, outputAuthor(ctx, record));
}

export function outputRepo(record: Pick<TaskRecord, 'repos'>, name: string, author?: Pick<TaskRecord, 'repos'> | undefined) {
  return resolveOutputRepo(record, name, author).repo;
}

/** Validation observes git; it never fetches, checks out or integrates anything. */
export async function readOutputs(ctx: Context, record: TaskRecord): Promise<OutputData> {
  // The one gate of every consumer (status, get_report, pull_ready, cohort_show, events, base refs): a report still being written is not judged.
  if (outputsPending(ctx.config, record, inspectReport(ctx.config, record, ctx.runner.now(), !record.attemptId), ctx.runner.now())) return { outputs: null, outputs_valid: false, outputs_errors: [], outputs_partial: false, outputs_pending: true };
  let data: OutputData;
  try { data = parseOutputs(readReportText(ctx.config, record, record.report)); }
  catch { return { outputs: null, outputs_valid: false, outputs_errors: ['no report'] }; }
  if (!data.outputs) return data;
  // One message per distinct problem, with the number of entries it covers.
  const problems = new Map<string, number>();
  const note = (message: string): void => void problems.set(message, (problems.get(message) ?? 0) + 1);
  for (const ref of [...data.outputs.commits, ...data.outputs.integrate]) {
    const found = resolveRefRepo(ctx, record, ref.repo);
    if (!found.repo) { note(`repo ${ref.repo}: ${found.problem === 'ambiguous' ? 'ambiguous' : 'not'} in the task repos; write one of: ${found.allowed.join(', ')}`); continue; }
    const repo = found.repo;
    ref.repo = path.basename(repo.path);
    const git = async (args: string[]) => ctx.runner.exec('git', ['-C', repo.path, ...args], { readOnly: true });
    if ((await git(['show-ref', '--verify', '--quiet', `refs/heads/${ref.branch}`])).code !== 0) note(`${ref.repo}: branch ${ref.branch} does not exist`);
    if ((await git(['rev-parse', '--verify', '--end-of-options', `${ref.sha}^{commit}`])).code !== 0) note(`${ref.repo}: commit ${ref.sha} does not exist`);
  }
  for (const [message, count] of problems) data.outputs_errors.push(count > 1 ? `${message} (${count} entries)` : message);
  data.outputs_valid = data.outputs_errors.length === 0;
  if (!data.outputs_valid) data.outputs_partial = true;
  return data;
}

/** A declared output verdict wins. Legacy fallback accepts an explicit verdict line only. */
export function dependencyVerdict(text: string): OutputVerdict | undefined {
  const outputs = parseOutputs(text).outputs;
  if (outputs) return outputs.verdict;
  const found = /^\s*(?:\*\*)?(?:Werdykt|Verdict):\s*(?:\*\*)?(PASS|PARTIAL|FAIL|BLOCKED)\b/im.exec(text)?.[1];
  return found?.toUpperCase() as OutputVerdict | undefined;
}

export const OUTPUT_PROTOCOL = [
  'Before report-end write exactly one fenced ```agentctl-outputs YAML block (schema version: 1).',
  'Fields: version: 1; verdict: PASS|PARTIAL|FAIL|BLOCKED; commits: [{repo, branch, sha}]; integrate: [{repo, branch, sha, note?}]; decisions: [text]; actions: [{title, shell}]; checks: [{name, result: PASS|FAIL|WARN|SKIP, note?}]; preview: URL (optional); notes: [text].',
  'Write each check as a mapping, for example `- {name: "unit tests", result: PASS}`. A one-key mapping (`- unit tests: PASS`), a plain text and a lower-case result (`pass`) are also accepted and normalized by agentctl; they are not format errors, do not report them as such.',
  '`repo` is the name of the repository: the last part of its path (for example `sandbox` for ~/code/sandbox). The repository path or the path of your worktree are accepted too. Example: `commits: [{repo: sandbox, branch: dev-u1, sha: 3db6b8d}]`. A reviewer writes the repo of the code it reviews the same way.',
  'Use existing branches and commit SHAs in the task repositories. Use empty lists for no items; omit unknown preview. These are reported facts and proposed actions; agentctl never executes actions or merges.',
].join('\n');

/**
 * Outputs are judged only on a finished report of the current attempt: the explicit report-end plus the settle time. Before that the agent is
 * still writing, and "missing block" would be a false alarm. Tasks from before the protocol keep the old rule.
 */
export function outputsPending(config: Pick<Context['config'], 'reportSettleS'>, record: Pick<TaskRecord, 'outputsProtocol'>, report: { sentinel?: boolean; mtime?: number }, nowMs: number): boolean {
  if (!record.outputsProtocol) return false;
  if (!report.sentinel) return true;
  return config.reportSettleS > 0 && report.mtime !== undefined && nowMs - report.mtime < config.reportSettleS * 1000;
}

/** Once per completed report hash, also across hooks and watcher restarts. */
export async function journalOutputs(ctx: Context, record: TaskRecord): Promise<void> {
  if (ctx.runner.dryRun) return;
  const report = inspectReport(ctx.config, record, ctx.runner.now(), !record.attemptId);
  if (!report.ready || !report.signature) return;
  if (outputsPending(ctx.config, record, report, ctx.runner.now())) return;
  const file = path.join(ctx.config.stateDir, record.window, 'outputs-seen.json');
  await withFileLock(`${file}.lock`, async () => {
    let seen: string[] = [];
    try { seen = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first report */ }
    if (seen.includes(report.signature!)) return;
    const data = await readOutputs(ctx, record);
    // A closed task from before the protocol was never asked for the block: its absence is not a warning (a block it has is still journaled).
    if (!record.outputsProtocol && !data.outputs) { await ctx.runner.writeFile(file, JSON.stringify([...seen, report.signature])); return; }
    // Journal is also the recovery ledger if a process died before writing outputs-seen.
    if (!readJournal(ctx.config, -1).some(e => e.kind === 'report-outputs' && e.task === record.task && e.reportHash === report.signature)) {
      await recordJournal(ctx, { kind: 'report-outputs', task: record.task, ...(record.reviewOf ? { reviewOf: record.reviewOf } : {}), reportHash: report.signature, decisions: data.outputs?.decisions ?? [], actions: data.outputs?.actions ?? [], text: data.outputs_valid ? `${record.task}: ${countText(data.outputs!.decisions.length, 'decyzja', 'decyzje', 'decyzji')}, ${countText(data.outputs!.actions.length, 'akcja', 'akcje', 'akcji')}` : `${record.task}: outputs warning: ${data.outputs_errors.join('; ')}` });
    }
    await ctx.runner.writeFile(file, JSON.stringify([...seen, report.signature]));
  });
}

export function aggregateOutputs(items: Array<{ task: string; data: OutputData; reviewOf?: string | null | undefined }>) {
  const source = (task: string): string => (items.find((i) => i.task === task)?.reviewOf ? `przegląd ${task}` : task);
  const integrate = items.flatMap(({ task, data }) => (data.outputs?.integrate ?? []).map(r => ({ ...r, task, duplicate: false, conflict: false })));
  for (const r of integrate) {
    r.duplicate = integrate.some(o => o !== r && o.repo === r.repo && o.branch === r.branch && o.sha === r.sha);
    r.conflict = integrate.some(o => o !== r && o.repo === r.repo && o.branch === r.branch && o.sha !== r.sha);
  }
  return {
    integrate,
    decisions: items.flatMap(({ task, data, reviewOf }) => (data.outputs?.decisions ?? []).map(text => ({ task, text, ...(reviewOf ? { source: source(task), review_of: reviewOf } : {}) }))),
    actions: items.flatMap(({ task, data, reviewOf }) => (data.outputs?.actions ?? []).map(a => ({ task, ...a, ...(reviewOf ? { source: source(task), review_of: reviewOf } : {}) }))),
    checks: items.flatMap(({ task, data }) => (data.outputs?.checks ?? []).map(c => ({ task, ...c, text: c.result ? `${c.name}: ${c.result}${c.note ? ` – ${c.note}` : ''}` : c.name }))),
    warnings: items.filter(i => !i.data.outputs_valid && i.data.outputs_errors.length > 0).map(({ task, data }) => ({ task, errors: data.outputs_errors })),
  };
}
