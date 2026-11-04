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
import { setHeaderFields as setFields } from '../src/core/taskstore.ts';
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

describe('FIX2 A: automatic review start gate and old entries', () => {
  it('A2/R1: a follow-up accepted after the status snapshot keeps the review from starting', async () => {
    const { f, tick } = authorCase('r1'); await reviewTick(f.ctx);
    const rows = await collectStatus(f.ctx, { progress: false, archived: true });
    await enqueuePrompt(f.ctx, 'author', 'New author turn');
    assert.deepEqual(await tick({ rows }), []); assert.equal(readTaskRecord(f.config, 'author-rev'), undefined); assert.equal(readQueue(f.config)[0]!.status, 'queued');
  });

  const ps = (lines: string[]) => (cmd: string, args: string[]) => cmd === 'ps' && args[0] === '-axo' ? { stdout: lines.join('\n') + '\n' } : cmd === 'ps' ? { stdout: ' 4242\n' } : undefined;
  it('A3/R2: a git process (or its child) whose cwd is in the author checkout blocks, without the path in argv', async () => {
    const wtOf = (root: string) => path.join(root, 'repo-author');
    let root = '';
    const { f } = authorCase('r2', '', (cmd, args, opts) => {
      const p = ps([' 4242 1 git -c alias.hold=!sleep 8 hold', ' 4243 4242 sleep 8'])(cmd, args); if (p) return p;
      if (cmd.endsWith('lsof')) return { stdout: `p${args[1]}\nn${wtOf(root)}/sub/dir\n` };
      return undefined;
    });
    root = f.root;
    assert.match((await authorCheckoutBusy(f.ctx, 'AUTHOR'))!, /działa w|proces/);
  });
  it('A3: a git process elsewhere does not block; one that cannot be inspected blocks with the reason', async () => {
    let mode: 'elsewhere' | 'unknown' = 'elsewhere';
    const { f } = authorCase('r2b', '', (cmd, args) => {
      const p = ps([' 4242 1 git status'])(cmd, args); if (p) return p;
      if (cmd.endsWith('lsof')) return mode === 'elsewhere' ? { stdout: 'p4242\nn/somewhere/else\n' } : { code: 1 };
      return undefined;
    });
    assert.equal(await authorCheckoutBusy(f.ctx, 'AUTHOR'), undefined);
    mode = 'unknown'; assert.match((await authorCheckoutBusy(f.ctx, 'AUTHOR'))!, /nie można sprawdzić katalogu/);
  });

  it('A1/R3: a rebuilt old entry has its own report even when the project config names the author\'s absolute report', async () => {
    const { f, author } = authorCase('r3'); fs.writeFileSync(path.join(f.repo, '.agentctl.yaml'), `report: ${author.report}\n`);
    const raw = legacyRaw(f, author);
    const migrated = (await repinReview(f.ctx, raw, { author: 'AUTHOR', hash: 'h', heads: { [f.repo]: A } }, true, async () => A))!;
    const resolved = resolveSpec(migrated.raw, { config: f.config });
    assert.notEqual(resolved.report, author.report); assert.equal(resolved.report, path.join(f.config.cache, 'author-rev', 'AUTHOR-REV.md')); assert.ok(migrated.raw.header.report);
    assert.equal(migrated.reuse, false); assert.ok(resolved.repos.every(r => r.branch === undefined && r.worktree !== `${f.repo}-author`));
    assertReviewIsolated(resolved, author);
  });
  it('A1: the hard invariant refuses a report or a worktree shared with the author', () => {
    const f = fixture('invariant'); const author = seedTask(f.config, 'AUTHOR', { repos: [{ path: f.repo, worktree: `${f.repo}-author`, branch: 'a', base: A }] });
    const spec = (report: string, worktree: string) => ({ task: 'AUTHOR-REV', report, repos: [{ path: f.repo, worktree }] });
    assert.throws(() => assertReviewIsolated(spec(author.report, `${f.repo}-rev`), author), /author's report/);
    assert.throws(() => assertReviewIsolated(spec('/x/r.md', `${f.repo}-author`), author), /overlaps the author's checkout/);
    assert.throws(() => assertReviewIsolated(spec('/x/r.md', `${f.repo}-author/sub`), author), /overlaps/);
    assert.doesNotThrow(() => assertReviewIsolated(spec('/x/r.md', `${f.repo}-author-rev`), author));
  });
  it('A1: every review start checks the invariant: a legacy entry that would share the report never starts', async () => {
    const { f, author, tick } = authorCase('r3-start', 'limits: {codex: 1}\n'); fs.writeFileSync(path.join(f.repo, '.agentctl.yaml'), `report: ${author.report}\n`);
    await queueLegacy(f, author, { [f.repo]: A });
    assert.deepEqual(await tick(), ['AUTHOR-REV']);
    const record = readTaskRecord(f.config, 'author-rev');
    if (record) { assert.notEqual(record.report, author.report); assert.notEqual(record.repos[0]!.worktree, `${f.repo}-author`); }
    assert.ok(!readQueue(f.config).some(e => e.status === 'starting'));
  });
  it('A1/R4: an archived author still allows the rebuild, review_of validation and retry', async () => {
    const { f, author } = authorCase('r4');
    await f.ctx.tmux.killWindow('author'); await setFields(f.runner, taskFile(f.config, 'author'), { closed: true });
    const raw = await queueLegacy(f, author);
    await archiveClosed(f.ctx); assert.equal(readTaskRecord(f.config, 'author'), undefined, 'archived');
    assert.deepEqual(findAuthor('AUTHOR', [], f.config), { agent: 'claude', model: 'opus' });
    const migrated = await repinReview(f.ctx, raw, { author: 'AUTHOR', hash: 'h', heads: { [f.repo]: A } }, true, async () => A);
    assert.ok(migrated); assert.equal(migrated!.reuse, false);
    await saveEntry(f.ctx, { ...readQueue(f.config)[0]!, status: 'failed', error: 'unsafe start residue' });
    const again = await retryEntry(f.ctx, 'AUTHOR-REV'); assert.equal(again.status, 'queued'); assert.equal(again.reuse, undefined);
    assert.ok(!again.spec.includes('branch:'));
  });
  it('A1: missing data makes the old entry fail with the instruction to remove and queue again, never to reuse the author', async () => {
    const { f, author } = authorCase('r4-missing');
    const raw = legacyRaw(f, author);
    const hinted = (e: unknown) => /queue_rm/.test((e as { hint?: string }).hint ?? '');
    await assert.rejects(repinReview(f.ctx, raw, { author: 'GHOST', hash: 'h', heads: { [f.repo]: A } }, true, async () => A), hinted);
    await assert.rejects(repinReview(f.ctx, raw, { author: 'AUTHOR', hash: 'h', heads: {} }, true, async () => A), hinted);
  });
  it('A1: queue_retry rebuilds BEFORE the residue check (the author\'s checkout is not inspected)', async () => {
    const { f, author } = authorCase('retry-first', '', (cmd, args) => cmd === 'git' && args.includes('worktree') && args.includes('list') ? { stdout: '' } : undefined);
    await queueLegacy(f, author); await saveEntry(f.ctx, { ...readQueue(f.config)[0]!, status: 'failed', error: 'unsafe start residue: sandbox' });
    const again = await retryEntry(f.ctx, 'AUTHOR-REV'); assert.equal(again.status, 'queued');
    const preview = await f.full('queue_retry', { task: 'AUTHOR-REV' }); assert.doesNotMatch(preview.text, /unsafe start residue/);
  });
  it('A1: the rebuild is idempotent, covers a pair of repos and leaves disjoint paths', async () => {
    const f = fixture('pair-rebuild'); const second = path.join(f.root, 'client'); fs.mkdirSync(second);
    const author = seedTask(f.config, 'AUTHOR', { review: { default: 'auto' }, repos: [{ path: f.repo, worktree: `${f.repo}-author`, branch: 'author', base: B }, { path: second, worktree: `${second}-author`, branch: 'author', base: B }] });
    const raw = legacyRaw(f, author), auto = { author: 'AUTHOR', hash: 'h', heads: { [f.repo]: A, [second]: A } };
    const first = (await repinReview(f.ctx, raw, auto, true, async () => A))!;
    const spec = resolveSpec(first.raw, { config: f.config });
    assert.deepEqual(spec.repos.map(r => r.worktree), [`${f.root}/repo-author-rev`, `${f.root}/client-author-rev`]); assertReviewIsolated(spec, author);
    assert.equal(await repinReview(f.ctx, first.raw, first.autoReview, first.reuse, async () => A), undefined, 'second pass changes nothing');
  });
  it('A1: an author closed WITH a finished report still gets its review', async () => {
    const { f, tick } = authorCase('closed-ok', 'limits: {codex: 1}\n'); await reviewTick(f.ctx);
    await f.ctx.tmux.killWindow('author'); await setFields(f.runner, taskFile(f.config, 'author'), { closed: true });
    assert.deepEqual(await tick(), ['AUTHOR-REV']);
  });

  it('A5/R5: a closed author without a new finished report ends the review as failed, retry stays possible', async () => {
    const { f, author, tick } = authorCase('r5-closed'); await reviewTick(f.ctx);
    await queuePrompt(f.ctx, author, 'Another turn', 'pending', { kind: 'followup' });
    await f.ctx.tmux.killWindow('author'); await setFields(f.runner, taskFile(f.config, 'author'), { closed: true, delivery_started_at: new Date().toISOString() });
    await tick(); const entry = readQueue(f.config)[0]!; assert.equal(entry.status, 'failed'); assert.match(entry.error!, /zamknięty bez nowego/); assert.doesNotMatch(entry.error!, /^cancelled/);
  });
  it('A5/R5: a cancelled author without a new finished report cancels the review', async () => {
    const { f, author, tick } = authorCase('r5-cancel'); await reviewTick(f.ctx);
    await queuePrompt(f.ctx, author, 'Another turn', 'pending', { kind: 'followup' });
    await f.ctx.tmux.killWindow('author'); await setFields(f.runner, taskFile(f.config, 'author'), { cancelled: true, cancelled_at: new Date().toISOString(), delivery_started_at: new Date().toISOString() });
    await tick(); const entry = readQueue(f.config)[0]!; assert.equal(entry.status, 'failed'); assert.match(entry.error!, /^cancelled: autor AUTHOR anulowany/);
  });

  it('A4/R8: an automatic review needs the explicit report-end of the current attempt, not only a settled turn', async () => {
    const { f, author, tick } = authorCase('r8');
    fs.writeFileSync(author.report, 'Werdykt: PASS\nunfinished report\n');
    f.config.reportSettleS = 1; const now = Date.now(); fs.utimesSync(author.report, new Date(now - 5000), new Date(now - 5000));
    await setFields(f.runner, taskFile(f.config, 'author'), { attempt_id: 'current-attempt', attempt_started: new Date(now - 100000).toISOString(), turn_ended_at: new Date(now - 1000).toISOString() });
    assert.deepEqual(await reviewTick(f.ctx), []); assert.deepEqual(await tick(), []);
  });

  it('A1/R7 (characterization): a moved author branch keeps the pinned head and the original delta base', async () => {
    const { f } = authorCase('r7'); await reviewTick(f.ctx);
    const entry = readQueue(f.config)[0]!, raw = splitSpecs(entry.spec)[0]!;
    const next = (await repinReview(f.ctx, raw, entry.autoReview!, false, async () => B))!;
    assert.equal(next.autoReview.heads[f.repo], B); assert.equal(next.autoReview.bases![f.repo], A);
  });
  it('A1/R9: the rebuilt prompt carries the new delta and the reviewer\'s own checkout', async () => {
    const { f, author } = authorCase('r9'); const tip = 'c'.repeat(40);
    const raw = legacyRaw(f, author); raw.prompt = `Review only the delta repo: ${B}..${A}. Do not check out another branch.`;
    const next = (await repinReview(f.ctx, raw, { author: 'AUTHOR', hash: 'h', heads: { [f.repo]: A } }, true, async () => tip))!;
    assert.ok(next.raw.prompt.includes(next.autoReview.delta!)); assert.ok(next.raw.prompt.includes(`${B}..${tip}`)); assert.ok(!next.raw.prompt.includes(`${B}..${A}`));
    assert.ok(next.raw.prompt.includes(`${f.root}/repo-author-rev`));
  });
  it('A6: the review prompt names the own checkout and no longer contradicts it (no author branch, no agentctl decision)', async () => {
    const { f } = authorCase('a6'); await reviewTick(f.ctx);
    const prompt = splitSpecs(readQueue(f.config)[0]!.spec)[0]!.prompt;
    assert.doesNotMatch(prompt, /(?:on|in) the author's (?:existing )?branch/); assert.doesNotMatch(prompt, /issue an agentctl decision/);
    assert.match(prompt, /own detached checkout/); assert.match(prompt, /do not run mark/); assert.match(prompt, /decisions/);
  });
});

describe('FIX2 B: outputs repo, verdict label, pending block', () => {
  const sha = 'abcdef1';
  const block = (commits: string) => `Werdykt: PASS\n\n\`\`\`agentctl-outputs\nversion: 1\nverdict: PASS\ncommits:\n${commits}\`\`\`\n<!-- agentctl:report-end -->\n`;
  const write = (record: ReturnType<typeof seedTask>, text: string) => { fs.mkdirSync(path.dirname(record.report), { recursive: true }); fs.writeFileSync(record.report, text); };
  it('B1/N1: repo may be the repo name, the repository path or the task worktree', async () => {
    const f = fixture('b1-repo'); const wt = `${f.repo}-t`;
    const r = seedTask(f.config, 'T', { repos: [{ path: f.repo, worktree: wt, branch: 't', base: A }] });
    for (const name of ['repo', f.repo, wt]) {
      write(r, block(`  - {repo: "${name}", branch: t, sha: ${sha}}\n`));
      const data = await readOutputs(f.ctx, r); assert.deepEqual(data.outputs_errors, [], name); assert.equal(data.outputs_valid, true);
    }
  });
  it('B1/N1: a reviewer may name the author\'s worktree, the author\'s repository path or the author\'s branch', async () => {
    const f = fixture('b1-review-repo'); const authorWt = `${f.repo}-author`;
    seedTask(f.config, 'AUTHOR', { repos: [{ path: f.repo, worktree: authorWt, branch: 'dev-u2', base: A }] });
    const rev = seedTask(f.config, 'AUTHOR-REV', { reviewOf: 'AUTHOR', repos: [{ path: f.repo, worktree: `${f.repo}-author-rev`, base: A }] });
    for (const name of [authorWt, f.repo, 'dev-u2', 'repo']) {
      write(rev, block(`  - {repo: "${name}", branch: dev-u2, sha: ${sha}}\n`));
      const data = await readOutputs(f.ctx, rev); assert.deepEqual(data.outputs_errors, [], name);
    }
  });
  it('B1/N1: an unknown or ambiguous repo is an error that lists the accepted values, once with a count', async () => {
    const f = fixture('b1-repo-bad'); const other = path.join(f.root, 'x', 'repo'); fs.mkdirSync(other, { recursive: true });
    const r = seedTask(f.config, 'T', { repos: [{ path: f.repo, worktree: `${f.repo}-t`, base: A }, { path: other, worktree: `${other}-t`, base: A }] });
    write(r, block(`  - {repo: nowhere, branch: t, sha: ${sha}}\n  - {repo: nowhere, branch: t, sha: ${sha}}\n  - {repo: nowhere, branch: t, sha: ${sha}}\n  - {repo: repo, branch: t, sha: ${sha}}\n`));
    const data = await readOutputs(f.ctx, r);
    const missing = data.outputs_errors.filter(e => e.startsWith('repo nowhere')); assert.equal(missing.length, 1); assert.match(missing[0]!, /\(3 entries\)/); assert.ok(missing[0]!.includes(f.repo) && missing[0]!.includes(`${f.repo}-t`));
    assert.ok(data.outputs_errors.some(e => /^repo repo: ambiguous/.test(e)), data.outputs_errors.join('|'));
  });
  it('B2: the protocol injected into agents says that one-key maps and lower-case results are accepted, and what repo means', () => {
    assert.match(OUTPUT_PROTOCOL, /one-key mapping/); assert.match(OUTPUT_PROTOCOL, /lower-case result/); assert.match(OUTPUT_PROTOCOL, /`repo` is the name of the repository/); assert.match(OUTPUT_PROTOCOL, /repo: sandbox/);
  });
  it('B3/N3: the report event takes outputs.verdict, then a header line; never a sentence of the body; one label', () => {
    const f = fixture('b3');
    const fileOf = (name: string, text: string) => { const p = path.join(f.root, `${name}.md`); fs.writeFileSync(p, text); return p; };
    assert.equal(readVerdict(fileOf('declared', block('  []\n').replace('Werdykt: PASS', 'Werdykt: FAIL').replace('verdict: PASS', 'verdict: BLOCKED'))), 'Werdykt: BLOCKED');
    assert.equal(readVerdict(fileOf('header', 'Verdict: pass\n\nBody.\n')), 'Werdykt: PASS');
    assert.equal(readVerdict(fileOf('header2', '# Przegląd\n\nwerdykt: PARTIAL – brak testów\n')), 'Werdykt: PARTIAL – brak testów');
    const prose = ['# Review', ...Array.from({ length: 20 }, (_, i) => `Line ${i} of the review.`), 'verdict: PASS jest zgodny z treścią raportu, ale sam blok nie przechodzi walidacji schematu.'].join('\n');
    assert.equal(readVerdict(fileOf('prose', prose)), undefined);
  });
  it('B4/N4: an unfinished report of a protocol task is not judged: no "missing block" until report-end and settle', async () => {
    const f = fixture('b4'); const r = seedTask(f.config, 'W', { outputsProtocol: 1 });
    write(r, 'Werdykt: PASS\nstill writing the review…\n');
    const row = () => collectStatus(f.ctx, { progress: false }).then(rows => rows.find(x => x.task === 'W')!);
    const early = await row(); assert.deepEqual(early.outputs_errors, []); assert.equal(early.outputs_pending, true);
    await journalOutputs(f.ctx, r); assert.equal(readJournal(f.config).filter(e => e.kind === 'report-outputs').length, 0);
    write(r, 'Werdykt: PASS\nfinished\n<!-- agentctl:report-end -->\n');
    const done = await row(); assert.match((done.outputs_errors ?? [])[0] ?? '', /missing agentctl-outputs/); assert.notEqual(done.outputs_pending, true);
    await journalOutputs(f.ctx, r); assert.equal(readJournal(f.config).filter(e => e.kind === 'report-outputs').length, 1);
  });
  it('A6: a reviewer\'s decisions are labelled as the review\'s in events and the cohort aggregate', async () => {
    const f = fixture('a6-source'); const rev = seedTask(f.config, 'AUTHOR-REV', { reviewOf: 'AUTHOR', outputsProtocol: 1, cohort: 'C' }); await touchCohort(f.ctx, 'C');
    write(rev, block('  []\n').replace('commits:\n  []\n', 'decisions: [Czy scalić?]\n'));
    await journalOutputs(f.ctx, rev);
    const events = await collectEvents(f.ctx, { client: 'a6' }); assert.ok(events.summary.needYou.some(s => s.startsWith('przegląd AUTHOR-REV: decision: Czy scalić?')), events.summary.needYou.join('|'));
    const shown = await f.full('cohort_show', { cohort: 'C', format: 'json' }); assert.match(shown.text, /"source": "przegląd AUTHOR-REV"/);
  });
});

