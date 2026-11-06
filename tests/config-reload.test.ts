import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ConfigStore, configStatePath, readConfigState } from '../src/core/config-store.ts';
import { loadGlobalConfig } from '../src/core/config.ts';
import type { GlobalConfig } from '../src/core/config.ts';
import { Context } from '../src/core/context.ts';
import { runDoctor } from '../src/core/doctor.ts';
import { readJournal } from '../src/core/journal.ts';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import type { McpDeps } from '../src/core/mcp-tools.ts';
import type { Notifier } from '../src/core/notify.ts';
import { commitQueueAdd, planQueueAdd, readQueue } from '../src/core/queue.ts';
import { RecordingRunner } from '../src/core/runner.ts';
import { splitSpecs } from '../src/core/spec.ts';
import { readTaskRecord } from '../src/core/taskstore.ts';
import { reloadConfig, runWatch, watchLogPath } from '../src/core/watch.ts';
import { DiskRunner, FakeTmux, makeConfig, runCli, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();
const write = (config: GlobalConfig, extra: string): void =>
  fs.writeFileSync(config.path, `cache: ${config.cache}\nstate_dir: ${config.stateDir}\nreport: {settle_s: 0}\nusage:\n  claude_dir: ${config.usage.claudeDir}\n  codex_dir: ${config.usage.codexDir}\n${extra}`);
const loader = (config: GlobalConfig) => () => loadGlobalConfig(path.dirname(config.path));

describe('config store', () => {
  it('unchanged text is no change; a new text comes into force and names the sections that differ', () => {
    const config = makeConfig(scratch.sub('store'), 'limits:\n  claude: 1\n');
    const store = new ConfigStore(loader(config), config);
    assert.equal(store.refresh().changed, false);
    write(config, 'limits:\n  claude: 2\n');
    const r = store.refresh();
    assert.deepEqual([r.changed, r.keys, r.config.limits.claude], [true, ['limits'], 2]);
    assert.equal(store.refresh().changed, false);
  });

  it('a file that does not load leaves the previous settings, warns once, and a good file clears it', () => {
    const config = makeConfig(scratch.sub('store-bad'), 'limits:\n  claude: 1\n');
    const store = new ConfigStore(loader(config), config);
    write(config, 'limits:\n  claude: nope\n');
    const bad = store.refresh();
    assert.match(bad.error ?? '', /previous settings stay in force/);
    assert.equal(bad.config.limits.claude, 1);
    assert.match(bad.config.reloadWarning ?? '', /does not load/);
    const again = store.refresh();
    assert.equal(again.error, undefined, 'the same broken text is reported once');
    assert.ok(again.config.reloadWarning, 'but the warning stays');
    write(config, 'limits:\n  claude: 3\n');
    const good = store.refresh();
    assert.deepEqual([good.config.limits.claude, good.config.reloadWarning], [3, undefined]);
  });

  it('the first load throws when the file is bad (there is nothing to keep)', () => {
    const config = makeConfig(scratch.sub('store-first'));
    write(config, 'limits: 3\n');
    assert.throws(() => new ConfigStore(loader(config)).refresh(), /limits must be a mapping/);
  });
});

/** A runner whose sleep between two ticks lets the test edit the file, like the user does. */
class EditingRunner extends DiskRunner {
  edits: (() => void)[] = [];
  override async sleep(ms: number): Promise<void> {
    await super.sleep(ms);
    this.edits.shift()?.();
  }
}

const spec = (repo: string, task: string): string => `---\ntask: ${task}\nagent: claude\nrepos:\n  - path: ${repo}\n    worktree: ${repo}-${task.toLowerCase()}\n---\nPrompt of ${task}.\n`;

function watched(name: string, extra: string) {
  const root = scratch.sub(name);
  const repo = scratch.sub(`${name}/app`);
  const config = makeConfig(root, extra);
  const tmux = new FakeTmux();
  const runner = new EditingRunner({ dryRun: false, startTime: Date.now(), respond: tmux.respond });
  const out: string[] = [];
  const ctx = new Context(runner, config, (l) => out.push(l));
  const notifier: Notifier = { clickable: false, notify: async () => undefined };
  return { root, repo, config, tmux, runner, out, ctx, notifier };
}

describe('watch reloads the config', () => {
  it('raising a limit from 1 to 2 starts the waiting task at the next tick, without restarting the watcher', async () => {
    const s = watched('watch-raise', 'limits:\n  claude: 1\n');
    s.tmux.add('nc-1', '❯ ');
    seedTask(s.config, 'NC-1');
    const plan = await planQueueAdd(s.ctx, splitSpecs(spec(s.repo, 'NC-2'), 't'), {});
    await commitQueueAdd(s.ctx, plan.items, {});
    s.runner.edits.push(() => write(s.config, 'limits:\n  claude: 2\n'));
    await runWatch(s.ctx, s.notifier, { maxTicks: 2, configStore: new ConfigStore(loader(s.config), s.config) });
    assert.ok(readTaskRecord(s.ctx.config, 'nc-2'), 'NC-2 was started by the same watcher');
    assert.ok(s.tmux.windows.some((w) => w.name === 'nc-2'));
    assert.deepEqual(readQueue(s.ctx.config), []);
    assert.match(fs.readFileSync(watchLogPath(s.ctx), 'utf8'), /config: reloaded \(limits\)/);
    assert.match(readJournal(s.ctx.config).map((e) => e.text).join('\n'), /claude 1 → 2/);
  });

  it('a broken config keeps the old limit, is logged and noted for doctor; the fixed file takes over', async () => {
    const s = watched('watch-bad', 'limits:\n  claude: 1\n');
    s.tmux.add('nc-1', '❯ ');
    seedTask(s.config, 'NC-1');
    const plan = await planQueueAdd(s.ctx, splitSpecs(spec(s.repo, 'NC-2'), 't'), {});
    await commitQueueAdd(s.ctx, plan.items, {});
    s.runner.edits.push(() => write(s.config, 'limits:\n  claude: [broken\n'));
    s.runner.edits.push(() => write(s.config, 'limits:\n  claude: 2\n'));
    const store = new ConfigStore(loader(s.config), s.config);
    await runWatch(s.ctx, s.notifier, { maxTicks: 2, configStore: store });
    assert.equal(readTaskRecord(s.ctx.config, 'nc-2'), undefined, 'the old limit still holds');
    assert.equal(readQueue(s.ctx.config).length, 1);
    assert.match(fs.readFileSync(watchLogPath(s.ctx), 'utf8'), /config: config\.yaml does not load, the previous settings stay in force/);
    const state = readConfigState(configStatePath(s.config));
    assert.deepEqual([state?.ok, state?.by], [false, 'watch']);
    // doctor says so (the file is fine again by now, the watcher has not looked yet)
    write(s.config, 'limits:\n  claude: 2\n');
    const checks = await runDoctor(new RecordingRunner({ dryRun: false }), () => makeConfigAt(s.config), s.root, '22.10.0', 'linux', s.root, {});
    assert.match(checks.find((c) => c.name === 'config reload')?.detail ?? '', /the watch keeps the previous settings/);
    // the next look at the fixed file starts it
    await runWatch(s.ctx, s.notifier, { maxTicks: 1, configStore: store });
    assert.ok(readTaskRecord(s.ctx.config, 'nc-2'));
    assert.equal(readConfigState(configStatePath(s.config))?.ok, true);
  });

  it('keeps the rejection receipt across repeated notifications and ticks until valid text is loaded', async () => {
    const s = watched('watch-rejection-receipt', 'limits: {claude: 1}\n');
    const store = new ConfigStore(loader(s.config), s.config);
    const valid = fs.readFileSync(s.config.path, 'utf8');
    fs.appendFileSync(s.config.path, 'queue: [broken\n');
    await reloadConfig(s.ctx, store);
    const rejected = fs.readFileSync(configStatePath(s.config), 'utf8');
    assert.equal(JSON.parse(rejected).ok, false);
    for (let i = 0; i < 3; i++) {
      const repeated = await reloadConfig(s.ctx, store);
      assert.equal(repeated.error, undefined, 'the same warning is logged only once');
      assert.match(repeated.config.reloadWarning ?? '', /Cannot parse/);
      assert.equal(fs.readFileSync(configStatePath(s.config), 'utf8'), rejected, 'an unchanged broken config must keep its rejection receipt');
    }
    assert.equal(s.out.filter(line => /previous settings stay in force/.test(line)).length, 1);
    fs.writeFileSync(s.config.path, valid);
    await reloadConfig(s.ctx, store);
    assert.equal(readConfigState(configStatePath(s.config))?.ok, true);
  });

  it('every section is reloaded: the poll interval, mcp.allow and notify reach the process in force', async () => {
    const s = watched('watch-all', 'watch:\n  interval: 5\nmcp:\n  allow: [mark]\n');
    const store = new ConfigStore(loader(s.config), s.config);
    write(s.config, 'watch:\n  interval: 9\nmcp:\n  allow: [mark, send]\nnotify:\n  turn_end: false\n');
    const r = await reloadConfig(s.ctx, store);
    assert.deepEqual(r.keys.sort(), ['mcp', 'notify', 'watch']);
    assert.deepEqual([s.ctx.config.watch.interval, s.ctx.config.mcp.allow, s.ctx.config.notify.turnEnd], [9, ['mark', 'send'], false]);
  });
});

/** The config as loaded from disk now. */
function makeConfigAt(config: GlobalConfig): GlobalConfig {
  return loadGlobalConfig(path.dirname(config.path));
}

describe('the MCP server reloads the config on every call', () => {
  it('mcp.allow changes work without restarting the server; a broken file keeps the previous settings and status says so', async () => {
    const config = makeConfig(scratch.sub('mcp-reload'), 'mcp:\n  allow: [mark]\n');
    seedTask(config, 'NC-1');
    const tmux = new FakeTmux();
    let tools: McpDeps | undefined;
    const runner = new DiskRunner({ dryRun: false, respond: tmux.respond });
    const code = await runCli(config, runner, ['mcp', 'serve'], {
      loadConfig: loader(config),
      runMcp: async (t) => {
        tools = t;
      },
    });
    assert.equal(code.code, 0, code.stderr);
    const deps = tools as McpDeps;
    const send = MCP_TOOLS.find((t) => t.name === 'send')!;
    const denied = await send.run(deps, { task: 'NC-1', text: 'hi' } as never);
    assert.equal(denied.isError, true);
    write(config, 'mcp:\n  allow: [mark, send]\n');
    assert.deepEqual(deps.context(() => {}).config.mcp.allow, ['mark', 'send']);
    write(config, 'mcp:\n  allow: [mark, send]\nlimits:\n  claude: -1\n');
    const kept = deps.context(() => {}).config;
    assert.deepEqual(kept.mcp.allow, ['mark', 'send'], 'the previous settings stay');
    assert.match(kept.reloadWarning ?? '', /does not load/);
    const status = await MCP_TOOLS.find((t) => t.name === 'status')!.run(deps, {} as never);
    assert.match(status.text, /Config warning: config\.yaml does not load/);
    assert.equal(readConfigState(configStatePath(config))?.by, 'mcp');
  });

  it('the CLI says that a watcher keeps the previous settings when the file does not load', async () => {
    const config = makeConfig(scratch.sub('cli-hint'));
    const dir = path.dirname(config.path);
    fs.writeFileSync(configStatePath(config), JSON.stringify({ ok: false, at: '2026-11-02T10:00:00.000Z', by: 'watch', error: 'x' }));
    const prev = process.env.AGENTCTL_HOME;
    process.env.AGENTCTL_HOME = dir;
    try {
      const r = await runCli(config, new RecordingRunner({ dryRun: false }), ['status'], { loadConfig: () => { throw new (class extends Error {})('x'); } });
      assert.equal(r.code, 1);
    } finally {
      if (prev === undefined) delete process.env.AGENTCTL_HOME;
      else process.env.AGENTCTL_HOME = prev;
    }
  });
});
