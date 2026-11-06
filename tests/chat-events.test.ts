import { composerFixture } from './composer-fixture.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { cancelTasks, planCancel } from '../src/core/cancel.ts';
import { collectEvents, eventsMarkdown, markersPath, parseSince, readMarkers, renderEvents } from '../src/core/chat-events.ts';
import { Context } from '../src/core/context.ts';
import { recordJournal, readJournal } from '../src/core/journal.ts';
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

  it('--cohort keeps the events of the cohort (a task of it, or the cohort itself) and the summary of its tasks', async () => {
    const w = world('cohort');
    // Historical closed tasks: this test filters recorded events, rather than discovering a new tmux loss.
    seedTask(w.config, 'NC-1', { cohort: 'Sprint', closed: true });
    seedTask(w.config, 'NC-2', { closed: true });
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
