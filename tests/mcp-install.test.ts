import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runDoctor } from '../src/core/doctor.ts';
import { Context } from '../src/core/context.ts';
import {
  backupPath,
  claudeAddArgs,
  describeAllow,
  desktopConfigPath,
  installClaudeCode,
  installDesktop,
  lineDiff,
  mcpEntryFrom,
  pointsAtStable,
  readClaudeCodeRegistration,
  readDesktopRegistration,
  stableScript,
  uninstallClaudeCode,
  uninstallDesktop,
} from '../src/core/mcp-install.ts';
import type { McpEntry } from '../src/core/mcp-install.ts';
import { RecordingRunner } from '../src/core/runner.ts';
import { DiskRunner, makeConfig, runCli, useScratch } from './helpers.ts';

const scratch = useScratch();
const SELF = ['/usr/bin/env', 'AGENTCTL_HOME=/h/.agentctl', 'TMUX_TMPDIR=/h/tmx', 'PATH=/opt/homebrew/bin:/usr/bin:/bin', '/opt/node/bin/node', '--experimental-strip-types', '--no-warnings', '/stable/bin/agentctl.ts'];
const ENTRY: McpEntry = mcpEntryFrom(SELF);
const NOW = Date.UTC(2026, 10, 1, 12, 34, 56);

function ctxFor(name: string, confirm?: (q: string) => Promise<boolean>, runner = new DiskRunner({ dryRun: false, startTime: NOW })) {
  const out: string[] = [];
  const ctx = new Context(runner, makeConfig(scratch.sub(name)), (l) => out.push(l), confirm);
  return { ctx, out, runner };
}

function desktopFile(name: string, content?: unknown): string {
  const dir = scratch.sub(`${name}/Library/Application Support/Claude`);
  const file = path.join(dir, 'claude_desktop_config.json');
  if (content !== undefined) fs.writeFileSync(file, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  return file;
}

describe('mcp install: the entry', () => {
  it('node and the script are absolute, the flags are the type-stripping ones, and the environment of this run goes along', () => {
    assert.deepEqual(ENTRY, {
      command: '/opt/node/bin/node',
      args: ['--experimental-strip-types', '--no-warnings', '/stable/bin/agentctl.ts', 'mcp'],
      env: { AGENTCTL_HOME: '/h/.agentctl', TMUX_TMPDIR: '/h/tmx', PATH: '/opt/homebrew/bin:/usr/bin:/bin' },
    });
    assert.deepEqual(mcpEntryFrom(['/opt/node/bin/node', '/x/agentctl.ts']), { command: '/opt/node/bin/node', args: ['/x/agentctl.ts', 'mcp'], env: {} });
    assert.throws(() => mcpEntryFrom(['node', '/x/agentctl.ts']), /absolute path of node/);
  });

  it('the stable copy is where the update script keeps it, unless AGENTCTL_STABLE_DIR says otherwise', () => {
    assert.equal(stableScript({}, '/Users/me'), '/Users/me/Projects/agentctl-stable/bin/agentctl.ts');
    assert.equal(stableScript({ AGENTCTL_STABLE_DIR: '/s' }, '/Users/me'), '/s/bin/agentctl.ts');
    assert.equal(pointsAtStable(ENTRY, { AGENTCTL_STABLE_DIR: '/stable' }, '/h'), true);
    assert.equal(pointsAtStable(ENTRY, { AGENTCTL_STABLE_DIR: '/other' }, '/h'), false);
    assert.equal(desktopConfigPath('/Users/me'), '/Users/me/Library/Application Support/Claude/claude_desktop_config.json');
    assert.equal(backupPath('/c/x.json', NOW), '/c/x.json.bak-20261101-123456');
  });

  it('a small line diff shows added and removed lines with a little context', () => {
    const a = ['{', '  "a": 1,', '  "b": 2', '}'].join('\n');
    const b = ['{', '  "a": 1,', '  "b": 2,', '  "c": 3', '}'].join('\n');
    assert.deepEqual(lineDiff(a, b), ['  {', '    "a": 1,', '-   "b": 2', '+   "b": 2,', '+   "c": 3', '  }']);
    assert.deepEqual(lineDiff('', 'x'), ['+ x']);
  });
});

describe('mcp install --desktop (on copies)', () => {
  const others = { globalShortcut: 'Alt+Space', mcpServers: { filesystem: { command: 'npx', args: ['-y', 'x'] } } };

  it('adds the entry, keeps the other servers and keys, backs the old file up with the date, and shows the diff first', async () => {
    const file = desktopFile('d1', others);
    const original = fs.readFileSync(file, 'utf8');
    const asked: string[] = [];
    const { ctx, out } = ctxFor('d1', async (q) => (asked.push(q), true));
    const result = await installDesktop(ctx, ENTRY, { file, yes: false });
    assert.deepEqual([result.outcome, result.backup], ['written', `${file}.bak-20261101-123456`]);
    assert.deepEqual(asked, ['Write it? [y/N] ']);
    const written = JSON.parse(fs.readFileSync(file, 'utf8')) as { globalShortcut: string; mcpServers: Record<string, unknown> };
    assert.equal(written.globalShortcut, 'Alt+Space');
    assert.deepEqual(Object.keys(written.mcpServers), ['filesystem', 'agentctl']);
    assert.deepEqual(written.mcpServers.filesystem, others.mcpServers.filesystem);
    assert.deepEqual(written.mcpServers.agentctl, ENTRY);
    assert.equal(fs.readFileSync(`${file}.bak-20261101-123456`, 'utf8'), original);
    const text = out.join('\n');
    assert.match(text, /The entry:\n {2}\{\n {4}"agentctl": \{\n {6}"command": "\/opt\/node\/bin\/node"/);
    assert.match(text, /Other servers kept as they are: filesystem/);
    assert.match(text, /\+ {5}"agentctl": \{/);
    assert.match(text, /Quit the Claude app completely \(Cmd\+Q/);
    assert.ok(text.indexOf('Change:') < text.indexOf('Written '), 'the preview comes before the write');
  });

  it('n changes nothing: no write, no backup', async () => {
    const file = desktopFile('d2', others);
    const original = fs.readFileSync(file, 'utf8');
    const { ctx, out } = ctxFor('d2', async () => false);
    assert.equal((await installDesktop(ctx, ENTRY, { file, yes: false })).outcome, 'declined');
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['claude_desktop_config.json']);
    assert.ok(out.at(-1)?.includes('Aborted'));
  });

  it('without a terminal and without -y it refuses to guess', async () => {
    const file = desktopFile('d3', others);
    const { ctx } = ctxFor('d3');
    await assert.rejects(installDesktop(ctx, ENTRY, { file, yes: false }), /no terminal to ask on/);
  });

  it('--dry-run: the whole preview, the commands that would run, and the file untouched', async () => {
    const file = desktopFile('d4', others);
    const original = fs.readFileSync(file, 'utf8');
    const runner = new RecordingRunner({ startTime: NOW });
    const { ctx, out } = ctxFor('d4', undefined, runner);
    const result = await installDesktop(ctx, ENTRY, { file, yes: true });
    assert.equal(result.outcome, 'dry-run');
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.match(runner.commands[0] ?? '', /^cp '.*claude_desktop_config\.json' '.*claude_desktop_config\.json\.bak-\d{8}-\d{6}'$/);
    assert.match(runner.commands[1] ?? '', /^write '.*claude_desktop_config\.json' \(\d+ bytes\)$/);
    assert.match(out.join('\n'), /Change:/);
    assert.match(out.at(-1) ?? '', /^Dry run: nothing was written\. A real run writes /);
    assert.ok(!out.some((l) => l.startsWith('Written')));
  });

  it('running it again changes nothing; a changed entry is replaced (diff shows both)', async () => {
    const file = desktopFile('d5', undefined);
    const { ctx, out } = ctxFor('d5', async () => true);
    assert.equal((await installDesktop(ctx, ENTRY, { file, yes: true })).outcome, 'written');
    assert.equal(fs.readdirSync(path.dirname(file)).length, 1, 'no file before, so no backup');
    assert.equal((await installDesktop(ctx, ENTRY, { file, yes: true })).outcome, 'unchanged');
    assert.match(out.join('\n'), /already has exactly this entry; nothing to do/);
    const moved = { ...ENTRY, args: ['--experimental-strip-types', '--no-warnings', '/elsewhere/agentctl.ts', 'mcp'] };
    assert.equal((await installDesktop(ctx, moved, { file, yes: true })).outcome, 'written');
    assert.match(out.join('\n'), /- {9}"\/stable\/bin\/agentctl\.ts"[\s\S]*\+ {9}"\/elsewhere\/agentctl\.ts"/);
    assert.equal(fs.readdirSync(path.dirname(file)).length, 2);
  });

  it('a file that is not valid JSON, or not an object, is never touched', async () => {
    const { ctx } = ctxFor('d6', async () => true);
    for (const [name, content, pattern] of [['bad', '{ "mcpServers": ', /is not valid JSON/], ['array', '[]', /top level is not an object/], ['servers', '{"mcpServers": []}', /"mcpServers" is not an object/]] as const) {
      const file = desktopFile(`d6-${name}`, content);
      await assert.rejects(installDesktop(ctx, ENTRY, { file, yes: true }), pattern);
      assert.equal(fs.readFileSync(file, 'utf8'), content);
    }
  });

  it('uninstall removes only the agentctl entry, with a backup; with none there is nothing to do', async () => {
    const file = desktopFile('u1', { ...others, mcpServers: { ...others.mcpServers, agentctl: ENTRY } });
    const { ctx, out } = ctxFor('u1', async () => true);
    assert.equal((await uninstallDesktop(ctx, { file, yes: false })).outcome, 'written');
    const after = JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers: Record<string, unknown>; globalShortcut: string };
    assert.deepEqual(Object.keys(after.mcpServers), ['filesystem']);
    assert.equal(after.globalShortcut, 'Alt+Space');
    assert.equal(fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.bak-')).length, 1);
    assert.equal((await uninstallDesktop(ctx, { file, yes: true })).outcome, 'unchanged');
    assert.match(out.join('\n'), /no "agentctl" entry; nothing to remove/);
    assert.equal((await uninstallDesktop(ctx, { file: desktopFile('u2'), yes: true })).outcome, 'unchanged');
  });
});

describe('mcp install --claude-code', () => {
  const respond = (registered: string | undefined, claudeFound = true) => (cmd: string, args: string[]) => {
    if (cmd !== 'claude') return undefined;
    if (!claudeFound) return { code: 127 };
    if (args[0] === 'mcp' && args[1] === 'get') return registered ? { stdout: registered } : { code: 1, stderr: 'No MCP server found' };
    return undefined;
  };
  const run = (name: string, registered?: string, found = true) => {
    const runner = new RecordingRunner({ dryRun: false, respond: respond(registered, found), startTime: NOW });
    return ctxFor(name, async () => true, runner);
  };

  it('claude mcp add --scope user with the env flags before --transport, the name, then -- and the absolute node with its flags', async () => {
    const { ctx, runner } = run('cc1');
    assert.equal((await installClaudeCode(ctx, ENTRY, { yes: false })).outcome, 'written');
    assert.deepEqual(runner.calls.map((c) => c.line).filter((l) => l.startsWith('claude mcp')), [
      'claude mcp add --scope user --env AGENTCTL_HOME=/h/.agentctl --env TMUX_TMPDIR=/h/tmx --env PATH=/opt/homebrew/bin:/usr/bin:/bin --transport stdio agentctl -- /opt/node/bin/node --experimental-strip-types --no-warnings /stable/bin/agentctl.ts mcp',
    ]);
    assert.deepEqual(claudeAddArgs(ENTRY).slice(0, 4), ['mcp', 'add', '--scope', 'user']);
  });

  it('an existing registration is shown and replaced: remove, then add', async () => {
    const { ctx, runner, out } = run('cc2', 'agentctl:\n  Scope: User config\n  Command: /old/node /old/agentctl.ts mcp');
    await installClaudeCode(ctx, ENTRY, { yes: true });
    assert.deepEqual(runner.calls.map((c) => c.line.split(' --')[0]).filter((l) => l.startsWith('claude mcp')), ['claude mcp remove', 'claude mcp add']);
    assert.match(out.join('\n'), /Registered now:\n {2}agentctl:[\s\S]*It will be replaced/);
  });

  it('n runs nothing; a missing claude is an error that points to the desktop route', async () => {
    const no = new RecordingRunner({ dryRun: false, respond: respond(undefined), startTime: NOW });
    const { ctx } = ctxFor('cc3', async () => false, no);
    assert.equal((await installClaudeCode(ctx, ENTRY, { yes: false })).outcome, 'declined');
    assert.ok(!no.commands.some((c) => c.startsWith('claude mcp')));
    const missing = run('cc4', undefined, false);
    await assert.rejects(installClaudeCode(missing.ctx, ENTRY, { yes: true }), /claude \(Claude Code\) was not found/);
  });

  it('uninstall removes the user-scope registration, and says so when there is none', async () => {
    const some = run('cc5', 'agentctl: ...');
    assert.equal((await uninstallClaudeCode(some.ctx, { yes: true })).outcome, 'written');
    assert.ok(some.runner.commands.includes('claude mcp remove --scope user agentctl'));
    const none = run('cc6');
    assert.equal((await uninstallClaudeCode(none.ctx, { yes: true })).outcome, 'unchanged');
    assert.ok(!none.runner.commands.some((c) => c.startsWith('claude mcp remove')));
  });
});

describe('mcp: doctor', () => {
  const env = { AGENTCTL_STABLE_DIR: '/stable' };
  const doctor = async (name: string, desktop: unknown, claudeGet: string | undefined, yaml = '') => {
    const home = scratch.sub(`${name}/home`);
    if (desktop !== undefined) {
      fs.mkdirSync(path.dirname(desktopConfigPath(home)), { recursive: true });
      fs.writeFileSync(desktopConfigPath(home), JSON.stringify(desktop));
    }
    const config = makeConfig(scratch.sub(name), yaml);
    const runner = new RecordingRunner({ dryRun: false, respond: (cmd, args) => (cmd === 'claude' && args[1] === 'get' ? (claudeGet ? { stdout: claudeGet } : { code: 1 }) : undefined) });
    const checks = await runDoctor(runner, () => config, home, '26.0.0', 'darwin', home, env);
    return checks.filter((c) => c.name.startsWith('mcp'));
  };

  it('not registered anywhere: warnings, never a failure; writing is off', async () => {
    const checks = await doctor('dr1', undefined, undefined);
    assert.deepEqual(checks.map((c) => [c.name, c.status]), [['mcp (Claude desktop)', 'warn'], ['mcp (Claude Code)', 'warn'], ['mcp access', 'ok']]);
    assert.match(checks[0]?.detail ?? '', /is not registered/);
    assert.equal(checks[2]?.detail, 'writing is off (mcp.allow is empty): the chat can only read');
  });

  it('registered and pointing at the stable copy: ok; at something else, or at a script that is gone: a warning that names it', async () => {
    const script = path.join(scratch.sub('dr2s/stable/bin'), 'agentctl.ts');
    fs.writeFileSync(script, '');
    const stable = { mcpServers: { agentctl: { command: 'node', args: ['--experimental-strip-types', script, 'mcp'] } } };
    const okChecks = await new Promise<Awaited<ReturnType<typeof doctor>>>((resolve) => {
      const home = scratch.sub('dr2/home');
      fs.mkdirSync(path.dirname(desktopConfigPath(home)), { recursive: true });
      fs.writeFileSync(desktopConfigPath(home), JSON.stringify(stable));
      const config = makeConfig(scratch.sub('dr2'));
      const runner = new RecordingRunner({ dryRun: false, respond: (cmd) => (cmd === 'claude' ? { code: 1 } : undefined) });
      void runDoctor(runner, () => config, home, '26.0.0', 'darwin', home, { AGENTCTL_STABLE_DIR: path.dirname(path.dirname(script)) }).then((c) => resolve(c.filter((x) => x.name.startsWith('mcp'))));
    });
    assert.deepEqual([okChecks[0]?.status, okChecks[0]?.detail], ['ok', `registered, runs ${script}`]);
    const dev = await doctor('dr3', { mcpServers: { agentctl: { command: 'node', args: [script, 'mcp'] } } }, undefined);
    assert.equal(dev[0]?.status, 'warn');
    assert.match(dev[0]?.detail ?? '', /not the stable copy \/stable\/bin\/agentctl\.ts/);
    const gone = await doctor('dr4', { mcpServers: { agentctl: { command: 'node', args: ['/nowhere/agentctl.ts', 'mcp'] } } }, undefined);
    assert.match(gone[0]?.detail ?? '', /the script \/nowhere\/agentctl\.ts does not exist/);
  });

  it('Claude Code registered through claude mcp get is read from its output; the allow list is reported', async () => {
    const checks = await doctor('dr5', undefined, 'agentctl:\n  Command: /opt/node/bin/node\n  Args: --experimental-strip-types /nowhere/agentctl.ts mcp', 'mcp: {allow: [send, close], allow_rm_worktree: true}\n');
    const code = checks.find((c) => c.name === 'mcp (Claude Code)');
    assert.equal(code?.status, 'warn');
    assert.match(code?.detail ?? '', /\/nowhere\/agentctl\.ts does not exist/);
    assert.equal(checks.find((c) => c.name === 'mcp access')?.detail, 'the chat may write: send, close; close may also remove worktrees (mcp.allow_rm_worktree)');
    assert.equal(describeAllow({ allow: [], allowRmWorktree: false }), 'writing is off (mcp.allow is empty): the chat can only read');
  });

  it('readers: a broken file is a warning text, not an exception; no claude means no line', async () => {
    const file = desktopFile('dr6', '{ nope');
    assert.match(readDesktopRegistration(file, env, '/h').detail, /not valid JSON/);
    assert.equal(readDesktopRegistration(file, env, '/h').registered, false);
    const runner = new RecordingRunner({ dryRun: false, respond: () => ({ code: 127 }) });
    assert.equal(await readClaudeCodeRegistration(runner, env, '/h'), undefined);
  });
});

describe('mcp install: the CLI', () => {
  const self = () => SELF as never;

  it('--desktop --config <copy> --dry-run prints the entry and the diff and writes nothing', async () => {
    const file = desktopFile('cl1', { mcpServers: { filesystem: { command: 'npx' } } });
    const original = fs.readFileSync(file, 'utf8');
    const config = makeConfig(scratch.sub('cl1'));
    const r = await runCli(config, new RecordingRunner({ startTime: NOW }), ['mcp', 'install', '--desktop', '--config', file, '--dry-run'], { selfArgv: self });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /"command": "\/opt\/node\/bin\/node"/);
    assert.match(r.stdout, /Other servers kept as they are: filesystem/);
    assert.match(r.stdout, /warning: this agentctl runs \/stable\/bin\/agentctl\.ts, not the stable copy/);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  });

  it('-y writes the copy and uninstall takes the entry out again', async () => {
    const file = desktopFile('cl2', { mcpServers: { filesystem: { command: 'npx' } } });
    const config = makeConfig(scratch.sub('cl2'));
    const runner = new DiskRunner({ dryRun: false, startTime: NOW });
    const install = await runCli(config, runner, ['mcp', 'install', '--desktop', '--config', file, '-y'], { selfArgv: self });
    assert.equal(install.code, 0, install.stderr);
    assert.deepEqual(Object.keys((JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers: object }).mcpServers), ['filesystem', 'agentctl']);
    const remove = await runCli(config, runner, ['mcp', 'uninstall', '--desktop', '--config', file, '-y']);
    assert.equal(remove.code, 0, remove.stderr);
    assert.deepEqual(Object.keys((JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers: object }).mcpServers), ['filesystem']);
  });

  it('install needs to be told where', async () => {
    const config = makeConfig(scratch.sub('cl3'));
    const r = await runCli(config, new RecordingRunner(), ['mcp', 'install'], { selfArgv: self });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /say where: --desktop and\/or --claude-code/);
  });
});
