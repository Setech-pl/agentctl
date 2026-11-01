import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { describeNotifyResult } from '../src/cli.ts';
import { runDoctor } from '../src/core/doctor.ts';
import { DesktopNotifier, NOTIFIER_MEMORY_MS, notifierFailure, notifierMemoryPath, notifierOptionsFor, readNotifierMemory } from '../src/core/notify.ts';
import type { DesktopNotifierOptions } from '../src/core/notify.ts';
import type { ExecResult } from '../src/core/runner.ts';
import { DiskRunner, makeConfig, runCli, useScratch } from './helpers.ts';

const scratch = useScratch();
const TN = '/opt/homebrew/bin/terminal-notifier';
const PERMISSION = 'Could not request notification permission: Notifications are not allowed for this application';

type TnAnswer = Partial<ExecResult>;

/** A runner whose terminal-notifier answers from `tn`, whose osascript succeeds, and that records which of them ran. */
function setup(name: string, yaml = '') {
  const config = makeConfig(scratch.sub(name), yaml);
  const tn: { answer: TnAnswer; calls: string[][] } = { answer: { code: 0 }, calls: [] };
  const osa: { answer: TnAnswer; calls: string[][] } = { answer: { code: 0 }, calls: [] };
  const runner = new DiskRunner({
    dryRun: false,
    startTime: Date.UTC(2026, 10, 1, 12, 0, 0),
    respond: (cmd, args) => {
      if (cmd === TN) {
        tn.calls.push(args);
        return tn.answer;
      }
      if (cmd === 'osascript') {
        osa.calls.push(args);
        return osa.answer;
      }
      return undefined;
    },
  });
  const options = (extra: Partial<DesktopNotifierOptions> = {}): DesktopNotifierOptions => notifierOptionsFor(config, extra);
  const make = (extra: Partial<DesktopNotifierOptions> = {}) => new DesktopNotifier(runner, 'darwin', TN, options(extra));
  const dir = path.dirname(config.path);
  return { config, runner, tn, osa, make, dir, memoryFile: notifierMemoryPath(dir), logFile: path.join(dir, 'notifier.log') };
}

describe('notifier: terminal-notifier that cannot show notifications', () => {
  it('a non-zero exit sends the same notification through osascript and remembers it for an hour; one warning in the log', async () => {
    const t = setup('n1');
    t.tn.answer = { code: 1, stderr: `${PERMISSION}\n` };
    const n = t.make();
    assert.equal(n.clickable, true, 'until it failed once, the click action is offered');
    const result = await n.notify('agentctl', 'NC-1: raport gotowy', { group: 'agentctl-NC-1', execute: 'x' });
    assert.deepEqual([result.channel, result.ok, result.fallbackFrom], ['osascript', true, 'terminal-notifier']);
    assert.match(result.error ?? '', /not allowed for this application/);
    assert.equal(t.tn.calls.length, 1);
    assert.equal(t.osa.calls.length, 1);
    assert.match(t.osa.calls[0]?.[1] ?? '', /display notification "NC-1: raport gotowy" with title "agentctl"/);
    const memory = readNotifierMemory(t.memoryFile, t.runner.now());
    assert.equal(memory?.until, t.runner.now() + NOTIFIER_MEMORY_MS);
    assert.match(memory?.reason ?? '', /Could not request notification permission/);
    assert.equal(n.clickable, false, 'no click action while it is given up');
    const log = fs.readFileSync(t.logFile, 'utf8').trimEnd().split('\n');
    assert.equal(log.length, 1);
    assert.match(log[0] ?? '', /terminal-notifier failed \(Could not request notification permission.*osascript.*Allow Notifications.*notify\.backend: osascript/);
  });

  it('the permission message alone is enough, also with exit code 0', async () => {
    const t = setup('n2');
    t.tn.answer = { code: 0, stdout: `${PERMISSION}\n` };
    const result = await t.make().notify('agentctl', 'x');
    assert.deepEqual([result.channel, result.fallbackFrom], ['osascript', 'terminal-notifier']);
    assert.equal(notifierFailure({ code: 0, stdout: 'ok', stderr: '' }), undefined);
    assert.match(notifierFailure({ code: 0, stdout: '', stderr: 'Notifications are not allowed for this application' }) ?? '', /not allowed/);
    assert.equal(notifierFailure({ code: 2, stdout: '', stderr: '' }), 'exit code 2');
  });

  it('within the hour terminal-notifier is not run again and the log gets no second warning; after the hour it is tried again', async () => {
    const t = setup('n3');
    t.tn.answer = { code: 1, stderr: PERMISSION };
    const n = t.make();
    await n.notify('agentctl', 'one');
    for (const text of ['two', 'three']) {
      await t.runner.sleep(10 * 60_000);
      const r = await n.notify('agentctl', text);
      assert.deepEqual([r.channel, r.fallbackFrom], ['osascript', 'terminal-notifier']);
      assert.equal(r.skippedUntil, readNotifierMemory(t.memoryFile, t.runner.now())?.until);
    }
    assert.equal(t.tn.calls.length, 1);
    assert.equal(t.osa.calls.length, 3);
    assert.equal(fs.readFileSync(t.logFile, 'utf8').trimEnd().split('\n').length, 1);
    await t.runner.sleep(41 * 60_000); // 61 minutes since the failure
    t.tn.answer = { code: 0 };
    const back = await n.notify('agentctl', 'four');
    assert.deepEqual([back.channel, back.ok, back.fallbackFrom], ['terminal-notifier', true, undefined]);
    assert.equal(t.tn.calls.length, 2);
    assert.equal(readNotifierMemory(t.memoryFile, t.runner.now()), undefined, 'a success forgets the failure');
    assert.equal(n.clickable, true);
  });

  it('a second process (a hook) sees the memory a first one wrote', async () => {
    const t = setup('n4');
    t.tn.answer = { code: 1, stderr: PERMISSION };
    await t.make().notify('agentctl', 'from the watcher');
    const hook = t.make();
    await hook.notify('agentctl', 'from a hook');
    assert.equal(t.tn.calls.length, 1);
  });

  it('osascript failing too is reported, not thrown', async () => {
    const t = setup('n5');
    t.tn.answer = { code: 1, stderr: PERMISSION };
    t.osa.answer = { code: 1, stderr: 'execution error' };
    const r = await t.make().notify('agentctl', 'x');
    assert.deepEqual([r.channel, r.ok, r.error], ['osascript', false, 'execution error']);
  });
});

describe('notifier: notify.backend', () => {
  it('osascript never runs terminal-notifier and is not clickable', async () => {
    const t = setup('b1', 'notify: {backend: osascript}\n');
    const n = t.make();
    const r = await n.notify('agentctl', 'x');
    assert.deepEqual([r.channel, r.ok, r.fallbackFrom], ['osascript', true, undefined]);
    assert.equal(t.tn.calls.length, 0);
    assert.equal(n.clickable, false);
    assert.equal(fs.existsSync(t.memoryFile), false);
  });

  it('terminal-notifier has no fallback: a failure is reported and logged, osascript stays silent', async () => {
    const t = setup('b2', 'notify: {backend: terminal-notifier}\n');
    t.tn.answer = { code: 1, stderr: PERMISSION };
    const r = await t.make().notify('agentctl', 'x');
    assert.deepEqual([r.channel, r.ok], ['terminal-notifier', false]);
    assert.equal(t.osa.calls.length, 0);
    assert.equal(fs.existsSync(t.memoryFile), false, 'nothing is remembered, every notification tries again');
    assert.match(fs.readFileSync(t.logFile, 'utf8'), /no fallback/);
  });

  it('auto is the default; the value is checked', () => {
    assert.equal(makeConfig(scratch.sub('b3')).notify.backend, 'auto');
    assert.equal(makeConfig(scratch.sub('b4'), 'notify: {backend: osascript}\n').notify.backend, 'osascript');
    assert.throws(() => makeConfig(scratch.sub('b5'), 'notify: {backend: growl}\n'), /notify\.backend must be one of auto, terminal-notifier, osascript/);
  });

  it('without terminal-notifier installed it is osascript, and elsewhere notify-send', async () => {
    const t = setup('b6');
    const n = new DesktopNotifier(t.runner, 'darwin', undefined, notifierOptionsFor(t.config));
    assert.equal((await n.notify('a', 'b')).channel, 'osascript');
    const linux = new DesktopNotifier(t.runner, 'linux');
    assert.equal((await linux.notify('a', 'b')).channel, 'notify-send');
  });
});

describe('notify-test', () => {
  const sent = (t: ReturnType<typeof setup>) => async () => new DesktopNotifier(t.runner, 'darwin', TN, notifierOptionsFor(t.config, { retryBroken: true }));

  it('says terminal-notifier carried it when it works', async () => {
    const t = setup('t1');
    const r = await runCli(t.config, t.runner, ['notify-test'], { makeNotifier: sent(t) });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Sent through terminal-notifier: a click on the notification switches to the task window/);
    assert.match(t.tn.calls[0]?.join(' ') ?? '', /Test powiadomienia agentctl/);
  });

  it('after a failure it says osascript carried it, why, and what to do; it tries terminal-notifier again although it is remembered as broken', async () => {
    const t = setup('t2');
    t.tn.answer = { code: 1, stderr: PERMISSION };
    const r = await runCli(t.config, t.runner, ['notify-test'], { makeNotifier: sent(t) });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Sent through osascript \(no click action\)/);
    assert.match(r.stdout, /terminal-notifier failed: Could not request notification permission/);
    assert.match(r.stdout, /System Settings > Notifications > terminal-notifier > Allow Notifications, alert style Banners/);
    assert.match(r.stdout, /notify: \{backend: osascript\}/);
    t.tn.answer = { code: 0 };
    const again = await runCli(t.config, t.runner, ['notify-test'], { makeNotifier: sent(t) });
    assert.match(again.stdout, /Sent through terminal-notifier/);
    assert.equal(t.tn.calls.length, 2);
  });

  it('exits 1 when no channel worked', async () => {
    const t = setup('t3');
    t.tn.answer = { code: 1, stderr: PERMISSION };
    t.osa.answer = { code: 1, stderr: 'boom' };
    const r = await runCli(t.config, t.runner, ['notify-test'], { makeNotifier: sent(t) });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /No channel worked: osascript failed \(boom\)/);
  });

  it('describes a notifier that does not report its channel', () => {
    assert.match(describeNotifyResult(undefined, 'auto')[0] ?? '', /does not say which channel/);
  });
});

describe('doctor: the notification check', () => {
  const diagnose = 'terminal-notifier 3.1.0\nProblems found:\n  - Notifications are not allowed for terminal-notifier.\n';
  const respond = (diag: string) => (cmd: string, args: string[]) => {
    if (cmd === 'sh' && args.join(' ').includes('terminal-notifier')) return { stdout: `${TN}\n` };
    if (cmd === TN) return { stdout: diag };
    if (cmd === 'sh') return { code: 1 };
    return { stdout: 'x 3.8' };
  };
  const notifications = async (t: ReturnType<typeof setup>, diag: string) => {
    const runner = new DiskRunner({ dryRun: false, startTime: t.runner.now(), respond: respond(diag) });
    return (await runDoctor(runner, () => t.config, t.dir, '26.0.0', 'darwin')).find((c) => c.name === 'notifications');
  };

  it('warns about the missing permission with the steps, and says osascript is the fallback', async () => {
    const t = setup('d1');
    const check = await notifications(t, diagnose);
    assert.equal(check?.status, 'warn');
    assert.match(check?.detail ?? '', /will not show notifications yet: .*Notifications are not allowed/);
    assert.match(check?.detail ?? '', /falls back to osascript/);
    assert.match(check?.detail ?? '', /System Settings > Notifications > terminal-notifier > Allow Notifications, alert style Banners/);
    assert.match(check?.detail ?? '', /notify: \{backend: osascript\}/);
    assert.match(check?.detail ?? '', /agentctl notify-test/);
  });

  it('warns while the failure is remembered, and says until when', async () => {
    const t = setup('d2');
    fs.writeFileSync(t.memoryFile, JSON.stringify({ until: t.runner.now() + 30 * 60_000, at: t.runner.now(), reason: PERMISSION }));
    const check = await notifications(t, 'terminal-notifier 3.1.0\n');
    assert.equal(check?.status, 'warn');
    assert.match(check?.detail ?? '', /failed \(Could not request notification permission.*\); notifications go through osascript/);
  });

  it('is fine when nothing is wrong, and when osascript was chosen on purpose', async () => {
    const t = setup('d3');
    assert.equal((await notifications(t, 'terminal-notifier 3.1.0\n'))?.status, 'ok');
    const chosen = setup('d4', 'notify: {backend: osascript}\n');
    const check = await notifications(chosen, diagnose);
    assert.deepEqual([check?.status, check?.detail], ['ok', 'osascript, no click action (notify.backend: osascript)']);
  });
});
