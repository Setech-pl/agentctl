import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { makeConfig, seedTask, useScratch, FakeTmux, DiskRunner } from './helpers.ts';
import { assertAgentSpawnAllowed, openAgentWindow } from '../src/core/window-guard.ts';

const scratch = useScratch();
const root = path.resolve(import.meta.dirname, '..');

describe('the one door of every agent window (FIX3 N1)', () => {
  it('refuses a review whose report or checkout is the author\'s, and makes no window', async () => {
    const dir = scratch.sub('door'), config = makeConfig(dir, 'capacity: {snapshot: false, codex_refresh: false}\n');
    const tmux = new FakeTmux(), runner = new DiskRunner({ dryRun: false, startTime: Date.now(), respond: (cmd, args, opts) => tmux.respond(cmd, args, opts) });
    const ctx = new Context(runner, config, () => {});
    const worktree = path.join(dir, 'author-wt'); fs.mkdirSync(worktree);
    const author = seedTask(config, 'AUTHOR', { repos: [{ path: dir, worktree, branch: 'author', base: 'a'.repeat(40) }] });
    const request = { task: 'AUTHOR-REV', window: 'author-rev', env: {}, reviewOf: 'AUTHOR', sessionUp: true, origin: 'new' as const };
    await assert.rejects(() => openAgentWindow(ctx, { ...request, cwd: worktree, report: author.report, repos: author.repos }), /start refused/);
    await assert.rejects(() => openAgentWindow(ctx, { ...request, cwd: worktree, report: path.join(dir, 'own.md'), repos: author.repos }), /overlaps the author's checkout/);
    assert.ok(!tmux.windows.some(w => w.name === 'author-rev'));
    await openAgentWindow(ctx, { ...request, cwd: path.join(dir, 'own-wt'), report: path.join(dir, 'own.md'), repos: [{ worktree: path.join(dir, 'own-wt') }] });
    assert.ok(tmux.windows.some(w => w.name === 'author-rev'), 'a review with its own report and checkout gets its window');
    assert.doesNotThrow(() => assertAgentSpawnAllowed(ctx, { task: 'PLAIN', report: author.report, repos: author.repos, origin: 'new' }), 'a task that reviews nothing is not checked');
  });
  it('inventory: only the door (and the named roles below) creates a window or starts a provider CLI; a path around it fails this test', () => {
    const found = scanTree(path.join(root, 'src'));
    assert.deepEqual(found, [], `these places create tmux windows or start a provider CLI without openAgentWindow:\n${found.join('\n')}`);
    for (const name of ['new.ts', 'resume.ts']) assert.match(fs.readFileSync(path.join(root, 'src/core', name), 'utf8'), /openAgentWindow\(/, `${name} opens its window through the door`);
  });
  it('inventory mutations: raw tmux calls and provider CLI starts outside the exempt functions are found', () => {
    const mutant = (body: string, file = 'src/core/mutant.ts') => scanSource(file, `export async function sneaky(ctx: any) {\n${body}\n}\n`);
    const bypasses = [
      "await ctx.runner.exec('tmux', ['new-window', '-d', '-n', 'x']);",
      "await runner.exec('tmux', [\n  'new-session', '-d', '-s', 's']);",
      "await ctx.runner.exec('tmux', ['respawn-pane', '-k', '-t', 'x', 'claude']);",
      "spawn('tmux', ['respawn-window', '-t', 'x']);",
      "execFile('tmux', ['new-window']);",
      "const args = ['new-window', '-n', 'x']; await ctx.runner.exec('tmux', args);",
      "await ctx.tmux.newWindow('x', '/tmp', {});",
      "await ctx.tmux.newSession('x', '/tmp', {});",
      "await ctx.tmux.respawn('x', '/tmp', 'claude');",
      "await ctx.runner.exec('claude', ['--dangerously-skip-permissions']);",
      "spawn('codex', ['exec', 'do it']);",
      "await ctx.runner.exec(agent, ['-p', 'hello']);",
    ];
    for (const body of bypasses) assert.ok(mutant(body).length > 0, `must be found: ${body}`);
    for (const body of ["await ctx.runner.exec('claude', ['--version'], { readOnly: true });", "await ctx.runner.exec('tmux', ['list-windows', '-t', 's']);", "await ctx.tmux.hasSession();"]) assert.deepEqual(mutant(body), [], `must pass: ${body}`);
    assert.ok(scanSource('src/core/new.ts', "export async function startTasks(ctx: any) {\n await ctx.tmux.newWindow('x', '/tmp', {});\n}\n").length > 0, 'an exemption is a function, not a file');
    assert.deepEqual(scanSource('src/core/windows.ts', "export async function ensureWindow(ctx: any) {\n await tmux.startWindow('w', '/tmp', 'cmd', true);\n}\n"), [], 'the named role stays exempt');
  });
});

/** The only functions that may create a window/session or start a provider CLI, each with the reason. Everything else goes through openAgentWindow. */
const EXEMPT: { file: string; fn: string; why: string }[] = [
  { file: 'src/core/window-guard.ts', fn: 'openAgentWindow', why: 'the door itself' },
  { file: 'src/core/tmux.ts', fn: 'newSession', why: 'tmux primitive called by the door' },
  { file: 'src/core/tmux.ts', fn: 'newWindow', why: 'tmux primitive called by the door' },
  { file: 'src/core/tmux.ts', fn: 'startWindow', why: 'tmux primitive for interface windows (board, watch)' },
  { file: 'src/core/tmux.ts', fn: 'respawn', why: 'tmux primitive for interface windows (board, watch)' },
  { file: 'src/core/windows.ts', fn: 'ensureWindow', why: 'board/watch run agentctl itself, they are interface processes, not agents' },
  { file: 'src/core/manager.ts', fn: 'startManager', why: 'the supervisor role: no task report protocol, no checkout of a task' },
  { file: 'src/core/mcp-install.ts', fn: 'installClaudeCode', why: 'registers the MCP server in the Claude CLI config: no agent turn, no window' },
  { file: 'src/core/mcp-install.ts', fn: 'uninstallClaudeCode', why: 'removes the MCP server from the Claude CLI config: no agent turn, no window' },
  { file: 'src/core/readonly-rpc.ts', fn: 'readRateLimits', why: 'Codex handshake for the rate limits: no turn, no window' },
];
const RAW_TMUX = /['"`](new-window|new-session|respawn-pane|respawn-window|split-window)['"`]/g;
const TMUX_METHOD = /\.(newWindow|newSession|startWindow|respawn)\(/g;
const CLI_START = /\b(?:exec|spawn|spawnSync|execFile|execFileSync)\(\s*(?:['"](?:claude|codex)['"]|(?:agent|provider|settings\.command))\s*,[^;]*/g;

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'await', 'try']);
function enclosingFunction(source: string, index: number): string {
  const lines = source.slice(0, index).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/.exec(lines[i]!) ?? /^ {2}(?:private\s+|static\s+)?(?:async\s+)?(\w+)\s*\(.*\)\s*(?::\s*[^{=]+)?\{\s*$/.exec(lines[i]!);
    if (m && !KEYWORDS.has(m[1]!)) return m[1]!;
  }
  return '';
}
function scanSource(file: string, source: string): string[] {
  const out: string[] = [];
  const check = (index: number, what: string): void => {
    const fn = enclosingFunction(source, index);
    if (!EXEMPT.some(e => e.file === file && e.fn === fn)) out.push(`${file}:${source.slice(0, index).split('\n').length} ${what} in ${fn || 'module scope'}`);
  };
  for (const m of source.matchAll(RAW_TMUX)) check(m.index!, `raw tmux ${m[1]}`);
  for (const m of source.matchAll(TMUX_METHOD)) check(m.index!, `tmux.${m[1]}()`);
  for (const m of source.matchAll(CLI_START)) if (!/readOnly:\s*true/.test(m[0])) check(m.index!, `provider CLI start ${m[0].slice(0, 40)}`);
  return out;
}
function scanTree(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? scanTree(p) : p.endsWith('.ts') ? scanSource(path.relative(root, p), fs.readFileSync(p, 'utf8')) : [];
  });
}
