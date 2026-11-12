import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { it } from 'node:test';
import { newTasks } from '../src/core/new.ts';
import { resolveSpec } from '../src/core/spec.ts';
import { collectStatus } from '../src/core/status.ts';
import { collectTaskUsage } from '../src/core/usage.ts';
import { UsageReader } from '../src/core/usage-sources.ts';
import { provider } from '../src/core/providers/registry.ts';
import { readTaskRecord } from '../src/core/taskstore.ts';
import { makeConfig, makeContext, seedTask, useScratch, FakeTmux, REPO_ROOT } from './helpers.ts';
const scratch = useScratch();
const kimi = provider('kimi');
function world(name: string) {
  const root = scratch.sub(name), home = path.join(root, 'kimi'); fs.mkdirSync(home);
  const config = makeConfig(root, `providers: [claude, codex, kimi]\ncapacity: {snapshot: false, codex_refresh: false}\nusage: {kimi_dir: ${home}}\n`);
  return { root, home, config };
}
it('P28 recomputes needs-input after re-login despite persisted event, observation and notification state', async () => {
  const w = world('relogin'), tmux = new FakeTmux(w.config.session);
  const pane = tmux.add('k', '● Error: token rejected; re-login required.\nSign in to Kimi Code\nPress Ctrl-C to cancel');
  const record = seedTask(w.config, 'K', { agent: 'kimi', model: 'k3', attemptId: 'current', turnEndedAt: undefined, windowId: pane.id });
  const state = path.join(w.config.stateDir, 'k');
  fs.writeFileSync(path.join(state, 'event.json'), JSON.stringify({ outcome: 'needs-input', at: record.started, text: '' }));
  fs.writeFileSync(path.join(state, 'notified.json'), JSON.stringify({ state: 'needs-input', source: 'watch', at: Date.now() }));
  fs.writeFileSync(path.join(state, 'idle-observation.json'), JSON.stringify({ working: false, idle: 0, attempt: `current::${pane.id}`, observedWork: true }));
  const { ctx } = makeContext(w.config, { respond: tmux.respond });
  assert.equal((await collectStatus(ctx))[0]?.state, 'needs-input');
  fs.mkdirSync(path.dirname(record.report), { recursive: true });
  fs.writeFileSync(record.report, 'Verdict: PASS\n<!-- agentctl:attempt current -->\n<!-- agentctl:report-end -->\n');
  pane.screen = fs.readFileSync(path.join(REPO_ROOT, 'tests/fixtures/screen-kimi-synthetic-relogin-idle.txt'), 'utf8');
  for (let i = 0; i < 3; i++) assert.equal((await collectStatus(ctx))[0]?.state, 'report-ready');
  assert.equal((await collectStatus(makeContext(w.config, { respond: tmux.respond }).ctx))[0]?.state, 'report-ready', 'new reader context needs no restart or event');
});
for (const version of ['2.5.1', '']) it(`records fake kimi --version at start (${version || 'unreadable'}) and uses it in status and usage`, async () => {
  const w = world(`version-${version || 'empty'}`), fake = path.join(w.root, 'fake-kimi');
  fs.writeFileSync(fake, `#!/bin/sh\n[ "$1" = --version ] || exit 99\nprintf '%s\\n' '${version}'\n`, { mode: 0o755 });
  const tmux = new FakeTmux(w.config.session); tmux.newWindowScreen = fs.readFileSync(path.join(REPO_ROOT, 'tests/fixtures/screen-kimi-02-bezczynny.txt'), 'utf8');
  const versionCalls: string[][] = [];
  const { ctx } = makeContext(w.config, { respond: (cmd, args, opts) => {
    if (cmd === 'kimi') { versionCalls.push(args); const r = spawnSync(fake, args, { encoding: 'utf8' }); return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }; }
    return tmux.respond(cmd, args, opts);
  } });
  const spec = resolveSpec({ index: 1, header: { task: 'V', agent: 'kimi', model: 'k3', effort: 'high', repos: [{ path: w.root, worktree: `${w.root}/wt` }] }, prompt: 'Work' }, { config: w.config });
  await newTasks(ctx, [spec], { waitTrust: false, noSwitch: true });
  const record = readTaskRecord(w.config, 'v')!;
  assert.equal(record.agentCliVersion, version || 'unknown');
  assert.ok(versionCalls.some(args => args.join(' ') === '--version'));
  const dir = path.join(w.home, 'sessions/workspace/session_S/agents/main'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'wire.jsonl'), now = Date.parse(record.started) + 1;
  fs.writeFileSync(file, [
    { type: 'metadata', protocol_version: '1.5', cwd: `${w.root}/wt`, session_id: 'S', time: now },
    { type: 'llm.request', modelAlias: 'kimi-code/k3', thinkingEffort: 'high', time: now },
    { type: 'usage.record', inputOther: 2, output: 3, time: now },
  ].map(o => JSON.stringify(o)).join('\n') + '\n');
  await kimi.events.poll!(ctx, record);
  assert.equal(record.observed?.cliVersion, version || 'unknown');
  assert.equal((await collectStatus(ctx)).find(row => row.task === 'V')?.observed?.cliVersion, version || 'unknown');
  assert.equal(collectTaskUsage(w.config, new UsageReader(undefined), [record], now + 1).get('V')?.observed?.cliVersion, version || 'unknown');
  // A fully consumed cursor must not preserve an old unknown observation forever.
  record.observed = { model: 'kimi-code/k3', effort: 'high', cliVersion: 'unknown' };
  await kimi.events.poll!(ctx, record);
  assert.equal(record.observed.cliVersion, version || 'unknown');
});
