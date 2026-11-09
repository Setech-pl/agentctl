import { composerFixture } from './composer-fixture.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { cancelTasks, planCancel } from '../src/core/cancel.ts';
import { collectEvents, eventsMarkdown, markersPath, parseSince, readMarkers, renderEvents } from '../src/core/chat-events.ts';
import { Context } from '../src/core/context.ts';
import { historyPath, recordEvent } from '../src/core/history.ts';
import { journalPath, recordJournal, readJournal } from '../src/core/journal.ts';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import type { McpDeps, McpToolDef } from '../src/core/mcp-tools.ts';
import type { Notifier } from '../src/core/notify.ts';
import { commitQueueAdd, planQueueAdd, queueTick, QueueMemory } from '../src/core/queue.ts';
import { splitSpecs } from '../src/core/spec.ts';
import { WatchMemory, watchTick } from '../src/core/watch.ts';
import { loadGlobalConfig } from '../src/core/config.ts';
import { DiskRunner, FakeTmux, makeConfig, runCli, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();
const T0 = Date.parse('2026-11-02T10:00:00.000Z');
const min = (n: number): number => T0 + n * 60_000;

function world(name: string, extra = '') {
  const config = makeConfig(scratch.sub(name), extra);
  const tmux = new FakeTmux();
  const runner = new DiskRunner({ dryRun: false, startTime: T0, respond: tmux.respond });
  const ctx = new Context(runner, config, () => {});
  return { config, tmux, runner, ctx, at: (ms: number) => void (runner.now = () => ms) };
}

describe('events: the journal and the markers', () => {
  it('since: last uses the marker of the client; the first call looks back 24 h; each client has its own marker', async () => {
    const w = world('markers');
    w.at(min(0));
    await recordJournal(w.ctx, { kind: 'limits-changed', text: 'limity: claude 3 → 4' });
    w.at(min(10));
    const first = await collectEvents(w.ctx, { client: 'mcp' });
    assert.equal(first.events.length, 1);
    assert.match(first.sinceLabel, /pierwsze wywołanie mcp/);
    assert.equal(first.markerMoved, true);
    w.at(min(20));
    await recordJournal(w.ctx, { kind: 'queue-start', task: 'NC-5', text: 'Uruchomiono NC-5 z kolejki (claude)' });
    w.at(min(30));
    const second = await collectEvents(w.ctx, { client: 'mcp' });
    assert.deepEqual(second.events.map((e) => e.kind), ['queue-start'], 'only what is new since the call at min 10');
    assert.deepEqual((await collectEvents(w.ctx, { client: 'mcp' })).events, [], 'nothing twice');
    // the cli never looked: it sees both
    const cli = await collectEvents(w.ctx, { client: 'cli' });
    assert.deepEqual(cli.events.map((e) => e.kind), ['limits-changed', 'queue-start']);
    assert.deepEqual(Object.keys(readMarkers(w.config)).sort(), ['cli', 'mcp']);
  });

  it('--keep (peek) and a dry run leave the marker; ages, HH:MM and ISO times are accepted; nonsense is an error', async () => {
    const w = world('since');
    w.at(min(0));
    await recordJournal(w.ctx, { kind: 'usage', text: 'Claude: 83% limitu 5 h' });
    w.at(min(90));
    const peek = await collectEvents(w.ctx, { client: 'mcp', keep: true });
    assert.equal(peek.markerMoved, false);
    assert.equal(fs.existsSync(markersPath(w.config)), false);
    assert.equal((await collectEvents(w.ctx, { client: 'mcp', since: '30m', keep: true })).events.length, 0);
    assert.equal((await collectEvents(w.ctx, { client: 'mcp', since: '2h', keep: true })).events.length, 1);
    assert.equal((await collectEvents(w.ctx, { client: 'mcp', since: '2026-11-02T09:00:00Z', keep: true })).events.length, 1);
    // HH:MM may equal now (11:30 in UTC); it must never point into the future.
    assert.equal(parseSince('11:30', 'cli', w.config, min(90)).ms <= min(90), true);
    assert.throws(() => parseSince('yesterday-ish', 'cli', w.config, min(0)), /cannot read the time/);
  });

  it('P37: HH:MM is the most recent past occurrence: 23:50 at 06:19 means yesterday, 05:00 means today', async () => {
    const config = makeConfig(scratch.sub('since-hm'));
    const now = new Date(2026, 10, 6, 6, 19).getTime(); // 06:19 local, any timezone
    const at = (hm: string) => new Date(parseSince(hm, 'cli', config, now).ms);
    const morning = at('05:00');
    assert.deepEqual([morning.getFullYear(), morning.getMonth(), morning.getDate(), morning.getHours(), morning.getMinutes()], [2026, 10, 6, 5, 0], '05:00 today');
    assert.equal(parseSince('05:00', 'cli', config, now).label, 'od 05:00');
    const late = at('23:50');
    assert.deepEqual([late.getFullYear(), late.getMonth(), late.getDate(), late.getHours(), late.getMinutes()], [2026, 10, 5, 23, 50], '23:50 is still in the future today: it means yesterday');
    assert.equal(parseSince('23:50', 'cli', config, now).label, 'od 23:50 (wczoraj)');
    assert.equal(parseSince('23:50', 'cli', config, now).note, undefined, 'no more "in the future" note');
  });

  it('--cohort keeps the events of the cohort (a task of it, or the cohort itself) and the summary of its tasks', async () => {
    const w = world('cohort');
    // Historical closed tasks: this test filters recorded events, rather than discovering a new tmux loss.
    for (const record of [seedTask(w.config, 'NC-1', { cohort: 'Sprint', closed: true }), seedTask(w.config, 'NC-2', { closed: true })]) {
      fs.mkdirSync(path.dirname(record.report), { recursive: true });
      fs.writeFileSync(record.report, 'Werdykt: PASS\n<!-- agentctl:report-end -->\n');
    }
    w.at(min(1));
    await recordJournal(w.ctx, { kind: 'report-ready', task: 'NC-1', text: 'NC-1 raport gotowy', verdict: 'PASS' });
    await recordJournal(w.ctx, { kind: 'report-ready', task: 'NC-2', text: 'NC-2 raport gotowy' });
    await recordJournal(w.ctx, { kind: 'cohort-done', cohort: 'Sprint', text: 'kohorta Sprint: wszystkie raporty gotowe (1)' });
    fs.mkdirSync(path.join(w.config.cache, 'x'), { recursive: true });
    // the cohort file exists so that findCohort knows it
    fs.mkdirSync(path.join(path.dirname(w.config.path), 'cohorts'), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(w.config.path), 'cohorts', 'sprint.json'), JSON.stringify({ name: 'Sprint', created: new Date(T0).toISOString() }));
    w.at(min(5));
    const all = await collectEvents(w.ctx, { client: 'cli', keep: true });
    const mine = await collectEvents(w.ctx, { client: 'cli', cohort: 'sprint', keep: true });
    assert.equal(all.events.length, 3);
    assert.deepEqual(mine.events.map((e) => e.task ?? e.cohort), ['NC-1', 'Sprint']);
    assert.match(renderEvents(mine).join('\n'), /RAPORT {2}NC-1 {2}PASS/);
    assert.match(eventsMarkdown(mine), /\*\*RAPORT\*\* NC-1 – PASS/);
  });
});

describe('events: what writes the journal', () => {
  it('watch: report-ready (with the verdict), needs-input, limited; cancel; queue start; the summary says what waits', async () => {
    const w = world('sources', 'limits:\n  claude: 2\n');
    const notifier: Notifier = { clickable: false, notify: async () => undefined };
    const record = seedTask(w.config, 'NC-1');
    w.tmux.add('nc-1', '● Reading\n  esc to interrupt\n');
    const memory = new WatchMemory();
    await watchTick(w.ctx, memory, notifier);
    fs.mkdirSync(path.dirname(record.report), { recursive: true });
    fs.writeFileSync(record.report, '# NC-1\n\nWerdykt: PASS – all done\n');
    (w.tmux.windows[0] as { screen: string }).screen = '❯ \n';
    w.at(min(1));
    await watchTick(w.ctx, memory, notifier);
    seedTask(w.config, 'NC-2');
    w.tmux.add('nc-2', '? Which color?\n  Enter to select · Esc to cancel\n');
    const lim = seedTask(w.config, 'NC-3');
    void lim;
    w.tmux.add('nc-3', "You've hit your session limit · resets 14:00\n");
    w.at(min(2));
    await watchTick(w.ctx, memory, notifier);
    await watchTick(w.ctx, memory, notifier);
    const kinds = readJournal(w.config).map((e) => `${e.kind}:${e.task}`);
    assert.ok(kinds.includes('report-ready:NC-1'), kinds.join());
    assert.ok(kinds.includes('needs-input:NC-2'), kinds.join());
    assert.ok(kinds.includes('limited:NC-3'), kinds.join());
    assert.equal(kinds.filter((k) => k === 'report-ready:NC-1').length, 1, 'once');
    assert.equal(readJournal(w.config).find((e) => e.kind === 'report-ready')?.verdict, 'Werdykt: PASS – all done');
    // a task from the queue starts, another is cancelled
    w.tmux.newWindowScreen = composerFixture('› Ask Codex to do anything\n');
    const repo = scratch.sub('sources/app');
    const spec = `---\ntask: NC-9\nagent: codex\nrepos:\n  - path: ${repo}\n    worktree: ${repo}-nc-9\n---\nGo.\n`;
    const plan = await planQueueAdd(w.ctx, splitSpecs(spec, 't'), {});
    await commitQueueAdd(w.ctx, plan.items, {});
    const queueMemory = new QueueMemory();
    await queueTick(w.ctx, queueMemory, notifier, {});
    await queueMemory.idle();
    const cancel = await planCancel(w.ctx, ['NC-2'], { reason: 'zbędne', source: 'cli' });
    await cancelTasks(w.ctx, cancel, { reason: 'zbędne', source: 'cli' });
    w.at(min(10));
    const report = await collectEvents(w.ctx, { client: 'cli', since: '1h', keep: true });
    const text = renderEvents(report).join('\n');
    assert.match(text, /START {2}NC-9/);
    assert.match(text, /ANULOWANE {2}NC-2 {2}NC-2 anulowane – zbędne/);
    assert.match(text, /RAPORT {2}NC-1 {2}Werdykt: PASS – all done/);
    assert.match(text, /Teraz: \d+ aktywne/);
    assert.deepEqual(report.summary.reportsToPull, ['NC-1']);
  });
});

describe('events: the CLI and the MCP tool', () => {
  it('agentctl events prints the events and moves the cli marker; --json; --keep; --clip does not move it', async () => {
    const w = world('cli');
    await recordJournal(w.ctx, { kind: 'limits-changed', text: 'limity: claude 3 → 4' });
    const run = (args: string[]) => runCli(w.config, w.runner, ['events', ...args]);
    const kept = await run(['--keep']);
    assert.match(kept.stdout, /LIMITY {2}limity: claude 3 → 4/);
    assert.equal(fs.existsSync(markersPath(w.config)), false);
    const json = JSON.parse((await run(['--json'])).stdout);
    assert.equal(json.events.length, 1);
    assert.equal(json.client, 'cli');
    assert.match((await run([])).stdout, /brak zmian/);
    const clip = await run(['--clip']);
    assert.match(clip.stdout, /clipboard|\*\*Zdarzenia/);
    assert.equal((await run(['--json', '--clip'])).code, 1);
  });

  it('events_since: read tool, per-client marker (mcp), peek, and a description that tells the chat to call it first', async () => {
    const w = world('mcp');
    await recordJournal(w.ctx, { kind: 'queue-start', task: 'NC-5', text: 'Uruchomiono NC-5 z kolejki (claude)' });
    const deps: McpDeps = { context: (out) => new Context(w.runner, loadGlobalConfig(path.dirname(w.config.path)), out), notify: async () => undefined };
    const tool = MCP_TOOLS.find((t) => t.name === 'events_since') as McpToolDef;
    assert.equal(tool.kind, 'read');
    assert.match(tool.description, /start of EVERY answer/);
    const call = (args: Record<string, unknown> = {}) => tool.run(deps, z.object(tool.input).parse(args) as never);
    const peek = await call({ peek: true });
    assert.match(peek.text, /START {2}NC-5/);
    const first = await call();
    assert.match(first.text, /START {2}NC-5/);
    const second = await call();
    assert.match(second.text, /brak zmian/);
    assert.match((await call({ format: 'json' })).text, /"client": "mcp:/);
    assert.equal((await call({ since: 'soon' })).isError, true);
  });
});

describe('events: legacy oversized gc_suggest entries', () => {
  // A journal written before the write-time bound of recordJournal: a gc_suggest with a whole GC plan, then a normal event.
  const legacyGc = (w: ReturnType<typeof world>) => {
    const plan = { items: Array.from({ length: 400 }, (_, i) => ({ task: `OLD-${i}`, kind: 'worktree', bytes: 123456789, note: 'x'.repeat(40) })) };
    const entry = { at: new Date(min(1)).toISOString(), kind: 'gc_suggest', text: 'kohorta Old: gc_preview gotowy (400 pozycji)', cohort: 'Old', gc_preview: plan };
    fs.writeFileSync(journalPath(w.config), `${JSON.stringify(entry)}\n${JSON.stringify({ at: new Date(min(2)).toISOString(), kind: 'limits-changed', text: 'limity: claude 3 → 4' })}\n`);
    return entry;
  };
  const markerAt = (w: ReturnType<typeof world>, cursor: string) => fs.writeFileSync(markersPath(w.config), JSON.stringify({ cli: cursor }));

  it('summarized on read: one page carries it (with its other fields) and the event that follows, no fragments', async () => {
    const w = world('gc-legacy');
    legacyGc(w);
    w.at(min(5));
    const page = await collectEvents(w.ctx, { client: 'cli', keep: true });
    assert.deepEqual(page.events.map((e) => e.kind), ['gc_suggest', 'limits-changed']);
    const gc = page.events[0]!;
    assert.equal('fragment' in gc, false, 'no JSON fragments for a legacy gc_suggest');
    assert.equal(gc.text, 'kohorta Old: gc_preview gotowy (400 pozycji)', 'unrelated fields survive the summary');
    assert.deepEqual(gc.gc_preview, { dropped: 'oversized payload; details via gc_preview / agentctl gc' });
    assert.equal(page.has_more, false);
  });

  it('a mid-fragment cursor into the dropped payload counts the entry as delivered; the next event is served whole', async () => {
    const w = world('gc-cursor-past');
    const entry = legacyGc(w);
    w.at(min(5));
    const offset = JSON.stringify(entry).length - 50;
    markerAt(w, `e2:0:${offset}`);
    const page = await collectEvents(w.ctx, { client: 'cli', keep: true });
    assert.deepEqual(page.events.map((e) => e.kind), ['limits-changed'], 'no stale fragments of the dropped payload');
    assert.equal(page.has_more, false);
  });

  it('a fragment cursor before the gc_preview value continues seamlessly on the summarized entry', async () => {
    const w = world('gc-cursor-prefix');
    const entry = legacyGc(w);
    w.at(min(5));
    markerAt(w, 'e2:0:20');
    const page = await collectEvents(w.ctx, { client: 'cli', keep: true });
    const summarized = JSON.stringify({ ...entry, gc_preview: { dropped: 'oversized payload; details via gc_preview / agentctl gc' } });
    const first = page.events[0]!;
    assert.equal(first.kind, 'gc_suggest');
    const fragment = (first as { fragment?: { offset: number; total: number } }).fragment;
    assert.equal(fragment?.offset, 20);
    assert.equal(fragment?.total, summarized.length);
    assert.equal(first.text, summarized.slice(20), 'the prefix before gc_preview is byte-identical, the delivery continues there');
  });
});


describe('P71 current attention summary', () => {
  it('drops closed and pulled outputs while keeping historical events', async () => {
    const w = world('p71-attention');
    for (const [task, fields] of [['CLOSED', { closed: true }], ['PULLED', { pulled: new Date(min(20)).toISOString() }], ['OPEN', {}]] as const) {
      const r = seedTask(w.config, task, fields);
      fs.mkdirSync(path.dirname(r.report), { recursive: true });
      fs.writeFileSync(r.report, 'Werdykt: PASS\n<!-- agentctl:report-end -->\n');
      fs.utimesSync(r.report, min(1) / 1000, min(1) / 1000);
      await recordJournal(w.ctx, { kind: 'report-outputs', task, text: task, decisions: ['choose'], actions: [{ title: 'act', shell: 'echo ok' }] });
    }
    w.at(min(30));
    const report = await collectEvents(w.ctx, { client: 'cli', keep: true });
    assert.equal(report.events.filter(e => e.kind === 'report-outputs').length, 3);
    assert.deepEqual(report.summary.needYou, ['OPEN: decision: choose', 'OPEN: action: act (echo ok)']);
  });
  it('shows the unrated counter once per client session, even with explicit since', async () => {
    const w = world('p71-rating');
    const r = seedTask(w.config, 'DONE', { closed: true });
    await recordEvent(w.ctx, r, 'report', { reportAt: new Date(min(1)).toISOString() });
    assert.ok(fs.existsSync(historyPath(w.config)));
    assert.equal((await collectEvents(w.ctx, { client: 'cli' })).summary.unmarked, 1);
    assert.equal((await collectEvents(w.ctx, { client: 'cli', since: '24h' })).summary.unmarked, undefined);
    assert.equal((await collectEvents(w.ctx, { client: 'other' })).summary.unmarked, 1);
  });
});
