import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { runDoctor } from '../src/core/doctor.ts';
import { blockingEnv, managerFiles, readManagerMcp } from '../src/core/manager.ts';
import { DiskRunner, FakeTmux, makeConfig, runCli, useScratch } from './helpers.ts';

const scratch = useScratch();
const SELF = ['/usr/bin/env', 'AGENTCTL_HOME=/h', '/opt/node/bin/node', '--no-warnings', '/stable/bin/agentctl.ts'];
const HELP = '  --remote-control [name]  Start an interactive session with Remote Control\n  --effort <level>\n  --bare ... --append-system-prompt[-file] ...\n';
const CONNECTED = '❯ Try "x"\n  /rc active\n';

function world(name: string, yaml = '', help = HELP, screen = CONNECTED) {
  const root = scratch.sub(name);
  const project = scratch.sub(`${name}-project`);
  const config = makeConfig(root, yaml.replaceAll('PROJECT', project));
  const tmux = new FakeTmux(config.session);
  tmux.newWindowScreen = screen;
  const runner = new DiskRunner({
    dryRun: false,
    respond: (cmd, args, opts) => {
      if (cmd === 'claude') return args[0] === '--help' ? { stdout: help } : args[0] === '--version' ? { stdout: '2.1.309 (Claude Code)\n' } : { code: 1 };
      return tmux.respond(cmd, args, opts);
    },
  });
  return { root, project, config, tmux, runner };
}

const up = (w: ReturnType<typeof world>) => runCli(w.config, w.runner, ['up', '--no-attach'], { selfArgv: () => SELF });

describe('up: the manager', () => {
  it('without manager.autostart up starts the watcher and the board only', async () => {
    const w = world('up-1');
    const r = await up(w);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(w.tmux.windows.map((x) => x.name).sort(), ['board', 'watch']);
    assert.doesNotMatch(r.stdout, /Manager/);
  });

  it('with manager.autostart: true it starts the manager as well, without waiting, and never a second copy', async () => {
    const w = world('up-2', 'manager:\n  autostart: true\n  project: PROJECT\n');
    const first = await up(w);
    assert.equal(first.code, 0, first.stderr);
    assert.deepEqual(w.tmux.windows.map((x) => x.name).sort(), ['board', 'manager', 'watch']);
    assert.match(first.stdout, /Manager: started in window agentctl:manager, in .*up-2-project\. The first time, answer the folder trust and "Enable Remote Control"/);
    assert.ok(w.runner.commands.some((c) => c.includes('send-keys') && c.includes('exec sh')), 'the command was typed');
    assert.equal(w.runner.queries.filter((q) => q.includes('capture-pane')).length, 0, 'nothing was waited for: no screen was read');
    assert.ok(fs.existsSync(managerFiles(w.config).role));
    const second = await up(w);
    assert.match(second.stdout, /Manager: already running in window agentctl:manager \(połączony\), left alone/);
    assert.equal(w.tmux.windows.filter((x) => x.name === 'manager').length, 1);
  });

  it('a manager that cannot start is a line, not the end of up', async () => {
    const w = world('up-3', 'manager:\n  autostart: true\n  project: PROJECT\n', '  --effort <level>\n');
    const r = await up(w);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Manager: not started - this Claude Code has no --remote-control flag/);
    assert.deepEqual(w.tmux.windows.map((x) => x.name).sort(), ['board', 'watch']);
    assert.match(r.stdout, /Open the board: tmux attach/);
    const noProject = world('up-4', 'manager:\n  autostart: true\n  project: /nowhere/at/all\n');
    assert.match((await up(noProject)).stdout, /Manager: not started - the manager directory \/nowhere\/at\/all does not exist/);
  });
});

describe('doctor: Remote Control and the manager', () => {
  const run = async (w: ReturnType<typeof world>, env: NodeJS.ProcessEnv = {}) =>
    runDoctor(w.runner, () => w.config, scratch.dir, '22.12.0', 'linux', scratch.dir, env);
  const pick = (checks: Awaited<ReturnType<typeof run>>, name: string) => checks.find((c) => c.name === name);

  it('claude with --remote-control and the role flag: ok; without: a warning that says what to do', async () => {
    const ok = await run(world('d-1'));
    assert.equal(pick(ok, 'claude remote control')?.status, 'ok');
    const old = await run(world('d-2', '', '  --effort <level>\n'));
    assert.equal(pick(old, 'claude remote control')?.status, 'warn');
    assert.match(pick(old, 'claude remote control')?.detail ?? '', /no --remote-control flag.*claude update/);
    const half = await run(world('d-3', '', '  --remote-control [name]\n'));
    assert.match(pick(half, 'claude remote control')?.detail ?? '', /no --append-system-prompt-file/);
  });

  it('an API key or a gateway in the environment is a warning: Claude Code refuses Remote Control then', async () => {
    assert.deepEqual(blockingEnv({ ANTHROPIC_API_KEY: 'sk-x', ANTHROPIC_BASE_URL: '', HOME: '/h' }), ['ANTHROPIC_API_KEY']);
    const c = pick(await run(world('d-4'), { ANTHROPIC_API_KEY: 'sk-x', ANTHROPIC_BASE_URL: 'https://gw' }), 'claude remote control');
    assert.equal(c?.status, 'warn');
    assert.match(c?.detail ?? '', /ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL are set here/);
    assert.ok(!(c?.detail ?? '').includes('sk-x'), 'the value is never printed');
  });

  it('the manager: not running is ok (optional) and a warning with autostart; connected, waiting and a failure are said', async () => {
    const none = pick(await run(world('d-5')), 'manager');
    assert.equal(none?.status, 'ok');
    assert.match(none?.detail ?? '', /not running \(optional\): agentctl manager/);
    const auto = pick(await run(world('d-6', 'manager:\n  autostart: true\n')), 'manager');
    assert.equal(auto?.status, 'warn');
    assert.match(auto?.detail ?? '', /manager\.autostart is on, but it is not running/);
    const w = world('d-7');
    w.tmux.add('manager', CONNECTED);
    assert.equal(pick(await run(w), 'manager')?.status, 'ok');
    assert.match(pick(await run(w), 'manager')?.detail ?? '', /connected to Remote Control/);
    const waiting = world('d-8');
    waiting.tmux.add('manager', '❯ Try "x"\n');
    assert.match(pick(await run(waiting), 'manager')?.detail ?? '', /czeka na połączenie/);
    assert.equal(pick(await run(waiting), 'manager')?.status, 'warn');
  });

  it('a missing project or guide of the manager is named', async () => {
    const c = pick(await run(world('d-9', 'manager:\n  project: /nowhere\n  guide: /nowhere/g.md\n')), 'manager');
    assert.equal(c?.status, 'warn');
    assert.match(c?.detail ?? '', /manager\.project \/nowhere does not exist/);
    assert.match(c?.detail ?? '', /manager\.guide \/nowhere\/g\.md does not exist/);
  });

  it('the MCP server for Claude Code: before the first start it says where it comes from; after, it checks the files exist', async () => {
    const w = world('d-10');
    assert.match(pick(await run(w), 'manager mcp')?.detail ?? '', /--mcp-config.*agentctl mcp install --claude-code/);
    await runCli(w.config, w.runner, ['manager', '--project', w.project], { selfArgv: () => SELF });
    assert.deepEqual(readManagerMcp(w.config), { command: '/opt/node/bin/node', script: '/stable/bin/agentctl.ts' });
    const missing = pick(await run(w), 'manager mcp');
    assert.equal(missing?.status, 'warn');
    assert.match(missing?.detail ?? '', /\/opt\/node\/bin\/node, \/stable\/bin\/agentctl\.ts, which does not exist/);
    const real = fs.realpathSync(process.execPath);
    fs.writeFileSync(managerFiles(w.config).mcp, JSON.stringify({ mcpServers: { agentctl: { type: 'stdio', command: real, args: [process.argv[1] ?? real, 'mcp'] } } }));
    assert.equal(pick(await run(w), 'manager mcp')?.status, 'ok');
    assert.equal(new Context(w.runner, w.config, () => {}).config.manager.name, 'agentctl manager');
  });
});
