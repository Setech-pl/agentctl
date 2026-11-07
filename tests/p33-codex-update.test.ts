import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { buildAgentArgv } from '../src/core/agents.ts';
import { checkWindowLimit } from '../src/core/checks.ts';
import { DEFAULT_AGENT_SETTINGS } from '../src/core/config.ts';
import { liveWindows } from '../src/core/plan.ts';
import { codex } from '../src/core/providers/codex.ts';
import { waitForReady } from '../src/core/ready.ts';
import { RecordingRunner } from '../src/core/runner.ts';
import { Tmux } from '../src/core/tmux.ts';
import { FakeTmux, makeContext, makeConfig, seedTask, useScratch } from './helpers.ts';

/*
 * P33: the Codex "Update available" modal (a numbered menu: neither the ready pattern nor the trust dialog) blocked every
 * start for the full ready timeout and left the window holding a provider slot. Task windows now start with
 * -c check_for_update_on_startup=false, the modal is its own waitForReady class (needs-input, never answered by agentctl),
 * and a window that never became ready holds no slot.
 */

const scratch = useScratch();
const MODAL = fs.readFileSync(new URL('./fixtures/screen-codex-update-modal.txt', import.meta.url), 'utf8');

describe('P33: Codex update modal', () => {
  it('the modal matches neither the ready nor the trust pattern, and waitForReady returns the dialog class at once', async () => {
    const settings = DEFAULT_AGENT_SETTINGS.codex;
    assert.equal(new RegExp(settings.readyPattern, 'm').test(MODAL), false, 'a numbered menu is not the input prompt');
    assert.equal(new RegExp(settings.trustPattern, 'm').test(MODAL), false);
    let captures = 0;
    const runner = new RecordingRunner({
      dryRun: false,
      respond: (cmd, args) => (cmd === 'tmux' && args[0] === 'capture-pane' ? (captures++, { stdout: MODAL }) : undefined),
    });
    const t0 = runner.now();
    const result = await waitForReady(runner, new Tmux(runner, 'agentctl'), 'upd-1', {
      pattern: settings.readyPattern,
      trustPattern: settings.trustPattern,
      ...(settings.dialogPattern ? { dialogPattern: settings.dialogPattern } : {}),
      timeoutMs: 60_000,
      intervalMs: 500,
    });
    assert.deepEqual([result.ready, result.trust, result.dialog], [false, false, true]);
    assert.equal(captures, 1, 'the wait ends on the first capture, not after the 60 s timeout');
    assert.ok(runner.now() - t0 < 60_000);
  });

  it('the Codex argv disables the startup update check and user flags still win (they come last)', () => {
    const settings = { ...DEFAULT_AGENT_SETTINGS.codex, flags: ['-c', 'check_for_update_on_startup=true'] };
    const argv = buildAgentArgv({ agent: 'codex', model: 'default', effort: 'high', task: 'UPD-1' }, settings, []);
    const pair = (flag: string) => argv.slice(argv.indexOf(flag) + 1, argv.indexOf(flag) + 2)[0];
    assert.ok(argv.includes('-c'), '-c present');
    const all = argv.flatMap((a, i) => (a === '-c' ? [argv[i + 1]!] : []));
    assert.deepEqual(all.filter((v) => v.startsWith('check_for_update_on_startup')), ['check_for_update_on_startup=false', 'check_for_update_on_startup=true']);
    assert.ok(pair('-c') !== undefined);
    const lastUpdateKey = argv.lastIndexOf('check_for_update_on_startup=true');
    assert.ok(lastUpdateKey > argv.indexOf('check_for_update_on_startup=false'), 'the user flag comes after the default and wins');
  });

  it('doctor says the startup update check is disabled for task windows', () => {
    const config = makeConfig(scratch.sub('doctor'));
    const lines = codex.doctor({ found: true, version: '0.167.0', raw: 'codex 0.167.0', features: { config: true } }, {}, config);
    assert.ok(lines.some((l) => l.name === 'codex' && l.level === 'ok' && /check_for_update_on_startup=false/.test(l.text)));
    const old = codex.doctor({ found: true, version: '0.100.0', raw: 'codex 0.100.0', features: {} }, {}, config);
    assert.ok(old.some((l) => l.name === 'codex' && l.level === 'warn' && /no -c\/--config flag/.test(l.text) && /Update available/.test(l.text)), 'an old Codex without -c gets an explicit update-check warning');
  });

  it('doctor reflects a user override of the startup update check (user flags come last and win)', () => {
    const on = makeConfig(scratch.sub('doctor-on'), 'agents:\n  codex:\n    flags: [-c, check_for_update_on_startup=true]\n');
    const lines = codex.doctor({ found: true, version: '0.167.0', raw: 'codex 0.167.0', features: { config: true } }, {}, on);
    assert.ok(!lines.some((l) => /check_for_update_on_startup=false/.test(l.text)), 'no "disabled" claim against the user override');
    assert.ok(lines.some((l) => l.name === 'codex' && l.level === 'warn' && /check_for_update_on_startup=true/.test(l.text) && /user flags come last and win/.test(l.text)));
    const off = makeConfig(scratch.sub('doctor-off'), 'agents:\n  codex:\n    flags: [-c, check_for_update_on_startup=true, -c, check_for_update_on_startup=false]\n');
    const last = codex.doctor({ found: true, version: '0.167.0', raw: 'codex 0.167.0', features: { config: true } }, {}, off);
    assert.ok(last.some((l) => l.level === 'ok' && /check_for_update_on_startup=false/.test(l.text)), 'the last occurrence wins, as in argv');
  });

  it('a live window that never became ready (prompt never pasted) holds no provider slot', async () => {
    const config = makeConfig(scratch.sub('slot'), 'limits: {codex: 1}\n');
    const tmux = new FakeTmux();
    tmux.add('upd-2', MODAL);
    const { ctx } = makeContext(config, { dryRun: false, respond: tmux.respond, startTime: Date.now() });
    seedTask(config, 'UPD-2', { agent: 'codex', pendingPrompt: 'Do the thing.', promptDelivery: 'needs-attention' });
    let live = await liveWindows(ctx);
    assert.deepEqual(live.filter((w) => w.agent === 'codex').map((w) => [w.window, w.counted]), [['upd-2', false]]);
    assert.equal(checkWindowLimit('codex', 1, live, config.session), undefined, 'the slot is free although the window stands');
    // A normal running window still counts, and so does a start in flight (launching, no failure yet).
    tmux.add('ok-1', '› Ask Codex to do anything\n? for shortcuts\n');
    seedTask(config, 'OK-1', { agent: 'codex', window: 'ok-1' });
    live = await liveWindows(ctx);
    assert.equal(live.find((w) => w.window === 'ok-1')?.counted, undefined);
    assert.match(checkWindowLimit('codex', 1, live, config.session) ?? '', /window limit for codex reached: 1 of 1/);
  });
});
