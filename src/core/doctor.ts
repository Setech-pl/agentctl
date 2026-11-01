import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { INSTALL_HINTS } from './agents.ts';
import { PROJECT_CONFIG_NAME, loadGlobalConfig, loadProjectConfig } from './config.ts';
import type { GlobalConfig } from './config.ts';
import type { Runner } from './runner.ts';
import { describeAllow, desktopConfigPath, readClaudeCodeRegistration, readDesktopRegistration, stableScript } from './mcp-install.ts';
import type { McpRegistration } from './mcp-install.ts';
import { findTerminalNotifier, notifierMemoryPath, readNotifierMemory } from './notify.ts';
import { Tmux } from './tmux.ts';
import { errorMessage } from './util.ts';

export interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

const MIN_NODE = [22, 6];
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

/** Probe the machine: required tools fail the check, optional ones only warn. */
export async function runDoctor(
  runner: Runner,
  loadConfig: () => GlobalConfig = loadGlobalConfig,
  cwd: string = process.cwd(),
  nodeVersion: string = process.versions.node,
  platform: string = os.platform(),
  home: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, status: Check['status'], detail: string): void => {
    checks.push({ name, status, detail });
  };

  add('node', atLeast(nodeVersion, MIN_NODE) ? 'ok' : 'fail', atLeast(nodeVersion, MIN_NODE) ? `v${nodeVersion}` : `v${nodeVersion}: Node ${MIN_NODE.join('.')}+ is required (type stripping)`);

  const git = await runner.exec('git', ['--version'], { readOnly: true });
  if (git.code === 0) add('git', 'ok', firstLine(git.stdout));
  else add('git', 'fail', `not found. ${INSTALL_HINTS.git}`);

  let config: GlobalConfig | undefined;
  try {
    config = loadConfig();
  } catch (e) {
    add('config', 'fail', errorMessage(e).split('\n').join(' '));
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

  // The chat integration is optional: every line here is ok or a warning, never a failure.
  const registrations: McpRegistration[] = [];
  if (platform === 'darwin') registrations.push(readDesktopRegistration(desktopConfigPath(home), env, home));
  const code = await readClaudeCodeRegistration(runner, env, home);
  if (code) registrations.push(code);
  for (const r of registrations) {
    if (!r.registered) add(`mcp (${r.where})`, 'warn', `agentctl is not registered: ${r.detail}`);
    else if (r.scriptExists === false) add(`mcp (${r.where})`, 'warn', `registered, but the script ${r.script} does not exist; run "agentctl mcp install" again`);
    else if (r.stable === false) add(`mcp (${r.where})`, 'warn', `registered, but it runs ${r.script ?? 'an unknown script'}, not the stable copy ${stableScript(env, home)}; run "agentctl mcp install" from the stable copy`);
    else add(`mcp (${r.where})`, 'ok', `registered${r.script ? `, runs ${r.script}` : ''}`);
  }
  if (config) add('mcp access', 'ok', describeAllow(config.mcp));

  if (config) {
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
      const project = loadProjectConfig(cwd);
      add('project config', 'ok', project ? project.path : `no ${PROJECT_CONFIG_NAME} in ${path.resolve(cwd)} (optional)`);
    } catch (e) {
      add('project config', 'fail', errorMessage(e).split('\n').join(' '));
    }
    if (tmuxVersion.code === 0) {
      const tmux = new Tmux(runner, config.session);
      const up = await tmux.hasSession();
      add('session', 'ok', up ? `"${config.session}" is running` : `"${config.session}" not running yet (created by "agentctl new")`);
    }
  }
  return checks;
}
