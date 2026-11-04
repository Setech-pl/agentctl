import { collectStatus } from './status.ts';
import { inspectReport } from './report-state.ts';
import { missingLinkTargets, projectLinks } from './links.ts';
import { listTaskRecords, listArchivedRecords } from './taskstore.ts';
import { collectDisk, diskLine } from './disk.ts';
import { projectGuide } from './guide.ts';
import { developmentEnvironment, installation } from './installation.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { INSTALL_HINTS } from './agents.ts';
import { configStatePath, readConfigState } from './config-store.ts';
import { PROJECT_CONFIG_NAME, configDir, loadGlobalConfig, loadProjectConfig } from './config.ts';
import type { GlobalConfig } from './config.ts';
import type { Runner } from './runner.ts';
import { findMcpProcesses, staleProcesses, staleWarning } from './mcp-processes.ts';
import { describeAllow, desktopConfigPath, readClaudeCodeRegistration, readDesktopRegistration, stableScript } from './mcp-install.ts';
import type { McpRegistration } from './mcp-install.ts';
import { awayReport, renderAway } from './away.ts';
import { Context } from './context.ts';
import { blockingEnv, managerFiles, managerView, readManagerMcp, remoteControlSupport } from './manager.ts';
import { isPublicServer, weakTopic } from './ntfy-setup.ts';
import { findTerminalNotifier, notifierMemoryPath, readNotifierMemory } from './notify.ts';
import { Tmux } from './tmux.ts';
import { errorMessage } from './util.ts';

export interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

const MIN_NODE = [22, 14];
const MIN_TMUX = [3, 2];

function firstLine(s: string): string {
  return s.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
}

/** The "Problems found" of `terminal-notifier -diagnose` (3.x): no permission yet, alert style None … Empty for an older version or when all is fine. */
export function notifierProblems(diagnose: string): string[] {
  const after = diagnose.split(/^Problems found:\s*$/m)[1];
  if (after === undefined) return [];
  return after.split('\n').map((l) => /^\s*-\s+(.*\S)\s*$/.exec(l)?.[1] ?? '').filter(Boolean);
}

/** What to do when terminal-notifier cannot show notifications (macOS does not let it ask from the command line). */
const NOTIFIER_STEPS =
  'Fix: System Settings > Notifications > terminal-notifier > Allow Notifications, alert style Banners; if terminal-notifier is not on that list, set "notify: {backend: osascript}" in config.yaml. Check with: agentctl notify-test';

function atLeast(version: string, min: number[]): boolean {
  const nums = (/(\d+)\.(\d+)/.exec(version) ?? []).slice(1).map(Number);
  const [major = 0, minor = 0] = nums;
  return major > (min[0] as number) || (major === min[0] && minor >= (min[1] as number));
}

/** The manager (optional, so a warning at most): does it run, is its configuration usable, can Claude Code reach the agentctl MCP server. */
async function managerChecks(runner: Runner, config: GlobalConfig, tmuxOk: boolean, add: (name: string, status: Check['status'], detail: string) => void): Promise<void> {
  const m = config.manager;
  const problems: string[] = [];
  if (m.project && !fs.existsSync(m.project)) problems.push(`manager.project ${m.project} does not exist`);
  if (m.guide && !fs.existsSync(m.guide)) problems.push(`manager.guide ${m.guide} does not exist (the manager starts without it)`);
  const configured = m.autostart || m.project !== null;
  if (!tmuxOk) {
    if (m.autostart) problems.push('manager.autostart is on, but tmux is missing');
  } else {
    const view = await managerView(new Context(runner, config, () => {}));
    if (view.state === 'connected') add('manager', problems.length > 0 ? 'warn' : 'ok', [`"${view.name}" runs in window ${config.session}:manager, connected to Remote Control`, ...problems].join('; '));
    else if (view.state === 'missing') {
      if (m.autostart) problems.push('manager.autostart is on, but it is not running: agentctl manager (agentctl up starts it)');
      add('manager', problems.length > 0 ? 'warn' : 'ok', problems.length > 0 ? problems.join('; ') : configured ? 'not running: agentctl manager' : 'not running (optional): agentctl manager, then talk to it from the Claude app on the phone');
    } else add('manager', 'warn', [`window ${config.session}:manager is up, but ${view.text}`, ...problems].join('; '));
  }
  if (!tmuxOk && problems.length > 0) add('manager', 'warn', problems.join('; '));
  // Claude Code reaches the MCP server of agentctl either from its user scope (agentctl mcp install --claude-code) or from the manager's mcp.json.
  const file = readManagerMcp(config);
  if (file) {
    const missing = [file.command, file.script].filter((p): p is string => p !== undefined && !fs.existsSync(p));
    if (missing.length > 0) add('manager mcp', 'warn', `${managerFiles(config).mcp} runs ${missing.join(', ')}, which does not exist; start the manager again (agentctl manager stop, agentctl manager)`);
    else add('manager mcp', 'ok', `the manager gets the agentctl MCP server from ${managerFiles(config).mcp}${file.script ? ` (runs ${file.script})` : ''}`);
  } else add('manager mcp', 'ok', 'written at the first start of the manager (--mcp-config); for other Claude Code sessions: agentctl mcp install --claude-code');
}

/** Probe the machine: required tools fail the check, optional ones only warn. */
export async function runDoctor(
  runner: Runner,
  loadConfig: () => GlobalConfig = loadGlobalConfig,
  cwd: string | null = process.cwd(),
  nodeVersion: string = process.versions.node,
  platform: string = os.platform(),
  home: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, status: Check['status'], detail: string): void => {
    checks.push({ name, status, detail });
  };

  add('node', atLeast(nodeVersion, MIN_NODE) ? 'ok' : 'fail', atLeast(nodeVersion, MIN_NODE) ? `v${nodeVersion}` : `v${nodeVersion}: Node ${MIN_NODE.join('.')}+ is required`);

  const installed = installation(undefined, env);
  add('installation', 'ok', `${installed.source}: ${installed.executable}`);
  const dev = developmentEnvironment(undefined, process.argv[1] ?? installed.executable, stableScript(env, home), home) || developmentEnvironment(env.AGENTCTL_HOME ? path.join(env.AGENTCTL_HOME, 'config.yaml') : undefined, undefined, undefined, home);
  add('agentctl PATH', installed.matches || dev ? 'ok' : 'warn', dev && !installed.matches ? `środowisko dev; PATH: ${installed.found ?? 'not installed'}; running ${installed.executable}` : installed.matches
    ? `${installed.found} points to this package`
    : `${installed.found ?? 'agentctl not found in PATH'}; expected ${installed.executable}. Do not confuse @setech-pl/agentctl with @orgloop/agentctl (same command name). Check: command -v agentctl`);

  const git = await runner.exec('git', ['--version'], { readOnly: true });
  if (git.code === 0) add('git', 'ok', firstLine(git.stdout));
  else add('git', 'fail', `not found. ${INSTALL_HINTS.git}`);

  let config: GlobalConfig | undefined;
  try {
    config = loadConfig();
    const disk = await collectDisk(new Context(runner, config, () => {}));
    add('disk', disk.level === 'critical' ? 'fail' : disk.level === 'ok' ? 'ok' : 'warn', diskLine(disk));
    add('MCP permissions', 'ok', 'Existing queue permission still permits only queue insertion; queue:* explicitly enables the queue group. close/interrupt/queue_rm now require preview then confirm.');
  } catch (e) {
    // A running watch or MCP server keeps the last good settings meanwhile: say so.
    const state = readConfigState(path.join(configDir(env), 'config-state.json'));
    add('config', 'fail', `${errorMessage(e).split('\n').join(' ')}${state && !state.ok ? ` – the ${state.by} keeps the previous settings (since ${state.at})` : ''}`);
  }

  const tmuxVersion = await runner.exec('tmux', ['-V'], { readOnly: true });
  if (tmuxVersion.code !== 0) add('tmux', 'fail', `not found. ${INSTALL_HINTS.tmux}`);
  else {
    const v = firstLine(tmuxVersion.stdout);
    if (atLeast(v, MIN_TMUX)) add('tmux', 'ok', v);
    else add('tmux', 'warn', `${v}: tmux ${MIN_TMUX.join('.')}+ is needed for per-window environment (new-window -e)`);
  }

  const claude = await runner.exec('claude', ['--version'], { readOnly: true });
  if (claude.code !== 0) add('claude', 'warn', `not found (only needed for agent: claude). ${INSTALL_HINTS.claude}`);
  else {
    const help = await runner.exec('claude', ['--help'], { readOnly: true });
    const effort = /--effort\b/.test(help.stdout)
      ? 'effort: native --effort flag'
      : 'effort: no --effort flag in this version; set agents.claude.effort_args: [] (the prompt header still carries the effort)';
    add('claude', 'ok', `${firstLine(claude.stdout)}; ${effort}`);
    // Remote Control (the manager, and remote_control: true in a spec) needs these two flags and a claude.ai login without an API key or a gateway.
    const support = remoteControlSupport(help.stdout);
    const blocking = blockingEnv(env);
    if (!support.remoteControl) add('claude remote control', 'warn', 'this Claude Code has no --remote-control flag in its help: agentctl manager and remote_control: true need it (claude update)');
    else if (!support.roleFile) add('claude remote control', 'warn', 'has --remote-control, but no --append-system-prompt-file: agentctl manager cannot give the manager its role (claude update)');
    else if (blocking.length > 0) add('claude remote control', 'warn', `has --remote-control, but ${blocking.join(', ')} ${blocking.length === 1 ? 'is' : 'are'} set here: Claude Code then refuses Remote Control (it needs a claude.ai login, not an API key or a gateway). A tmux server started from this shell has them too`);
    else add('claude remote control', 'ok', 'has --remote-control and --append-system-prompt-file (the login is not checked: claude auth status)');
  }

  const codex = await runner.exec('codex', ['--version'], { readOnly: true });
  if (codex.code !== 0) add('codex', 'warn', `not found (only needed for agent: codex). ${INSTALL_HINTS.codex}`);
  else {
    const help = await runner.exec('codex', ['--help'], { readOnly: true });
    const effort = /-c, --config/.test(help.stdout)
      ? 'effort: via -c model_reasoning_effort=<effort>'
      : 'effort: no -c/--config flag in this version; set agents.codex.effort_args: [] (the prompt header still carries the effort)';
    add('codex', 'ok', `${firstLine(codex.stdout)}; ${effort}`);
  }

  const gh = await runner.exec('gh', ['--version'], { readOnly: true });
  if (gh.code === 0) add('gh', 'ok', firstLine(gh.stdout));
  else add('gh', 'warn', 'not found (optional; used by humans for PRs, never by agentctl)');

  const notifier = await findTerminalNotifier(runner, platform);
  if (platform === 'darwin') {
    const backend = config?.notify.backend ?? 'auto';
    const remembered = config ? readNotifierMemory(notifierMemoryPath(path.dirname(config.path)), runner.now()) : undefined;
    if (backend === 'osascript') add('notifications', 'ok', 'osascript, no click action (notify.backend: osascript)');
    else if (!notifier) add('notifications', 'warn', 'osascript, no click action. For click-to-window: brew install terminal-notifier');
    else {
      const problems = notifierProblems((await runner.exec(notifier, ['-diagnose'], { readOnly: true, timeoutMs: 10_000 })).stdout);
      if (remembered) {
        add('notifications', 'warn', `terminal-notifier (${notifier}) failed (${remembered.reason || 'no reason given'}); notifications go through osascript (no click action) until ${new Date(remembered.until).toLocaleTimeString()}. ${NOTIFIER_STEPS}`);
      } else if (problems.length > 0) {
        add('notifications', 'warn', `terminal-notifier (${notifier}) will not show notifications yet: ${problems.join(' ')} agentctl then falls back to osascript (no click action). ${NOTIFIER_STEPS}`);
      } else add('notifications', 'ok', `terminal-notifier (${notifier}): a click on a notification switches to the task window`);
    }
  } else add('notifications', 'ok', 'notify-send (no click action)');

  // The phone is optional: a weak topic or a missing token is a warning.
  if (config) {
    const ntfy = config.notify.ntfy;
    if (!ntfy?.topic) add('phone', 'ok', 'not set up (optional): agentctl ntfy-setup');
    else {
      const problems: string[] = [];
      const weak = weakTopic(ntfy.topic);
      if (weak && isPublicServer(ntfy.server)) problems.push(`the topic is guessable (${weak}) and on ${ntfy.server} the name is the only protection: run agentctl ntfy-setup --regenerate`);
      else if (weak) problems.push(`the topic is weak (${weak})`);
      if (!isPublicServer(ntfy.server) && !ntfy.token) problems.push(`${ntfy.server} is not the public server and notify.ntfy.token is not set (a private server wants a token)`);
      add('phone', problems.length > 0 ? 'warn' : 'ok', problems.length > 0 ? problems.join('; ') : `${ntfy.server}, topic ${ntfy.topic.slice(0, 9)}…, ${ntfy.events.length} events`);
      const report = awayReport(config);
      add('away', 'ok', renderAway(report).join('; '));
    }
  }

  // The chat integration is optional: every line here is ok or a warning, never a failure.
  const registrations: McpRegistration[] = [];
  if (platform === 'darwin') registrations.push(readDesktopRegistration(desktopConfigPath(home), env, home));
  const code = await readClaudeCodeRegistration(runner, env, home);
  if (code) registrations.push(code);
  for (const r of registrations) {
    if (r.command && /\/Cellar\/node(?:@[^/]+)?\//.test(r.command)) add(`mcp node (${r.where})`, 'warn', `versioned Node path ${r.command}; repair: agentctl mcp install --desktop --claude-code`);
    if (!r.registered) add(`mcp (${r.where})`, 'warn', `agentctl is not registered: ${r.detail}`);
    else if (r.scriptExists === false) add(`mcp (${r.where})`, 'warn', `registered, but the script ${r.script} does not exist; run "agentctl mcp install --desktop --claude-code" again`);
    else if (r.stable === false) add(`mcp (${r.where})`, 'warn', `registered, but it runs ${r.script ?? 'an unknown script'}, not the stable copy ${stableScript(env, home)}; run "agentctl mcp install --desktop --claude-code" from the stable copy`);
    else add(`mcp (${r.where})`, 'ok', `registered${r.script ? `, runs ${r.script}` : ''}`);
  }
  if (config) {
    add('mcp access', 'ok', describeAllow(config.mcp));
    // A config written for another version names tools this one does not know: the server runs without them, and says so here.
    for (const w of config.mcp.warnings) add('mcp config', 'warn', w);
  }
  const procs = await findMcpProcesses(runner);
  const stale = staleProcesses(procs, stableScript(env, home));
  const warning = staleWarning(stale, stableScript(env, home));
  if (warning && !dev) add('mcp server', 'warn', warning);
  else if (dev) add('mcp server', 'ok', 'środowisko dev; stable MCP version comparison is informational');
  else if (procs.length > 0) add('mcp server', 'ok', `${procs.length} running (pid ${procs.map((p) => p.pid).join(', ')}), none older than the stable copy`);

  if (config) {
    if (tmuxVersion.code === 0) {
      const tmux = new Tmux(runner, config.session);
      const window = (await tmux.windows()).find((w) => w.role === 'watch' || w.plain === 'watch');
      const alive = window && !(await tmux.paneDead('watch'));
      add('watch', alive ? 'ok' : 'warn', alive ? 'watch window is running' : 'watch is not running; start: agentctl watch --tmux --restart (or agentctl up --no-attach)');
    }
    const cache = config.cache;
    if (!fs.existsSync(cache)) add('cache', 'warn', `${cache} does not exist yet (created on first "agentctl new")`);
    else {
      try {
        fs.accessSync(cache, fs.constants.W_OK);
        add('cache', 'ok', cache);
      } catch {
        add('cache', 'fail', `${cache} is not writable`);
      }
    }
    const stateDir = config.stateDir;
    if (!fs.existsSync(stateDir)) add('state', 'warn', `${stateDir} does not exist yet (created on first "agentctl new")`);
    else {
      try {
        fs.accessSync(stateDir, fs.constants.W_OK);
        add('state', 'ok', stateDir);
      } catch {
        add('state', 'fail', `${stateDir} is not writable`);
      }
    }
    add('config', 'ok', config.loaded ? `${config.path}` : `${config.path} not found, using defaults`);
    const reload = readConfigState(configStatePath(config));
    if (reload && !reload.ok) add('config reload', 'warn', `the ${reload.by} keeps the previous settings since ${reload.at}: ${reload.error ?? 'the file did not load'}`);
    if (config.mirrorDir) {
      const dir = config.mirrorDir;
      try {
        fs.accessSync(fs.existsSync(dir) ? dir : path.dirname(dir), fs.constants.W_OK);
        add('mirror', 'ok', `${dir}${fs.existsSync(dir) ? '' : ' (created on first status/pull)'}`);
      } catch {
        add('mirror', 'fail', `${dir} is not writable`);
      }
    } else add('mirror', 'ok', 'off (set mirror_dir in the config to enable)');
    try {
      const reportRows = new Map((await collectStatus(new Context(runner, config, () => {}), { progress: false, archived: true })).map(r => [r.task, r]));
      const taskProcesses = (await runner.exec('ps', ['-axo', 'command='], { readOnly: true })).stdout.split('\n');
      for (const record of [...listTaskRecords(config), ...listArchivedRecords(config)]) {
        const report = inspectReport(config, record, runner.now(), !record.attemptId);
        if (reportRows.get(record.task)?.report !== 'yes') add(`report ${record.task}`, 'warn', `${report.ready ? 'incomplete for current turn' : report.reason}: ${record.report}${record.reportSource ? ` (previous copy: ${record.reportSource})` : ''}`);
        else if (!record.reportConfirmed && record.reportSource && path.normalize(record.reportSource) !== path.normalize(record.report)) add(`report ${record.task}`, 'warn', `raport pochodzi z kopii ${record.reportSource} – sprawdź`);
        if (record.closed || record.cancelled) continue;
        if (taskProcesses.some(command => /\/Cellar\/node(?:@[^/]+)?\//.test(command) && command.includes('--task') && command.replaceAll(/[^a-zA-Z0-9_-]+/g, ' ').split(' ').includes(record.task))) add(`task node ${record.task}`, 'warn', 'versioned Node path in active callback argv; works until Node is upgraded; regenerate task wiring when convenient');
        const dir = path.join(config.stateDir, record.window);
        for (const name of ['claude-settings.json']) {
          try { if (/\/Cellar\/node(?:@[^/]+)?\//.test(fs.readFileSync(path.join(dir, name), 'utf8'))) add(`task node ${record.task}`, 'warn', `versioned Node path in ${name}; works until Node is upgraded; regenerate task wiring when convenient`); } catch { /* absent */ }
        }
      }
    } catch (e) { add('task diagnostics', 'warn', errorMessage(e)); }
    for (const repo of new Set([...listTaskRecords(config), ...listArchivedRecords(config)].flatMap(r => r.repos.map(repo => repo.path)))) {
      if (repo === cwd) continue;
      try { for (const warning of missingLinkTargets(projectLinks(repo, '', config.cache))) add('project links', 'fail', `${repo}: ${warning}`); }
      catch (e) { add('project links', 'fail', errorMessage(e)); }
    }
    if (cwd === null) add('project', 'ok', 'bez projektu');
    else try {
      const project = loadProjectConfig(cwd);
      for (const warning of missingLinkTargets(projectLinks(cwd, '', config.cache))) add('project links', 'fail', warning);
      for (const warning of projectGuide(cwd).warnings) add('project guide', 'warn', warning);
      add('project config', 'ok', project ? project.path : `no ${PROJECT_CONFIG_NAME} in ${path.resolve(cwd)} (optional)`);
    } catch (e) {
      add('project config', 'fail', errorMessage(e).split('\n').join(' '));
    }
    if (tmuxVersion.code === 0) {
      const tmux = new Tmux(runner, config.session);
      const up = await tmux.hasSession();
      add('session', 'ok', up ? `"${config.session}" is running` : `"${config.session}" not running yet (created by "agentctl new")`);
    }
    await managerChecks(runner, config, tmuxVersion.code === 0, add);
  }
  return checks;
}
