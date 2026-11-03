import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { checkWindowLimit } from '../src/core/checks.ts';
import { DEFAULT_AGENT_SETTINGS } from '../src/core/config.ts';
import { Context } from '../src/core/context.ts';
import { mcpEntryFrom } from '../src/core/mcp-install.ts';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import {
  buildManagerArgv,
  findQr,
  findSessionUrl,
  managerAdvice,
  managerAddress,
  managerFiles,
  managerMcpJson,
  managerSettingsJson,
  managerStateOf,
  managerView,
  readToolNames,
  remoteControlSupport,
  renderManagerRole,
  startManager,
  stopManager,
} from '../src/core/manager.ts';
import { liveWindows } from '../src/core/plan.ts';
import { listTargets } from '../src/core/resolve.ts';
import { agentCommandLine } from '../src/core/agents.ts';
import { RecordingRunner } from '../src/core/runner.ts';
import { collectStatus } from '../src/core/status.ts';
import { DiskRunner, FakeTmux, makeConfig, runCli, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();
const SELF = ['/usr/bin/env', 'AGENTCTL_HOME=/h', '/opt/node/bin/node', '--no-warnings', '/stable/bin/agentctl.ts'];
const HELP = '  --remote-control [name]  Start an interactive session with Remote Control\n  --append-system-prompt <prompt>\n  --effort <level>\n  --bare  ... --append-system-prompt[-file] ...\n';
const IDLE = '❯ Try "fix lint"\n? for shortcuts\n';
const CONNECTED = `${IDLE}  /rc active\n`;

const claude = DEFAULT_AGENT_SETTINGS.claude;
const launch = { name: 'agentctl manager', model: 'sonnet', effort: 'medium', roleFile: '/h/manager/role.md', settingsFile: '/h/manager/settings.json', mcpFile: '/h/manager/mcp.json' };

/** A world: config, a scripted tmux and claude answering --version/--help. */
function world(name: string, yaml = '', screen = CONNECTED, help = HELP) {
  const root = scratch.sub(name);
  const config = makeConfig(root, yaml);
  const tmux = new FakeTmux(config.session);
  tmux.newWindowScreen = screen;
  const runner = new DiskRunner({
    dryRun: false,
    respond: (cmd, args, opts) => {
      if (cmd === 'claude') return args[0] === '--help' ? { stdout: help } : { stdout: '2.1.309 (Claude Code)\n' };
      return tmux.respond(cmd, args, opts);
    },
  });
  const out: string[] = [];
  const ctx = new Context(runner, config, (l) => out.push(l));
  const project = scratch.sub(`${name}-project`);
  return { root, config, tmux, runner, ctx, out, project };
}

describe('manager: the command line', () => {
  it('is an interactive claude with Remote Control, never the server mode', () => {
    const argv = buildManagerArgv(launch, claude);
    assert.deepEqual(argv, [
      'claude', '--model', 'sonnet', '--effort', 'medium',
      '--mcp-config', '/h/manager/mcp.json', '--remote-control', 'agentctl manager', '--settings', '/h/manager/settings.json', '--append-system-prompt-file', '/h/manager/role.md',
    ]);
    assert.notEqual(argv[1], 'remote-control', 'the server mode refuses --settings and cannot carry the role');
    assert.equal(agentCommandLine(argv), "claude --model sonnet --effort medium --mcp-config /h/manager/mcp.json --remote-control 'agentctl manager' --settings /h/manager/settings.json --append-system-prompt-file /h/manager/role.md");
  });

  it('gives the name explicitly, so --remote-control cannot swallow the next flag', () => {
    const argv = buildManagerArgv(launch, claude);
    assert.equal(argv[argv.indexOf('--remote-control') + 1], 'agentctl manager');
    assert.ok(argv[argv.indexOf('--mcp-config') + 2]?.startsWith('--'), 'the variadic --mcp-config is followed by a flag');
  });

  it('omits --model for "default", follows agents.claude.flags and effort_args, and never adds an auto-accept flag', () => {
    const argv = buildManagerArgv({ ...launch, model: 'default' }, { flags: ['--verbose'], effortArgs: [] });
    assert.deepEqual(argv.slice(0, 3), ['claude', '--verbose', '--mcp-config']);
    for (const bad of ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--permission-mode', '--bare']) assert.ok(!argv.includes(bad), bad);
  });

  it('needs --remote-control and the role file flag in the help of claude', () => {
    assert.deepEqual(remoteControlSupport(HELP), { remoteControl: true, roleFile: true });
    assert.deepEqual(remoteControlSupport('  --effort <level>\n'), { remoteControl: false, roleFile: false });
    assert.equal(remoteControlSupport('--append-system-prompt-file <file>').roleFile, true);
  });
});

describe('manager: the files', () => {
  it('lets only the read tools through without a tap, and names the server like mcp install', () => {
    const settings = JSON.parse(managerSettingsJson()) as { permissions: { allow: string[] } };
    const writes = MCP_TOOLS.filter((t) => t.kind === 'write').map((t) => `mcp__agentctl__${t.name}`);
    assert.ok(settings.permissions.allow.includes('mcp__agentctl__status'));
    assert.ok(settings.permissions.allow.includes('mcp__agentctl__events_since'));
    assert.deepEqual(settings.permissions.allow.filter((a) => writes.includes(a)), [], 'a tool that changes something is asked about');
    assert.equal(settings.permissions.allow.length, readToolNames().length);
    const mcp = JSON.parse(managerMcpJson(mcpEntryFrom(SELF))) as { mcpServers: Record<string, { type: string; command: string; args: string[]; env: Record<string, string> }> };
    assert.deepEqual(Object.keys(mcp.mcpServers), ['agentctl']);
    assert.deepEqual(mcp.mcpServers.agentctl, { type: 'stdio', command: '/opt/node/bin/node', args: ['--no-warnings', '/stable/bin/agentctl.ts', 'mcp'], env: { AGENTCTL_HOME: '/h' } });
  });

  it('the role: events first, consent for every change, short summaries, no merge or push', () => {
    const role = renderManagerRole({ name: 'agentctl manager', allowedWrites: ['send', 'new'] });
    assert.match(role, /events_since/);
    assert.match(role, /then `status`/);
    assert.match(role, /Available write tools: send, new/);
    assert.match(role, /at most 6 lines/);
    assert.match(role, /Do not merge, rebase, push/);
    assert.match(role, /Do not edit files of the project/);
    assert.doesNotMatch(role, /Additional manager guide/);
    assert.match(renderManagerRole({ name: 'm', allowedWrites: [] }), /none \(the server is read-only for now\)/);
  });

  it('appends the guide when there is one, cut at the limit', () => {
    const role = renderManagerRole({ name: 'm', allowedWrites: [], guide: '# Spec guide\nUse short prompts.\n' });
    assert.match(role, /## Additional manager guide[\s\S]*Use short prompts\./);
    assert.match(renderManagerRole({ name: 'm', allowedWrites: [], guide: 'x'.repeat(70_000) }), /\[cut: the guide is longer than 60000 characters\]/);
  });
});

describe('manager: reading the screen', () => {
  const s = { readyPattern: claude.readyPattern, trustPattern: claude.trustPattern };
  it('tells the state from what Claude Code shows', () => {
    assert.equal(managerStateOf('Starting…', s), 'starting');
    assert.equal(managerStateOf(IDLE, s), 'waiting');
    assert.equal(managerStateOf(CONNECTED, s), 'connected');
    assert.equal(managerStateOf('Quick safety check: Is this a project you trust?\n❯ 1. Yes, I trust this folder', s), 'confirm');
    assert.equal(managerStateOf('Enable Remote Control? (y/n)', s), 'confirm');
    assert.equal(managerStateOf(`${IDLE}Remote Control failed: not logged in`, s), 'failed');
    assert.equal(managerStateOf(`${CONNECTED}Remote Control disconnected`, s), 'failed');
    assert.equal(managerStateOf(`${IDLE}/config: Enable Remote Control for all sessions: false`, s), 'waiting', 'the /config row is not the dialog');
  });

  it('finds the session address and the QR code', () => {
    const url = 'https://claude.ai/code/session_01AbCd?x=1';
    assert.equal(findSessionUrl(`foo\n  ${url}\nbar`), url);
    assert.equal(findSessionUrl(`(${url}).`), url);
    assert.equal(findSessionUrl('nothing here'), undefined);
    const qr = Array.from({ length: 14 }, (_, i) => `  ${i % 2 ? '█▀▀ ▄▄█ ▀█ ▄▀▄ █▀▀█' : '█ ▄▄ █▀ ▄ ▀█▄▀ ▄ █ ▄▄█'}  `);
    assert.equal(findQr(`header\n${qr.join('\n')}\nfooter`).length, 14);
    assert.deepEqual(findQr('█▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\nshort run'), []);
  });
});

describe('manager: start, look, stop', () => {
  it('makes the window "manager" in the project, types the command and writes the files', async () => {
    const w = world('start-1');
    const result = await startManager(w.ctx, { project: w.project, self: SELF });
    assert.equal(result.action, 'started');
    assert.equal(result.state, 'connected');
    assert.deepEqual(w.tmux.windows.map((x) => x.name), ['manager']);
    const files = managerFiles(w.config);
    assert.ok(files.dir.endsWith('/manager'));
    assert.equal(fs.readFileSync(files.mcp, 'utf8').includes('"agentctl"'), true);
    assert.match(fs.readFileSync(files.role, 'utf8'), /Manager appendix/);
    assert.equal(JSON.parse(fs.readFileSync(files.settings, 'utf8')).permissions.allow.includes('mcp__agentctl__status'), true);
    const created = w.runner.commands.find((c) => c.includes('new-session'));
    assert.match(created ?? '', new RegExp(`-n manager -c ${w.project}`));
    const typed = w.runner.commands.find((c) => c.includes('send-keys') && c.includes('--remote-control'));
    // the recorded line is quoted once more, as tmux gets it
    assert.match(typed ?? '', /claude --model sonnet --effort medium --mcp-config .*manager\/mcp\.json --remote-control '\\''agentctl manager'\\'' --settings .*settings\.json --append-system-prompt-file .*role\.md/);
    assert.match(managerAdvice(w.ctx, result).join('\n'), /connected.*tap Code/);
  });

  it('takes the config: project, name, model, effort and the guide', async () => {
    const guide = scratch.sub('guide-dir');
    fs.writeFileSync(`${guide}/g.md`, 'GUIDE-TEXT\n');
    const w = world('start-2', `manager:\n  project: ${scratch.sub('start-2-cfg-project')}\n  name: Dyspozytor\n  model: opus\n  effort: high\n  guide: ${guide}/g.md\nmcp:\n  allow: [send]\n`);
    const result = await startManager(w.ctx, { self: SELF });
    assert.equal(result.project, scratch.sub('start-2-cfg-project'));
    assert.match(result.command, /--model opus --effort high .*--remote-control Dyspozytor /);
    const role = fs.readFileSync(managerFiles(w.config).role, 'utf8');
    assert.match(role, /GUIDE-TEXT/);
    assert.match(role, /Available write tools: send/);
    // flags win over the config
    const w2 = world('start-3');
    const r2 = await startManager(w2.ctx, { project: w2.project, name: 'N', model: 'haiku', effort: 'low', self: SELF });
    assert.match(r2.command, /--model haiku --effort low .*--remote-control N /);
  });

  it('never starts a second copy', async () => {
    const w = world('start-4');
    await startManager(w.ctx, { project: w.project, self: SELF });
    const before = w.runner.commands.length;
    const again = await startManager(w.ctx, { project: w.project, self: SELF });
    assert.equal(again.action, 'exists');
    assert.equal(again.state, 'connected');
    assert.equal(w.tmux.windows.filter((x) => x.name === 'manager').length, 1);
    assert.equal(w.runner.commands.length, before, 'no tmux command, no file written');
  });

  it('does not answer a dialog: trust and "Enable Remote Control" are left to you', async () => {
    const w = world('start-5', '', 'Quick safety check: Is this a project you trust?\n❯ 1. Yes, I trust this folder\n');
    const result = await startManager(w.ctx, { project: w.project, self: SELF });
    assert.equal(result.state, 'confirm');
    const advice = managerAdvice(w.ctx, result).join('\n');
    assert.match(advice, /Enable Remote Control/);
    assert.match(advice, /agentctl never answers/);
    assert.match(advice, /select-window -t manager/);
    assert.equal(w.runner.commands.filter((c) => /send-keys .*(Enter|y\b)/.test(c) && !c.includes('--remote-control')).length, 1, 'only the Enter after the command line');
  });

  it('reports the connection that has not come yet, and a failure', async () => {
    const waiting = world('start-6', '', IDLE);
    const r1 = await startManager(waiting.ctx, { project: waiting.project, self: SELF });
    assert.equal(r1.state, 'waiting');
    assert.match(managerAdvice(waiting.ctx, r1).join('\n'), /has not connected yet/);
    const failed = world('start-7', '', `${IDLE}Remote Control failed: log in with claude.ai\n`);
    const r2 = await startManager(failed.ctx, { project: failed.project, self: SELF });
    assert.equal(r2.state, 'failed');
    assert.match(managerAdvice(failed.ctx, r2).join('\n'), /claude auth login/);
  });

  it('refuses a claude without the flags, a missing folder and a missing claude', async () => {
    const old = world('start-8', '', CONNECTED, '  --effort <level>\n');
    await assert.rejects(startManager(old.ctx, { project: old.project, self: SELF }), /no --remote-control flag/);
    assert.equal(old.tmux.windows.length, 0, 'no window was made');
    const noRole = world('start-9', '', CONNECTED, '  --remote-control [name]\n');
    await assert.rejects(startManager(noRole.ctx, { project: noRole.project, self: SELF }), /no --append-system-prompt-file/);
    const w = world('start-10');
    await assert.rejects(startManager(w.ctx, { project: `${w.project}/nope`, self: SELF }), /does not exist/);
    const gone = world('start-11');
    const ctx = new Context(new RecordingRunner({ dryRun: false, respond: (cmd) => (cmd === 'claude' ? { code: 127 } : undefined) }), gone.config, () => {});
    await assert.rejects(startManager(ctx, { project: gone.project, self: SELF }), /claude not found/);
  });

  it('a missing guide file is a warning, not a failure', async () => {
    const w = world('start-12', `manager:\n  guide: ${scratch.sub('start-12-g')}/nope.md\n`);
    await startManager(w.ctx, { project: w.project, self: SELF });
    assert.match(w.out.join('\n'), /warning: manager\.guide .* cannot be read/);
    assert.doesNotMatch(fs.readFileSync(managerFiles(w.config).role, 'utf8'), /Additional manager guide/);
  });

  it('writes nothing and starts nothing in a dry run', async () => {
    const w = world('start-13');
    const runner = new RecordingRunner({ dryRun: true });
    const ctx = new Context(runner, w.config, () => {});
    const result = await startManager(ctx, { project: w.project, self: SELF });
    assert.equal(result.action, 'started');
    assert.ok(runner.commands.some((c) => c.includes('new-session') && c.includes('manager')));
    assert.equal(w.tmux.windows.length, 0);
    assert.equal(fs.existsSync(managerFiles(w.config).role), false);
  });

  it('--url reads the address from the window; stop closes only that window', async () => {
    const w = world('url-1');
    await startManager(w.ctx, { project: w.project, self: SELF });
    assert.equal((await managerAddress(w.ctx)).url, undefined);
    w.tmux.find(`=${w.config.session}:manager`)!.screen = `${CONNECTED}Session: https://claude.ai/code/session_01XyZ\n`;
    const a = await managerAddress(w.ctx);
    assert.equal(a.url, 'https://claude.ai/code/session_01XyZ');
    assert.equal(a.view.state, 'connected');
    w.tmux.add('watch', 'x');
    assert.equal(await stopManager(w.ctx), 'stopped');
    assert.deepEqual(w.tmux.windows.map((x) => x.name), ['watch']);
    assert.equal(await stopManager(w.ctx), 'not-running');
    assert.equal((await managerView(w.ctx)).state, 'missing');
    assert.equal((await managerAddress(w.ctx)).url, undefined);
  });
});

describe('manager: not a task', () => {
  it('is no orphan in status, no target of task commands and no place against the limits', async () => {
    const w = world('not-task', 'limits:\n  claude: 1\n');
    await startManager(w.ctx, { project: w.project, self: SELF });
    assert.deepEqual(await collectStatus(w.ctx, { progress: false }), [], 'no row for the manager');
    assert.deepEqual(await listTargets(w.ctx), []);
    const live = await liveWindows(w.ctx);
    assert.deepEqual(live.filter((x) => x.agent !== undefined), []);
    assert.equal(checkWindowLimit('claude', 1, live, w.config.session), undefined, 'the one place of claude is still free');
    // a task window next to it uses the place, the manager does not add to it
    seedTask(w.config, 'AB-1');
    w.tmux.add('ab-1', IDLE);
    const both = await liveWindows(w.ctx);
    assert.match(checkWindowLimit('claude', 1, both, w.config.session) ?? '', /1 of 1 .*\(ab-1\)/);
  });
});

describe('manager: the command', () => {
  it('start, again, --url, stop through the CLI', async () => {
    const w = world('cli-1');
    const extra = { selfArgv: () => SELF };
    const started = await runCli(w.config, w.runner, ['manager', '--project', w.project], extra);
    assert.equal(started.code, 0, started.stderr);
    assert.match(started.stdout, /The manager "agentctl manager" runs in window agentctl:manager/);
    assert.match(started.stdout, /is connected/);
    const again = await runCli(w.config, w.runner, ['manager'], extra);
    assert.match(again.stdout, /already running .*left alone: połączony/);
    const url = await runCli(w.config, w.runner, ['manager', '--url'], extra);
    assert.match(url.stdout, /not on the screen[\s\S]*\/remote-control/);
    const stop = await runCli(w.config, w.runner, ['manager', 'stop'], extra);
    assert.match(stop.stdout, /The manager is stopped/);
    assert.match((await runCli(w.config, w.runner, ['manager', 'stop'], extra)).stdout, /not running/);
    const missing = await runCli(w.config, w.runner, ['manager', '--url'], extra);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /the manager is not running/);
  });

  it('--dry-run prints the commands and changes nothing', async () => {
    const w = world('cli-2');
    const runner = new RecordingRunner({ dryRun: true, emit: () => {} });
    const r = await runCli(w.config, runner, ['manager', '--project', w.project, '--dry-run'], { selfArgv: () => SELF, makeRunner: () => runner });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(runner.commands.some((c) => c.includes('--remote-control')));
    assert.equal(w.tmux.windows.length, 0);
  });
});
