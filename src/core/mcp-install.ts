import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { confirmAction } from './clipboard.ts';
import type { GlobalConfig } from './config.ts';
import type { Context } from './context.ts';
import type { SelfArgv } from './events.ts';
import type { Runner } from './runner.ts';
import { AgentctlError, errorMessage, isObject, shellLine } from './util.ts';

/** The name under which agentctl is registered in the app and in Claude Code. */
export const MCP_SERVER_NAME = 'agentctl';

/** An entry of `mcpServers` in claude_desktop_config.json (and what `claude mcp add` is given). */
export interface McpEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * The entry that starts `agentctl mcp`: the absolute node, its flags and the absolute script (the stable copy, when this runs from it),
 * and the settings of this run that the server needs (config directory, tmux socket directory, PATH). The app starts a server with a
 * bare environment where neither `node` nor Homebrew's `tmux` is found, so nothing is left to PATH.
 */
export function mcpEntryFrom(self: SelfArgv): McpEntry {
  const rest = [...self];
  const env: Record<string, string> = {};
  if (rest[0] === '/usr/bin/env') {
    rest.shift();
    while (rest[0] !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0])) {
      const item = rest.shift() as string;
      const eq = item.indexOf('=');
      env[item.slice(0, eq)] = item.slice(eq + 1);
    }
  }
  const [command, ...args] = rest;
  if (!command || !path.isAbsolute(command)) throw new AgentctlError('cannot tell the absolute path of node for the entry', 'Run this as "agentctl mcp install …" from the installed command.');
  return { command, args: [...args, 'mcp'], env };
}

/** Where the stable copy lives (the same variable the update script reads). */
export function stableScript(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  return path.join(env.AGENTCTL_STABLE_DIR ?? path.join(home, 'Projects', 'agentctl-stable'), 'bin', 'agentctl.ts');
}

const realOrSelf = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

/** The script an entry runs: the argument after the node flags. */
export function scriptOf(entry: Pick<McpEntry, 'args'>): string | undefined {
  return entry.args.find((a) => /\.ts$|\.js$|\.mjs$/.test(a) && !a.startsWith('--'));
}

/** True when the entry runs the stable copy. */
export function pointsAtStable(entry: Pick<McpEntry, 'args'>, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): boolean {
  const script = scriptOf(entry);
  return script !== undefined && realOrSelf(script) === realOrSelf(stableScript(env, home));
}

export function desktopConfigPath(home: string = os.homedir()): string {
  return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
}

// ---- a small line diff, for the preview

/** Lines changed between `a` and `b` (longest common subsequence), with `context` unchanged lines around them. */
export function lineDiff(a: string, b: string, context = 2): string[] {
  const x = a === '' ? [] : a.split('\n');
  const y = b === '' ? [] : b.split('\n');
  const lcs: number[][] = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  }
  const all: { mark: ' ' | '+' | '-'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) all.push({ mark: ' ', text: x[i++] as string }), j++;
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) all.push({ mark: '-', text: x[i++] as string });
    else all.push({ mark: '+', text: y[j++] as string });
  }
  while (i < x.length) all.push({ mark: '-', text: x[i++] as string });
  while (j < y.length) all.push({ mark: '+', text: y[j++] as string });
  const keep = all.map((l, k) => l.mark !== ' ' || all.slice(Math.max(0, k - context), k + context + 1).some((n) => n.mark !== ' '));
  const out: string[] = [];
  let gap = false;
  all.forEach((l, k) => {
    if (!keep[k]) {
      gap = true;
      return;
    }
    if (gap && out.length > 0) out.push('  ...');
    gap = false;
    out.push(`${l.mark} ${l.text}`);
  });
  return out;
}

// ---- Claude desktop: claude_desktop_config.json

interface DesktopConfig {
  [key: string]: unknown;
  mcpServers?: Record<string, unknown>;
}

function readDesktopConfig(file: string): { config: DesktopConfig; existed: boolean } {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { config: {}, existed: false };
    throw new AgentctlError(`cannot read ${file}: ${errorMessage(e)}`);
  }
  if (text.trim() === '') return { config: {}, existed: true };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new AgentctlError(`${file} is not valid JSON (${errorMessage(e)}); not touching it`, 'Fix the file by hand (the app shows the error in Settings > Developer), then run this again.');
  }
  if (!isObject(data)) throw new AgentctlError(`${file}: the top level is not an object; not touching it`);
  if (data.mcpServers !== undefined && !isObject(data.mcpServers)) throw new AgentctlError(`${file}: "mcpServers" is not an object; not touching it`);
  return { config: data as DesktopConfig, existed: true };
}

const pretty = (config: unknown): string => `${JSON.stringify(config, null, 2)}\n`;

const stamp = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/** `<file>.bak-YYYYMMDD-HHMMSS` */
export function backupPath(file: string, ms: number): string {
  return `${file}.bak-${stamp(ms)}`;
}

export interface InstallResult {
  /** What happened: written, nothing to do, or declined. */
  outcome: 'written' | 'unchanged' | 'declined' | 'dry-run';
  backup?: string;
}

export interface InstallOptions {
  file: string;
  yes: boolean;
  /** Warnings printed with the preview (for example: this does not run the stable copy). */
  warnings?: string[];
}

/** Add (or replace) the agentctl entry of `mcpServers`; the other servers and keys stay. Shows the entry and the diff, asks, backs up, writes. */
export async function installDesktop(ctx: Context, entry: McpEntry, opts: InstallOptions): Promise<InstallResult> {
  const { config, existed } = readDesktopConfig(opts.file);
  const next: DesktopConfig = { ...config, mcpServers: { ...(config.mcpServers ?? {}), [MCP_SERVER_NAME]: entry } };
  const before = existed ? pretty(config) : '';
  const after = pretty(next);
  if (before === after) {
    ctx.out(`${opts.file} already has exactly this entry; nothing to do.`);
    return { outcome: 'unchanged' };
  }
  const others = Object.keys(config.mcpServers ?? {}).filter((k) => k !== MCP_SERVER_NAME);
  const summary = [
    `Claude desktop config: ${opts.file}${existed ? '' : ' (does not exist yet, will be created)'}`,
    'The entry:',
    ...pretty({ [MCP_SERVER_NAME]: entry }).trimEnd().split('\n').map((l) => `  ${l}`),
    `Other servers kept as they are: ${others.length > 0 ? others.join(', ') : '(none)'}`,
    'Change:',
    ...lineDiff(before, after).map((l) => `  ${l}`),
    ...(opts.warnings ?? []).map((w) => `warning: ${w}`),
  ];
  if (!(await confirmAction(ctx, summary, 'Write it?', opts.yes))) return { outcome: 'declined' };
  const { runner } = ctx;
  let backup: string | undefined;
  if (existed) {
    // A dry run has a pretend clock; the name it prints should be the one a real run would use.
    backup = backupPath(opts.file, runner.dryRun ? Date.now() : runner.now());
    await runner.copyFile(opts.file, backup);
  }
  await runner.writeFile(opts.file, after);
  if (runner.dryRun) {
    ctx.out(`Dry run: nothing was written. A real run writes ${opts.file}${backup ? ` and keeps the old file as ${backup}` : ''}.`);
    return { outcome: 'dry-run', ...(backup ? { backup } : {}) };
  }
  ctx.out(`Written ${opts.file}${backup ? `; the old file is kept as ${backup}` : ''}.`);
  ctx.out('Quit the Claude app completely (Cmd+Q, not just the window) and open it again; the tools show under Settings > Developer / the "+" menu of a chat.');
  return { outcome: runner.dryRun ? 'dry-run' : 'written', ...(backup ? { backup } : {}) };
}

/** Remove the agentctl entry; the other servers stay. */
export async function uninstallDesktop(ctx: Context, opts: InstallOptions): Promise<InstallResult> {
  const { config, existed } = readDesktopConfig(opts.file);
  if (!existed || !config.mcpServers || !(MCP_SERVER_NAME in config.mcpServers)) {
    ctx.out(`${opts.file}: no "${MCP_SERVER_NAME}" entry; nothing to remove.`);
    return { outcome: 'unchanged' };
  }
  const servers = { ...config.mcpServers };
  delete servers[MCP_SERVER_NAME];
  const next: DesktopConfig = { ...config, mcpServers: servers };
  const summary = [`Claude desktop config: ${opts.file}`, 'Change:', ...lineDiff(pretty(config), pretty(next)).map((l) => `  ${l}`)];
  if (!(await confirmAction(ctx, summary, 'Write it?', opts.yes))) return { outcome: 'declined' };
  const backup = backupPath(opts.file, ctx.runner.dryRun ? Date.now() : ctx.runner.now());
  await ctx.runner.copyFile(opts.file, backup);
  await ctx.runner.writeFile(opts.file, pretty(next));
  ctx.out(ctx.runner.dryRun ? `Dry run: nothing was written. A real run writes ${opts.file} and keeps the old file as ${backup}.` : `Written ${opts.file}; the old file is kept as ${backup}. Quit the Claude app completely and open it again.`);
  return { outcome: ctx.runner.dryRun ? 'dry-run' : 'written', backup };
}

// ---- Claude Code: claude mcp add --scope user

/** The `claude mcp add` that registers the entry for the user (all projects, and the VS Code extension, which reads the same configuration). */
export function claudeAddArgs(entry: McpEntry): string[] {
  const env = Object.entries(entry.env).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
  // --transport between --env and the name: the CLI would take the name for another --env value otherwise.
  return ['mcp', 'add', '--scope', 'user', ...env, '--transport', 'stdio', MCP_SERVER_NAME, '--', entry.command, ...entry.args];
}

export const claudeRemoveArgs = (): string[] => ['mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME];

/** What `claude mcp get agentctl` says; undefined when it is not registered (or claude is not there). */
export async function claudeGet(runner: Runner): Promise<string | undefined> {
  const r = await runner.exec('claude', ['mcp', 'get', MCP_SERVER_NAME], { readOnly: true, timeoutMs: 20_000 });
  return r.code === 0 && r.stdout.trim() !== '' ? r.stdout.trim() : undefined;
}

export async function installClaudeCode(ctx: Context, entry: McpEntry, opts: { yes: boolean; warnings?: string[] }): Promise<InstallResult> {
  const { runner } = ctx;
  const have = await runner.exec('claude', ['--version'], { readOnly: true });
  if (have.code !== 0) throw new AgentctlError('claude (Claude Code) was not found', 'Install Claude Code first; for the desktop app use "agentctl mcp install --desktop".');
  const current = await claudeGet(runner);
  const add = claudeAddArgs(entry);
  const summary = [
    'Claude Code, scope user (every project; the VS Code extension reads the same configuration):',
    ...(current ? ['Registered now:', ...current.split('\n').map((l) => `  ${l}`), 'It will be replaced (removed, then added).'] : ['Not registered yet.']),
    'Commands:',
    ...(current ? [`  ${shellLine('claude', claudeRemoveArgs())}`] : []),
    `  ${shellLine('claude', add)}`,
    ...(opts.warnings ?? []).map((w) => `warning: ${w}`),
  ];
  if (!(await confirmAction(ctx, summary, 'Run it?', opts.yes))) return { outcome: 'declined' };
  if (current) {
    const r = await runner.exec('claude', claudeRemoveArgs());
    if (r.code !== 0) throw new AgentctlError(`claude mcp remove failed: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`}`);
  }
  const r = await runner.exec('claude', add);
  if (r.code !== 0) throw new AgentctlError(`claude mcp add failed: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`}`);
  ctx.out(r.stdout.trim() || 'Registered. In a Claude Code session, /mcp lists it; new sessions pick it up.');
  return { outcome: runner.dryRun ? 'dry-run' : 'written' };
}

export async function uninstallClaudeCode(ctx: Context, opts: { yes: boolean }): Promise<InstallResult> {
  const { runner } = ctx;
  const have = await runner.exec('claude', ['--version'], { readOnly: true });
  if (have.code !== 0) throw new AgentctlError('claude (Claude Code) was not found');
  if (!(await claudeGet(runner)) && !runner.dryRun) {
    ctx.out(`Claude Code: "${MCP_SERVER_NAME}" is not registered; nothing to remove.`);
    return { outcome: 'unchanged' };
  }
  if (!(await confirmAction(ctx, [`Run: ${shellLine('claude', claudeRemoveArgs())}`], 'Run it?', opts.yes))) return { outcome: 'declined' };
  const r = await runner.exec('claude', claudeRemoveArgs());
  if (r.code !== 0) throw new AgentctlError(`claude mcp remove failed: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`}`);
  ctx.out(r.stdout.trim() || 'Removed.');
  return { outcome: runner.dryRun ? 'dry-run' : 'written' };
}

// ---- doctor

export interface McpRegistration {
  where: 'Claude desktop' | 'Claude Code';
  registered: boolean;
  /** The entry runs the stable copy. */
  stable?: boolean;
  script?: string;
  scriptExists?: boolean;
  detail: string;
}

/** The agentctl entry of the desktop config, if any. */
export function readDesktopRegistration(file: string, env: NodeJS.ProcessEnv, home: string): McpRegistration {
  let config: DesktopConfig;
  try {
    const read = readDesktopConfig(file);
    if (!read.existed) return { where: 'Claude desktop', registered: false, detail: `${file} does not exist (the app is not set up, or agentctl mcp install --desktop was not run)` };
    config = read.config;
  } catch (e) {
    return { where: 'Claude desktop', registered: false, detail: errorMessage(e).split('\n')[0] as string };
  }
  const raw = config.mcpServers?.[MCP_SERVER_NAME];
  if (!isObject(raw)) return { where: 'Claude desktop', registered: false, detail: `no "${MCP_SERVER_NAME}" entry in ${file}` };
  const args = Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === 'string') : [];
  const script = scriptOf({ args });
  return {
    where: 'Claude desktop',
    registered: true,
    stable: pointsAtStable({ args }, env, home),
    ...(script ? { script, scriptExists: fs.existsSync(script) } : {}),
    detail: file,
  };
}

/** `claude mcp get agentctl`, read-only. */
export async function readClaudeCodeRegistration(runner: Runner, env: NodeJS.ProcessEnv, home: string): Promise<McpRegistration | undefined> {
  const have = await runner.exec('claude', ['--version'], { readOnly: true });
  if (have.code !== 0) return undefined;
  const text = await claudeGet(runner);
  if (!text) return { where: 'Claude Code', registered: false, detail: 'not registered (agentctl mcp install --claude-code)' };
  const script = /(\/\S+\.(?:ts|js|mjs))/.exec(text)?.[1];
  return {
    where: 'Claude Code',
    registered: true,
    ...(script ? { script, scriptExists: fs.existsSync(script), stable: realOrSelf(script) === realOrSelf(stableScript(env, home)) } : {}),
    detail: 'claude mcp get agentctl',
  };
}

/** One doctor line for what the chat may do (the allow list), so a forgotten "allow" is visible. */
export function describeAllow(mcp: GlobalConfig['mcp']): string {
  if (mcp.allow.length === 0) return 'writing is off (mcp.allow is empty): the chat can only read';
  return `the chat may write: ${mcp.allow.join(', ')}${mcp.allowRmWorktree ? '; close may also remove worktrees (mcp.allow_rm_worktree)' : ''}`;
}
