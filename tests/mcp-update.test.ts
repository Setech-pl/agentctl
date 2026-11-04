import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { z } from 'zod';
import { loadGlobalConfig } from '../src/core/config.ts';
import { Context } from '../src/core/context.ts';
import { runDoctor } from '../src/core/doctor.ts';
import { findMcpProcesses, parsePs, STALE_MCP_MESSAGE, staleProcesses, staleWarning } from '../src/core/mcp-processes.ts';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import type { McpDeps, McpToolDef, ToolResult } from '../src/core/mcp-tools.ts';
import { RecordingRunner } from '../src/core/runner.ts';
import { FakeTmux, makeConfig, runCli, useScratch } from './helpers.ts';

const scratch = useScratch();
const tool = (name: string): McpToolDef => MCP_TOOLS.find((t) => t.name === name) as McpToolDef;

/** A stable copy on disk, updated at `updated` (ms). */
function stableCopy(name: string, version: string, updated: number): { root: string; script: string } {
  const root = scratch.sub(`${name}/agentctl-stable`);
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'agentctl', version }));
  const script = path.join(root, 'bin', 'agentctl.ts');
  fs.writeFileSync(script, '');
  for (const f of [path.join(root, 'package.json'), path.join(root, 'node_modules')]) fs.utimesSync(f, updated / 1000, updated / 1000);
  return { root, script };
}

/** `ps -axww -o pid=,lstart=,command=` as the fake machine prints it. */
const psLine = (pid: number, started: Date, command: string): string => {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const two = (n: number): string => String(n).padStart(2, '0');
  const lstart = `${days[started.getDay()]} ${months[started.getMonth()]} ${String(started.getDate()).padStart(2)} ${two(started.getHours())}:${two(started.getMinutes())}:${two(started.getSeconds())} ${started.getFullYear()}`;
  return `${String(pid).padStart(5)} ${lstart} ${command}`;
};

const NODE = '/opt/homebrew/bin/node --experimental-strip-types --no-warnings';

describe('mcp: lenient allow list', () => {
  // The stable copy these tests compare with is a throwaway one of the same version, never the real ~/Projects/agentctl-stable.
  let saved: string | undefined;
  before(() => {
    saved = process.env.AGENTCTL_STABLE_DIR;
    process.env.AGENTCTL_STABLE_DIR = stableCopy('len-stable', '0.10.0', Date.now()).root;
  });
  after(() => {
    if (saved === undefined) delete process.env.AGENTCTL_STABLE_DIR;
    else process.env.AGENTCTL_STABLE_DIR = saved;
  });

  function setup(name: string, yaml: string) {
    const root = scratch.sub(name);
    const config = makeConfig(root, yaml);
    const tmux = new FakeTmux();
    const runner = new RecordingRunner({ dryRun: false, respond: tmux.respond });
    const deps: McpDeps = {
      context: (out) => new Context(runner, loadGlobalConfig(path.dirname(config.path)), out),
      notify: async () => {},
      server: { version: '0.10.0', script: '/stable/bin/agentctl.ts', pid: 4242, started: '2026-11-02T08:00:00.000Z' },
    };
    const call = (n: string, args: Record<string, unknown> = {}): Promise<ToolResult> => tool(n).run(deps, z.object(tool(n).input).parse(args) as never);
    return { root, config, call };
  }

  it('an unknown name in mcp.allow does not take the server down: it is ignored, the others stay, status warns', async () => {
    const t = setup('len1', 'mcp: {allow: [future_tool, send, cancel]}\n');
    assert.deepEqual(t.config.mcp.allow, ['send', 'cancel']);
    const r = await t.call('status');
    assert.equal(r.isError, undefined);
    assert.match(r.text, /^No tasks\n/);
    assert.match(r.text, /Config warning: config\.mcp\.allow: "future_tool" is not a write tool of this version, ignored/);
    // the write tools that are known still work
    assert.match((await t.call('send', { task: 'NC-1', text: 'hi' })).text, /no task|No tasks|unknown/i);
  });

  it('an unknown key, a wrong type and a section that is not a mapping are warnings too', () => {
    const w = (yaml: string): string[] => makeConfig(scratch.sub(`len-${yaml.length}`), yaml).mcp.warnings;
    assert.match(w('mcp: {allow: [send], shell: true}\n').join(), /unknown key "shell".*: ignored/);
    assert.match(w('mcp: {allow: send}\n').join(), /config\.mcp\.allow.*: ignored/);
    assert.match(w('mcp: {allow_rm_worktree: maybe}\n').join(), /allow_rm_worktree must be true or false: ignored/);
    assert.match(w('mcp: 5\n').join(), /config\.mcp must be a mapping.*ignored, writing is off/);
    assert.deepEqual(makeConfig(scratch.sub('len-ok'), 'mcp: {allow: [send, queue]}\n').mcp.warnings, []);
  });

  it('only a config that cannot be read at all is an error', () => {
    assert.throws(() => makeConfig(scratch.sub('len-bad1'), 'mcp: {allow: [send]\n'), /Cannot parse/);
    assert.throws(() => makeConfig(scratch.sub('len-bad3'), 'limits: {claude: nope}\n'), /limits\.claude/);
  });

  it('status and version name the version and the script of the running server', async () => {
    const t = setup('len2', '');
    const status = await t.call('status');
    assert.match(status.text, /MCP server: agentctl 0\.10\.0 \(\/stable\/bin\/agentctl\.ts, pid 4242, started 2026-11-02T08:00:00\.000Z\)/);
    const v = JSON.parse((await t.call('version')).text.split('\n\n')[0] as string) as { version: string; script: string; pid: number; writeToolsAllowed: string[]; configWarnings: string[] };
    assert.deepEqual([v.version, v.script, v.pid, v.writeToolsAllowed, v.configWarnings], ['0.10.0', '/stable/bin/agentctl.ts', 4242, [], []]);
    assert.equal(tool('version').kind, 'read');
    const warned = setup('len3', 'mcp: {allow: [nope]}\n');
    assert.deepEqual((JSON.parse((await warned.call('version')).text) as { configWarnings: string[] }).configWarnings.length, 1);
  });

  it('a server that is older than the stable copy on disk says so', async () => {
    const t = setup('len4', '');
    const stable = stableCopy('len4', '0.11.0', Date.now());
    const before = process.env.AGENTCTL_STABLE_DIR;
    process.env.AGENTCTL_STABLE_DIR = stable.root;
    try {
      assert.match((await t.call('status')).text, /środowisko dev/);
      const v = await t.call('version');
      assert.match(v.text, /"older": false/);
      assert.match(v.text, /środowisko dev/);
    } finally {
      if (before === undefined) delete process.env.AGENTCTL_STABLE_DIR;
      else process.env.AGENTCTL_STABLE_DIR = before;
    }
  });
});

describe('mcp: an old server process after agentctl-update', () => {
  const T0 = Date.UTC(2026, 10, 2, 10, 0, 0);

  it('parsePs finds the server, not "mcp install", not other commands', () => {
    const out = [
      psLine(100, new Date(T0), `${NODE} /Users/m/Projects/agentctl-stable/bin/agentctl.ts mcp`),
      psLine(101, new Date(T0), `${NODE} /Users/m/Projects/agentctl-stable/bin/agentctl.ts mcp serve`),
      psLine(102, new Date(T0), `${NODE} /Users/m/Projects/agentctl-stable/bin/agentctl.ts mcp install --desktop`),
      psLine(103, new Date(T0), `${NODE} /Users/m/Projects/agentctl-stable/bin/agentctl.ts watch`),
      psLine(104, new Date(T0), '/bin/zsh -c grep agentctl mcp notes'),
      'garbage line',
    ].join('\n');
    assert.deepEqual(parsePs(out).map((p) => [p.pid, path.basename(p.script)]), [[100, 'agentctl.ts'], [101, 'agentctl.ts']]);
    assert.equal(parsePs(out)[0]?.started, new Date(T0).getTime());
  });

  it('a process that started before the stable copy was updated is old; one that started after is not; another script is left alone', async () => {
    const stable = stableCopy('old1', '0.10.0', T0);
    const dev = stableCopy('old1dev', '0.10.0', T0);
    const procs = parsePs(
      [
        psLine(100, new Date(T0 - 3600_000), `${NODE} ${stable.script} mcp`),
        psLine(101, new Date(T0 + 60_000), `${NODE} ${stable.script} mcp`),
        psLine(102, new Date(T0 - 3600_000), `${NODE} ${dev.script} mcp`),
      ].join('\n'),
    );
    const stale = staleProcesses(procs, stable.script);
    assert.deepEqual(stale.map((p) => p.pid), [100]);
    const warning = staleWarning(stale, stable.script) ?? '';
    assert.ok(warning.startsWith(STALE_MCP_MESSAGE));
    assert.match(warning, /pid 100; the stable copy is now 0\.10\.0; agentctl does not stop it for you/);
    assert.equal(staleWarning([], stable.script), undefined);
  });

  it('a symbolic link to the stable script counts as the stable script (the global command is one)', () => {
    const stable = stableCopy('old2', '0.10.0', T0);
    const link = path.join(scratch.sub('old2/bin'), 'agentctl');
    fs.symlinkSync(stable.script, link);
    const procs = parsePs(psLine(100, new Date(T0 - 1000), `${NODE} ${link} mcp`));
    assert.deepEqual(staleProcesses(procs, stable.script).map((p) => p.pid), [100]);
  });

  it('findMcpProcesses asks ps through the runner (a dry run asks nothing)', async () => {
    const runner = new RecordingRunner({ dryRun: false, respond: (cmd, args) => (cmd === 'ps' && args[0] === '-axww' ? { stdout: psLine(7, new Date(T0), `${NODE} /s/bin/agentctl.ts mcp`) } : undefined) });
    assert.deepEqual((await findMcpProcesses(runner)).map((p) => p.pid), [7]);
    assert.deepEqual(await findMcpProcesses(new RecordingRunner({ dryRun: true })), []);
  });

  it('doctor warns about an old server and about the config; a current server is a plain ok', async () => {
    const stable = stableCopy('doc1', '0.10.0', T0);
    const home = scratch.sub('doc1/home');
    const config = makeConfig(scratch.sub('doc1'), 'mcp: {allow: [send, nope]}\n');
    const run = async (ps: string) => {
      const runner = new RecordingRunner({ dryRun: false, respond: (cmd) => (cmd === 'ps' ? { stdout: ps } : cmd === 'claude' ? { code: 1 } : undefined) });
      return (await runDoctor(runner, () => config, home, '26.0.0', 'darwin', home, { AGENTCTL_STABLE_DIR: stable.root })).filter((c) => c.name.startsWith('mcp'));
    };
    const old = await run(psLine(100, new Date(T0 - 3600_000), `${NODE} ${stable.script} mcp`));
    const server = old.find((c) => c.name === 'mcp server');
    assert.equal(server?.status, 'ok');
    assert.match(server?.detail ?? '', /środowisko dev/);
    const cfg = old.find((c) => c.name === 'mcp config');
    assert.equal(cfg?.status, 'warn');
    assert.match(cfg?.detail ?? '', /"nope" is not a write tool of this version, ignored/);
    const fresh = await run(psLine(100, new Date(T0 + 3600_000), `${NODE} ${stable.script} mcp`));
    assert.equal(fresh.find((c) => c.name === 'mcp server')?.status, 'ok');
    assert.match((await run('')).find(c => c.name === 'mcp server')?.detail ?? '', /środowisko dev/);
  });

  it('agentctl mcp check prints the warning, or says all is current; it stops nothing', async () => {
    const stable = stableCopy('chk1', '0.10.0', T0);
    const config = makeConfig(scratch.sub('chk1'));
    const env = process.env.AGENTCTL_STABLE_DIR;
    process.env.AGENTCTL_STABLE_DIR = stable.root;
    try {
      const mk = (ps: string) => new RecordingRunner({ dryRun: false, respond: (cmd) => (cmd === 'ps' ? { stdout: ps } : undefined) });
      const old = mk(psLine(100, new Date(T0 - 3600_000), `${NODE} ${stable.script} mcp`));
      const r = await runCli(config, old, ['mcp', 'check']);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /^warning: serwer MCP w aplikacji działa na starej wersji – zamknij aplikację Claude \(⌘Q\) i otwórz ponownie/);
      assert.ok(!old.commands.some((c) => /^kill|pkill/.test(c)), 'nothing is killed');
      const ok = await runCli(config, mk(''), ['mcp', 'check']);
      assert.match(ok.stdout, /No MCP server process runs older code than the stable copy\./);
    } finally {
      if (env === undefined) delete process.env.AGENTCTL_STABLE_DIR;
      else process.env.AGENTCTL_STABLE_DIR = env;
    }
  });
});
