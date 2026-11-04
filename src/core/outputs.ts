import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import type { Context } from './context.ts';
import type { TaskRecord } from './taskstore.ts';
import { inspectReport } from './report-state.ts';
import { recordJournal, readJournal } from './journal.ts';
import { withFileLock } from './file-lock.ts';

export const VERDICTS = ['PASS', 'PARTIAL', 'FAIL', 'BLOCKED'] as const;
export type OutputVerdict = typeof VERDICTS[number];
const ref = z.object({ repo: z.string().min(1), branch: z.string().min(1), sha: z.string().regex(/^[a-f0-9]{7,40}$/i) }).strict();
export const outputsSchema = z.object({
  version: z.literal(1), verdict: z.enum(VERDICTS),
  commits: z.array(ref).default([]),
  integrate: z.array(ref.extend({ note: z.string().optional() })).default([]),
  decisions: z.array(z.string().min(1)).default([]),
  actions: z.array(z.object({ title: z.string().min(1), shell: z.string().min(1) }).strict()).default([]),
  checks: z.array(z.string()).default([]), preview: z.url().optional(), notes: z.array(z.string()).default([]),
}).strict();
export type Outputs = z.infer<typeof outputsSchema>;
export interface OutputData { outputs: Outputs | null; outputs_valid: boolean; outputs_errors: string[] }

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
  const invalid = (message: string): OutputData => ({ outputs: null, outputs_valid: false, outputs_errors: [message] });
  if (blocks.length !== 1) return invalid(blocks.length ? 'multiple agentctl-outputs blocks' : 'missing agentctl-outputs block (schema version: 1)');
  try {
    const parsed = outputsSchema.safeParse(YAML.parse(blocks[0]!, { maxAliasCount: 50 }));
    return parsed.success ? { outputs: parsed.data, outputs_valid: true, outputs_errors: [] } : { outputs: null, outputs_valid: false, outputs_errors: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) };
  } catch (e) { return invalid(`invalid outputs YAML: ${e instanceof Error ? e.message : String(e)}`); }
}

export function outputRepo(record: Pick<TaskRecord, 'repos'>, name: string) {
  const hits = record.repos.filter(r => r.path === name || path.basename(r.path) === name);
  return hits.length === 1 ? hits[0] : undefined;
}

/** Validation observes git; it never fetches, checks out or integrates anything. */
export async function readOutputs(ctx: Context, record: TaskRecord): Promise<OutputData> {
  let data: OutputData;
  try { data = parseOutputs(fs.readFileSync(record.report, 'utf8')); }
  catch { return { outputs: null, outputs_valid: false, outputs_errors: ['no report'] }; }
  if (!data.outputs) return data;
  for (const ref of [...data.outputs.commits, ...data.outputs.integrate]) {
    const repo = outputRepo(record, ref.repo);
    if (!repo) { data.outputs_errors.push(`repo ${ref.repo}: missing or ambiguous in task repos`); continue; }
    const git = async (args: string[]) => ctx.runner.exec('git', ['-C', repo.path, ...args], { readOnly: true });
    if ((await git(['show-ref', '--verify', '--quiet', `refs/heads/${ref.branch}`])).code !== 0) data.outputs_errors.push(`${ref.repo}: branch ${ref.branch} does not exist`);
    if ((await git(['rev-parse', '--verify', '--end-of-options', `${ref.sha}^{commit}`])).code !== 0) data.outputs_errors.push(`${ref.repo}: commit ${ref.sha} does not exist`);
  }
  data.outputs_valid = data.outputs_errors.length === 0;
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
  'Fields: version: 1; verdict: PASS|PARTIAL|FAIL|BLOCKED; commits: [{repo, branch, sha}]; integrate: [{repo, branch, sha, note?}]; decisions: [text]; actions: [{title, shell}]; checks: [text]; preview: URL (optional); notes: [text].',
  'Use existing branches and commit SHAs in the task repositories. Use empty lists for no items; omit unknown preview. These are reported facts and proposed actions; agentctl never executes actions or merges.',
].join('\n');

/** Once per completed report hash, also across hooks and watcher restarts. */
export async function journalOutputs(ctx: Context, record: TaskRecord): Promise<void> {
  if (ctx.runner.dryRun) return;
  const report = inspectReport(ctx.config, record, ctx.runner.now(), !record.attemptId);
  if (!report.ready || !report.signature) return;
  const file = path.join(ctx.config.stateDir, record.window, 'outputs-seen.json');
  await withFileLock(`${file}.lock`, async () => {
    let seen: string[] = [];
    try { seen = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first report */ }
    if (seen.includes(report.signature!)) return;
    const data = await readOutputs(ctx, record);
    // Journal is also the recovery ledger if a process died before writing outputs-seen.
    if (!readJournal(ctx.config, -1).some(e => e.kind === 'report-outputs' && e.task === record.task && e.reportHash === report.signature)) {
      await recordJournal(ctx, { kind: 'report-outputs', task: record.task, reportHash: report.signature, decisions: data.outputs?.decisions ?? [], actions: data.outputs?.actions ?? [], text: data.outputs_valid ? `${record.task}: ${data.outputs!.decisions.length} decisions, ${data.outputs!.actions.length} actions` : `${record.task}: outputs warning: ${data.outputs_errors.join('; ')}` });
    }
    await ctx.runner.writeFile(file, JSON.stringify([...seen, report.signature]));
  });
}

export function aggregateOutputs(items: Array<{ task: string; data: OutputData }>) {
  const integrate = items.flatMap(({ task, data }) => (data.outputs?.integrate ?? []).map(r => ({ ...r, task, duplicate: false, conflict: false })));
  for (const r of integrate) {
    r.duplicate = integrate.some(o => o !== r && o.repo === r.repo && o.branch === r.branch && o.sha === r.sha);
    r.conflict = integrate.some(o => o !== r && o.repo === r.repo && o.branch === r.branch && o.sha !== r.sha);
  }
  return {
    integrate,
    decisions: items.flatMap(({ task, data }) => (data.outputs?.decisions ?? []).map(text => ({ task, text }))),
    actions: items.flatMap(({ task, data }) => (data.outputs?.actions ?? []).map(a => ({ task, ...a }))),
    checks: items.flatMap(({ task, data }) => (data.outputs?.checks ?? []).map(text => ({ task, text }))),
    warnings: items.filter(i => !i.data.outputs_valid).map(({ task, data }) => ({ task, errors: data.outputs_errors })),
  };
}
