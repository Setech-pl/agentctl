import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { awayPath, awayReport, awayTick, phoneActive, readAway, setAway } from '../src/core/away.ts';
import { Context } from '../src/core/context.ts';
import { DiskRunner, makeConfig, runCli, useScratch } from './helpers.ts';

const scratch = useScratch();
const NTFY = 'notify:\n  ntfy:\n    topic: agentctl-test-topic-0123456789\n';

/** ioreg answers with this many seconds of idle time. */
function ioregRunner(idle: { seconds: number | 'broken' }) {
  return new DiskRunner({
    dryRun: false,
    startTime: Date.UTC(2026, 10, 2, 12, 0, 0),
    respond: (cmd) => {
      if (cmd !== 'ioreg') return undefined;
      if (idle.seconds === 'broken') return { code: 1, stderr: 'no ioreg' };
      return { code: 0, stdout: `    | |   "HIDIdleTime" = ${Math.round(idle.seconds * 1e9)}\n` };
    },
  });
}

describe('away: the state', () => {
  it('is off until set; on and off are written to AGENTCTL_HOME and read back', async () => {
    const config = makeConfig(scratch.sub('a1'), NTFY);
    const ctx = new Context(new DiskRunner({ dryRun: false }), config, () => {});
    assert.equal(readAway(config).on, false);
    assert.equal(phoneActive(config), false, 'a topic alone does not send');
    const first = await setAway(ctx, true, 'cli');
    assert.equal(first.changed, true);
    assert.equal(readAway(config).on, true);
    assert.equal(readAway(config).by, 'cli');
    assert.equal(phoneActive(config), true);
    assert.ok(fs.existsSync(awayPath(config)));
    assert.equal((await setAway(ctx, true, 'cli')).changed, false);
    await setAway(ctx, false, 'cli');
    assert.equal(phoneActive(config), false);
  });

  it('notify.ntfy.always sends without away; no topic never sends', () => {
    assert.equal(phoneActive(makeConfig(scratch.sub('a2'), `${NTFY}    always: true\n`)), true);
    assert.equal(phoneActive(makeConfig(scratch.sub('a3'), 'notify:\n  ntfy:\n    always: true\n')), false);
    assert.equal(phoneActive(makeConfig(scratch.sub('a4'))), false);
  });

  it('a broken away.json counts as off', () => {
    const config = makeConfig(scratch.sub('a5'), NTFY);
    fs.writeFileSync(awayPath(config), '{nope');
    assert.equal(readAway(config).on, false);
  });
});

describe('away: auto_idle (ioreg mocked)', () => {
  const setup = (name: string, minutes: number | null) => {
    const idle = { seconds: 0 as number | 'broken' };
    const config = makeConfig(scratch.sub(name), `${NTFY}${minutes === null ? '' : `away:\n  auto_idle: ${minutes}\n`}`);
    const runner = ioregRunner(idle);
    return { idle, config, ctx: new Context(runner, config, () => {}) };
  };

  it('idle longer than the threshold turns away on; the first activity turns it off', async () => {
    const t = setup('i1', 10);
    t.idle.seconds = 9 * 60;
    assert.equal(await awayTick(t.ctx), undefined);
    t.idle.seconds = 10 * 60 + 1;
    assert.equal(await awayTick(t.ctx), 'on');
    assert.deepEqual([readAway(t.config).on, readAway(t.config).by], [true, 'auto']);
    assert.equal(await awayTick(t.ctx), undefined, 'already on: nothing changes');
    t.idle.seconds = 2;
    assert.equal(await awayTick(t.ctx), 'off');
    assert.equal(readAway(t.config).on, false);
  });

  it('away set by hand is not taken back by activity', async () => {
    const t = setup('i2', 10);
    await setAway(t.ctx, true, 'cli');
    t.idle.seconds = 1;
    assert.equal(await awayTick(t.ctx), undefined);
    assert.equal(readAway(t.config).on, true);
  });

  it('a hand-made "off" while idle is not undone until there was activity', async () => {
    const t = setup('i3', 10);
    t.idle.seconds = 20 * 60;
    await awayTick(t.ctx);
    await setAway(t.ctx, false, 'cli');
    assert.equal(await awayTick(t.ctx), undefined, 'still idle, but the user said off');
    assert.equal(readAway(t.config).on, false);
    t.idle.seconds = 3;
    await awayTick(t.ctx);
    t.idle.seconds = 20 * 60;
    assert.equal(await awayTick(t.ctx), 'on', 'after activity it may come on again');
  });

  it('without auto_idle, or when ioreg fails, nothing happens', async () => {
    const off = setup('i4', null);
    off.idle.seconds = 99999;
    assert.equal(await awayTick(off.ctx), undefined);
    const broken = setup('i5', 5);
    broken.idle.seconds = 'broken';
    assert.equal(await awayTick(broken.ctx), undefined);
    assert.equal(readAway(broken.config).on, false);
  });
});

describe('away: agentctl away', () => {
  it('on, status, off, and the report', async () => {
    const config = makeConfig(scratch.sub('c1'), NTFY);
    const runner = new DiskRunner({ dryRun: false });
    const on = await runCli(config, runner, ['away', 'on']);
    assert.equal(on.code, 0);
    assert.match(on.stdout, /^away on/);
    assert.match((await runCli(config, runner, ['away', 'on'])).stdout, /already on/);
    const status = await runCli(config, runner, ['away']);
    assert.match(status.stdout, /away: ON since .* \(set by cli\)/);
    assert.match(status.stdout, /notifications are sent/);
    const json = JSON.parse((await runCli(config, runner, ['away', 'status', '--json'])).stdout);
    assert.equal(json.on, true);
    assert.equal(json.phoneActive, true);
    await runCli(config, runner, ['away', 'off']);
    assert.match((await runCli(config, runner, ['away', 'status'])).stdout, /away: off[\s\S]*quiet while you are here/);
    assert.equal(awayReport(config).on, false);
  });

  it('away on without a phone set up says how to set it up', async () => {
    const config = makeConfig(scratch.sub('c2'));
    const r = await runCli(config, new DiskRunner({ dryRun: false }), ['away', 'on']);
    assert.match(r.stdout, /ntfy-setup/);
  });
});
