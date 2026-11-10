import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { cancelTasks, planCancel } from '../src/core/cancel.ts';
import { closeTask } from '../src/core/close.ts';
import { Context } from '../src/core/context.ts';
import { handleEvent } from '../src/core/event-command.ts';
import { Alerts } from '../src/core/alert.ts';
import { computeStats, foldHistory, historyPath, logMarkdown, markTask, median, readHistory, recordEvent, renderLog, renderStats, selectHistory, statsMarkdown } from '../src/core/history.ts';
import type { HistoryRecord } from '../src/core/history.ts';
import type { Notifier } from '../src/core/notify.ts';
import { readTaskRecord } from '../src/core/taskstore.ts';
import { WatchMemory, watchTick } from '../src/core/watch.ts';
import { DiskRunner, FakeTmux, runCli, useScratch } from './helpers.ts';
import { makeWorld } from './usage-world.ts';

const scratch = useScratch();
const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const WORKING = '● Reading src/menu.ts\n  esc to interrupt\n';
const IDLE = '❯ \n';

/** One task NC-1 with a Claude session, a report, a worktree that git answers for, and a window. */
function setup(name: string, usageExtra = '') {
  const w = makeWorld(scratch, name, usageExtra);
  const tmux = new FakeTmux();
  const wt = w.worktree('nc-1');
  const repo = path.join(w.root, 'app');
  fs.mkdirSync(repo, { recursive: true });
  const report = path.join(w.config.cache, 'nc-1', 'NC-1.md');
  fs.mkdirSync(path.dirname(report), { recursive: true });
  const record = w.task('NC-1', wt, { started: '2026-11-01T09:00:00.000Z', cohort: 'sprint', report, repos: [{ path: repo, worktree: wt, branch: 'agent/nc-1' }] });
  w.claudeSession(wt, 'sess-1', '2026-11-01T10:00:00.000Z');
  tmux.add('nc-1', WORKING);
  const runner = new DiskRunner({
    dryRun: false,
    startTime: NOW,
    respond: (cmd, args, opts) => {
      if (cmd === 'git') {
        const a = args.slice(2).join(' ');
        if (a.startsWith('status --porcelain')) return { stdout: ' M a.txt\n' };
        if (a.startsWith('rev-parse')) return { stdout: 'abc\n' };
        if (a.startsWith('rev-list --count')) return { stdout: '3\n' };
        if (a.startsWith('diff --name-only')) return { stdout: 'b.txt\nc.txt\n' };
        return {};
      }
      return tmux.respond(cmd, args, opts);
    },
  });
  const out: string[] = [];
  const ctx = new Context(runner, w.config, (l) => out.push(l));
  const writeReport = (text = '# NC-1\n\nWerdykt: PASS – all done\n', mtime = '2026-11-01T11:00:00.000Z'): void => {
    fs.writeFileSync(report, text);
    fs.utimesSync(report, new Date(mtime), new Date(mtime));
  };
  return { ...w, tmux, runner, ctx, out, record, report, writeReport, wt };
}

describe('history records', () => {
  it('a report-ready record carries the task, the models, the time, the tokens, the progress and the verdict', async () => {
    const s = setup('rec-report');
    s.writeReport();
    const entry = await recordEvent(s.ctx, s.record, 'report');
    assert.ok(entry);
    const [h] = readHistory(s.config);
    assert.equal(h?.event, 'report');
    assert.equal(h?.task, 'NC-1');
    assert.equal(h?.cohort, 'sprint');
    assert.equal(h?.project, 'app');
    assert.deepEqual(h?.requested, { agent: 'claude', model: 'opus', effort: 'high' });
    assert.deepEqual(h?.effective, { agent: 'claude', model: 'opus', effort: 'high' });
    assert.equal(h?.started, '2026-11-01T09:00:00.000Z');
    assert.equal(h?.reportAt, '2026-11-01T11:00:00.000Z');
    assert.equal(h?.durationMs, 2 * 3600_000);
    assert.equal(h?.tokens?.fresh, 5 + 326 + 17200 + 5 + 400);
    assert.equal(h?.tokens?.cacheRead, 34200);
    assert.deepEqual(h?.progress, { commits: 3, files: 3 });
    assert.equal(h?.verdict, 'Werdykt: PASS – all done');
    assert.equal(h?.result, null);
    assert.equal(historyPath(s.config), path.join(path.dirname(s.config.path), 'history.jsonl'));
  });

  it('the same report is recorded once, however many times it is seen; a rewritten report is a new record', async () => {
    const s = setup('rec-dedupe');
    s.writeReport();
    await recordEvent(s.ctx, s.record, 'report');
    assert.equal(await recordEvent(s.ctx, s.record, 'report'), undefined);
    assert.equal(readHistory(s.config).length, 1);
    s.writeReport('# NC-1\n\nWerdykt: PASS – second report\n', '2026-11-01T12:00:00.000Z');
    await recordEvent(s.ctx, s.record, 'report');
    assert.equal(readHistory(s.config).length, 2);
  });

  it('no report, no report record; a dry run writes nothing', async () => {
    const s = setup('rec-none');
    assert.equal(await recordEvent(s.ctx, s.record, 'report'), undefined);
    s.writeReport();
    const dry = new Context(new DiskRunner({ dryRun: true }), s.config, () => {});
    assert.equal(await recordEvent(dry, s.record, 'report'), undefined);
    assert.equal(fs.existsSync(historyPath(s.config)), false);
  });

  it('n/d stays null: a task without session logs has tokens null, not 0', async () => {
    const s = setup('rec-nodata');
    s.writeReport();
    const other = s.task('NC-2', s.worktree('nc-2'), { started: '2026-11-01T09:00:00.000Z', report: s.report });
    await recordEvent(s.ctx, other, 'report');
    assert.equal(readHistory(s.config)[0]?.tokens, null);
  });

  it('the watcher records the report when the task enters report-ready, once', async () => {
    const s = setup('rec-watch');
    const notified: string[] = [];
    const notifier: Notifier = { clickable: false, notify: async (_t, m) => void notified.push(m) };
    const memory = new WatchMemory();
    await watchTick(s.ctx, memory, notifier);
    s.writeReport();
    (s.tmux.windows[0] as { screen: string }).screen = IDLE;
    s.runner.now = () => NOW;
    await watchTick(s.ctx, memory, notifier);
    await watchTick(s.ctx, memory, notifier);
    const reports = readHistory(s.config).filter((h) => h.event === 'report');
    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.task, 'NC-1');
  });

  it('the agent\'s own end-of-turn event records it too, and the watcher does not repeat it', async () => {
    const s = setup('rec-event');
    s.writeReport();
    (s.tmux.windows[0] as { screen: string }).screen = IDLE;
    const notifier: Notifier = { clickable: false, notify: async () => {} };
    await handleEvent(s.ctx, new Alerts(s.ctx, notifier), { task: 'NC-1', agent: 'claude', kind: 'stop', payload: { session_id: 'x', last_assistant_message: 'done' } });
    assert.equal(readHistory(s.config).filter((h) => h.event === 'report').length, 1);
    const memory = new WatchMemory();
    await watchTick(s.ctx, memory, notifier);
    assert.equal(readHistory(s.config).filter((h) => h.event === 'report').length, 1);
  });

  it('close records the task with watch-cached progress before worktree removal', async () => {
    const s = setup('rec-close');
    s.writeReport();
    fs.writeFileSync(path.join(s.config.stateDir, 'nc-1/progress.json'), JSON.stringify({ commits: 3, files: 3 }));
    await closeTask(s.ctx, 'NC-1');
    const closed = readHistory(s.config).find((h) => h.event === 'closed');
    assert.ok(closed);
    assert.ok(closed.closedAt);
    assert.equal(closed.durationMs, 2 * 3600_000);
    assert.deepEqual(closed.progress, { commits: 3, files: 3 });
    assert.equal(readTaskRecord(s.config, 'nc-1')?.closed, true);
  });

  it('cancel records the reason; a task from the queue that never ran is recorded too', async () => {
    const s = setup('rec-cancel');
    s.writeReport();
    await recordEvent(s.ctx, s.record, 'report');
    const plan = await planCancel(s.ctx, ['NC-1'], { reason: 'wrong approach', source: 'cli' });
    await cancelTasks(s.ctx, plan, { reason: 'wrong approach', source: 'cli' });
    const c = readHistory(s.config).find((h) => h.event === 'cancelled');
    assert.equal(c?.task, 'NC-1');
    assert.equal(c?.cancelReason, 'wrong approach');
    assert.ok(c?.cancelledAt);
    assert.equal(c?.tokens?.fresh, 5 + 326 + 17200 + 5 + 400);
  });
});

/** A mark: it has no numbers of its own to bring (the report record has them). */
const mark = (task: string, over: Partial<HistoryRecord>): HistoryRecord => rec(task, { event: 'mark', durationMs: null, tokens: null, verdict: null, progress: null, reportAt: null, ...over });

function rec(task: string, over: Partial<HistoryRecord>): HistoryRecord {
  return {
    v: 1, event: 'report', at: '2026-11-01T12:00:00.000Z', task, cohort: null, project: 'app',
    requested: { agent: 'claude', model: 'opus', effort: 'high' }, effective: { agent: 'claude', model: 'opus', effort: 'high' },
    started: '2026-11-01T10:00:00.000Z', reportAt: '2026-11-01T11:00:00.000Z', closedAt: null, cancelledAt: null, cancelReason: null, durationMs: 3600_000,
    tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, fresh: 100_000 }, progress: { commits: 1, files: 2 }, verdict: 'PASS', movedFrom: null, movedTo: null, result: null, note: null, ...over,
  };
}

describe('mark', () => {
  it('writes a record with the result and the note; the last mark wins and the old one is reported', async () => {
    const s = setup('mark');
    const first = await markTask(s.ctx, 'nc-1', 'partial', 'missed the edge case');
    assert.deepEqual(first, { task: 'NC-1', result: 'partial', previous: null });
    const second = await markTask(s.ctx, 'NC-1', 'ok');
    assert.equal(second.previous, 'partial');
    const rows = foldHistory(readHistory(s.config));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.result, 'ok');
    assert.equal(rows[0]?.note, null);
    assert.equal(rows[0]?.effective?.model, 'opus');
  });

  it('the CLI: agentctl mark <task> ok|partial|fail --note; a bad result and an unknown task are errors', async () => {
    const s = setup('mark-cli');
    const ok = await runCli(s.config, s.runner, ['mark', 'NC-1', 'fail', '--note', 'broke the build']);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(ok.stdout.trim(), 'NC-1: fail');
    assert.equal(readHistory(s.config)[0]?.note, 'broke the build');
    const again = await runCli(s.config, s.runner, ['mark', 'NC-1', 'ok']);
    assert.equal(again.stdout.trim(), 'NC-1: ok (was fail)');
    assert.equal((await runCli(s.config, s.runner, ['mark', 'NC-1', 'great'])).code, 1);
    assert.match((await runCli(s.config, s.runner, ['mark', 'NC-9', 'ok'])).stderr, /no task "NC-9"/);
  });
});

describe('folding, log and stats', () => {
  it('a later null never wipes a known value; the end is the strongest event', () => {
    const rows = foldHistory([
      rec('A-1', { event: 'report', at: '2026-11-01T12:00:00.000Z' }),
      rec('A-1', { event: 'closed', at: '2026-11-01T13:00:00.000Z', tokens: null, verdict: null, closedAt: '2026-11-01T13:00:00.000Z' }),
      mark('A-1', { at: '2026-11-01T14:00:00.000Z', result: 'ok', note: 'good', tokens: null }),
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.end, 'closed');
    assert.equal(rows[0]?.tokens?.fresh, 100_000);
    assert.equal(rows[0]?.verdict, 'PASS');
    assert.equal(rows[0]?.result, 'ok');
    assert.equal(rows[0]?.at, '2026-11-01T14:00:00.000Z');
  });

  const history: HistoryRecord[] = [
    rec('A-1', { durationMs: 1000_000, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, fresh: 100_000 } }),
    rec('A-2', { durationMs: 3000_000, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, fresh: 300_000 } }),
    rec('A-3', { durationMs: 2000_000, tokens: null }),
    mark('A-1', { result: 'ok', at: '2026-11-01T13:00:00.000Z' }),
    mark('A-2', { result: 'fail', at: '2026-11-01T13:00:00.000Z' }),
    rec('A-4', { event: 'cancelled', cancelledAt: '2026-11-01T12:30:00.000Z', cancelReason: 'wrong approach' }),
    rec('B-1', { effective: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium' }, cohort: 'sprint', durationMs: 600_000, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, fresh: 50_000 } }),
    mark('B-1', { result: 'partial', at: '2026-11-01T13:00:00.000Z', effective: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium' }, cohort: 'sprint' }),
    rec('M-1', { event: 'moved', movedTo: 'M-1-2', durationMs: null, tokens: null, reportAt: null }),
  ];

  it('stats group by agent/model/effort: count, medians, shares of the marked, unmarked, cancelled and moved', () => {
    const groups = computeStats(foldHistory(history));
    const claude = groups.find((g) => g.agent === 'claude')!;
    assert.equal(claude.tasks, 4); // A-1, A-2, A-3, M-1 (A-4 was cancelled)
    assert.equal(claude.cancelled, 1);
    assert.equal(claude.medianDurationMs, 2000_000);
    assert.equal(claude.medianTokens, 200_000);
    assert.deepEqual([claude.ok, claude.partial, claude.fail, claude.unmarked], [1, 0, 1, 2]);
    assert.equal(claude.moved, 1);
    const codex = groups.find((g) => g.agent === 'codex')!;
    assert.deepEqual([codex.tasks, codex.partial, codex.medianDurationMs], [1, 1, 600_000]);
    const text = renderStats(groups).join('\n');
    assert.match(text, /claude\/opus\/high\s+4\s+33m 20s\s+200k\s+50%\s+0%\s+50%\s+2\s+1\s+1/);
    assert.match(text, /codex\/gpt-6\.1-sol\/medium\s+1\s+10m 00s\s+50k\s+0%\s+100%\s+0%/);
    assert.match(statsMarkdown(groups), /^\| agent\/model\/effort \| tasks \|/);
  });

  it('log: one line per task, newest first, the result marked, the reason of a cancel instead of a verdict', () => {
    const lines = renderLog(foldHistory(history).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)));
    const text = lines.join('\n');
    assert.match(lines[0]!, /^WHEN\s+TASK\s+COHORT\s+AGENT\/MODEL\/EFFORT\s+END\s+TIME\s+TOKENS\s+PROGRESS\s+RESULT\s+VERDICT$/);
    assert.match(text, /A-1\s+-\s+claude\/opus\/high\s+report\s+16m 40s\s+100k\s+1c 2f\s+ok\s+PASS/);
    assert.match(text, /A-4\s+.*cancelled.*wrong approach/);
    assert.match(text, /A-3\s+.*n\/d/);
    assert.match(logMarkdown(foldHistory(history)), /^\| when \| task \|/);
  });

  it('--since and --cohort filter; both through the CLI, with --json and --clip (a stand-in for the clipboard tool)', async () => {
    const s = setup('log-cli');
    fs.writeFileSync(historyPath(s.config), `${history.map((h) => JSON.stringify(h)).join('\n')}\n`);
    assert.deepEqual(selectHistory(s.ctx, { cohort: 'SPRINT' }).map((t) => t.task), ['B-1']);
    assert.equal(selectHistory(s.ctx, { since: '12h' }).length, 0, 'the newest record is 23 hours old');
    const log = await runCli(s.config, s.runner, ['log', '--cohort', 'sprint']);
    assert.equal(log.code, 0, log.stderr);
    assert.match(log.stdout, /B-1/);
    assert.doesNotMatch(log.stdout, /A-1/);
    const json = JSON.parse((await runCli(s.config, s.runner, ['stats', '--json'])).stdout) as { agent: string; tasks: number }[];
    assert.equal(json.find((g) => g.agent === 'claude')?.tasks, 4);
    const clipped: string[] = [];
    const runner = new DiskRunner({ dryRun: false, startTime: NOW, respond: (cmd, _a, opts) => (cmd === 'pbcopy' ? (clipped.push(opts?.input ?? ''), {}) : undefined) });
    const clip = await runCli(s.config, runner, ['stats', '--clip']);
    assert.match(clip.stdout, /Copied the stats to the clipboard/);
    assert.match(clipped[0] ?? '', /^\| agent\/model\/effort \|/);
    assert.equal((await runCli(s.config, runner, ['log', '--json', '--clip'])).code, 1);
    const empty = setup('log-empty');
    assert.match((await runCli(empty.config, empty.runner, ['log'])).stdout, /No history yet/);
  });

  it('median', () => {
    assert.deepEqual([[], [4], [1, 9], [3, 1, 2]].map(median), [null, 4, 5, 2]);
  });
});
