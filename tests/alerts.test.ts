import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { main } from '../src/cli.ts';
import type { CliDeps } from '../src/cli.ts';
import { Alerts, DEDUP_MIN_MS, ledgerPath, readLedger } from '../src/core/alert.ts';
import { switchAttachedClient } from '../src/core/attach.ts';
import type { GlobalConfig } from '../src/core/config.ts';
import { Context } from '../src/core/context.ts';
import { eventFile, eventsLogPath, handleEvent, readStoredEvent } from '../src/core/event-command.ts';
import type { EventInput } from '../src/core/event-command.ts';
import { DesktopNotifier, findTerminalNotifier, terminalAppFor } from '../src/core/notify.ts';
import type { Notifier, NotifyClick } from '../src/core/notify.ts';
import { RecordingRunner, tmuxEnv } from '../src/core/runner.ts';
import { collectStatus } from '../src/core/status.ts';
import { watchLogPath, WatchMemory, watchTick } from '../src/core/watch.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();
const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const fixture = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const json = (name: string): unknown => JSON.parse(fixture(name));

const SELF = ['/usr/bin/env', 'AGENTCTL_HOME=/h', '/opt/node/bin/node', '--experimental-strip-types', '--no-warnings', '/opt/agentctl/bin/agentctl.ts'];
const IDLE = 'Welcome\n❯ Try "x"\n  ⏵⏵ auto mode on';
const WORKING = 'Thinking…\nesc to interrupt';
/** A dialog that none of the screen patterns knows: only the event tells. */
const UNKNOWN_DIALOG = ' Some new kind of dialog\n ❯ 1. Yes\n   2. No\n';

interface Sent {
  title: string;
  message: string;
  click: NotifyClick | undefined;
}

class FakeNotifier implements Notifier {
  clickable: boolean;
  readonly sent: Sent[] = [];
  constructor(clickable = false) {
    this.clickable = clickable;
  }
  async notify(title: string, message: string, click?: NotifyClick): Promise<void> {
    this.sent.push({ title, message, click });
  }
  get messages(): string[] {
    return this.sent.map((s) => s.message);
  }
}

function setup(name: string, yaml = '', task = 'NC-1', extra: Parameters<typeof seedTask>[2] = {}) {
  const config = makeConfig(scratch.sub(name), yaml);
  const fake = new FakeTmux();
  const runner = new DiskRunner({ dryRun: false, respond: fake.respond, startTime: Date.now() });
  const out: string[] = [];
  const ctx = new Context(runner, config, (l) => out.push(l));
  const record = seedTask(config, task, extra);
  fake.add(task.toLowerCase(), IDLE);
  const notifier = new FakeNotifier();
  const alerts = new Alerts(ctx, notifier, { self: SELF, env: {} });
  const send = (input: Partial<EventInput>) => handleEvent(ctx, alerts, { task, agent: 'claude', payload: undefined, ...input });
  const screen = (text: string): void => {
    (fake.windows.find((w) => w.name.endsWith(task.toLowerCase())) as { screen: string }).screen = text;
  };
  return { config, fake, runner, ctx, out, record, notifier, alerts, send, screen };
}

const logOf = (ctx: Context): string => fs.readFileSync(eventsLogPath(ctx), 'utf8');

describe('agentctl event: a question', () => {
  it('Claude permission dialog: the question from the screen is the notification; state, log and event.json follow', async () => {
    const t = setup('ev-q1');
    t.screen(fixture('screen-claude-permission.txt'));
    const r = await t.send({ kind: 'notification', payload: json('claude-notification-permission.json') });
    assert.deepEqual(t.notifier.messages, ['NC-1: Do you want to proceed? touch approved-by-claude.txt']);
    assert.equal(t.notifier.sent[0]?.title, 'agentctl');
    assert.equal(r.announced?.state, 'needs-input');
    const stored = readStoredEvent(t.config, t.record);
    assert.equal(stored?.outcome, 'needs-input');
    assert.equal(stored?.type, 'notification:permission_prompt');
    assert.match(logOf(t.ctx), /NC-1 {2}claude {2}notification:permission_prompt {2}\[notified: NC-1: Do you want to proceed\? touch approved-by-claude\.txt\]\n$/);
    assert.equal(readLedger(t.ctx, 'nc-1')?.state, 'needs-input');
  });

  it('AskUserQuestion: the text of the question', async () => {
    const t = setup('ev-q2');
    t.screen(fixture('screen-claude-askuserquestion.txt'));
    await t.send({ kind: 'notification', payload: json('claude-notification-askuserquestion.json') });
    assert.deepEqual(t.notifier.messages, ['NC-1: Which colour do you prefer, red or blue?']);
  });

  it('a dialog that is not drawn yet: waits once, then falls back to the message of the event', async () => {
    const t = setup('ev-q3');
    const before = t.runner.now();
    await t.send({ kind: 'notification', payload: json('claude-notification-permission.json') });
    assert.deepEqual(t.notifier.messages, ['NC-1: Claude needs your permission']);
    assert.equal(t.runner.now() - before, 500);
  });

  it('the state shows at once: needs-input from the event while the screen has a dialog the patterns do not know', async () => {
    const t = setup('ev-q4');
    t.screen(UNKNOWN_DIALOG);
    assert.equal((await collectStatus(t.ctx, { progress: false }))[0]?.state, 'waiting');
    await t.send({ kind: 'notification', payload: json('claude-notification-permission.json') });
    const [row] = await collectStatus(t.ctx, { progress: false });
    assert.equal(row?.state, 'needs-input');
    assert.equal(row?.question, 'Claude needs your permission');
  });

  it('the event goes stale when the dialog is gone (input box back) and never beats a running turn', async () => {
    const t = setup('ev-q5');
    t.screen(UNKNOWN_DIALOG);
    await t.send({ kind: 'notification', payload: json('claude-notification-permission.json') });
    t.screen(IDLE);
    assert.equal((await collectStatus(t.ctx, { progress: false }))[0]?.state, 'waiting');
    t.screen(WORKING);
    assert.equal((await collectStatus(t.ctx, { progress: false }))[0]?.state, 'working');
  });

  it('an event from before the task was (re)started does not count', async () => {
    const t = setup('ev-q6');
    t.screen(UNKNOWN_DIALOG);
    fs.mkdirSync(path.dirname(eventFile(t.ctx, 'nc-1')), { recursive: true });
    fs.writeFileSync(eventFile(t.ctx, 'nc-1'), JSON.stringify({ outcome: 'needs-input', at: '2026-10-30T10:00:00.000Z', type: 'x', text: '' }));
    assert.equal(readStoredEvent(t.config, t.record), undefined);
    assert.equal((await collectStatus(t.ctx, { progress: false }))[0]?.state, 'waiting');
  });

  it('the screen reading fills in the question of a row without an event (Codex approvals)', async () => {
    const t = setup('ev-q7', '', 'NC-2', { agent: 'codex', model: 'gpt-6.1-sol' });
    t.screen(fixture('screen-codex-approval.txt'));
    const [row] = await collectStatus(t.ctx, { progress: false });
    assert.equal(row?.state, 'needs-input');
    assert.equal(row?.question, "Would you like to run the following command? $ printf 'yes' > approved-by-codex3.txt");
  });
});

describe('agentctl event: the end of a turn', () => {
  it('waiting: the notification says so and quotes the last words of the agent', async () => {
    const t = setup('ev-t1');
    await t.send({ kind: 'stop', payload: json('claude-stop.json') });
    assert.deepEqual(t.notifier.messages, ['NC-1: skończył turę i czeka na Ciebie – ok']);
    assert.equal(readLedger(t.ctx, 'nc-1')?.state, 'waiting');
  });

  it('with the report there: "raport gotowy" and its verdict, the same text the watcher would send', async () => {
    const t = setup('ev-t2');
    fs.mkdirSync(path.dirname(t.record.report), { recursive: true });
    fs.writeFileSync(t.record.report, '# NC-1\n\n**Werdykt:** PASS – 12 tests\n\nDetails.\n');
    await t.send({ kind: 'stop', payload: json('claude-stop.json') });
    assert.deepEqual(t.notifier.messages, ['NC-1: raport gotowy – Werdykt: PASS – 12 tests']);
    assert.equal(readLedger(t.ctx, 'nc-1')?.state, 'report-ready');
  });

  it('notify.turn_end: false keeps the report and question notifications, not the plain end of turn', async () => {
    const t = setup('ev-t3', 'notify: {turn_end: false}\n');
    await t.send({ kind: 'stop', payload: json('claude-stop.json') });
    assert.deepEqual(t.notifier.messages, []);
    assert.equal(readStoredEvent(t.config, t.record)?.outcome, 'turn-complete');
    assert.match(logOf(t.ctx), /stop {2}"ok"\n$/);
  });

  it('Codex: the JSON arrives as the argument; the title turn is logged and silent', async () => {
    const t = setup('ev-t4', '', 'NC-2', { agent: 'codex', model: 'gpt-6.1-sol' });
    await t.send({ task: 'NC-2', agent: 'codex', payload: json('codex-title-turn.json') });
    assert.deepEqual(t.notifier.messages, []);
    assert.equal(fs.existsSync(eventFile(t.ctx, 'nc-2')), false);
    assert.match(logOf(t.ctx), /NC-2 {2}codex {2}agent-turn-complete:title\n$/);
    await t.send({ task: 'NC-2', agent: 'codex', payload: json('codex-turn-complete.json') });
    assert.deepEqual(t.notifier.messages, ['NC-2: skończył turę i czeka na Ciebie – Created approved.txt containing yes after approval.']);
  });

  it('idle_prompt is logged and ends a stale question, without a notification', async () => {
    const t = setup('ev-t5');
    await t.send({ kind: 'notification', payload: { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' } });
    assert.deepEqual(t.notifier.messages, []);
    assert.equal(readStoredEvent(t.config, t.record)?.outcome, 'turn-complete');
  });
});

describe('agentctl event: limits, bad input, the notify of the user', () => {
  it('a limit event: state limited, a notification with the proposal', async () => {
    const t = setup('ev-l1');
    await t.send({ kind: 'stop-failure', payload: json('claude-stop-failure-rate-limit.synthetic.json') });
    assert.deepEqual(t.notifier.messages, ['NC-1: claude wyczerpał limit użycia – agentctl move NC-1 przeniesie zadanie na codex']);
    assert.equal((await collectStatus(t.ctx, { progress: false }))[0]?.state, 'limited');
    t.screen(WORKING);
    assert.equal((await collectStatus(t.ctx, { progress: false }))[0]?.state, 'working', 'a retry after the reset clears it');
  });

  it('a pinned task: the notification says move will not help', async () => {
    const t = setup('ev-l2', '', 'NC-1', { pin: true });
    await t.send({ kind: 'stop-failure', payload: { error: 'billing_error' } });
    assert.match(t.notifier.messages[0] as string, /przypięte – pin: true – move go nie przeniesie/);
  });

  it('an unknown task, garbage and a missing --kind never throw', async () => {
    const t = setup('ev-b1');
    const unknown = await t.send({ task: 'NOPE-1', kind: 'stop', payload: json('claude-stop.json') });
    assert.equal(unknown.note, 'unknown task');
    const noKind = await t.send({ payload: json('claude-stop.json') });
    assert.equal(noKind.note, 'no --kind');
    await t.send({ kind: 'stop', payload: 'not json' });
    assert.match(logOf(t.ctx), /NOPE-1 {2}claude {2}stop {2}unknown task, ignored\n/);
    assert.match(logOf(t.ctx), /invalid {2}claude events need --kind/);
  });

  it('Codex: the notify the user already had runs afterwards with the very same JSON, also when ours finds nothing to do', async () => {
    const t = setup('ev-f1', '', 'NC-2', { agent: 'codex', model: 'gpt-6.1-sol' });
    const raw = fs.readFileSync(path.join(FIXTURES, 'codex-title-turn.json'), 'utf8').trim();
    await t.send({ task: 'NC-2', agent: 'codex', payload: JSON.parse(raw), rawPayload: raw, forward: ['/Applications/Sky.app/client', 'turn-ended'] });
    const forwarded = t.runner.commands.find((c) => c.startsWith('/Applications/Sky.app/client turn-ended '));
    assert.ok(forwarded?.includes('"type":"agent-turn-complete"') && forwarded.includes('Generate a concise'), 'the JSON is passed on as it came');
  });
});

describe('agentctl event and watch: one transition, one notification', () => {
  const REPORT = '# Report\n\nWerdykt: PASS\n';

  it('event first, watcher second: the watcher logs it and stays quiet', async () => {
    const t = setup('dup1');
    t.screen(WORKING);
    const memory = new WatchMemory();
    await watchTick(t.ctx, memory, t.notifier);
    fs.mkdirSync(path.dirname(t.record.report), { recursive: true });
    fs.writeFileSync(t.record.report, REPORT);
    await t.send({ kind: 'stop', payload: json('claude-stop.json') });
    t.screen(IDLE);
    await t.runner.sleep(3000);
    const events = await watchTick(t.ctx, memory, t.notifier);
    assert.equal(events[0]?.duplicate, true);
    assert.deepEqual(t.notifier.messages, ['NC-1: raport gotowy – Werdykt: PASS']);
    const log = fs.readFileSync(watchLogPath(t.ctx), 'utf8');
    assert.match(log, /working -> report-ready {2}\[already announced by the agent's event: NC-1: raport gotowy – Werdykt: PASS\]\n/);
  });

  it('watcher first, event a moment later: the event stays quiet', async () => {
    const t = setup('dup2');
    t.screen(WORKING);
    const memory = new WatchMemory();
    await watchTick(t.ctx, memory, t.notifier);
    fs.mkdirSync(path.dirname(t.record.report), { recursive: true });
    fs.writeFileSync(t.record.report, REPORT);
    t.screen(IDLE);
    await watchTick(t.ctx, memory, t.notifier);
    assert.equal(t.notifier.sent.length, 1);
    const r = await t.send({ kind: 'stop', payload: json('claude-stop.json') });
    assert.equal(r.announced?.result, 'duplicate');
    assert.equal(t.notifier.sent.length, 1);
    assert.match(logOf(t.ctx), /\[duplicate, not notified: NC-1: raport gotowy – Werdykt: PASS\]/);
  });

  it('a later event is a new transition, and two events from the agent are never merged', async () => {
    const t = setup('dup3');
    t.screen(UNKNOWN_DIALOG);
    await t.send({ kind: 'notification', payload: json('claude-notification-permission.json') });
    await t.send({ kind: 'notification', payload: json('claude-notification-permission.json') });
    assert.equal(t.notifier.sent.length, 2, 'a second permission prompt right after the first is a new question');

    const w = setup('dup4');
    w.screen(WORKING);
    const memory = new WatchMemory();
    await watchTick(w.ctx, memory, w.notifier);
    w.screen(UNKNOWN_DIALOG.replace('Some new kind of dialog', 'Esc to cancel · Tab to amend'));
    await watchTick(w.ctx, memory, w.notifier);
    assert.equal(w.notifier.sent.length, 1);
    await w.runner.sleep(DEDUP_MIN_MS + 1000);
    const late = await w.send({ kind: 'notification', payload: json('claude-notification-permission.json') });
    assert.equal(late.announced?.result, 'sent', 'after the window the same state is announced again');
  });

  it('the watcher asks about a question with its text, and about a limit with the proposal', async () => {
    const t = setup('dup5');
    t.screen(WORKING);
    const memory = new WatchMemory();
    await watchTick(t.ctx, memory, t.notifier);
    t.screen(fixture('screen-claude-askuserquestion.txt'));
    await watchTick(t.ctx, memory, t.notifier);
    assert.deepEqual(t.notifier.messages, ['NC-1: Which colour do you prefer, red or blue?']);
    t.screen(`${IDLE}\n  ⎿  You've hit your session limit · resets 3pm`);
    await watchTick(t.ctx, memory, t.notifier);
    assert.equal(t.notifier.messages[1], 'NC-1: claude wyczerpał limit użycia – agentctl move NC-1 przeniesie zadanie na codex');
  });

  it('an orphan window is notified without a state folder being made for it', async () => {
    const t = setup('dup7');
    t.fake.add('stray', IDLE);
    const memory = new WatchMemory();
    await watchTick(t.ctx, memory, t.notifier);
    t.fake.windows[1]!.screen = IDLE;
    const second = setup('dup7b');
    second.fake.add('stray', IDLE);
    await watchTick(second.ctx, new WatchMemory(), second.notifier);
    assert.equal(fs.existsSync(path.join(second.config.stateDir, 'stray')), false);
    // a stray window that appears later is announced
    const late = setup('dup7c');
    const m = new WatchMemory();
    await watchTick(late.ctx, m, late.notifier);
    late.fake.add('stray', IDLE);
    await watchTick(late.ctx, m, late.notifier);
    assert.match(late.notifier.messages[0] as string, /^STRAY: okno bez pliku stanu \(orphan\)/);
    assert.equal(fs.existsSync(path.join(late.config.stateDir, 'stray')), false);
  });

  it('the ledger lives next to the task state', () => {
    const t = setup('dup6');
    assert.equal(ledgerPath(t.ctx, 'nc-1'), path.join(t.config.stateDir, 'nc-1', 'notified.json'));
    assert.equal(readLedger(t.ctx, 'nc-1'), undefined);
  });
});

describe('click on a notification', () => {
  const clients = (t: ReturnType<typeof setup>): void => {
    t.fake.clients = [
      { name: '/dev/ttys001', activity: 100 },
      { name: '/dev/ttys002', activity: 200 },
    ];
  };
  const clickable = (t: ReturnType<typeof setup>, env: NodeJS.ProcessEnv = {}): { alerts: Alerts; notifier: FakeNotifier } => {
    const notifier = new FakeNotifier(true);
    return { alerts: new Alerts(t.ctx, notifier, { self: SELF, env }), notifier };
  };

  it('with a client attached: the click runs `attach TASK --switch-client` with absolute paths and activates the terminal', async () => {
    const t = setup('click1');
    clients(t);
    const { alerts, notifier } = clickable(t, { TERM_PROGRAM: 'Apple_Terminal' });
    await alerts.send({ task: 'NC-1', window: 'nc-1' }, 'needs-input', 'NC-1: Proceed?', 'event');
    assert.deepEqual(notifier.sent[0], {
      title: 'agentctl',
      message: 'NC-1: Proceed?',
      click: {
        group: 'agentctl-NC-1',
        activate: 'com.apple.Terminal',
        execute: '/usr/bin/env AGENTCTL_HOME=/h /opt/node/bin/node --experimental-strip-types --no-warnings /opt/agentctl/bin/agentctl.ts attach NC-1 --switch-client',
      },
    });
  });

  it('with no client attached: the click only activates the terminal and the text says how to attach', async () => {
    const t = setup('click2');
    const { alerts, notifier } = clickable(t, { TERM_PROGRAM: 'iTerm.app' });
    await alerts.send({ task: 'NC-1', window: 'nc-1' }, 'needs-input', 'NC-1: Proceed?', 'event');
    assert.equal(notifier.sent[0]?.message, 'NC-1: Proceed? · agentctl attach NC-1');
    assert.deepEqual(notifier.sent[0]?.click, { group: 'agentctl-NC-1', activate: 'com.googlecode.iterm2' });
  });

  it('terminal app: notify.terminal_app wins, then TERM_PROGRAM, then the tmux server\'s environment; "tmux" or unknown: no activate', async () => {
    const cfg = setup('click3', 'notify: {terminal_app: com.mitchellh.ghostty}\n');
    assert.equal((await clickable(cfg, { TERM_PROGRAM: 'iTerm.app' }).alerts.clickFor({ task: 'NC-1', window: 'nc-1' }, 'x')).click.activate, 'com.mitchellh.ghostty');
    const inTmux = setup('click4');
    assert.equal((await clickable(inTmux, { TERM_PROGRAM: 'tmux' }).alerts.clickFor({ task: 'NC-1', window: 'nc-1' }, 'x')).click.activate, undefined);
    inTmux.fake.termProgram = 'Apple_Terminal';
    assert.equal((await clickable(inTmux, { TERM_PROGRAM: 'tmux' }).alerts.clickFor({ task: 'NC-1', window: 'nc-1' }, 'x')).click.activate, 'com.apple.Terminal');
    const unknown = setup('click5');
    unknown.fake.termProgram = 'WezTerm';
    assert.equal((await clickable(unknown, { TERM_PROGRAM: 'WezTerm' }).alerts.clickFor({ task: 'NC-1', window: 'nc-1' }, 'x')).click.activate, undefined);
    assert.equal(terminalAppFor('Apple_Terminal'), 'com.apple.Terminal');
    assert.equal(terminalAppFor(undefined), undefined);
  });

  it('a notifier without click support (osascript) gets the plain text and no tmux queries', async () => {
    const t = setup('click6');
    clients(t);
    await t.alerts.send({ task: 'NC-1', window: 'nc-1' }, 'needs-input', 'NC-1: Proceed?', 'event');
    assert.deepEqual(t.notifier.sent[0], { title: 'agentctl', message: 'NC-1: Proceed?', click: {} });
    assert.ok(!t.fake.seen.some((s) => s.startsWith('list-clients')));
  });

  it('attach --switch-client: selects the window and switches the most recently active client', async () => {
    const t = setup('click7');
    clients(t);
    const target = await switchAttachedClient(t.ctx, 'nc-1');
    assert.equal(target.task, 'NC-1');
    assert.deepEqual(t.fake.switched, ['/dev/ttys002']);
    assert.ok(t.fake.seen.some((s) => s.startsWith('select-window')));
  });

  it('attach --switch-client: no client attached is an error that says what to do; an unknown task too', async () => {
    const t = setup('click8');
    await assert.rejects(switchAttachedClient(t.ctx, 'nc-1'), /no tmux client is attached to session "agentctl"/);
    await assert.rejects(switchAttachedClient(t.ctx, 'zz'), /no task "zz"/);
    assert.deepEqual(t.fake.switched, []);
  });
});

describe('notifier: terminal-notifier or osascript', () => {
  it('terminal-notifier gets title, message, sound, group and the click action', async () => {
    const runner = new RecordingRunner({ dryRun: false });
    const n = new DesktopNotifier(runner, 'darwin', '/opt/homebrew/bin/terminal-notifier');
    assert.equal(n.clickable, true);
    await n.notify('agentctl', 'NC-1: Proceed?', { group: 'agentctl-NC-1', execute: 'agentctl attach NC-1 --switch-client', activate: 'com.apple.Terminal' });
    assert.deepEqual(runner.commands, [
      "/opt/homebrew/bin/terminal-notifier -title agentctl -message 'NC-1: Proceed?' -sound Glass -group agentctl-NC-1 -execute 'agentctl attach NC-1 --switch-client' -activate com.apple.Terminal",
    ]);
  });

  it('without terminal-notifier the old osascript notification, no action; notify-send off macOS', async () => {
    const mac = new RecordingRunner({ dryRun: false });
    const n = new DesktopNotifier(mac, 'darwin');
    assert.equal(n.clickable, false);
    await n.notify('agentctl', 'hi "there"', { execute: 'ignored', activate: 'ignored' });
    assert.equal(mac.commands.length, 1);
    assert.match(mac.commands[0] as string, /^osascript -e 'display notification "hi \\"there\\"" with title "agentctl" sound name "Glass"'$/);
    const linux = new RecordingRunner({ dryRun: false });
    await new DesktopNotifier(linux, 'linux', '/opt/homebrew/bin/terminal-notifier').notify('agentctl', 'hi');
    assert.deepEqual(linux.commands, ['notify-send agentctl hi']);
  });

  it('detect: looks for terminal-notifier on macOS only', async () => {
    const found = new RecordingRunner({ dryRun: false, respond: (cmd, args) => (cmd === 'sh' && String(args[1]).includes('terminal-notifier') ? { stdout: '/opt/homebrew/bin/terminal-notifier\n' } : undefined) });
    assert.equal(await findTerminalNotifier(found, 'darwin'), '/opt/homebrew/bin/terminal-notifier');
    assert.equal((await DesktopNotifier.detect(found, 'darwin')).clickable, true);
    assert.equal(await findTerminalNotifier(found, 'linux'), undefined);
    const missing = new RecordingRunner({ dryRun: false, respond: () => ({ code: 1 }) });
    assert.equal(await findTerminalNotifier(missing, 'darwin'), undefined);
    assert.equal((await DesktopNotifier.detect(new RecordingRunner({ dryRun: false }), 'darwin')).clickable, false);
  });

  it('tmux gets a UTF-8 locale when none is set (a click has no LANG, and tmux then turns the tab of a -F format into "_")', () => {
    assert.equal(tmuxEnv({ PATH: '/x' }).LC_ALL, 'en_US.UTF-8');
    assert.equal(tmuxEnv({ LANG: 'C' }).LC_ALL, 'en_US.UTF-8');
    const utf8 = { LANG: 'pl_PL.UTF-8' };
    assert.equal(tmuxEnv(utf8), utf8);
    assert.equal(tmuxEnv({ LC_ALL: 'en_US.utf8' }).LC_ALL, 'en_US.utf8');
  });
});

describe('agentctl event / attach --switch-client through the CLI', () => {
  function run(argv: string[], t: ReturnType<typeof setup>, stdin: string) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const notifier = new FakeNotifier();
    const deps: CliDeps = {
      stdout: (s) => stdout.push(s),
      stderr: (s) => stderr.push(s),
      readStdin: () => stdin,
      stdinIsTTY: false,
      loadConfig: () => t.config as GlobalConfig,
      confirm: undefined,
      readClipboard: async () => '',
      watchCommand: () => 'agentctl watch',
      makeRunner: () => t.runner,
      selfArgv: () => SELF,
      makeNotifier: async () => notifier,
    };
    return main(argv, deps).then((code) => ({ code, stdout: stdout.join(''), stderr: stderr.join(''), notifier }));
  }

  it('Claude: the hook JSON comes on stdin; nothing is printed and the exit code is 0', async () => {
    const t = setup('cli1');
    const r = await run(['event', '--task', 'NC-1', '--agent', 'claude', '--kind', 'stop'], t, fixture('claude-stop.json'));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.deepEqual(r.notifier.messages, ['NC-1: skończył turę i czeka na Ciebie – ok']);
  });

  it('Codex: the JSON is the last argument, --forward is a JSON list', async () => {
    const t = setup('cli2', '', 'NC-2', { agent: 'codex', model: 'gpt-6.1-sol' });
    const raw = fixture('codex-turn-complete.json').trim();
    const r = await run(['event', '--task', 'NC-2', '--agent', 'codex', '--forward', '["/bin/echo","x"]', raw], t, '');
    assert.equal(r.code, 0);
    assert.equal(r.notifier.sent.length, 1);
    assert.ok(t.runner.commands.some((c) => c.startsWith('/bin/echo x ')));
  });

  it('it exits 0 even when it fails, and says so on stderr only', async () => {
    const t = setup('cli3');
    const broken: CliDeps = {
      stdout: () => assert.fail('no output expected'),
      stderr: () => {},
      readStdin: () => '',
      stdinIsTTY: false,
      loadConfig: () => {
        throw new Error('config is broken');
      },
      confirm: undefined,
      readClipboard: async () => '',
      watchCommand: () => 'agentctl watch',
      makeRunner: () => t.runner,
    };
    assert.equal(await main(['event', '--task', 'NC-1', '--agent', 'claude', '--kind', 'stop'], broken), 0);
    const bad = await run(['event', '--task', 'NC-1', '--agent', 'claude', '--kind', 'stop'], t, 'garbage {');
    assert.equal(bad.code, 0);
  });

  it('attach --switch-client needs a task and a client', async () => {
    const t = setup('cli4');
    t.fake.clients = [{ name: '/dev/ttys009', activity: 1 }];
    assert.equal((await run(['attach', 'nc-1', '--switch-client'], t, '')).code, 0);
    assert.deepEqual(t.fake.switched, ['/dev/ttys009']);
    const noTask = await run(['attach', '--switch-client'], t, '');
    assert.equal(noTask.code, 1);
    assert.match(noTask.stderr, /--switch-client needs a task ID/);
  });
});
