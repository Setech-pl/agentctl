import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Alerts } from '../src/core/alert.ts';
import { Context } from '../src/core/context.ts';
import { eventsLogPath, handleEvent } from '../src/core/event-command.ts';
import { DEFAULT_AGENT_SETTINGS } from '../src/core/config.ts';
import { DEFAULT_WINDOW_ICONS } from '../src/core/icons.ts';
import type { Notifier } from '../src/core/notify.ts';
import { classifyScreen, taskState } from '../src/core/state.ts';
import { collectStatus } from '../src/core/status.ts';
import { tmuxLine } from '../src/core/statusline.ts';
import { WatchMemory, watchTick } from '../src/core/watch.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();
const fixture = (name: string): string => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8');
const FOOTER = fixture('screen-claude-background-footer.synthetic.txt');
const STILL = fixture('screen-claude-background-still-running.synthetic.txt');
const PROSE = fixture('screen-claude-idle-prose-about-shells.synthetic.txt');
const claude = DEFAULT_AGENT_SETTINGS.claude;
const stopPayload = { last_assistant_message: 'Tests started.' };

class Recorder implements Notifier {
  readonly messages: string[] = [];
  async notify(_title: string, message: string): Promise<void> {
    this.messages.push(message);
  }
}

describe('background work: the screen', () => {
  it('"· 1 shell, 6 monitors" in the footer and "… still running" are background, not waiting', () => {
    assert.equal(classifyScreen(FOOTER, claude), 'background');
    assert.equal(classifyScreen(STILL, claude), 'background');
    assert.equal(taskState({ alive: true, screen: FOOTER, settings: claude, reportReady: false }), 'background');
    assert.equal(taskState({ alive: true, screen: STILL, settings: claude, reportReady: true }), 'background', 'a report that is there does not end the wait for the background work');
  });

  it('prose about shells and monitors, and an idle prompt without the count, stay waiting', () => {
    assert.equal(taskState({ alive: true, screen: PROSE, settings: claude, reportReady: false }), 'waiting');
    assert.equal(taskState({ alive: true, screen: 'Welcome\n❯ \n  ⏵⏵ auto mode on', settings: claude, reportReady: false }), 'waiting');
  });

  it('a running turn, a question, a limit and the trust dialog beat background', () => {
    assert.equal(taskState({ alive: true, screen: `${FOOTER}\nThinking…\nesc to interrupt`, settings: claude, reportReady: false }), 'working');
    assert.equal(taskState({ alive: true, screen: `${FOOTER}\nEnter to select · ↑/↓ to navigate · Esc to cancel`, settings: claude, reportReady: false }), 'needs-input');
    assert.equal(taskState({ alive: true, screen: `${FOOTER}\n⎿ You've hit your session limit · resets 5pm`, settings: claude, reportReady: false }), 'limited');
    assert.equal(taskState({ alive: true, screen: `${FOOTER}\nQuick safety check`, settings: claude, reportReady: false }), 'needs-trust');
  });

  it('background_patterns in the config replace the defaults and are checked', () => {
    const config = makeConfig(scratch.sub('cfg1'), 'agents:\n  claude:\n    background_patterns: ["\\\\d+ jobs? in flight"]\n');
    assert.deepEqual(config.agents.claude.backgroundPatterns, ['\\d+ jobs? in flight']);
    assert.equal(classifyScreen('3 jobs in flight\n❯ ', config.agents.claude), 'background');
    assert.equal(classifyScreen(FOOTER, config.agents.claude), 'idle');
    assert.throws(() => makeConfig(scratch.sub('cfg2'), 'agents:\n  claude:\n    background_patterns: ["("]\n'), /background_patterns\[0\] is not a valid regular expression/);
  });

  it('the tmux status bar counts background together with working, and the icon is the hourglass', () => {
    assert.equal(DEFAULT_WINDOW_ICONS.background, '⏳');
    const row = (state: string) => ({ state, pulled: null }) as never;
    assert.equal(tmuxLine([row('working'), row('background'), row('background'), row('waiting')], null), '3⚙ 1⏸');
  });
});

function setup(name: string, screen: string) {
  const config = makeConfig(scratch.sub(name));
  const tmux = new FakeTmux();
  const runner = new DiskRunner({ dryRun: false, respond: tmux.respond, startTime: Date.now() });
  const ctx = new Context(runner, config, () => {});
  const record = seedTask(config, 'NC-1');
  tmux.add('nc-1', screen);
  const notifier = new Recorder();
  const alerts = new Alerts(ctx, notifier, { env: {} });
  return { config, tmux, runner, ctx, record, notifier, alerts };
}

describe('background work: no end-of-turn notification, no waiting notice', () => {
  it('the Stop hook while shells and monitors run sends nothing and says so in the log; once they are gone it does', async () => {
    const t = setup('e1', FOOTER);
    await handleEvent(t.ctx, t.alerts, { task: 'NC-1', agent: 'claude', kind: 'stop', payload: stopPayload });
    assert.deepEqual(t.notifier.messages, []);
    assert.match(fs.readFileSync(eventsLogPath(t.ctx), 'utf8'), /stop {2}\[not announced: background work is still running\]/);
    t.tmux.windows[0]!.screen = PROSE;
    await handleEvent(t.ctx, t.alerts, { task: 'NC-1', agent: 'claude', kind: 'stop', payload: stopPayload });
    assert.deepEqual(t.notifier.messages, ['NC-1: skończył turę i czeka na Ciebie – Tests started.']);
  });

  it('a series of Stop hooks every few minutes stays silent', async () => {
    const t = setup('e2', STILL);
    for (let i = 0; i < 4; i++) await handleEvent(t.ctx, t.alerts, { task: 'NC-1', agent: 'claude', kind: 'stop', payload: stopPayload });
    assert.deepEqual(t.notifier.messages, []);
  });

  it('status shows background, and watch reports no "waiting too long" however long it lasts', async () => {
    const t = setup('w1', FOOTER);
    assert.equal((await collectStatus(t.ctx, { progress: false }))[0]?.state, 'background');
    const memory = new WatchMemory();
    await watchTick(t.ctx, memory, t.notifier);
    await t.runner.sleep(t.config.watch.waitingAfter * 1000 * 3);
    const events = await watchTick(t.ctx, memory, t.notifier);
    assert.deepEqual(events, []);
    assert.deepEqual(t.notifier.messages, []);
    // The background work is gone and the agent waits: the same screen without the count is `waiting`, and then the reminder applies.
    t.tmux.windows[0]!.screen = PROSE;
    const after = await watchTick(t.ctx, memory, t.notifier);
    assert.deepEqual(after.map((e) => [e.from, e.to]), [['background', 'waiting']]);
    await t.runner.sleep(t.config.watch.waitingAfter * 1000);
    const later = await watchTick(t.ctx, memory, t.notifier);
    assert.deepEqual(later.map((e) => e.reason), ['waiting-too-long']);
  });

  it('a report that appears while background work runs is announced when that work is gone', async () => {
    const t = setup('w2', FOOTER);
    const memory = new WatchMemory();
    await watchTick(t.ctx, memory, t.notifier);
    fs.mkdirSync(path.dirname(t.record.report), { recursive: true });
    fs.writeFileSync(t.record.report, '# done\nWerdykt: PASS\n');
    assert.deepEqual(await watchTick(t.ctx, memory, t.notifier), []);
    assert.deepEqual(t.notifier.messages, []);
    t.tmux.windows[0]!.screen = PROSE;
    await watchTick(t.ctx, memory, t.notifier);
    assert.deepEqual(t.notifier.messages, ['NC-1: raport gotowy – Werdykt: PASS']);
  });
});
