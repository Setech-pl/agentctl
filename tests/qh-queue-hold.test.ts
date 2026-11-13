import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { loadGlobalConfig } from '../src/core/config.ts';
import { ConfigStore } from '../src/core/config-store.ts';
import { Context } from '../src/core/context.ts';
import { readJournal } from '../src/core/journal.ts';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import type { McpDeps, McpToolDef, ToolResult } from '../src/core/mcp-tools.ts';
import type { Notifier } from '../src/core/notify.ts';
import { commitQueueAdd, planQueueAdd, queueTick, QueueMemory } from '../src/core/queue.ts';
import { splitSpecs } from '../src/core/spec.ts';
import { queueHolds } from '../src/core/usage-limits.ts';
import { reloadConfig } from '../src/core/watch.ts';
import { DiskRunner, FakeTmux, runCli, useScratch } from './helpers.ts';
import { makeWorld, setClaudePlan } from './usage-world.ts';

/*
 * QH: `usage.queue_hold` is set from the chat (set_limits queue_hold: a percentage, "off", or per provider), written into config.yaml with its
 * comments and a .bak like the limits, and a running watch applies it from its next tick without a restart, also after a hand edit.
 * limits, capacity, config_show, queue_list and the board show the hold in force.
 */
const scratch = useScratch();
const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const tool = (name: string): McpToolDef => MCP_TOOLS.find((t) => t.name === name) as McpToolDef;

function setup(name: string) {
  const w = makeWorld(scratch, name, '  # the hold is tuned by the owner\n');
  fs.appendFileSync(w.config.path, '# limits of the night\nlimits: {claude: 4, codex: 4}\nmcp: {allow: [set_limits]}\ncapacity: {snapshot: false, codex_refresh: false}\n');
  const dir = path.dirname(w.config.path);
  const tmux = new FakeTmux();
  const runner = new DiskRunner({ dryRun: false, startTime: NOW, respond: tmux.respond });
  const fresh = () => loadGlobalConfig(dir);
  // The MCP server reads the config again on every call; the watcher keeps its own, refreshed by reloadConfig.
  const deps: McpDeps = { context: (out) => new Context(runner, fresh(), out), notify: async () => {} };
  const call = (n: string, args: Record<string, unknown> = {}): Promise<ToolResult> => tool(n).run(deps, z.object(tool(n).input).parse(args) as never);
  const set = async (hold: unknown) => {
    const preview = await call('set_limits', { queue_hold: hold });
    assert.ok(!preview.isError, preview.text);
    assert.match(preview.text, /Not changed yet/);
    return call('set_limits', { queue_hold: hold, confirm: true });
  };
  const watcher = new Context(runner, fresh(), () => {});
  const store = new ConfigStore(fresh, watcher.config);
  return { ...w, dir, runner, fresh, call, set, watcher, store };
}

describe('QH: usage.queue_hold from MCP set_limits', () => {
  it('set for every provider, per provider and off; comments stay, a .bak is kept, a wrong value changes nothing', async () => {
    const s = setup('set');
    const original = fs.readFileSync(s.config.path, 'utf8');
    const preview = await s.call('set_limits', { queue_hold: 90 });
    assert.match(preview.text, /usage\.queue_hold\.claude: off -> 90%[\s\S]*usage\.queue_hold\.codex: off -> 90%/);
    assert.equal(fs.readFileSync(s.config.path, 'utf8'), original, 'the preview writes nothing');
    const done = await s.set(90);
    assert.ok(!done.isError, done.text);
    assert.match(done.text, /^Queue hold changed \(queue_hold claude off -> 90%, queue_hold codex off -> 90%\)/);
    const text = fs.readFileSync(s.config.path, 'utf8');
    assert.match(text, /^ {2}queue_hold: 90$/m);
    assert.match(text, /# the hold is tuned by the owner/);
    assert.match(text, /# limits of the night/);
    assert.equal(fs.readFileSync(`${s.config.path}.bak`, 'utf8'), original);
    assert.deepEqual(s.fresh().usage.queueHold, { claude: 90, codex: 90 });
    assert.deepEqual(s.fresh().limits, { claude: 4, codex: 4 }, 'the limits stay');

    await s.set({ codex: 85 });
    assert.deepEqual(s.fresh().usage.queueHold, { claude: 90, codex: 85 }, 'only the named provider changes');
    await s.set({ claude: 'off' });
    assert.deepEqual(s.fresh().usage.queueHold, { codex: 85 }, '"off" removes one provider');
    await s.set('off');
    assert.deepEqual(s.fresh().usage.queueHold, {});
    assert.doesNotMatch(fs.readFileSync(s.config.path, 'utf8'), /queue_hold/, '"off" removes the key');
    assert.match(fs.readFileSync(s.config.path, 'utf8'), /# the hold is tuned by the owner/);

    const before = fs.readFileSync(s.config.path, 'utf8');
    assert.throws(() => z.object(tool('set_limits').input).parse({ queue_hold: 0 }), 'a percentage starts at 1');
    assert.throws(() => z.object(tool('set_limits').input).parse({ queue_hold: { claude: 101 } }));
    const kimi = await s.call('set_limits', { queue_hold: { kimi: 90 } });
    assert.equal(kimi.isError, true);
    assert.match(kimi.text, /queue_hold\.kimi: not an active provider/);
    assert.equal(fs.readFileSync(s.config.path, 'utf8'), before);
    assert.match(tool('set_limits').description, /queue_hold format, exactly: a whole percentage 1-100 for every active provider \(queue_hold: 90\), "off" for no hold at all \(queue_hold: "off"\), or per provider \{claude: 90, codex: "off"\}/);
  });

  it('a running watch applies the hold at its next reload, without a restart, also after a hand edit; the journal says it once', async () => {
    const s = setup('live');
    setClaudePlan(s.config.path, NOW, { session: 96, week: 5 });
    assert.deepEqual(queueHolds(s.watcher.config, NOW), {});
    await s.set({ claude: 90 });
    assert.deepEqual(queueHolds(s.watcher.config, NOW), {}, 'not before the watcher looked');
    const r = await reloadConfig(s.watcher, s.store);
    assert.equal(r.changed, true);
    assert.match(queueHolds(s.watcher.config, NOW).claude ?? '', /^wstrzymane: claude 96% limitu 5h .* > usage\.queue_hold 90%$/);
    assert.equal(readJournal(s.config).filter((j) => j.kind === 'limits-changed' && j.text === 'queue_hold: claude off → 90%').length, 1, 'set_limits and the reload say it once');
    // The owner edits the file by hand: a new mtime, a new hold.
    fs.writeFileSync(s.config.path, fs.readFileSync(s.config.path, 'utf8').replace(/queue_hold:\s*\n\s+claude: 90/, 'queue_hold: {claude: 97}'));
    assert.equal((await reloadConfig(s.watcher, s.store)).changed, true);
    assert.deepEqual(s.watcher.config.usage.queueHold, { claude: 97 });
    assert.deepEqual(queueHolds(s.watcher.config, NOW), {}, '96% is under the new hold');
    assert.equal((await reloadConfig(s.watcher, s.store)).changed, false, 'an unchanged file is not reloaded');
  });

  it('the hold is visible in queue_list, limits, capacity and config_show, holds the queue and releases it when set off', async () => {
    const s = setup('visible');
    setClaudePlan(s.config.path, NOW, { session: 96, week: 5 });
    const repo = s.worktree('app');
    await commitQueueAdd(s.watcher, (await planQueueAdd(s.watcher, splitSpecs(`---\ntask: Q-1\nagent: claude\nrepos:\n  - {path: ${repo}, worktree: ${repo}-q1}\n---\nPrompt.\n`, 't'))).items);
    assert.doesNotMatch((await s.call('queue_list')).text, /wstrzymane/);
    await s.set({ claude: 90 });
    assert.match((await s.call('queue_list')).text, /Q-1 claude\/\S+: wstrzymane: claude 96% limitu 5h .* > usage\.queue_hold 90%/);
    assert.match((await s.call('limits')).text, /^claude: .* queue_hold=90%$/m);
    assert.match((await s.call('limits')).text, /^codex: .* queue_hold=off$/m);
    assert.match((await s.call('capacity')).text, /capacity: claude: .*queue_hold 90%/);
    const shown = JSON.parse((await s.call('config_show')).text) as { truncated?: boolean; fragment?: string };
    // config_show is long: its first fragment starts with the hold in force.
    assert.match(shown.truncated ? shown.fragment! : JSON.stringify(shown, null, 2), /^\{\s*"queue_hold": \{\s*"claude": "90%",\s*"codex": "off"\s*\}/);
    const notifier: Notifier = { clickable: false, notify: async () => {} };
    const memory = new QueueMemory();
    await reloadConfig(s.watcher, s.store);
    assert.deepEqual(await queueTick(s.watcher, memory, notifier, { rows: [] }), [], 'held');
    await s.set('off');
    await reloadConfig(s.watcher, s.store);
    assert.deepEqual(await queueTick(s.watcher, memory, notifier, { rows: [] }), ['Q-1'], 'released without a restart');
    await memory.idle();
  });

  it('CLI: limits set queue_hold.codex=85 writes the mapping; limits shows the HOLD column', async () => {
    const s = setup('cli');
    const set = await runCli(s.fresh(), s.runner, ['limits', 'set', 'queue_hold.codex=85', '--yes']);
    assert.equal(set.code, 0, set.stderr);
    assert.deepEqual(s.fresh().usage.queueHold, { codex: 85 });
    const both = await runCli(s.fresh(), s.runner, ['limits', 'set', 'claude=2', 'queue_hold=off', '--yes']);
    assert.equal(both.code, 0, both.stderr);
    assert.deepEqual([s.fresh().limits.claude, s.fresh().usage.queueHold], [2, {}]);
    await runCli(s.fresh(), s.runner, ['limits', 'set', 'queue_hold=80', '--yes']);
    const shown = await runCli(s.fresh(), s.runner, ['limits']);
    assert.match(shown.stdout, /HOLD/);
    assert.match(shown.stdout, /^claude .* 80%$/m);
    const wrong = await runCli(s.fresh(), s.runner, ['limits', 'set', 'queue_hold=0', '--yes']);
    assert.notEqual(wrong.code, 0);
  });
});
