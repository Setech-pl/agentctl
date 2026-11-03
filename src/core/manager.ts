import { collectGuide, dispatcherGuide } from './guide.ts';
import fs from 'node:fs';
import path from 'node:path';
import { agentCommandLine } from './agents.ts';
import { PATTERN_FLAGS } from './config.ts';
import type { AgentSettings, GlobalConfig, ManagerSettings } from './config.ts';
import type { Context } from './context.ts';
import { mcpEntryFrom, MCP_SERVER_NAME } from './mcp-install.ts';
import type { McpEntry } from './mcp-install.ts';
import { MCP_TOOLS } from './mcp-tools.ts';
import { waitForReady } from './ready.ts';
import { RC_CONFIRM, RC_CONNECTED, RC_FAILED, RC_FIRST_TIME } from './remote-control.ts';
import { AgentctlError, expandHome } from './util.ts';
import type { SelfArgv } from './events.ts';
import { MANAGER_WINDOW } from './windows.ts';

/*
 * The manager: one Claude Code session that stays in the window "manager" of the agentctl session, started with Remote Control, so the Claude
 * app on the phone can talk to it. It has the agentctl MCP server (it asks what is going on and, once you agree, starts the next step) and a role
 * that says so. Nothing in the project it runs in is changed: the role goes in with --append-system-prompt-file, the MCP server with --mcp-config,
 * the permissions of the read tools with --settings, all three from files in <config dir>/manager/. The window is not a task: it has no state
 * file, does not count against the limits and is not touched by close, cancel or gc.
 */

export { MANAGER_WINDOW, RC_CONFIRM, RC_CONNECTED, RC_FAILED };

/** Where the files the manager is started with live (all of them are rewritten at every start). */
export function managerFiles(config: Pick<GlobalConfig, 'path'>): { dir: string; role: string; settings: string; mcp: string } {
  const dir = path.join(path.dirname(config.path), 'manager');
  return { dir, role: path.join(dir, 'role.md'), settings: path.join(dir, 'settings.json'), mcp: path.join(dir, 'mcp.json') };
}

// ---- what is on the screen

/** How far the manager is, as far as the screen of its window says. */
export type ManagerState =
  /** No window. */
  | 'missing'
  /** A dialog waits for you: folder trust, or "Enable Remote Control". */
  | 'confirm'
  /** The session is up and shows its input, but no Remote Control indicator: it waits for the connection. */
  | 'waiting'
  /** The Remote Control indicator is on (`/rc active`). */
  | 'connected'
  /** Claude Code reports that Remote Control failed or disconnected. */
  | 'failed'
  /** The window is there, Claude Code does not show its input yet. */
  | 'starting';

const test = (pattern: string, screen: string): boolean => new RegExp(pattern, PATTERN_FLAGS).test(screen);

/** The state a screen of the manager window shows. `settings` are the patterns of the Claude agent (ready, trust). */
export function managerStateOf(screen: string, settings: Pick<AgentSettings, 'readyPattern' | 'trustPattern'>): ManagerState {
  if (test(RC_FAILED, screen)) return 'failed';
  if (test(RC_CONNECTED, screen)) return 'connected';
  if (test(RC_CONFIRM, screen) || test(settings.trustPattern, screen)) return 'confirm';
  if (test(settings.readyPattern, screen)) return 'waiting';
  return 'starting';
}

/** The state in the words of the board and the status line. */
export const MANAGER_STATE_TEXT: Record<ManagerState, string> = {
  missing: 'nie działa',
  confirm: 'czeka na potwierdzenie w oknie',
  waiting: 'czeka na połączenie',
  connected: 'połączony',
  failed: 'połączenie nie działa',
  starting: 'uruchamia się',
};

const SESSION_URL = /https:\/\/claude\.ai\/code\/[^\s)>"'\]]+/g;

/** The last session address on the screen (the status panel of `/remote-control` and the start banner print it); undefined when there is none. */
export function findSessionUrl(screen: string): string | undefined {
  const found = screen.match(SESSION_URL);
  return found ? found[found.length - 1]?.replace(/[.,;]+$/, '') : undefined;
}

const QR_LINE = /^[ ▀▄█]{20,}$/;

/** The QR code on the screen: the longest run of at least 12 lines made only of block characters; empty when there is none. */
export function findQr(screen: string): string[] {
  let best: string[] = [];
  let run: string[] = [];
  const flush = (): void => {
    if (run.length >= 12 && run.length > best.length) best = run;
    run = [];
  };
  for (const raw of screen.split('\n')) {
    const line = raw.trimEnd();
    if (QR_LINE.test(line) && /[▀▄█]/.test(line)) run.push(line);
    else flush();
  }
  flush();
  return best;
}

// ---- what the session is started with

/** The tools of the agentctl MCP server that only read (the manager may call them without asking on the phone). */
export function readToolNames(): string[] {
  return MCP_TOOLS.filter((t) => t.kind === 'read').map((t) => t.name);
}

/**
 * `--settings`: the read tools of agentctl need no tap on the phone. The tools that change something are not listed, so Claude Code asks you
 * first (a second consent next to the one the role demands), and `mcp.allow` still decides whether the server does it at all.
 */
export function managerSettingsJson(): string {
  const allow = readToolNames().map((t) => `mcp__${MCP_SERVER_NAME}__${t}`);
  return `${JSON.stringify({ permissions: { allow } }, null, 2)}\n`;
}

/** `--mcp-config`: the same server entry `agentctl mcp install --claude-code` registers, under the same name. */
export function managerMcpJson(entry: McpEntry): string {
  const server: Record<string, unknown> = { type: 'stdio', command: entry.command, args: entry.args };
  if (Object.keys(entry.env).length > 0) server.env = entry.env;
  return `${JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: server } }, null, 2)}\n`;
}

export const MAX_GUIDE_CHARS = 60_000;

export interface RoleInput {
  /** The name of the session (as the phone shows it). */
  name: string;
  /** The text of `manager.guide`, if there is one. */
  guide?: string | undefined;
  /** The write tools `mcp.allow` lets the server do; the manager says what it cannot do instead of working around it. */
  allowedWrites: readonly string[];
  dispatcher?: string;
}

/** The role of the manager, appended to the system prompt of the session. */
export function renderManagerRole(input: RoleInput): string {
  const writes = input.allowedWrites.length > 0 ? input.allowedWrites.join(', ') : 'none (the server is read-only for now)';
  const lines = [
    input.dispatcher ?? dispatcherGuide('en'),
    `# Manager appendix: "${input.name}"`,
    '',
    'You manage tasks through agentctl MCP from this terminal and Remote Control. Do not edit files of the project or launch agents by hand.',
    '- Begin work-related replies with `events_since`, then `status`; call `pull_ready` before discussing finished work.',
    '- Use MCP tools. A refusal means explain mcp.allow; never work around it through a shell.',
    `- Available write tools: ${writes}. Execute within the user authorization established in this conversation; show the concrete spec when approval is missing.`,
    '- Write in the user language. Reports: verdict first, at most 6 lines in the phone summary, with a path for details.',
    '- Do not merge, rebase, push, tag, publish or remove worktrees without explicit user instructions. Never auto-accept trust or permissions.',
  ];
  if (input.guide && input.guide.trim() !== '') {
    const guide = input.guide.length > MAX_GUIDE_CHARS ? `${input.guide.slice(0, MAX_GUIDE_CHARS)}\n[cut: the guide is longer than ${MAX_GUIDE_CHARS} characters]` : input.guide;
    lines.push('', '## Additional manager guide', '', guide.trimEnd());
  }
  return `${lines.join('\n')}\n`;
}

export interface ManagerLaunch {
  name: string;
  model: string;
  effort: string;
  roleFile: string;
  settingsFile: string;
  mcpFile: string;
}

/**
 * `claude --model <model> --effort <effort> <agents.claude.flags> --mcp-config <file> --remote-control <name> --settings <file> --append-system-prompt-file <file>`.
 *
 * An interactive session (not `claude remote-control`, the server mode, which refuses every global flag that it cannot hand on to its sessions).
 * The name is always given, so `--remote-control` never takes a following flag for its optional value; the variadic `--mcp-config` stands before
 * flags only. No auto-accept flag is ever added.
 */
export function buildManagerArgv(launch: ManagerLaunch, settings: Pick<AgentSettings, 'flags' | 'effortArgs'>): string[] {
  const hasModel = launch.model !== 'default';
  const effortArgs = settings.effortArgs.map((a) => a.replaceAll('{effort}', launch.effort));
  return [
    'claude',
    ...(hasModel ? ['--model', launch.model] : []),
    ...effortArgs,
    ...settings.flags,
    '--mcp-config',
    launch.mcpFile,
    '--remote-control',
    launch.name,
    '--settings',
    launch.settingsFile,
    '--append-system-prompt-file',
    launch.roleFile,
  ];
}

/** What `claude --help` must list for the manager to start. */
export function remoteControlSupport(help: string): { remoteControl: boolean; roleFile: boolean } {
  return { remoteControl: /--remote-control\b/.test(help), roleFile: /--append-system-prompt(?:-file\b|\[-file\])/.test(help) };
}

// ---- looking at the window

export interface ManagerView {
  name: string;
  window: string;
  state: ManagerState;
  text: string;
}

/** The manager window and what its screen says; `state: missing` when there is no window. */
export async function managerView(ctx: Context): Promise<ManagerView> {
  const { config, tmux } = ctx;
  const base = { name: config.manager.name, window: MANAGER_WINDOW };
  if (!(await tmux.hasSession()) || !(await tmux.listWindows()).includes(MANAGER_WINDOW)) return { ...base, state: 'missing', text: MANAGER_STATE_TEXT.missing };
  const screen = await tmux.capture(MANAGER_WINDOW);
  const state = screen.code === 0 ? managerStateOf(screen.stdout, config.agents.claude) : 'starting';
  return { ...base, state, text: MANAGER_STATE_TEXT[state] };
}

export interface ManagerAddress {
  url: string | undefined;
  qr: string[];
  view: ManagerView;
}

/** `agentctl manager --url`: the session address and the QR code, if the window's scrollback shows them. Nothing is typed into the window. */
export async function managerAddress(ctx: Context): Promise<ManagerAddress> {
  const view = await managerView(ctx);
  if (view.state === 'missing') return { url: undefined, qr: [], view };
  const screen = await ctx.tmux.capture(MANAGER_WINDOW, 600, undefined, undefined, true);
  const text = screen.code === 0 ? screen.stdout : '';
  return { url: findSessionUrl(text), qr: findQr(text), view };
}

// ---- start and stop

export interface ManagerOptions {
  project?: string | undefined;
  name?: string | undefined;
  model?: string | undefined;
  effort?: ManagerSettings['effort'] | undefined;
  /** This very agentctl as a command line: the MCP server entry. */
  self: SelfArgv;
  /** Do not wait for the input prompt (`agentctl up`): the window is made and the command typed, nothing more. */
  noWait?: boolean;
  /** Ctrl-C ends the wait without closing the window. */
  signal?: AbortSignal;
}

export interface ManagerStartResult {
  action: 'started' | 'exists';
  window: string;
  name: string;
  project: string;
  command: string;
  state: ManagerState;
  files: ReturnType<typeof managerFiles>;
}

/** The directory the manager runs in: `--project`, else `manager.project`, else where agentctl is run. Must exist. */
export function managerProject(config: Pick<GlobalConfig, 'manager'>, project: string | undefined, cwd: string = process.cwd()): string {
  const dir = project ? path.resolve(cwd, expandHome(project)) : (config.manager.project ?? cwd);
  let ok = false;
  try {
    ok = fs.statSync(dir).isDirectory();
  } catch {
    // not there
  }
  if (!ok) throw new AgentctlError(`the manager directory ${dir} does not exist`, 'Give an existing folder with --project, or set manager.project in config.yaml.');
  return dir;
}

/** The write tools `mcp.allow` lets through (the role tells the manager). */
function allowedWrites(config: Pick<GlobalConfig, 'mcp'>): string[] {
  return [...config.mcp.allow];
}

/**
 * Make the window "manager" (never a second one) and start the session in it. The files it is started with are written first. When Claude Code
 * asks for the folder trust or the one-time "Enable Remote Control", agentctl does not answer: the result says `confirm` and the caller tells you
 * to do it in the window.
 */
export async function startManager(ctx: Context, opts: ManagerOptions): Promise<ManagerStartResult> {
  const { runner, tmux, config } = ctx;
  const files = managerFiles(config);
  const name = opts.name ?? config.manager.name;
  const project = managerProject(config, opts.project);
  const existing = await managerView(ctx);
  const launch: ManagerLaunch = { name, model: opts.model ?? config.manager.model, effort: opts.effort ?? config.manager.effort, roleFile: files.role, settingsFile: files.settings, mcpFile: files.mcp };
  const command = agentCommandLine(buildManagerArgv(launch, config.agents.claude));
  if (existing.state !== 'missing') return { action: 'exists', window: MANAGER_WINDOW, name: existing.name, project, command, state: existing.state, files };

  if (!runner.dryRun) {
    const version = await runner.exec('claude', ['--version'], { readOnly: true });
    if (version.code !== 0) throw new AgentctlError('claude not found or not working', 'Install Claude Code: https://docs.claude.com/en/docs/claude-code');
    const support = remoteControlSupport((await runner.exec('claude', ['--help'], { readOnly: true })).stdout);
    if (!support.remoteControl) throw new AgentctlError('this Claude Code has no --remote-control flag', 'Update Claude Code (Remote Control needs 2.1.x with a claude.ai login): claude update');
    if (!support.roleFile) throw new AgentctlError('this Claude Code has no --append-system-prompt-file flag, which carries the role of the manager', 'Update Claude Code: claude update');
  }

  let guide: string | undefined;
  if (config.manager.guide) {
    try {
      guide = fs.readFileSync(config.manager.guide, 'utf8');
    } catch {
      ctx.info(`manager: warning: manager.guide ${config.manager.guide} cannot be read, the manager starts without it`);
    }
  }
  await runner.mkdir(files.dir);
  await runner.writeFile(files.role, renderManagerRole({ name, guide, dispatcher: collectGuide(config, { project }).text, allowedWrites: allowedWrites(config) }));
  await runner.writeFile(files.settings, managerSettingsJson());
  await runner.writeFile(files.mcp, managerMcpJson(mcpEntryFrom(opts.self)));

  const sessionUp = await tmux.hasSession();
  const made = sessionUp ? await tmux.newWindow(MANAGER_WINDOW, project, {}) : await tmux.newSession(MANAGER_WINDOW, project, {});
  if (made.code !== 0) throw new AgentctlError(`tmux could not make the window "${MANAGER_WINDOW}": ${made.stderr.trim() || `exit ${made.code}`}`);
  await tmux.typeCommand(MANAGER_WINDOW, command);
  ctx.info(`manager: window ${config.session}:${MANAGER_WINDOW} in ${project} running ${command}`);
  if (opts.noWait || runner.dryRun) return { action: 'started', window: MANAGER_WINDOW, name, project, command, state: 'starting', files };

  const settings = config.agents.claude;
  const ready = await waitForReady(runner, tmux, MANAGER_WINDOW, {
    pattern: settings.readyPattern,
    trustPattern: settings.trustPattern,
    timeoutMs: settings.readyTimeout * 1000,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  // Connecting takes a moment after the input shows: look a few more times for the indicator.
  let state = managerStateOf(ready.screen, settings);
  for (let i = 0; i < 10 && state === 'waiting' && !opts.signal?.aborted; i++) {
    await runner.sleep(500);
    const again = await tmux.capture(MANAGER_WINDOW);
    if (again.code === 0) state = managerStateOf(again.stdout, settings);
  }
  return { action: 'started', window: MANAGER_WINDOW, name, project, command, state, files };
}

/** What to tell you after a start: where the one-time confirmations are, or that the session is up. */
export function managerAdvice(ctx: Pick<Context, 'config'>, result: ManagerStartResult): string[] {
  const { session } = ctx.config;
  const attach = `tmux attach -t ${session} \\; select-window -t ${MANAGER_WINDOW}`;
  switch (result.state) {
    case 'connected':
      return [`The manager "${result.name}" is connected. Open the Claude app on the phone, tap Code, and pick the session with a computer icon and a green dot.`];
    case 'confirm':
      return [
        `The manager waits for you in window ${session}:${MANAGER_WINDOW}: ${RC_FIRST_TIME}.`,
        `Go there: ${attach}`,
        'Then: agentctl manager --url, or open the Claude app on the phone, tap Code and pick the session.',
      ];
    case 'failed':
      return [`Claude Code says Remote Control did not connect. Look at the window: ${attach}. Typical causes: not logged in with claude.ai (claude auth login), ANTHROPIC_API_KEY or ANTHROPIC_BASE_URL set, a Team plan without Remote Control enabled.`];
    case 'waiting':
      return [`The manager is up but Remote Control has not connected yet. If it does not within a minute, look at the window: ${attach} (the first time Claude Code asks to "Enable Remote Control" there).`];
    case 'starting':
      return [`The manager is starting. Look at the window: ${attach}; the first time Claude Code asks for the folder trust and to "Enable Remote Control" there.`];
    case 'missing':
      return [];
  }
}

/** `agentctl manager stop`: closes the window (the session goes offline in the app; the conversation stays in Claude Code's history). */
export async function stopManager(ctx: Context): Promise<'stopped' | 'not-running'> {
  const view = await managerView(ctx);
  if (view.state === 'missing') return 'not-running';
  const r = await ctx.tmux.killWindow(MANAGER_WINDOW);
  if (r.code !== 0) throw new AgentctlError(`tmux could not close the window "${MANAGER_WINDOW}": ${r.stderr.trim() || `exit ${r.code}`}`);
  return 'stopped';
}

// ---- doctor

/** Variables that make Claude Code refuse Remote Control (an API key or a gateway instead of a claude.ai login, no feature flags). */
export const RC_BLOCKING_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'DISABLE_GROWTHBOOK',
] as const;

/** The variables of `env` that block Remote Control (set and not empty). */
export function blockingEnv(env: NodeJS.ProcessEnv): string[] {
  return RC_BLOCKING_ENV.filter((name) => (env[name] ?? '') !== '');
}

/** The script and node the manager's `mcp.json` runs, when the file is there: for doctor, which says if they still exist. */
export function readManagerMcp(config: Pick<GlobalConfig, 'path'>): { command: string; script: string | undefined } | undefined {
  try {
    const data = JSON.parse(fs.readFileSync(managerFiles(config).mcp, 'utf8')) as { mcpServers?: Record<string, { command?: unknown; args?: unknown }> };
    const server = data.mcpServers?.[MCP_SERVER_NAME];
    if (!server || typeof server.command !== 'string') return undefined;
    const args = Array.isArray(server.args) ? server.args.filter((a): a is string => typeof a === 'string') : [];
    return { command: server.command, script: args.find((a) => /\.(?:ts|js|mjs)$/.test(a)) };
  } catch {
    return undefined;
  }
}
