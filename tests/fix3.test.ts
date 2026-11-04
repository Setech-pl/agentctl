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
import { plural } from '../src/core/util.ts';
import { OUTPUT_PROTOCOL } from '../src/core/outputs.ts';
import { readVerdict } from '../src/core/verdict.ts';
import { authorCheckoutBusy, repinReview, assertReviewIsolated } from '../src/core/review-gate.ts';
import { archiveClosed } from '../src/core/archive.ts';
import { recordSamples } from '../src/core/usage-samples.ts';
import { retryEntry, saveEntry } from '../src/core/queue.ts';
import { findAuthor } from '../src/core/checks.ts';
import { setHeaderFields as setFields, renderTaskMd } from '../src/core/taskstore.ts';
import { planResume, resumeTasks } from '../src/core/resume.ts';
import { moveTask } from '../src/core/move.ts';
import { eventVerdict } from '../src/core/verdict.ts';
import { reportFingerprint } from '../src/core/report-state.ts';
import { openAgentWindow } from '../src/core/window-guard.ts';
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


type Respond = Parameters<typeof fixture>[2];
function authorCase(name: string, yaml = '', respond?: Respond) {
  const f = fixture(name, yaml, respond);
  const author = seedTask(f.config, 'AUTHOR', { review: { default: 'auto' }, repos: [{ path: f.repo, worktree: `${f.repo}-author`, branch: 'author', base: B }] });
  fs.mkdirSync(`${f.repo}-author`); f.tmux.add('author', '❯ \n'); report(author, {});
  const tick = async (opts: Parameters<typeof queueTick>[3] = {}) => { const memory = new QueueMemory(); const began = await queueTick(f.ctx, memory, { clickable: false, notify: async () => {} } as never, opts); await memory.idle(); return began; };
  return { f, author, tick };
}
const legacyRaw = (f: ReturnType<typeof fixture>, author: ReturnType<typeof seedTask>) => f.raw('AUTHOR-REV', { agent: 'codex', model: 'gpt-6-astra', effort: 'medium', review_of: 'AUTHOR', review: false, after: ['AUTHOR'], repos: author.repos.map(r => ({ path: r.path, worktree: r.worktree, branch: r.branch, base: r.base })) });
async function queueLegacy(f: ReturnType<typeof fixture>, author: ReturnType<typeof seedTask>, heads?: Record<string, string>) {
  const raw = legacyRaw(f, author), spec = resolveSpec(raw, { config: f.config });
  await commitQueueAdd(f.ctx, [{ raw, spec }], { reuse: true, autoReview: { author: 'AUTHOR', hash: 'h', heads: heads ?? { [f.repo]: A } } });
  return raw;
}


const renderRecord = (r: Parameters<typeof renderTaskMd>[0]) => renderTaskMd(r, 'Author original task');

/** A review record written before the own-checkout rule: the author's worktree, the author's report. */
function legacyStarted(f: ReturnType<typeof fixture>, author: ReturnType<typeof seedTask>, live = false) {
  const r = seedTask(f.config, 'AUTHOR-REV', { agent: 'codex', model: 'gpt-6-astra', effort: 'medium', reviewOf: 'AUTHOR', autoReview: { author: 'AUTHOR', hash: 'old', heads: { [f.repo]: A } }, repos: author.repos, report: author.report });
  if (live) f.tmux.add('author-rev', 'Usage limit reached\n› \n');
  return r;
}

describe('FIX3 N1: the invariant of a review holds at every agent window', () => {
  it('F2-ISO-RESUME: a legacy review record is refused at resume, before a window or an attempt exist', async () => {
    const { f, author } = authorCase('f3-resume'); legacyStarted(f, author);
    const plan = await planResume(f.ctx, ['AUTHOR-REV'], { all: true });
    assert.equal(plan.items.length, 1);
    await assert.rejects(() => resumeTasks(f.ctx, plan), /stary rekord przeglądu – zamknij go \(close\) i zakolejkuj przegląd ponownie/);
    assert.ok(!f.tmux.windows.some(w => w.name.includes('author-rev')));
    assert.equal(readTaskRecord(f.config, 'author-rev')?.report, author.report, 'the record is not rebuilt in place');
    assert.equal(readTaskRecord(f.config, 'author-rev')?.attempt, undefined, 'no attempt was written');
  });
  it('F2-ISO-MOVE: a legacy review record is refused at move, nothing is started', async () => {
    const { f, author } = authorCase('f3-move'); await f.ctx.tmux.killWindow('author'); await setHeaderFields(f.runner, taskFile(f.config, 'author'), { closed: true, model: 'sonnet' }); legacyStarted(f, author, true);
    await assert.rejects(() => moveTask(f.ctx, 'AUTHOR-REV', { yes: true, agent: 'claude' }), /stary rekord przeglądu/);
    assert.equal(readTaskRecord(f.config, 'author-rev-2'), undefined);
  });
  it('move keeps the provenance (review_of, auto_review) of a review that has its own checkout', async () => {
    const { f, author } = authorCase('f3-move-ok'); await f.ctx.tmux.killWindow('author'); await setHeaderFields(f.runner, taskFile(f.config, 'author'), { closed: true, model: 'sonnet' });
    const own = { path: f.repo, worktree: `${f.repo}-author-rev`, base: A };
    const rev = seedTask(f.config, 'AUTHOR-REV', { agent: 'codex', model: 'gpt-6-astra', effort: 'medium', reviewOf: 'AUTHOR', autoReview: { author: 'AUTHOR', hash: 'h', heads: { [f.repo]: A }, bases: { [f.repo]: B }, delta: 'd' }, repos: [own], report: path.join(path.dirname(author.report), 'AUTHOR-REV.md') });
    fs.mkdirSync(own.worktree); f.tmux.add('author-rev', 'Usage limit reached\n› \n');
    await moveTask(f.ctx, 'AUTHOR-REV', { yes: true, agent: 'claude' });
    const moved = readTaskRecord(f.config, 'author-rev-2');
    assert.equal(moved?.reviewOf, 'AUTHOR'); assert.equal(moved?.autoReview?.hash, 'h'); assert.equal(rev.reviewOf, 'AUTHOR');
  });
  it('queue_retry of a legacy entry rebuilds it, and the door still refuses a record that was not rebuilt', async () => {
    const { f, author } = authorCase('f3-door'); legacyStarted(f, author);
    await assert.rejects(() => openAgentWindow(f.ctx, { task: 'AUTHOR-REV', window: 'author-rev', cwd: author.repos[0]!.worktree, env: {}, report: author.report, repos: author.repos, reviewOf: 'AUTHOR', origin: 'new', sessionUp: true }), /start refused/);
    assert.ok(!f.tmux.windows.some(w => w.name === 'author-rev'));
  });
  it('inventory: only the door creates a window for a task; a new path around it fails this test', () => {
    const allowed = new Set(['src/core/window-guard.ts', 'src/core/tmux.ts', 'src/core/manager.ts', 'src/core/windows.ts']);
    const found: string[] = [];
    const walk = (dir: string): void => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.ts') && /\b(?:tmux|ctx\.tmux)\.(?:newWindow|newSession|startWindow)\(|\.(?:newWindow|newSession|startWindow)\(/.test(fs.readFileSync(p, 'utf8')) && !allowed.has(path.relative(path.resolve(import.meta.dirname, '..'), p))) found.push(path.relative(path.resolve(import.meta.dirname, '..'), p)); } };
    walk(path.resolve(import.meta.dirname, '../src'));
    assert.deepEqual(found, [], `these files create tmux windows without openAgentWindow: ${found.join(', ')}`);
    const guardUsers = ['new.ts', 'resume.ts'].filter(n => !/openAgentWindow\(/.test(fs.readFileSync(path.resolve(import.meta.dirname, '../src/core', n), 'utf8')));
    assert.deepEqual(guardUsers, [], 'new and resume open their windows through openAgentWindow');
  });
});

describe('FIX3 N2/N3/N7: the author is gone, closed or cancelled', () => {
  it('F2-A4-GONE: a window that disappeared does not skip the settle time of the report', async () => {
    const { f, tick } = authorCase('f3-gone'); f.config.reportSettleS = 30; await f.ctx.tmux.killWindow('author'); await reviewTick(f.ctx);
    assert.deepEqual(await tick(), []);
    f.config.reportSettleS = 0;
    assert.deepEqual(await tick(), ['AUTHOR-REV']);
  });
  it('F2-A5-FRESH: an author closed between the precheck and the claim is decided on the fresh state', async () => {
    let change = false; let ref: ReturnType<typeof fixture> | undefined;
    const { f, tick } = authorCase('f3-fresh', '', (cmd, args) => {
      if (change && cmd === 'ps' && args[0] === '-axo') {
        change = false; const r = readTaskRecord(ref!.config, 'author')!;
        fs.writeFileSync(taskFile(ref!.config, 'author'), renderRecord({ ...r, closed: true, promptDelivery: 'pending', promptKind: 'followup', deliveryStartedAt: new Date().toISOString(), deliveryReportBaseline: reportFingerprint(r.report) }));
        ref!.tmux.windows = ref!.tmux.windows.filter(w => w.name !== 'author');
      }
      return undefined;
    });
    ref = f; await reviewTick(f.ctx); const rows = await collectStatus(f.ctx, { progress: false, archived: true }); change = true;
    const began = await tick({ rows });
    assert.deepEqual(began, []);
    assert.equal(readQueue(f.config)[0]?.status, 'failed');
    assert.equal(readTaskRecord(f.config, 'author-rev'), undefined);
  });
  for (const state of ['closed', 'cancelled'] as const) {
    it(`F2-A5-RETRY: a new finished report of a ${state} author lets queue_retry start the review`, async () => {
      const { f, author, tick } = authorCase(`f3-retry-${state}`);
      await reviewTick(f.ctx); await queuePrompt(f.ctx, author, 'more', 'pending', { kind: 'followup' }); await f.ctx.tmux.killWindow('author');
      await setHeaderFields(f.runner, taskFile(f.config, 'author'), { [state]: true, delivery_started_at: new Date().toISOString() });
      await tick();
      const failed = readQueue(f.config)[0]!;
      assert.equal(failed.status, 'failed');
      assert.match(failed.error ?? '', new RegExp(`^${state}:`), 'F2-A5-CLOSED: the cause is named');
      assert.match(failed.error ?? '', /report-end/); assert.match(failed.error ?? '', /queue_retry/);
      report(author, { decisions: ['finished new turn'] }, 'A new completed report');
      await retryEntry(f.ctx, 'AUTHOR-REV');
      assert.deepEqual(await tick(), ['AUTHOR-REV'], `${state}: retry after a new complete report must progress`);
    });
  }
  it('F2-A5-CLOSED: the reason of a closed author starts with closed:', async () => {
    const { f, author, tick } = authorCase('f3-closed-prefix');
    await reviewTick(f.ctx); await queuePrompt(f.ctx, author, 'more', 'pending', { kind: 'followup' }); await f.ctx.tmux.killWindow('author');
    await setHeaderFields(f.runner, taskFile(f.config, 'author'), { closed: true, delivery_started_at: new Date().toISOString() });
    await tick();
    assert.match(readQueue(f.config)[0]!.error ?? '', /^closed:/);
  });
  it('a plain after on a cancelled task stays blocked (only an automatic review reads the author\'s new report)', async () => {
    const f = fixture('f3-plain-after'); const t = seedTask(f.config, 'TASKA'); report(t); await setHeaderFields(f.runner, taskFile(f.config, 'taska'), { cancelled: true });
    const rows = await collectStatus(f.ctx, { progress: false, archived: true });
    const blocked = findBlocked([{ task: 'NEXT', after: ['TASKA'], status: 'queued' }], rows);
    assert.deepEqual(blocked.get('NEXT')?.cancelled, ['TASKA']);
  });
});

describe('FIX3 N4: one gate before the report is settled', () => {
  it('F2-B4-READ: status, get_report, pull_ready and cohort_show judge nothing before report-end plus settle', async () => {
    const f = fixture('f3-b4read'); f.config.reportSettleS = 30; await touchCohort(f.ctx, 'C');
    const r = seedTask(f.config, 'EARLY', { outputsProtocol: 1, cohort: 'C' });
    report(r, { decisions: ['D-early'], actions: [{ title: 'A-early', shell: 'echo proposed' }] });
    const row = (await collectStatus(f.ctx, { progress: false }))[0]!;
    assert.equal(row.outputs_pending, true); assert.notEqual(row.outputs_valid, true); assert.equal(row.outputs, null); assert.equal(row.decisionsCount ?? 0, 0); assert.deepEqual(row.outputs_errors, []);
    for (const [name, args] of [['status', { format: 'json' }], ['get_report', { task: 'EARLY' }], ['pull_ready', { all: true }], ['cohort_show', { cohort: 'C', format: 'json' }]] as const) {
      const out = await f.full(name, args);
      assert.ok(!out.isError, out.text);
      assert.doesNotMatch(out.text, /"outputs_valid"\s*:\s*true/, name);
      assert.doesNotMatch(out.text, /"decisions"\s*:\s*\[\s*"D-early|"title"\s*:\s*"A-early|decisions=1/, `${name} must not expose approved decisions or actions before the settle`);
      if (name !== 'cohort_show') assert.match(out.text, /"outputs_pending"\s*:\s*true/, name);
    }
    const events = await collectEvents(f.ctx, { client: 'b4' });
    assert.ok(!events.summary.needYou.some(s => /D-early|A-early/.test(s)));
    f.config.reportSettleS = 0;
    const after = (await collectStatus(f.ctx, { progress: false }))[0]!;
    assert.equal(after.outputs_valid, true); assert.equal(after.decisionsCount, 1); assert.ok(!after.outputs_pending);
  });
  it('a report from before the protocol is judged as always', async () => {
    const f = fixture('f3-b4-legacy'); f.config.reportSettleS = 30; const r = seedTask(f.config, 'OLDER'); report(r, { decisions: ['D-old'] });
    const row = (await collectStatus(f.ctx, { progress: false }))[0]!;
    assert.ok(!row.outputs_pending); assert.equal(row.decisionsCount, 1);
  });
});

describe('FIX3 N5/N6/N8', () => {
  it('F2-B1-BASE: a spelling accepted for the review (the author\'s worktree) resolves a dependent base', async () => {
    const f = fixture('f3-base', '', (cmd, args) => cmd === 'git' && args.includes('symbolic-ref') ? { code: 1 } : cmd === 'git' && args.includes(`${B}^{commit}`) ? { stdout: B } : undefined);
    const author = seedTask(f.config, 'AUTHOR', { repos: [{ path: f.repo, worktree: `${f.repo}-author`, branch: 'author', base: A }] });
    const rev = seedTask(f.config, 'AUTHOR-REV', { reviewOf: 'AUTHOR', repos: [{ path: f.repo, worktree: `${f.repo}-rev`, base: A }] });
    report(rev, { commits: [{ repo: author.repos[0]!.worktree, branch: 'author', sha: B }] });
    const data = await readOutputs(f.ctx, rev); assert.equal(data.outputs_valid, true, data.outputs_errors.join(';'));
    const next = await resolveTaskBases(f.ctx, f.spec('NEXT', { repos: [{ path: f.repo, worktree: `${f.repo}-next`, base: '@AUTHOR-REV' }] }));
    assert.equal(next.repos[0]!.base, B);
  });
  it('a detached review without commits in its outputs stands for the branch it reviewed', async () => {
    const f = fixture('f3-base-branch', '', (cmd, args) => cmd === 'git' && args.includes('symbolic-ref') ? { code: 1 } : cmd === 'git' && args.includes('refs/heads/author^{commit}') ? { stdout: B } : undefined);
    seedTask(f.config, 'AUTHOR', { repos: [{ path: f.repo, worktree: `${f.repo}-author`, branch: 'author', base: A }] });
    const rev = seedTask(f.config, 'AUTHOR-REV', { reviewOf: 'AUTHOR', repos: [{ path: f.repo, worktree: `${f.repo}-rev`, base: A }] }); report(rev, {});
    const next = await resolveTaskBases(f.ctx, f.spec('NEXT', { repos: [{ path: f.repo, worktree: `${f.repo}-next`, base: '@AUTHOR-REV' }] }));
    assert.equal(next.repos[0]!.base, B);
  });
  it('F2-B3-FENCE: a verdict inside a code example of a short report is not the verdict', () => {
    assert.equal(eventVerdict('# Review\n\nNo final verdict yet.\n\n## Example of rejected data\n\n```yaml\nverdict: FAIL\n```\n'), undefined);
    assert.equal(eventVerdict('# Review\n\n```\nWerdykt: FAIL\n```\n'), undefined, 'the very first block is an example too');
    assert.equal(eventVerdict('# Review\n\n> Werdykt: FAIL\n\ntext\n'), undefined, 'a quote is an example');
    assert.equal(eventVerdict('~~~\nWerdykt: FAIL\n~~~\n'), undefined);
  });
  it('B3: a real header verdict is found in a short and in a long report; outputs.verdict wins', () => {
    assert.equal(eventVerdict('Werdykt: PASS\n\nshort'), 'Werdykt: PASS');
    const long = `# Review of X\n\nStatus: PARTIAL\n\n${'a long paragraph of body text.\n\n'.repeat(60)}## Details\n\n${'more.\n'.repeat(40)}\n`;
    assert.equal(eventVerdict(long), 'Werdykt: PARTIAL');
    const lineHeavy = `${Array.from({ length: 20 }, (_, i) => `Autor: n${i}`).join('\n')}\nWerdykt: FAIL\n\n## Details\n`;
    assert.equal(eventVerdict(lineHeavy), 'Werdykt: FAIL', 'the boundary is the structure, not a number of lines');
    assert.equal(eventVerdict('Werdykt: FAIL\n\n```agentctl-outputs\nversion: 1\nverdict: PASS\n```\n'), 'Werdykt: PASS');
  });
  it('F2-A6-STATUS: MCP status names the review the decisions come from, in json and in the compact text', async () => {
    const f = fixture('f3-status-source'); const r = seedTask(f.config, 'AUTHOR-REV', { reviewOf: 'AUTHOR', outputsProtocol: 1 }); report(r, { decisions: ['D-source'] });
    assert.equal((await collectStatus(f.ctx))[0]!.reviewOf, 'AUTHOR');
    const json = await f.full('status', { format: 'json' });
    assert.match(json.text, /"review(?:Of|_of)"\s*:\s*"AUTHOR"/);
    const text = await f.full('status', {});
    assert.match(text.text, /review_of=AUTHOR/); assert.match(text.text, /decisions=1/);
  });
});
