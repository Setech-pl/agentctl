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
import { eventVerdict } from '../src/core/verdict.ts';
import { reportFingerprint } from '../src/core/report-state.ts';
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


import { screenMetadata } from '../src/core/tmux.ts';
import { buildClaudeSettings } from '../src/core/events.ts';
import { snapshotLines } from '../src/core/capacity.ts';
import { resumeText } from '../src/core/resume.ts';

const fixtureText = (name: string): string => fs.readFileSync(path.resolve(import.meta.dirname, 'fixtures', name), 'utf8');
const SUGGESTION = fixtureText('screen-claude-suggestion.txt'), SUGGESTION_ANSI = fixtureText('screen-claude-suggestion-ansi.txt');
const DRAFT = fixtureText('screen-claude-draft.txt'), DRAFT_ANSI = fixtureText('screen-claude-draft-ansi.txt');
const CODEX = fixtureText('screen-codex-placeholder.txt'), CODEX_ANSI = fixtureText('screen-codex-placeholder-ansi.txt');

describe('FIX5 E1: the dim suggestion of Claude Code is not a draft; text somebody typed still is', () => {
  it('the plain text alone cannot tell them apart: that is why the colour is read', () => {
    assert.match(screenMetadata(SUGGESTION).draft_input ?? '', /nie scalaj/);
  });
  it('tmux.capture hands every consumer the screen without the suggestion (and with the draft)', async () => {
    const f = fixture('f5-capture');
    const sug = f.tmux.add('sug'); sug.screen = SUGGESTION; sug.styled = SUGGESTION_ANSI;
    const draft = f.tmux.add('draft'); draft.screen = DRAFT; draft.styled = DRAFT_ANSI;
    assert.equal(screenMetadata((await f.ctx.tmux.capture('sug')).stdout).draft_input, null);
    assert.equal(screenMetadata((await f.ctx.tmux.capture('draft')).stdout).draft_input, 'my real draft');
  });
  it('status: draft_input is null for the suggestion and set for a real draft', async () => {
    const f = fixture('f5-status');
    for (const [name, plain, styled] of [['SUG', SUGGESTION, SUGGESTION_ANSI], ['DRF', DRAFT, DRAFT_ANSI]] as const) {
      const r = seedTask(f.config, name); const w = f.tmux.add(name.toLowerCase()); w.screen = plain; w.styled = styled; report(r, {});
    }
    const rows = await collectStatus(f.ctx, { progress: false });
    assert.equal(rows.find(r => r.task === 'SUG')!.draft_input, null);
    assert.equal(rows.find(r => r.task === 'DRF')!.draft_input, 'my real draft');
  });
  it('an automatic review after a Claude author with a suggestion in the field starts once the report has settled', async () => {
    const { f, tick } = authorCase('f5-review-suggestion');
    const w = f.tmux.windows.find(x => x.name === 'author')!; w.screen = SUGGESTION; w.styled = SUGGESTION_ANSI;
    await reviewTick(f.ctx);
    f.config.reportSettleS = 30;
    assert.deepEqual(await tick(), [], 'settle time still runs');
    const why = describeQueue(f.config, readQueue(f.config), [], await collectStatus(f.ctx, { progress: false, archived: true }), f.runner.now())[0]!.condition.text;
    assert.match(why, /raport ustala się/); assert.doesNotMatch(why, /szkic/);
    f.config.reportSettleS = 0;
    assert.deepEqual(await tick(), ['AUTHOR-REV']);
  });
  it('a real draft still holds the review back and says so', async () => {
    const { f, tick } = authorCase('f5-review-draft');
    const w = f.tmux.windows.find(x => x.name === 'author')!; w.screen = DRAFT; w.styled = DRAFT_ANSI;
    await reviewTick(f.ctx);
    assert.deepEqual(await tick(), []);
    const rows = await collectStatus(f.ctx, { progress: false, archived: true });
    assert.equal(rows.find(r => r.task === 'AUTHOR')!.draft_input, 'my real draft');
    assert.match(describeQueue(f.config, readQueue(f.config), [], rows, f.runner.now())[0]!.condition.text, /szkic w polu wpisywania/);
  });
  it('send to a Claude task with a suggestion in the field is not refused as "the input contains a draft"', async () => {
    const f = fixture('f5-send');
    const r = seedTask(f.config, 'SUG'); const w = f.tmux.add('sug'); w.screen = SUGGESTION; w.styled = SUGGESTION_ANSI; r.windowId = w.id;
    const result = await sendPrompts(f.ctx, [{ task: 'SUG', window: 'sug', prompt: 'next step' }]);
    assert.doesNotMatch(`${result[0]!.message} ${result[0]!.warning ?? ''}`, /draft|szkic/i);
    assert.ok(f.runner.calls.some(c => c.line.startsWith('tmux paste-buffer')), 'the text was pasted');
  });
  it('the settings file of a task switches the suggestions off, and still carries the hooks', () => {
    const settings = buildClaudeSettings('NC-1', ['/usr/bin/node', '/x/agentctl.ts']);
    assert.equal(settings.promptSuggestionEnabled, false);
    assert.ok(settings.hooks);
  });
});

describe('FIX5 E3 + P37: events_since with HH:MM is the most recent past occurrence, local time', () => {
  const at = (h: number, m: number, s = 0) => new Date(2026, 10, 4, h, m, s).getTime();
  const journalAt = (f: ReturnType<typeof fixture>, entries: [number, string][]) => {
    fs.writeFileSync(path.join(path.dirname(f.config.path), 'journal.jsonl'), entries.map(([ms, text]) => JSON.stringify({ at: new Date(ms).toISOString(), kind: 'queue-start', text })).join('\n') + '\n');
  };
  const run = async (now: number, since: string, entries: [number, string][]) => {
    const f = fixture(`f5-since-${since.replace(':', '')}-${now}`); journalAt(f, entries);
    const clock = f.runner as unknown as { now: () => number }; clock.now = () => now;
    return collectEvents(f.ctx, { client: 'since-test', since });
  };
  const old: [number, string][] = [[at(8, 13), 'morning'], [at(19, 20, 59), 'before'], [at(19, 21, 10), 'inside'], [at(19, 21, 30), 'later']];
  it('the current minute (19:21 at 19:21:40) returns only the events since 19:21:00, not the last 24 hours', async () => {
    const report = await run(at(19, 21, 40), '19:21', old);
    assert.deepEqual(report.events.map(e => e.text), ['inside', 'later']);
    assert.equal(report.has_more, false); assert.equal(report.note, undefined);
  });
  it('a minute that has not come yet means yesterday at that minute (P37), never an empty list with a note', async () => {
    const report = await run(at(19, 21, 40), '19:22', old);
    assert.deepEqual(report.events.map(e => e.text), ['morning', 'before', 'inside', 'later'], 'all of today is after yesterday 19:22');
    assert.equal(report.note, undefined); assert.equal(report.sinceLabel, 'od 19:22 (wczoraj)'); assert.equal(report.has_more, false);
  });
  it('midnight: 00:00 at 00:00:30 is today since 00:00:00; 23:59 is yesterday evening (P37)', async () => {
    const entries: [number, string][] = [[new Date(2026, 10, 3, 23, 59, 50).getTime(), 'yesterday'], [at(0, 0, 10), 'just after midnight']];
    assert.deepEqual((await run(at(0, 0, 30), '00:00', entries)).events.map(e => e.text), ['just after midnight']);
    const yesterday = await run(at(0, 0, 30), '23:59', entries);
    assert.deepEqual(yesterday.events.map(e => e.text), ['yesterday', 'just after midnight']);
    assert.equal(yesterday.note, undefined); assert.equal(yesterday.sinceLabel, 'od 23:59 (wczoraj)');
  });
});

describe('FIX5 E2/E4: Polish numerals', () => {
  const line = (n: number) => snapshotLines([{ provider: 'claude', ordered: false, remainingPercent: 50, resetsInMinutes: 10, ageSeconds: 1, staleDescription: '', freeSlots: 1, reportReady: n, estimate: null }] as never)[0]!;
  for (const [n, text] of [[1, '1 okno report-ready – close zwolni okno'], [2, '2 okna report-ready – close zwolni okna'], [4, '4 okna'], [5, '5 okien report-ready – close zwolni okien'], [12, '12 okien'], [22, '22 okna']] as const)
    it(`E2: capacity line for ${n} report-ready windows`, () => assert.ok(line(n).includes(text), line(n)));
  it('E4: "WYNIKI RAPORTU" counts decisions and actions in Polish', async () => {
    const f = fixture('f5-e4');
    const forms: [number, number, string][] = [[1, 1, '1 decyzja, 1 akcja'], [2, 2, '2 decyzje, 2 akcje'], [5, 0, '5 decyzji, 0 akcji'], [0, 5, '0 decyzji, 5 akcji'], [22, 12, '22 decyzje, 12 akcji']];
    for (const [d, a, expected] of forms) {
      const r = seedTask(f.config, `OUT${d}X${a}`, { outputsProtocol: 1 });
      report(r, { decisions: Array.from({ length: d }, (_, i) => `d${i}`), actions: Array.from({ length: a }, (_, i) => ({ title: `a${i}`, shell: 'echo' })) });
      await journalOutputs(f.ctx, r);
      const entry = readJournal(f.config).find(e => e.kind === 'report-outputs' && e.task === r.task);
      assert.equal(entry?.text, `${r.task}: ${expected}`);
    }
  });
  it('E2/E4: the resume line and the reports-to-pull line use the same helper', () => {
    assert.equal(resumeText(1), '1 zadanie do wznowienia (agentctl resume)');
    assert.equal(resumeText(3), '3 zadania do wznowienia (agentctl resume)');
    assert.equal(resumeText(7), '7 zadań do wznowienia (agentctl resume)');
  });
});
