import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import YAML from 'yaml';
import { z } from 'zod';
import { Context } from '../src/core/context.ts';
import { makeConfig, seedTask, useScratch, FakeTmux, DiskRunner, runCli } from './helpers.ts';
import type { ExecOptions, ExecResult } from '../src/core/runner.ts';
import { parseOutputs, readOutputs, aggregateOutputs, dependencyVerdict, journalOutputs } from '../src/core/outputs.ts';
import { collectStatus } from '../src/core/status.ts';
import { splitSpecs, resolveSpec } from '../src/core/spec.ts';
import { unmetAfter, findBlocked, blockedText } from '../src/core/depends.ts';
import { planQueueAdd, commitQueueAdd, readQueue, unblockEntry, describeQueue, queueTick, QueueMemory, renderRawSpec } from '../src/core/queue.ts';
import { enqueuePrompt } from '../src/core/prompt-queue.ts';
import { missingLinkTargets } from '../src/core/links.ts';
import { readTaskRecord, taskFile, setHeaderFields } from '../src/core/taskstore.ts';
import { reviewTick, reviewOrder } from '../src/core/review.ts';
import { resolveTaskBases } from '../src/core/base-ref.ts';
import { readJournal } from '../src/core/journal.ts';
import { collectEvents } from '../src/core/chat-events.ts';
import { limitedTick, limitedRecovered } from '../src/core/limited.ts';
import { collectStatus as status } from '../src/core/status.ts';
import type { PlanState } from '../src/core/usage.ts';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import { touchCohort, cohortTick } from '../src/core/cohort.ts';
import { readHistory } from '../src/core/history.ts';
import { sendPrompts } from '../src/core/send.ts';
import { drainPromptQueue, promptQueueView } from '../src/core/prompt-queue.ts';
import { deliverPendingPrompt, deliveryEvidence, queuePrompt } from '../src/core/prompt-delivery.ts';
import { handleEvent } from '../src/core/event-command.ts';
import { Alerts } from '../src/core/alert.ts';
import { peekTask } from '../src/core/peek.ts';
import { mcpWriteNotice } from '../src/core/mcp-notify.ts';
import { recordStaleCapacity } from '../src/core/capacity-events.ts';
import { newTasks } from '../src/core/new.ts';
import { initialBoardState, applySnapshot, handleKey, promptText, runBoardEffect } from '../src/core/board.ts';
import type { BoardRow } from '../src/core/board.ts';
const scratch = useScratch(), A = 'a'.repeat(40), B = 'b'.repeat(40);
function fixture(name: string, yaml = '', respond?: (cmd: string, args: string[], opts: ExecOptions) => Partial<ExecResult> | undefined) {
  const root = scratch.sub(name), config = makeConfig(root, `capacity: {snapshot: false, codex_refresh: false}\ncohort: {done_grace_s: 0}\nmcp: {allow: [new, queue, mark, hide, unhide, cohort_add, cohort_remove, cohort_note, adopt, notify_test, unblock, gc, archive]}\n${yaml}`);
  const tmux = new FakeTmux();
  const runner = new DiskRunner({ dryRun: false, startTime: Date.now(), respond: (cmd, args, opts) => {
    const custom = respond?.(cmd, args, opts); if (custom) return custom;
    if (cmd === 'git' && args.includes('rev-parse')) return { stdout: `${A}\n` };
    return tmux.respond(cmd, args, opts);
  } });
  const ctx = new Context(runner, config, () => {}), notices: string[] = [];
  const notifier = { notify: async (_title: string, text: string) => { notices.push(text); } };
  const deps = { context: () => ctx, notify: async (text: string) => { notices.push(text); } };
  const call = (name: string, args: Record<string, unknown> = {}) => { const tool = MCP_TOOLS.find(t => t.name === name)!; return tool.run(deps, z.object(tool.input).parse(args)); };
  const full = async (name: string, args: Record<string, unknown> = {}) => {
    let result = await call(name, args), text = result.text;
    while (text.startsWith('{"response_id"')) {
      let page = JSON.parse(text); let all = page.fragment;
      while (page.has_more) { result = await call('response_page', { response_id: page.response_id, response_offset: page.next_response_offset }); page = JSON.parse(result.text); all += page.fragment; }
      text = all;
    }
    return { ...result, text };
  };
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  const raw = (task: string, header: Record<string, unknown> = {}) => splitSpecs(`---\n${YAML.stringify({ task, agent: 'claude', model: 'opus', effort: 'high', repos: [{ path: repo, worktree: `${repo}-${task.toLowerCase()}`, branch: task.toLowerCase(), base: A }], ...header })}---\nImplement ${task}.\n`)[0]!;
  const spec = (task: string, header: Record<string, unknown> = {}) => resolveSpec(raw(task, header), { config });
  return { root, config, tmux, runner, ctx, notices, notifier, deps, call, full, repo, raw, spec };
}
function report(record: ReturnType<typeof seedTask>, outputs?: Record<string, unknown>, extra = '') {
  fs.mkdirSync(path.dirname(record.report), { recursive: true });
  const text = `Werdykt: FAIL\n${extra}\n${outputs ? '```agentctl-outputs\n' + YAML.stringify({ version: 1, verdict: 'PASS', ...outputs }) + '```\n' : ''}<!-- agentctl:report-end -->\n`;
  fs.writeFileSync(record.report, text); return text;
}
const plans = (now: number, used = 100, reset: number | null = now + 60000): Record<'claude' | 'codex', PlanState> => Object.fromEntries(['claude', 'codex'].map(provider => [provider, { provider, available: true, readAt: now, planType: null, windows: [{ kind: 'session', label: '5h', minutes: 300, usedPercent: used, resetsAt: reset }], maxPercent: used, note: '', stale: false }])) as Record<'claude' | 'codex', PlanState>;

describe('0.17.4 outputs are facts, independent of report readiness', () => {
  it('parses schema v1 and exposes validated refs, decisions, actions, checks and preview to every consumer', async () => {
    const f = fixture('outputs'), r = seedTask(f.config, 'T1', { cohort: 'NC', repos: [{ path: f.repo, worktree: `${f.repo}-t1`, branch: 't1' }] });
    report(r, { commits: [{ repo: 'repo', branch: 't1', sha: A }], integrate: [{ repo: 'repo', branch: 't1', sha: A, note: 'proposed' }], decisions: ['Choose deployment time'], actions: [{ title: 'Deploy', shell: 'echo proposed' }], checks: ['unit: PASS'], preview: 'https://example.invalid/demo' });
    const data = await readOutputs(f.ctx, r); assert.equal(data.outputs_valid, true); assert.equal(data.outputs?.verdict, 'PASS');
    const row = (await collectStatus(f.ctx))[0]!; assert.equal(row.report, 'yes'); assert.equal(row.decisionsCount, 1); assert.equal(row.actionsCount, 1); assert.equal(row.verdict, 'PASS');
    assert.match((await f.full('pull_ready')).text, /"outputs_valid":true/);
    assert.match((await f.full('get_report', { task: 'T1' })).text, /"outputs":/);
    const cohort = JSON.parse((await f.full('cohort_show', { cohort: 'NC', format: 'json' })).text); assert.equal(cohort.actions[0].task, 'T1'); assert.equal(cohort.integrate[0].sha, A); assert.equal(cohort.checks[0].task, 'T1');
    assert.equal(f.runner.calls.some(c => /^sh /.test(c.line)), false, 'actions are data, never shell execution');
  });
  for (const [name, text] of [
    ['missing', 'Werdykt: PASS\n'], ['version', '```agentctl-outputs\nversion: 9\nverdict: PASS\n```'],
    ['verdict', '```agentctl-outputs\nversion: 1\nverdict: MAYBE\n```'], ['yaml', '```agentctl-outputs\nverdict: [\n```'],
    ['duplicate', '```agentctl-outputs\nversion: 1\nverdict: PASS\n```\n```agentctl-outputs\nversion: 1\nverdict: PASS\n```'],
    ['after end', '<!-- agentctl:report-end -->\n```agentctl-outputs\nversion: 1\nverdict: PASS\n```'],
    ['nested', '````markdown\n```agentctl-outputs\nversion: 1\nverdict: PASS\n```\n````'],
  ]) it(`warns for ${name}; report remains ready`, async () => {
    const f = fixture(`bad-${name.replaceAll(' ', '-')}`), r = seedTask(f.config, 'T1'); report(r, undefined, text);
    const data = await readOutputs(f.ctx, r); assert.equal(data.outputs_valid, false); assert.ok(data.outputs_errors.length); assert.equal((await status(f.ctx))[0]?.report, 'yes');
  });
  it('rejects nonexistent branches/SHAs and ambiguous repo names without altering the report', async () => {
    const f = fixture('invalid-refs', '', (cmd, args) => cmd === 'git' ? { code: 1 } : undefined);
    const r = seedTask(f.config, 'T1', { repos: [{ path: f.repo, worktree: f.repo }] }); report(r, { commits: [{ repo: 'repo', branch: 'missing', sha: A }, { repo: 'other', branch: 'x', sha: A }] });
    const data = await readOutputs(f.ctx, r); assert.equal(data.outputs_errors.length, 3); assert.equal(data.outputs?.commits.length, 2); assert.equal((await status(f.ctx))[0]?.report, 'yes');
  });
  it('flags duplicate integrate entries and conflicting tips of the same branch with source task IDs', () => {
    const data = (sha: string) => parseOutputs('```agentctl-outputs\n' + YAML.stringify({ version: 1, verdict: 'PASS', integrate: [{ repo: 'app', branch: 'feature', sha }] }) + '```');
    const agg = aggregateOutputs([{ task: 'T1', data: data(A) }, { task: 'T2', data: data(A) }, { task: 'T3', data: data(B) }]);
    assert.equal(agg.integrate[0]?.duplicate, true); assert.ok(agg.integrate.every(r => r.conflict)); assert.equal(agg.integrate[2]?.task, 'T3');
  });
  it('events_since needYou includes new decisions/actions once per report, including after restart', async () => {
    const f = fixture('outputs-events'), r = seedTask(f.config, 'T1'); report(r, { decisions: ['D1'], actions: [{ title: 'A1', shell: 'echo A1' }] });
    const first = await collectEvents(f.ctx, { client: 'nc' }); assert.ok(first.summary.needYou.some(s => s.includes('D1'))); assert.ok(first.summary.needYou.some(s => s.includes('A1')));
    await journalOutputs(f.ctx, r); const second = await collectEvents(f.ctx, { client: 'nc' }); assert.equal(second.summary.needYou.some(s => /D1|A1/.test(s)), false);
    assert.equal(readJournal(f.config).filter(e => e.kind === 'report-outputs').length, 1);
    report(r, { decisions: ['D2'] }); const third = await collectEvents(f.ctx, { client: 'nc' }); assert.ok(third.summary.needYou.some(s => s.includes('D2')));
  });
});

describe('0.17.4 verdict dependencies', () => {
  for (const [verdict, expected] of [['PASS', false], ['PARTIAL', false], ['FAIL', true], ['BLOCKED', true], ['missing', true]] as const) it(`blocks after verdict ${verdict} exactly as specified`, async () => {
    const f = fixture(`after-${verdict}`), author = seedTask(f.config, 'AUTHOR');
    if (verdict === 'missing') { report(author); fs.writeFileSync(author.report, 'No verdict\n<!-- agentctl:report-end -->\n'); }
    else report(author, { verdict });
    const spec = f.spec('NEXT', { after: [{ task: 'AUTHOR', verdict: ['PASS', 'PARTIAL'] }] });
    const plan = await planQueueAdd(f.ctx, [f.raw('NEXT', { after: [{ task: 'AUTHOR', verdict: ['PASS', 'PARTIAL'] }] })]); await commitQueueAdd(f.ctx, plan.items);
    const entries = readQueue(f.config), rows = await status(f.ctx), blocked = findBlocked(entries, rows);
    assert.equal(blocked.has('NEXT'), expected); assert.equal(unmetAfter(spec.after, rows, spec.afterVerdicts).length, expected ? 1 : 0);
    if (expected) { assert.match(blockedText(blocked.get('NEXT')!), verdict === 'missing' ? /brak werdyktu/ : new RegExp(verdict)); const change = await unblockEntry(f.ctx, 'NEXT'); assert.deepEqual(change.dropped, ['AUTHOR']); }
  });
  it('accepts legacy Werdykt line only as fallback and refuses guesses from arbitrary prose', () => {
    assert.equal(dependencyVerdict('Werdykt: PARTIAL – evidence'), 'PARTIAL'); assert.equal(dependencyVerdict('Looks like PASS'), undefined);
    assert.equal(dependencyVerdict('Werdykt: FAIL\n```agentctl-outputs\nversion: 1\nverdict: PASS\n```'), 'PASS');
  });
  it('persists conditions through queue list and explicit unblock without dropping unrelated conditions', async () => {
    const f = fixture('after-unblock'); seedTask(f.config, 'A'); seedTask(f.config, 'B');
    const plan = await planQueueAdd(f.ctx, [f.raw('N', { after: [{ task: 'A', verdict: 'PASS' }, { task: 'B', verdict: 'PARTIAL' }] })]); await commitQueueAdd(f.ctx, plan.items);
    await unblockEntry(f.ctx, 'N', { dropAfter: 'A' }); const entry = readQueue(f.config)[0]!;
    assert.deepEqual(entry.afterVerdicts, { B: ['PARTIAL'] }); assert.deepEqual(resolveSpec(splitSpecs(entry.spec)[0]!, { config: f.config }).afterVerdicts, { B: ['PARTIAL'] });
  });
});

describe('0.17.4 automatic reviews and pinned task bases', () => {
  it('enqueues REV once after a confirmed report with author cohort/branch/base, then REV2 reviews the delta', async () => {
    let tip = A;
    const f = fixture('reviews', '', (cmd, args) => cmd === 'git' && args.includes('refs/heads/author^{commit}') ? { stdout: tip } : undefined);
    const author = seedTask(f.config, 'AUTHOR', { cohort: 'NC', review: { default: 'auto', rerun: true }, repos: [{ path: f.repo, worktree: `${f.repo}-author`, branch: 'author', base: B }] });
    fs.mkdirSync(`${f.repo}-author`); report(author, { verdict: 'PASS' });
    assert.deepEqual(await reviewTick(f.ctx), ['AUTHOR-REV']); assert.deepEqual(await reviewTick(f.ctx), []);
    let entry = readQueue(f.config)[0]!; let spec = resolveSpec(splitSpecs(entry.spec)[0]!, { config: f.config });
    assert.equal(spec.agent, 'codex'); assert.equal(spec.model, 'gpt-6-astra'); assert.equal(spec.effort, 'medium'); assert.equal(spec.cohort, 'NC'); assert.equal(spec.reviewOf, 'AUTHOR'); assert.equal(spec.repos[0]?.branch, undefined, 'detached review checkout, no author branch'); assert.equal(spec.repos[0]?.base, A, 'pinned to the author head'); assert.equal(entry.reuse, undefined); assert.deepEqual(entry.after, ['AUTHOR']);
    tip = B; report(author, { verdict: 'PARTIAL', notes: ['second report'] }); assert.deepEqual(await reviewTick(f.ctx), ['AUTHOR-REV2']);
    entry = readQueue(f.config).find(e => e.task === 'AUTHOR-REV2')!; assert.match(entry.spec, new RegExp(`${A}\\.\\.${B}`));
    assert.equal(readJournal(f.config).filter(e => e.kind === 'review-added').length, 2);
  });
  it('does not review an incomplete report, and rerun defaults off', async () => {
    const f = fixture('review-not-ready'), author = seedTask(f.config, 'A', { review: { default: 'auto' }, repos: [{ path: f.repo, worktree: `${f.repo}-a`, branch: 'a', base: A }], attemptId: 'current', attemptStarted: new Date(Date.now() - 2000).toISOString(), turnEndedAt: undefined });
    fs.mkdirSync(path.dirname(author.report), { recursive: true }); fs.writeFileSync(author.report, 'draft'); assert.deepEqual(await reviewTick(f.ctx), []);
    report(author, {}); assert.deepEqual(await reviewTick(f.ctx), ['A-REV']); report(author, { notes: ['changed'] }); assert.deepEqual(await reviewTick(f.ctx), []);
  });
  it('falls back to another configured model if the other provider is unavailable; no invented default', async () => {
    const f = fixture('review-fallback', '', cmd => cmd === 'codex' ? { code: 1 } : undefined), author = seedTask(f.config, 'A');
    const choice = await reviewOrder(f.ctx, author, {}); assert.equal(choice.order.agent, 'claude'); assert.notEqual(choice.order.model, author.model); assert.match(choice.rule, /unavailable/);
    f.config.equivalents = []; await assert.rejects(reviewOrder(f.ctx, author, {}), /no available different/);
  });
  it('merges project review defaults and explicit settings; false disables inherited auto', () => {
    const f = fixture('review-config'); fs.writeFileSync(path.join(f.repo, '.agentctl.yaml'), 'review: {default: auto, rerun: true, model: gpt-6-astra, effort: high}\n');
    assert.equal(f.spec('A').review?.rerun, true); assert.equal(f.spec('A', { review: false }).review, undefined); assert.equal(f.spec('A', { review: { effort: 'low', prompt_template: 'review.md' } }).review?.effort, 'low');
  });
  it('resolves output SHAs at start and freezes the original reference for TASK.md/preview', async () => {
    const f = fixture('base-output'), author = seedTask(f.config, 'A', { repos: [{ path: f.repo, worktree: f.repo, branch: 'a' }] }); report(author, { commits: [{ repo: 'repo', branch: 'a', sha: B }] });
    const resolved = await resolveTaskBases(f.ctx, f.spec('N', { repos: [{ path: f.repo, worktree: `${f.repo}-n`, base: '@A:repo' }] }));
    assert.equal(resolved.repos[0]?.base, A); assert.equal(resolved.repos[0]?.baseTask, '@A:repo'); assert.ok(f.runner.queries.some(line => line.includes(`${B}^{commit}`)));
  });
  it('uses the author branch HEAD when outputs are absent; blocks ambiguity and missing refs', async () => {
    const f = fixture('base-legacy'); seedTask(f.config, 'A', { repos: [{ path: f.repo, worktree: f.repo, branch: 'a' }] });
    assert.equal((await resolveTaskBases(f.ctx, f.spec('N', { repos: [{ path: f.repo, worktree: `${f.repo}-n`, base: '@A' }] }))).repos[0]?.base, A);
    assert.ok(f.runner.queries.some(line => line.includes('refs/heads/a^{commit}')));
    await assert.rejects(resolveTaskBases(f.ctx, f.spec('N', { repos: [{ path: f.repo, worktree: `${f.repo}-n`, base: '@MISSING' }] })), /no task/);
    seedTask(f.config, 'MULTI', { repos: [{ path: f.repo, worktree: f.repo }, { path: `${f.repo}2`, worktree: `${f.repo}2` }] });
    await assert.rejects(resolveTaskBases(f.ctx, f.spec('N', { repos: [{ path: f.repo, worktree: `${f.repo}-n`, base: '@MULTI' }] })), /ambiguous/);
  });
});

describe('0.17.4 limited recovery', () => {
  it('notifies once per provider episode, resumes safely after recovery, and persists retries across restarts', async () => {
    const f = fixture('limited'); const pane = f.tmux.add('t1', "You've hit your session limit\n❯ \n"); seedTask(f.config, 'T1', { windowId: pane.id });
    let reading = plans(f.runner.now()); let rows = await status(f.ctx); await limitedTick(f.ctx, rows, f.notifier, reading); await limitedTick(f.ctx, rows, f.notifier, reading);
    assert.equal(f.notices.length, 1); assert.match(f.notices[0]!, /claude: limit wyczerpany – zresetuj lub poczekaj do/); assert.equal(f.runner.calls.filter(c => c.line.startsWith('tmux paste-buffer')).length, 0);
    await f.runner.sleep(1000); reading = plans(f.runner.now(), 94); await limitedTick(f.ctx, rows, f.notifier, reading);
    assert.equal(f.runner.calls.filter(c => c.line.startsWith('tmux paste-buffer')).length, 1); assert.equal(readTaskRecord(f.config, 't1')?.agent, 'claude'); assert.equal(readTaskRecord(f.config, 't1')?.model, 'opus');
    await limitedTick(f.ctx, rows, f.notifier, reading); assert.equal(f.runner.calls.filter(c => c.line.startsWith('tmux paste-buffer')).length, 1);
    await f.runner.sleep(301000); await limitedTick(f.ctx, rows, f.notifier, plans(f.runner.now(), 94)); const state = JSON.parse(fs.readFileSync(path.join(path.dirname(f.config.path), 'limited-retries.json'), 'utf8')); assert.equal(state.claude.tasks.T1.attempts, 2);
  });
  for (const mode of ['draft', 'busy', 'question', 'trust', 'report', 'disabled'] as const) it(`does not resume ${mode}`, async () => {
    const f = fixture(`limited-${mode}`), pane = f.tmux.add('t1', "You've hit your session limit\n❯ \n"), r = seedTask(f.config, 'T1', { windowId: pane.id });
    await limitedTick(f.ctx, await status(f.ctx), f.notifier, plans(f.runner.now(), 100, f.runner.now() + 100)); await f.runner.sleep(200);
    if (mode === 'draft') pane.screen = "You've hit your session limit\n❯ my unsent draft\n";
    if (mode === 'busy') pane.screen = 'Working (esc to interrupt)\n❯ \n';
    if (mode === 'question') pane.screen = 'Waiting for your answer\n› \n';
    if (mode === 'trust') pane.screen = 'Yes, I trust this folder\n❯ \n';
    if (mode === 'report') report(r, {});
    if (mode === 'disabled') f.config.limited.autoResume = false;
    await limitedTick(f.ctx, await status(f.ctx), f.notifier, plans(f.runner.now(), 90)); assert.equal(f.runner.calls.filter(c => c.line.startsWith('tmux paste-buffer')).length, 0);
  });
  it('requires remaining above the threshold or an actual known reset; n/d and stale percentages never guess recovery', () => {
    const f = fixture('limited-threshold'), now = f.runner.now(), episode = { since: now, reset: null };
    assert.equal(limitedRecovered(f.ctx, plans(now, 95).claude, episode), false); assert.equal(limitedRecovered(f.ctx, plans(now, 94).claude, episode), true);
    assert.equal(limitedRecovered(f.ctx, { ...plans(now, 1).claude, stale: true }, episode), false); assert.equal(limitedRecovered(f.ctx, { ...plans(now).claude, available: false, maxPercent: null }, episode), false);
    assert.equal(limitedRecovered(f.ctx, plans(now).claude, { since: now, reset: now - 1 }), true);
  });
});

describe('0.17.4 shared preview scope, marks and GC suggestion', () => {
  it('independent preview tokens survive another preview and cannot confirm another operation', async () => {
    const f = fixture('tokens'); seedTask(f.config, 'T1'); seedTask(f.config, 'T2');
    const p1 = await f.full('hide', { tasks: ['T1'] }), p2 = await f.full('hide', { tasks: ['T2'] });
    const t1 = /preview_token: ([\da-f-]+)/.exec(p1.text)![1], t2 = /preview_token: ([\da-f-]+)/.exec(p2.text)![1]; assert.notEqual(t1, t2);
    assert.equal((await f.full('hide', { tasks: ['T1'], preview_token: t1, confirm: true })).isError, undefined);
    assert.equal((await f.full('hide', { tasks: ['T2'], preview_token: t2, confirm: true })).isError, undefined);
    assert.equal(readTaskRecord(f.config, 't1')?.hidden, true); assert.equal(readTaskRecord(f.config, 't2')?.hidden, true);
  });
  it('hide orphan and adopt existing metadata fail already in preview; cohort, notify and adopt previews are concrete', async () => {
    const f = fixture('preview-errors'); f.tmux.add('orphan', '❯ \n'); assert.equal((await f.full('hide', { tasks: ['ORPHAN'] })).isError, true);
    seedTask(f.config, 'T1'); assert.equal((await f.full('adopt', { task: 'T1', report: '/unneeded' })).isError, true);
    const adopt = await f.full('adopt', { task: 'NEW', report: path.join(f.root, 'NEW.md') }); assert.match(adopt.text, /NEW/);
    const cohort = await f.full('cohort_add', { tasks: ['T1'], cohort: 'NC' }); assert.match(cohort.text, /T1/); assert.match(cohort.text, /NC/);
    const notify = await f.full('notify_test'); assert.match(notify.text, /desktop/);
  });
  it('batch mark cohort range equals preview; membership changes reject confirmation, single mark remains immediate', async () => {
    const f = fixture('mark-scope'); for (const task of ['T1', 'T2']) seedTask(f.config, task, { cohort: task === 'T1' ? 'Nc' : 'NC' }); seedTask(f.config, 'OTHER', { cohort: 'other' });
    assert.equal((await f.call('mark', { cohort: 'nc', result: 'ok', confirm: true })).isError, true); assert.equal(readHistory(f.config).length, 0);
    const preview = await f.full('mark', { cohort: 'nc', result: 'ok' }); assert.ok(preview.text.includes('T1') && preview.text.includes('T2') && !preview.text.includes('OTHER')); assert.equal(readHistory(f.config).length, 0);
    assert.ok(!(await f.full('mark', { cohort: 'nc', result: 'ok', confirm: true })).isError); assert.deepEqual(readHistory(f.config).filter(h => h.event === 'mark').map(h => h.task).sort(), ['T1', 'T2']);
    await f.full('mark', { cohort: 'nc', result: 'fail' }); seedTask(f.config, 'LATE', { cohort: 'nc' }); assert.equal((await f.full('mark', { cohort: 'nc', result: 'fail', confirm: true })).isError, true);
    assert.ok(!(await f.full('mark', { task: 'OTHER', result: 'partial' })).isError);
  });
  it('CLI cohort mark previews then --yes records precisely the listed IDs and note', async () => {
    const f = fixture('mark-cli'); seedTask(f.config, 'T1', { cohort: 'NC' }); seedTask(f.config, 'T2', { cohort: 'NC' });
    const preview = await runCli(f.config, f.runner, ['mark', '--cohort', 'NC', 'ok', '--note', 'reviewed']); assert.equal(preview.code, 0); assert.match(preview.stdout, /Not executed/); assert.equal(readHistory(f.config).length, 0);
    const done = await runCli(f.config, f.runner, ['mark', '--cohort', 'NC', 'ok', '--note', 'reviewed', '--yes']); assert.equal(done.code, 0, done.stderr); assert.equal(readHistory(f.config).length, 2); assert.ok(readHistory(f.config).every(h => h.note === 'reviewed'));
  });
  it('board cohort o/p/f preview concrete task IDs before marking', async () => {
    const f = fixture('mark-board'); seedTask(f.config, 'T1', { cohort: 'NC' }); seedTask(f.config, 'T2', { cohort: 'NC' });
    const rows = (await status(f.ctx)).map(r => ({ ...r, worktrees: [] })) as BoardRow[];
    const state = { ...applySnapshot(initialBoardState(160, 40), { rows, preview: null, refreshedAt: 'now' }), cohortFilter: 'NC' };
    const asked = handleKey(state, 'o', {}); assert.equal(asked.effects.length, 0); assert.match(promptText(asked.state)!, /T1, T2 ok/);
    const yes = handleKey(asked.state, 'y', {}); assert.equal(yes.effects[0]?.type, 'mark-cohort'); await runBoardEffect(f.runner, f.config, yes.effects[0]!, { insideTmux: false }); assert.equal(readHistory(f.config).length, 2);
  });
  it('unblock preview names blocked state and dependencies, while GC suggests once after all cohort tasks close', async () => {
    const f = fixture('gc-suggest'); await touchCohort(f.ctx, 'NC'); seedTask(f.config, 'A', { cohort: 'NC', cancelled: true });
    const plan = await planQueueAdd(f.ctx, [f.raw('N', { after: ['A'], cohort: 'NC' })]).catch(() => undefined); assert.equal(plan, undefined, 'cancelled dependency rejected by queue validation');
    seedTask(f.config, 'A', { cohort: 'NC' }); const queue = await planQueueAdd(f.ctx, [f.raw('N', { after: ['A'], cohort: 'NC' })]); await commitQueueAdd(f.ctx, queue.items); await setHeaderFields(f.runner, taskFile(f.config, 'a'), { cancelled: true });
    const preview = await f.full('unblock', { task: 'N' }); assert.match(preview.text, /"state": "blocked"/); assert.match(preview.text, /"A"/);
    // Queue remains, so the cohort cannot be closed yet.
    await cohortTick(f.ctx, f.notifier, await status(f.ctx)); assert.equal(readJournal(f.config).filter(e => e.kind === 'gc_suggest').length, 0);
    fs.rmSync(path.join(path.dirname(f.config.path), 'queue'), { recursive: true });
    await cohortTick(f.ctx, f.notifier, await status(f.ctx)); await cohortTick(f.ctx, f.notifier, await status(f.ctx));
    const suggestions = readJournal(f.config).filter(e => e.kind === 'gc_suggest'); assert.equal(suggestions.length, 1); assert.ok(suggestions[0]?.gc_preview); assert.ok(fs.existsSync(taskFile(f.config, 'a')));
  });
});

describe('0.17.4 delivery evidence and FIFO', () => {
  for (const agent of ['claude', 'codex'] as const) it(`${agent}: send during work pastes immediately, confirms from echo/queue, and never rejects a second send`, async () => {
    let pasted = '', submitted = false;
    const f = fixture(`busy-${agent}`, '', (cmd, args, opts) => {
      if (cmd !== 'tmux') return;
      if (args[0] === 'load-buffer') pasted = opts.input?.toString() ?? '';
      if (args[0] === 'send-keys' && args.at(-1) === 'Enter' && pasted) submitted = true;
      if (args[0] === 'capture-pane') return { stdout: `Working (esc to interrupt)\n${submitted ? `Queued follow-up inputs\n${pasted}\n` : ''}${agent === 'claude' ? '❯' : '›'} \n` };
    });
    const pane = f.tmux.add('t1'); seedTask(f.config, 'T1', { agent, windowId: pane.id });
    let result = await sendPrompts(f.ctx, [{ task: 'T1', window: 't1', prompt: 'FIRST' }]); assert.match(result[0]!.message, /wklejono/); assert.equal(result[0]!.warning, undefined);
    submitted = false; result = await sendPrompts(f.ctx, [{ task: 'T1', window: 't1', prompt: 'SECOND' }]); assert.equal(result[0]!.warning, undefined); assert.equal(f.runner.calls.filter(c => c.line.startsWith('tmux paste-buffer')).length, 2);
  });
  it('an idle-only adapter keeps durable FIFO, visible in status/peek, then drains without losing or duplicating prompts', async () => {
    const f = fixture('fifo'); f.config.agents.claude.acceptsBusyPrompt = false; const pane = f.tmux.add('t1', 'Working (esc to interrupt)\n❯ \n'); seedTask(f.config, 'T1', { windowId: pane.id });
    const first = await sendPrompts(f.ctx, [{ task: 'T1', window: 't1', prompt: 'FIRST' }]), second = await sendPrompts(f.ctx, [{ task: 'T1', window: 't1', prompt: 'SECOND' }]);
    assert.match(first[0]!.message, /w kolejce 1/); assert.match(second[0]!.message, /w kolejce 2/); assert.equal((await status(f.ctx))[0]!.promptQueue?.length, 2); assert.equal((await peekTask(f.ctx, 'T1')).promptQueue?.length, 2);
    assert.equal(f.runner.calls.filter(c => c.line.startsWith('tmux paste-buffer')).length, 0);
    pane.screen = '❯ Try "fake"\n'; await drainPromptQueue(f.ctx, 't1'); await drainPromptQueue(f.ctx, 't1');
    assert.deepEqual(f.runner.calls.filter(c => c.line.startsWith('tmux load-buffer')).map(c => c.input), ['FIRST', 'SECOND']); assert.equal(promptQueueView(f.ctx, 't1').length, 0);
  });
  it('stuck draft + idle_prompt/Stop cannot confirm delivery; a matching submit still requires the composer to clear', async () => {
    let screen = '❯ STUCK\n'; const f = fixture('idle-evidence', '', (cmd, args) => cmd === 'tmux' && args[0] === 'capture-pane' ? { stdout: screen } : undefined);
    const pane = f.tmux.add('t1'); seedTask(f.config, 'T1', { windowId: pane.id }); await queuePrompt(f.ctx, readTaskRecord(f.config, 't1')!, 'STUCK'); await setHeaderFields(f.runner, taskFile(f.config, 't1'), { delivery_started_at: new Date(f.runner.now()).toISOString(), prompt_delivery: 'confirming' });
    const alerts = new Alerts(f.ctx, f.notifier);
    await handleEvent(f.ctx, alerts, { task: 'T1', agent: 'claude', kind: 'notification', payload: { notification_type: 'idle_prompt' } });
    await handleEvent(f.ctx, alerts, { task: 'T1', agent: 'claude', kind: 'stop', payload: {} });
    assert.equal(deliveryEvidence(f.ctx, readTaskRecord(f.config, 't1')!, screen), false);
    assert.equal(deliveryEvidence(f.ctx, { ...readTaskRecord(f.config, 't1')!, deliveryId: undefined }, '❯ \n'), false, 'legacy idle/Stop event is not submission evidence either');
    await f.runner.sleep(61000); assert.equal(await deliverPendingPrompt(f.ctx, 't1'), 'needs-attention');
    await handleEvent(f.ctx, alerts, { task: 'T1', agent: 'claude', kind: 'user-prompt-submit', payload: { prompt: 'STUCK' } }); assert.equal(deliveryEvidence(f.ctx, readTaskRecord(f.config, 't1')!, screen), false);
    screen = '❯ \n'; assert.equal(await deliverPendingPrompt(f.ctx, 't1'), 'sent');
  });
});

describe('0.17.4 timing, stale readings, notifications and response limits', () => {
  it('counts checkout/setup in task duration: 116 s setup + 19 s agent = 135 s, not 19 s', async () => {
    let runner: DiskRunner;
    const f = fixture('duration', '', (cmd, args) => {
      if (cmd === 'sh') { void runner.sleep(116000); return { code: 0 }; }
    }); runner = f.runner;
    await newTasks(f.ctx, [f.spec('T1', { setup: ['fixture-setup'] })]); await runner.sleep(19000);
    assert.equal((await status(f.ctx))[0]!.duration, '2m 15s');
  });
  it('stale reading is announced once for its identity despite temporary inactivity, again for a new reading', async () => {
    const f = fixture('stale'); const pane = f.tmux.add('t1'); seedTask(f.config, 'T1', { windowId: pane.id }); const p = plans(f.runner.now() - 3600000);
    await recordStaleCapacity(f.ctx, p); f.tmux.windows = []; await recordStaleCapacity(f.ctx, p); f.tmux.windows = [pane]; await recordStaleCapacity(f.ctx, p);
    assert.equal(readJournal(f.config).filter(e => e.text.includes('plan reading stale')).length, 1);
    p.claude.readAt! += 1; await recordStaleCapacity(f.ctx, p); assert.equal(readJournal(f.config).filter(e => e.text.includes('plan reading stale')).length, 2);
  });
  it('summary notifications combine writes at most once per 60 s and retain pending writes over restart; all/off are explicit', async () => {
    const f = fixture('notices'), send = async (text: string) => { f.notices.push(text); };
    await mcpWriteNotice(f.ctx, send, 'one'); await mcpWriteNotice(f.ctx, send, 'two'); await mcpWriteNotice(f.ctx, send, 'three'); assert.equal(f.notices.length, 1);
    await f.runner.sleep(60000); await mcpWriteNotice(f.ctx, send); assert.equal(f.notices.length, 2); assert.match(f.notices[1]!, /two; three.*2 operacji/);
    f.config.notify.mcpWrites = 'off'; await mcpWriteNotice(f.ctx, send, 'off'); assert.equal(f.notices.length, 2);
    f.config.notify.mcpWrites = 'all'; await mcpWriteNotice(f.ctx, send, 'all1'); await mcpWriteNotice(f.ctx, send, 'all2'); assert.equal(f.notices.length, 4);
  });
  it('outputs, cohort aggregates, get_report and previews respect even the 1 KiB MCP budget via continuations', async () => {
    const f = fixture('bound'); f.config.mcp.maxResponseKb = 1;
    const r = seedTask(f.config, 'T1', { cohort: 'NC' }); report(r, { decisions: Array.from({ length: 40 }, (_, i) => `${i} ${'detail '.repeat(30)}`) });
    for (const [tool, args] of [['get_report', { task: 'T1' }], ['pull_ready', {}], ['cohort_show', { cohort: 'NC', format: 'json' }], ['hide', { tasks: ['T1'] }]] as const) {
      const result = await f.call(tool, args); assert.ok(Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: result.text }], ...(result.isError ? { isError: true } : {}) })) <= 1024, tool);
    }
  });
});

it('verdict blocker for AUTHOR remains readable through MCP redaction, including a paused queue', async () => {
  const f = fixture('author-redaction'); f.config.queue.enabled = false;
  const r = seedTask(f.config, 'AUTHOR'); report(r, { verdict: 'PASS' });
  const plan = await planQueueAdd(f.ctx, [f.raw('NEXT', { after: [{ task: 'AUTHOR', verdict: 'FAIL' }] })]); await commitQueueAdd(f.ctx, plan.items);
  const text = (await f.full('queue_list')).text; assert.match(text, /AUTHOR: werdykt PASS; wymagany FAIL/);
  const json = (await f.full('queue_show', { task: 'NEXT' })).text; assert.match(json, /"AUTHOR":/); assert.match(json, /"FAIL"/);
});

it('batch tasks mark previews the resolved IDs and records exactly that set', async () => {
  const f = fixture('mark-tasks'); for (const task of ['A', 'B', 'C']) seedTask(f.config, task);
  const args = { tasks: ['a', 'b'], result: 'partial' }; const preview = await f.full('mark', args);
  assert.match(preview.text, /"task": "A"/); assert.match(preview.text, /"task": "B"/); assert.doesNotMatch(preview.text, /"task": "C"/);
  assert.equal(readHistory(f.config).length, 0); assert.ok(!(await f.full('mark', { ...args, confirm: true })).isError);
  assert.deepEqual(readHistory(f.config).map(r => r.task).sort(), ['A', 'B']);
});

it('batch mark previews expose affected records without disclosing their environment values', async () => {
  const f = fixture('mark-secret'); for (const task of ['A', 'B']) seedTask(f.config, task, { env: { TOKEN: 'private-value-123' } });
  const preview = await f.full('mark', { tasks: ['A', 'B'], result: 'ok' }); assert.ok(!preview.isError, preview.text); assert.doesNotMatch(preview.text, /private-value-123/); assert.match(preview.text, /"task": "A"/);
});

it('automatic review is atomically queued with reuse/provenance; a colliding manual review ID is never adopted', async () => {
  const f = fixture('review-collision'); const r = seedTask(f.config, 'AUTHOR', { review: { default: 'auto' }, repos: [{ path: f.repo, worktree: `${f.repo}-author`, branch: 'author', base: A }] }); report(r, {});
  seedTask(f.config, 'AUTHOR-REV', { reviewOf: 'AUTHOR' }); assert.deepEqual(await reviewTick(f.ctx), []);
  assert.ok(readJournal(f.config).some(e => e.text.includes('already exists and is not this automatic review'))); assert.equal(readQueue(f.config).length, 0);
  fs.rmSync(path.dirname(taskFile(f.config, 'author-rev')), { recursive: true }); await reviewTick(f.ctx);
  const entry = readQueue(f.config)[0]!; assert.equal(entry.reuse, undefined); assert.equal(entry.autoReview?.author, 'AUTHOR'); assert.ok(entry.autoReview?.hash);
});

describe('0.17.4 fix 1: automatic review runs in its own checkout, after the author is quiet', () => {
  const authorFixture = (name: string, yaml = 'block', respond?: Parameters<typeof fixture>[2]) => {
    const f = fixture(name, yaml === 'block' ? '' : yaml, respond); if (yaml === 'block') f.config.limits.codex = 0;
    const author = seedTask(f.config, 'AUTHOR', { cohort: 'NC', review: { default: 'auto' }, repos: [{ path: f.repo, worktree: `${f.repo}-author`, branch: 'author', base: B }] });
    fs.mkdirSync(`${f.repo}-author`); f.tmux.add('author', '❯ \n'); report(author, { verdict: 'PASS' });
    const tick = async () => { const memory = new QueueMemory(); const began = await queueTick(f.ctx, memory, { clickable: false, notify: async () => {} }, {}); await memory.idle(); return { began, memory }; };
    const view = async () => { const rows = await collectStatus(f.ctx, { progress: false, archived: true }); return describeQueue(f.config, readQueue(f.config), [], rows, f.runner.now()); };
    return { f, author, tick, view };
  };

  it('B1: the review gets its own detached worktree, branch-less, no reuse, and its own canonical report path', async () => {
    const { f } = authorFixture('b1-own');
    assert.deepEqual(await reviewTick(f.ctx), ['AUTHOR-REV']);
    const entry = readQueue(f.config)[0]!, spec = resolveSpec(splitSpecs(entry.spec)[0]!, { config: f.config });
    assert.equal(spec.repos[0]!.worktree, `${f.root}/repo-author-rev`); assert.notEqual(spec.repos[0]!.worktree, `${f.repo}-author`);
    assert.equal(spec.repos[0]!.branch, undefined); assert.equal(spec.repos[0]!.base, A); assert.equal(entry.reuse, undefined);
    assert.equal(spec.report, path.join(f.config.cache, 'author-rev', 'AUTHOR-REV.md')); assert.match(entry.spec, /report:/);
    assert.ok(spec.prompt.includes(`${f.root}/repo-author-rev`), 'the prompt names the reviewer checkout'); assert.equal(entry.autoReview?.heads[f.repo], A);
  });

  it('B1: a repo pair gets one own checkout per repository', async () => {
    const f = fixture('b1-pair'); f.config.limits.codex = 0; const second = path.join(f.root, 'client'); fs.mkdirSync(second);
    const author = seedTask(f.config, 'PAIR', { review: { default: 'auto' }, repos: [{ path: f.repo, worktree: `${f.repo}-pair`, branch: 'pair', base: B }, { path: second, worktree: `${second}-pair`, branch: 'pair', base: B }] });
    fs.mkdirSync(`${f.repo}-pair`); fs.mkdirSync(`${second}-pair`); report(author, {});
    assert.deepEqual(await reviewTick(f.ctx), ['PAIR-REV']);
    const spec = resolveSpec(splitSpecs(readQueue(f.config)[0]!.spec)[0]!, { config: f.config });
    assert.deepEqual(spec.repos.map(r => r.worktree), [`${f.root}/repo-pair-rev`, `${f.root}/client-pair-rev`]); assert.ok(spec.repos.every(r => r.branch === undefined));
  });

  it('B1: the review waits for an author with a follow-up in flight (not failed), then starts', async () => {
    const { f, tick, view } = authorFixture('b1-wait', 'limits: {codex: 1}\n');
    await reviewTick(f.ctx); await enqueuePrompt(f.ctx, 'author', 'F1: dopisz raport');
    const waiting = (await view())[0]!; assert.equal(waiting.condition.kind, 'after'); assert.match(waiting.condition.text, /czeka na autora AUTHOR.*follow-up/);
    assert.deepEqual((await tick()).began, []); assert.equal(readQueue(f.config)[0]!.status, 'queued'); assert.equal(readQueue(f.config)[0]!.attempts, undefined);
    fs.rmSync(path.join(f.config.stateDir, 'author', 'prompt-queue.json')); assert.equal((await view())[0]!.condition.kind, 'ready');
    assert.deepEqual((await tick()).began, ['AUTHOR-REV']);
  });

  it('B1: a report that settles later and an author git process keep the review waiting', async () => {
    const { f, author, tick, view } = authorFixture('b1-settle', 'limits: {codex: 1}\nreport: {settle_s: 3600}\n');
    await reviewTick(f.ctx); fs.utimesSync(author.report, new Date(), new Date());
    assert.match((await view())[0]!.condition.text, /raport ustala się/);
    f.config.reportSettleS = 0; assert.equal((await view())[0]!.condition.kind, 'ready');
    const busy = authorFixture('b1-git', 'limits: {codex: 1}\n', (cmd, args) => cmd === 'ps' ? { stdout: ` 4242 git -C ${path.join(scratch.dir, 'b1-git', 'repo-author')} status\n` } : undefined);
    await reviewTick(busy.f.ctx); assert.deepEqual((await busy.tick()).began, []); assert.equal(readQueue(busy.f.config)[0]!.status, 'queued'); void tick;
  });

  it('B1: a new author commit after queueing re-pins the review to the new SHA (delta and heads), ledger follows', async () => {
    let tip = A;
    const { f, tick } = authorFixture('b1-repin', 'block', (cmd, args) => cmd === 'git' && args.includes('refs/heads/author^{commit}') ? { stdout: tip } : undefined);
    await reviewTick(f.ctx); tip = B;
    await tick();
    const entry = readQueue(f.config)[0]!, spec = resolveSpec(splitSpecs(entry.spec)[0]!, { config: f.config });
    assert.equal(spec.repos[0]!.base, B); assert.equal(entry.autoReview!.heads[f.repo], B); assert.match(spec.prompt, new RegExp(`${A}\\.\\.${B}`)); assert.ok(!spec.prompt.includes(`${A}..${A}`));
    assert.ok(readJournal(f.config).some(e => e.kind === 'review-repinned'));
    const ledger = JSON.parse(fs.readFileSync(path.join(path.dirname(f.config.path), 'auto-reviews.json'), 'utf8')); assert.equal(ledger.AUTHOR[0].heads[f.repo], B);
  });

  it('B1: an entry queued by the previous build (author worktree, branch, reuse) is converted to the own-checkout layout', async () => {
    const { f, tick } = authorFixture('b1-legacy', 'block');
    const raw = f.raw('AUTHOR-REV', { agent: 'codex', model: 'gpt-6-astra', effort: 'medium', review_of: 'AUTHOR', review: false, after: ['AUTHOR'], repos: [{ path: f.repo, worktree: `${f.repo}-author`, branch: 'author', base: B }] });
    const spec = resolveSpec(raw, { config: f.config });
    await commitQueueAdd(f.ctx, [{ raw, spec }], { reuse: true, autoReview: { author: 'AUTHOR', hash: 'h', heads: { [f.repo]: A } } });
    await tick();
    const entry = readQueue(f.config)[0]!, migrated = resolveSpec(splitSpecs(entry.spec)[0]!, { config: f.config });
    assert.equal(entry.reuse, undefined); assert.equal(migrated.repos[0]!.branch, undefined); assert.equal(migrated.repos[0]!.worktree, `${f.root}/repo-author-rev`); assert.equal(migrated.repos[0]!.base, A);
    assert.equal(entry.autoReview!.bases?.[f.repo], B);
  });

  it('B1: "unsafe start residue" on a review start is transient and retried, not failed', async () => {
    const { f, tick } = authorFixture('b1-transient', 'limits: {codex: 1}\n', (cmd, args) => cmd === 'git' && args.includes('worktree') && args.includes('add') ? { code: 1, stderr: 'unsafe start residue: x: task/git process still running in checkout' } : undefined);
    await reviewTick(f.ctx); assert.deepEqual((await tick()).began, ['AUTHOR-REV']);
    const entry = readQueue(f.config)[0]!; assert.equal(entry.status, 'queued'); assert.ok(entry.retryAt); assert.equal(entry.attempts![0]!.transient, true);
  });
});


// The block of ~/Projects/cache-dev/dev-u1/DEV-U1.md (UAT of 0.17.4), verbatim.
const DEV_U1_REPORT = `Werdykt: PASS

Utworzono \`uat/u1.txt\` z treścią \`hello from DEV-U1\` i zapisano commit \`3db6b8d\` na gałęzi \`dev-u1\` w repozytorium \`sandbox\`.

<!-- agentctl:attempt 66eb0549-7646-456f-b716-2e08216fc6b2 -->

\`\`\`agentctl-outputs
version: 1
verdict: PASS
commits:
  - repo: sandbox
    branch: dev-u1
    sha: 3db6b8d
integrate:
  - repo: sandbox
    branch: dev-u1
    sha: 3db6b8d
    note: do scalenia testowego
decisions:
  - Czy scalić dev-u1 do main?
actions:
  - title: Scal testowo
    shell: git merge dev-u1
checks:
  - plik istnieje: PASS
\`\`\`

<!-- agentctl:report-end -->
`;

describe('0.17.4 fix 1: outputs are validated per section and entry (B2)', () => {
  const block = (yaml: string) => `\`\`\`agentctl-outputs\nversion: 1\nverdict: PASS\n${yaml}\`\`\`\n<!-- agentctl:report-end -->\n`;
  it('B2: the DEV-U1 fixture keeps decisions=1, actions=1, checks=1 and is valid; checks are normalized', async () => {
    const parsed = parseOutputs(DEV_U1_REPORT);
    assert.equal(parsed.outputs_valid, true, parsed.outputs_errors.join('; ')); assert.deepEqual(parsed.outputs_errors, []);
    assert.equal(parsed.outputs!.decisions.length, 1); assert.equal(parsed.outputs!.actions.length, 1);
    assert.deepEqual(parsed.outputs!.checks, [{ name: 'plik istnieje', result: 'PASS' }]);
    const f = fixture('b2-status'); const repo = path.join(f.root, 'sandbox'); fs.mkdirSync(repo);
    const r = seedTask(f.config, 'DEVU1', { repos: [{ path: repo, worktree: `${repo}-wt`, branch: 'dev-u1', base: A }], attemptId: '66eb0549-7646-456f-b716-2e08216fc6b2' });
    fs.mkdirSync(path.dirname(r.report), { recursive: true }); fs.writeFileSync(r.report, DEV_U1_REPORT);
    const row = (await collectStatus(f.ctx, { progress: false })).find(x => x.task === 'DEVU1')!;
    assert.equal(row.decisionsCount, 1); assert.equal(row.actionsCount, 1); assert.equal(row.outputs?.checks.length, 1); assert.equal(row.outputs_valid, true);
    const total = aggregateOutputs([{ task: 'DEVU1', data: row as never }]); assert.equal(total.decisions.length, 1); assert.equal(total.actions.length, 1); assert.equal(total.checks.length, 1); assert.deepEqual(total.warnings, []);
  });
  it('B2: all three forms of a check, any letter case of the result, are accepted and normalized', () => {
    const p = parseOutputs(block('checks:\n  - "unit: pass"\n  - build: Fail\n  - {name: lint, result: warn, note: 2 warnings}\n  - "plain text without result"\n  - {smoke: skip}\n'));
    assert.equal(p.outputs_valid, true, p.outputs_errors.join('; '));
    assert.deepEqual(p.outputs!.checks, [{ name: 'unit', result: 'PASS' }, { name: 'build', result: 'FAIL' }, { name: 'lint', result: 'WARN', note: '2 warnings' }, { name: 'plain text without result' }, { name: 'smoke', result: 'SKIP' }]);
  });
  it('B2: one bad entry is dropped with a warning; the other sections and entries stay; partial is reported', () => {
    const p = parseOutputs(block('commits:\n  - {repo: r, branch: b, sha: nothex}\n  - {repo: r, branch: b, sha: abcdef1}\ndecisions: [ok decision, 7]\nactions:\n  - {title: A, shell: echo}\n  - {title: no shell}\nchecks:\n  - {a: 1, b: 2}\n  - fine: PASS\nmystery: 1\n'));
    assert.equal(p.outputs_valid, false); assert.equal(p.outputs_partial, true); assert.ok(p.outputs);
    assert.equal(p.outputs!.commits.length, 1); assert.deepEqual(p.outputs!.decisions, ['ok decision']); assert.equal(p.outputs!.actions.length, 1); assert.deepEqual(p.outputs!.checks, [{ name: 'fine', result: 'PASS' }]);
    assert.deepEqual(p.outputs_errors.map(e => e.split(':')[0]), ['mystery', 'commits.0.sha', 'decisions.1', 'actions.1.shell', 'checks.0']);
  });
  it('B2: a missing version or verdict still refuses the whole block, and a missing block says so', () => {
    assert.equal(parseOutputs('```agentctl-outputs\nversion: 2\nverdict: PASS\n```\n').outputs, null);
    assert.equal(parseOutputs('```agentctl-outputs\nversion: 1\nverdict: MAYBE\n```\n').outputs, null);
    assert.match(parseOutputs('nothing').outputs_errors[0]!, /missing agentctl-outputs/);
  });
});

describe('0.17.4 fix 1: queue preview identity ignores mutable start state (P13)', () => {
  const queueSpec = (f: ReturnType<typeof fixture>, task: string, header = '') => `---\ntask: ${task}\nagent: claude\nmodel: opus\neffort: high\npin: true\n${header}repos:\n  - path: ${f.repo}\n    worktree: ${f.repo}-${task.toLowerCase()}\n    branch: ${task.toLowerCase()}\n    base: ${A}\n---\nDo ${task}.\n`;
  const token = (text: string) => /preview_token: ([\da-f-]+)/.exec(text)![1];
  it('P13: pin + satisfied after: preview then confirm queues the task', async () => {
    const f = fixture('p13-met'); report(seedTask(f.config, 'DONE', {}), {});
    const spec = queueSpec(f, 'NEXT', 'after: DONE\n'); const p = await f.full('queue', { spec }); assert.ok(!p.isError, p.text);
    const c = await f.full('queue', { spec, confirm: true, preview_token: token(p.text) }); assert.ok(!c.isError, c.text); assert.equal(readQueue(f.config).length, 1);
  });
  it('P13: pin + unmet after queues too', async () => {
    const f = fixture('p13-unmet'); seedTask(f.config, 'WAIT', {});
    const spec = queueSpec(f, 'NEXT', 'after: WAIT\n'); const p = await f.full('queue', { spec });
    const c = await f.full('queue', { spec, confirm: true, preview_token: token(p.text) }); assert.ok(!c.isError, c.text); assert.equal(readQueue(f.config)[0]!.task, 'NEXT');
  });
  it('P13: the after becomes satisfied between preview and confirm (start state flips from waiting to ready) and confirm still holds', async () => {
    const f = fixture('p13-flip'); const dep = seedTask(f.config, 'DEP', {});
    const spec = queueSpec(f, 'NEXT', 'after: DEP\n'); const p = await f.full('queue', { spec }); assert.match(p.text, /DEP/);
    report(dep, {}); const c = await f.full('queue', { spec, confirm: true, preview_token: token(p.text) }); assert.ok(!c.isError, c.text);
    const again = await f.full('queue', { spec: queueSpec(f, 'THIRD', 'after: DEP\n') }); const t3 = token(again.text);
    fs.rmSync(dep.report); const c3 = await f.full('queue', { spec: queueSpec(f, 'THIRD', 'after: DEP\n'), confirm: true, preview_token: t3 }); assert.ok(!c3.isError, c3.text);
  });
});

describe('0.17.4 fix 1: UAT polish (U-a … U-f)', () => {
  it('U-a/U-b: a missing links.to is named as links.to, with the resolved paths and the first missing component', () => {
    const f = fixture('u-links'); const wt = path.join(f.root, 'wt'); const to = path.join(f.root, 'gone', 'deeper', 'sim');
    const warnings = missingLinkTargets([{ from: 'sim', to }], wt);
    assert.equal(warnings.length, 1); assert.match(warnings[0]!, /links\.to points at a path that does not exist/); assert.ok(warnings[0]!.includes(`${wt}/sim -> ${to}`), 'the link is shown as <worktree>/sim, not /sim');
    assert.ok(warnings[0]!.includes(`first missing: ${path.join(f.root, 'gone')}`)); assert.match(warnings[0]!, /links\.from, is created for you|correct links\.to/); assert.ok(!/fix links\.to$/.test(warnings[0]!));
    assert.deepEqual(missingLinkTargets([{ from: 'sim', to: f.root }], wt), []);
  });
  it('U-c: a closed task from before the outputs protocol gets no "missing block" warning; one run with the protocol still does', async () => {
    const f = fixture('u-protocol'); const old = seedTask(f.config, 'OLD', { closed: true } as never), now = seedTask(f.config, 'NEW', { outputsProtocol: 1, attemptId: 'x' } as never);
    for (const r of [old, now]) { fs.mkdirSync(path.dirname(r.report), { recursive: true }); fs.writeFileSync(r.report, 'Werdykt: PASS\n<!-- agentctl:report-end -->\n'); }
    await journalOutputs(f.ctx, readTaskRecord(f.config, 'old')!); await journalOutputs(f.ctx, readTaskRecord(f.config, 'new')!);
    const entries = readJournal(f.config).filter(e => e.kind === 'report-outputs'); assert.deepEqual(entries.map(e => e.task), ['NEW']); assert.match(entries[0]!.text, /missing agentctl-outputs/);
  });
  it('U-d: cohorts that were closed before this version first looked at them get no gc_suggest; a cohort that closes afterwards does, once', async () => {
    const f = fixture('u-gc'); const closed = (task: string, cohort: string) => seedTask(f.config, task, { cohort, closed: true, closedAt: new Date().toISOString() } as never);
    await touchCohort(f.ctx, 'OLDC'); closed('O1', 'OLDC'); await touchCohort(f.ctx, 'NEWC'); seedTask(f.config, 'N1', { cohort: 'NEWC' });
    const rows = () => collectStatus(f.ctx, { progress: false, archived: true });
    await cohortTick(f.ctx, f.notifier as never, await rows());
    assert.equal(readJournal(f.config).filter(e => e.kind === 'gc_suggest').length, 0);
    closed('N1', 'NEWC'); await cohortTick(f.ctx, f.notifier as never, await rows()); await cohortTick(f.ctx, f.notifier as never, await rows());
    assert.deepEqual(readJournal(f.config).filter(e => e.kind === 'gc_suggest').map(e => e.cohort), ['NEWC']);
  });
  it('U-f: the send answer says "wklejono" once', async () => {
    const f = fixture('u-send'); f.config.mcp.allow.push('send'); seedTask(f.config, 'SENDER', { repos: [] }); f.tmux.add('sender', '❯ \n');
    const tool = MCP_TOOLS.find(t => t.name === 'send')!, deps = { ...f.deps, context: (log: (line: string) => void) => new Context(f.runner, f.config, log) };
    const r = await tool.run(deps as never, z.object(tool.input).parse({ task: 'SENDER', text: 'hello there' })); assert.ok(!r.isError, r.text);
    assert.equal((r.text.match(/wklejono|w kolejce/g) ?? []).length, 1, r.text);
  });
});

describe('P14: chat specs cannot carry repos[].setup', () => {
  it('new and queue refuse a per-repo setup from the chat, with the same hint as the top-level one', async () => {
    const f = fixture('p14-mcp');
    const spec = `---\ntask: PAIR\nagent: claude\nrepos:\n  - {path: ${f.repo}, worktree: ${f.repo}-pair, setup: [echo hi]}\n---\nGo.\n`;
    for (const tool of ['new', 'queue']) { const r = await f.full(tool, { spec }); assert.equal(r.isError, true, tool); assert.match(r.text, /"setup" runs shell commands/); }
  });
});

