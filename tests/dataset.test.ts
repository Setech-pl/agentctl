import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { it } from 'node:test';
import { datasetHistory, datasetRecords, exportDataset, CSV_COLUMNS } from '../src/core/dataset.ts';
import { makeConfig, makeContext, seedTask, useScratch, runCli } from './helpers.ts';
import { historyPath } from '../src/core/history.ts';
import { renderTaskMd, taskFile, archiveDir } from '../src/core/taskstore.ts';
const scratch = useScratch();
const old = { v: 1, event: 'report', task: 'OLD-1', at: '2026-11-02T12:00:00Z', started: '2026-11-01T12:00:00Z', reportAt: '2026-11-02T12:00:00Z', project: 'neon-city', cohort: 'Batch One', requested: { agent: 'codex', model: 'req', effort: 'high' }, effective: { agent: 'codex', model: 'actual', effort: 'medium' }, tokens: { input: 12, output: 8, cacheRead: 4, cacheWrite: 0 }, verdict: 'PASS: old report' };
function setup(name: string, history: unknown[] = [old]) {
  const root = scratch.sub(name), config = makeConfig(root);
  fs.writeFileSync(historyPath(config), history.map(x => JSON.stringify(x)).join('\n') + '\n');
  return { root, config, ...makeContext(config, { startTime: Date.parse('2026-11-05T12:00:00Z'), respond: cmd => { assert.notEqual(cmd, 'tmux'); return {}; } }) };
}
async function output(ctx: ReturnType<typeof setup>['ctx'], opts = {}) { let result = ''; await exportDataset(ctx, opts, chunk => { result += chunk; }); return result; }
// Node 22 has no Array.fromAsync.
async function collect(ctx: ReturnType<typeof setup>['ctx'], opts = {}) { const result: Record<string, any>[] = []; for await (const row of datasetRecords(ctx, opts)) result.push(row); return result; }
function hashes(dir: string): unknown { return fs.readdirSync(dir).sort().map(n => { const p = path.join(dir, n), st = fs.lstatSync(p); return [n, st.isDirectory() ? hashes(p) : createHash('sha256').update(fs.readFileSync(p)).digest('hex'), st.mtimeMs]; }); }
it('old history-only tasks preserve repo labels, null unknowns, tokens and distinct human judgment', async () => {
  const s = setup('old', [old, { ...old, event: 'mark', at: '2026-11-03T00:00:00Z', result: 'fail', note: 'human' }]);
  const [r] = await collect(s.ctx);
  assert.equal(r!.dataset_schema, 1); assert.equal(r!.instance_id, 'home'); assert.equal(r!.project, null); assert.equal(r!.repo_label, 'neon-city');
  assert.equal(r!.provenance.project, 'unknown'); assert.equal(r!.provenance.tokens, 'history'); assert.deepEqual(r!.provenance.sources, ['history']); assert.equal(r!.self_verdict, 'PASS'); assert.equal(r!.human_mark.result, 'fail'); assert.equal(r!.attempt_id, null); assert.equal(r!.tokens.input, 12); assert.equal(r!.tokens.reasoning, null);
  assert.equal(r!.observed.model, null); assert.ok(r!.unknown.includes('state_and_content_unavailable')); assert.ok(!('prompt_text' in r!)); assert.ok(!('report_text' in r!));
});
it('new identities separate attempts and preserve continuation/review, v2 project semantics and unsorted marks', async () => {
  const s = setup('attempts', [
    { ...old, v: 2, project: 'nc', repo_label: 'neon-city', attempt_id: 'one', attempt: 1, review_of: 'AUTHOR', movedFrom: 'PREV' },
    { ...old, attempt_id: 'two', attempt: 2, event: 'cancelled', cancelledAt: '2026-11-03T00:00:00Z', cancelReason: 'stop', observed: { model: 'seen', effort: 'low' } },
    { ...old, attempt_id: 'one', event: 'mark', at: '2026-11-04T00:00:00Z', result: 'ok' },
    { ...old, attempt_id: 'one', event: 'mark', at: '2026-11-03T00:00:00Z', result: 'fail' },
  ]);
  const rs = await collect(s.ctx); assert.equal(rs.length, 2);
  assert.equal(rs[0]!.project, 'nc'); assert.equal(rs[0]!.relation.review_of, 'AUTHOR'); assert.equal(rs[0]!.relation.continues, 'PREV'); assert.equal(rs[0]!.human_mark.result, 'ok');
  assert.equal(rs[1]!.tokens.input, null); assert.ok(rs[1]!.unknown.includes('usage_not_partitioned_by_attempt')); assert.equal(rs[1]!.cancellation.cancelled, true); assert.equal(rs[1]!.observed.model, 'seen'); assert.equal(rs[1]!.observed.provider, null);
});
it('filters use inclusive attempt starts, case-normalized cohorts and resolved provider; reject invalid ranges', async () => {
  const s = setup('filters');
  assert.equal((await collect(s.ctx, { since: old.started, until: old.started, cohort: 'batch one', agent: 'codex' })).length, 1);
  for (const opts of [{ since: '1d' }, { until: '2026-10-01' }, { cohort: 'other' }, { agent: 'kimi' }]) assert.equal((await collect(s.ctx, opts)).length, 0);
  await assert.rejects(output(s.ctx, { since: 'nonsense' }), /Invalid dataset time/);
  await assert.rejects(output(s.ctx, { since: '2026-12-01', until: '2026-10-01' }), /before/);
});
it('content opt-ins redact shared env values, assignments and URL credentials; export never changes files or receipts', async () => {
  const s = setup('content', []);
  const r = seedTask(s.config, 'NEW-1', { attempt: 1, attemptId: 'new-attempt', env: { API_TOKEN: 'env-secret' }, reviewOf: 'AUTHOR', repos: [{ path: path.join(s.root, 'app'), worktree: path.join(s.root, 'wt'), branch: 'task' }] });
  fs.writeFileSync(taskFile(s.config, r.window), renderTaskMd(r, 'Do env-secret. PASSWORD=inline-secret https://user:pass@host/?token=url-secret'));
  fs.mkdirSync(path.dirname(r.report), { recursive: true });
  fs.writeFileSync(r.report, 'Verdict: PASS\n<!-- agentctl:attempt new-attempt -->\n```agentctl-outputs\nversion: 1\nverdict: PASS\nchecks: [{name: unit, result: PASS}]\ncommits: [{repo: app, branch: task, sha: abcdef1}]\n```\nAnswer env-secret\n<!-- agentctl:report-end -->\n');
  const before = hashes(s.root);
  const plain = await output(s.ctx); assert.ok(!plain.includes('Answer')); assert.ok(!plain.includes('prompt_text'));
  const content = await output(s.ctx, { includePrompts: true, includeReports: true });
  for (const secret of ['env-secret', 'inline-secret', 'url-secret', 'user:pass']) assert.ok(!content.includes(secret), secret);
  const lines = content.trim().split('\n').map(l => JSON.parse(l)); assert.equal(lines[0].content_included.prompts, true); assert.equal(lines[0].content_included.reports, true);
  assert.match(lines[1].prompt_text, /Do \*\*\*/); assert.match(lines[1].report_text, /Answer \*\*\*/); assert.equal(lines[1].outputs.valid, true); assert.equal(lines[1].commits[0].sha, 'abcdef1');
  assert.deepEqual(hashes(s.root), before); assert.ok(!s.runner.calls.some(c => c.line.startsWith('tmux ')));
});
it('archived prompts are found and resumed content/usage are never attributed to an old attempt', async () => {
  const s = setup('archive', []), r = seedTask(s.config, 'ARC', { attempt: 2, attemptId: 'second' });
  fs.mkdirSync(archiveDir(s.config)); fs.renameSync(path.dirname(taskFile(s.config, r.window)), path.join(archiveDir(s.config), r.window));
  const [row] = await collect(s.ctx, { includePrompts: true }); assert.equal(row!.prompt_text, null); assert.equal(row!.tokens.input, null); assert.ok(row!.unknown.includes('usage_not_partitioned_by_attempt'));
  const a = seedTask(s.config, 'FIRST', { attempt: 1 }); fs.renameSync(path.dirname(taskFile(s.config, a.window)), path.join(archiveDir(s.config), a.window));
  assert.equal((await collect(s.ctx, { includePrompts: true })).find(r => r.task === 'FIRST')!.prompt_text, 'Do FIRST.');
});
it('large history is consumed incrementally, tolerates malformed tail, and folds without retaining events', async () => {
  const s = setup('stream', []), fd = fs.openSync(historyPath(s.config), 'w');
  for (let i = 0; i < 30000; i++) fs.writeSync(fd, JSON.stringify({ ...old, at: new Date(Date.parse(old.at) + i).toISOString() }) + '\n');
  fs.writeSync(fd, '{broken\n'); fs.closeSync(fd);
  const original = fs.readFileSync;
  fs.readFileSync = ((file: any, ...args: any[]) => { assert.notEqual(String(file), historyPath(s.config), 'history must not use readFileSync'); return (original as any)(file, ...args); }) as typeof fs.readFileSync;
  try { const [r] = await collect(s.ctx); assert.equal(r!.task, 'OLD-1'); } finally { fs.readFileSync = original; }
  const iter = datasetHistory(historyPath(s.config)); assert.equal((await iter.next()).value!.task, 'OLD-1'); await iter.return(undefined);
});
it('CSV has a stable flat content-free summary and RFC4180 quoting; JSONL starts with content header', async () => {
  const s = setup('csv', [{ ...old, cohort: 'quoted,"name"' }]);
  const csv = await output(s.ctx, { format: 'csv' }); assert.equal(csv.split('\r\n')[0], CSV_COLUMNS.join(',')); assert.match(csv, /"quoted,""name"""/); assert.equal(csv.split('\r\n').length, 3); assert.ok(!csv.includes('prompt_text'));
  await assert.rejects(output(s.ctx, { format: 'csv', includeReports: true }), /content-free/); await assert.rejects(output(s.ctx, { format: 'xml' }), /jsonl or csv/);
  assert.equal(JSON.parse((await output(s.ctx)).split('\n')[0]!).content_included.prompts, false);
});
it('CLI never migrates legacy state or overwrites an existing --out file', async () => {
  const s = setup('cli'); const before = hashes(s.root);
  const result = await runCli(s.config, s.runner, ['dataset', 'export']); assert.equal(result.code, 0); assert.match(result.stdout, /dataset_schema/); assert.deepEqual(hashes(s.root), before);
  const result2 = await runCli(s.config, s.runner, ['dataset', 'export', '--out', historyPath(s.config)]); assert.notEqual(result2.code, 0); assert.deepEqual(hashes(s.root), before);
  const out = path.join(s.root, 'export.jsonl'); assert.equal((await runCli(s.config, s.runner, ['dataset', 'export', '--out', out])).code, 0); assert.equal(fs.statSync(out).mode & 0o777, 0o600);
});

it('R2 N2: invalid dataset export options never create an --out file', async () => {
  const s = setup('invalid-out');
  const options = [['--format', 'xml'], ['--since', 'nonsense'], ['--until', 'nonsense'], ['--since', '2026-12-01', '--until', '2026-10-01'], ['--format', 'csv', '--include-reports'], ['--format', 'csv', '--include-prompts']];
  for (const [i, args] of options.entries()) {
    const out = path.join(s.root, `invalid-${i}.jsonl`), before = hashes(s.root);
    const result = await runCli(s.config, s.runner, ['dataset', 'export', '--out', out, ...args]);
    assert.notEqual(result.code, 0, args.join(' '));
    assert.equal(fs.existsSync(out), false, args.join(' '));
    assert.deepEqual(hashes(s.root), before);
  }
});

it('R2 N3: dataset report text redacts bare config-only and process-only secrets', async () => {
  const s = setup('config-secret', []);
  s.config.env.CONFIG_TOKEN = 'dataset-config-only-sentinel';
  const r = seedTask(s.config, 'SECRET', { attempt: 1, attemptId: 'secret-attempt' });
  fs.mkdirSync(path.dirname(r.report), { recursive: true });
  fs.writeFileSync(r.report, 'Verdict: PASS\n<!-- agentctl:attempt secret-attempt -->\nAnswer dataset-config-only-sentinel dataset-process-only-sentinel\n<!-- agentctl:report-end -->\n');
  const previous = process.env.R2_DATASET_SECRET;
  process.env.R2_DATASET_SECRET = 'dataset-process-only-sentinel';
  try {
    const [row] = await collect(s.ctx, { includeReports: true });
    assert.match(row!.report_text, /Answer \*\*\* \*\*\*/);
    assert.doesNotMatch(JSON.stringify(row), /dataset-config-only-sentinel|dataset-process-only-sentinel/);
    assert.deepEqual(row!.tokens, { input: null, output: null, cache_read: null, cache_write: null, reasoning: null });
  } finally { if (previous === undefined) delete process.env.R2_DATASET_SECRET; else process.env.R2_DATASET_SECRET = previous; }
});
