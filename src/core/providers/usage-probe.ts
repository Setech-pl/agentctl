import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Context } from '../context.ts';
import type { AgentSettings } from '../config.ts';
import type { PlanSnapshot } from '../usage-parse.ts';
import { homeDir } from '../usage-sources.ts';
import { writeLaunchScript } from '../launch-script.ts';
import { openAgentWindow } from '../window-guard.ts';
import { classifyScreen, inputVisible } from '../state.ts';
import { withFileLock } from '../file-lock.ts';

interface ProbeOptions {
  id: 'claude' | 'kimi'; label: string; file: string; dir: string; intervalMs: number;
  settings: AgentSettings;
  readSnapshot(): PlanSnapshot | undefined;
  parse(screen: string, now: number): PlanSnapshot | undefined;
  launch(): { env: Record<string, string>; argv: string[] };
  dialogResult?: boolean;
  rememberNote?: boolean;
}

/** Slash command only, private launch script and unique detached session. Never targets task windows. */
export async function refreshUsageProbe(ctx: Context, options: ProbeOptions): Promise<string | null> {
  const { file, readSnapshot, intervalMs, dir, settings, parse, label, id, launch } = options;
  return withFileLock(`${file}.probe.lock`, async () => {
    const now = ctx.runner.now(), cached = readSnapshot();
    if (cached && now - cached.at < intervalMs) return null;
    const stamp = path.join(homeDir(ctx.config), 'usage', `${id}-probe-at.json`);
    try { if (now - JSON.parse(fs.readFileSync(stamp, 'utf8')).at < intervalMs) return options.rememberNote ? JSON.parse(fs.readFileSync(stamp, 'utf8')).note ?? null : 'Kimi probe rate-limited (5 minutes)'; } catch { /* first probe */ }
    const remember = async (note: string): Promise<string> => {
      if (options.rememberNote) await ctx.runner.writeFile(stamp, JSON.stringify({ at: now, note }));
      return note;
    };
    const { env, argv } = launch();
    await ctx.runner.mkdir(dir);
    await ctx.runner.writeFile(stamp, JSON.stringify({ at: now }));
    const probeCtx = new Context(ctx.runner, { ...ctx.config, session: `agentctl-${id}-probe-${randomUUID().slice(0, 8)}` }, () => {});
    const tmux = probeCtx.tmux;
    let created = false;
    try {
      // The neutral probe uses the same private script as task launches (and no typed prompt).
      const command = await writeLaunchScript(ctx.runner, dir, argv, env);
      const start = await openAgentWindow(probeCtx, { task: 'usage-probe', window: 'usage', cwd: dir, env: {}, report: file, repos: [], origin: 'new', sessionUp: false, command });
      if (start.code !== 0) return `${label} probe could not start`;
      created = true;
      if (options.dialogResult) await ctx.runner.exec('tmux', ['resize-window', '-t', tmux.target('usage'), '-x', '120', '-y', '50']);
      let ready = false;
      for (let i = 0; i < (options.dialogResult ? 120 : 20); i++) {
        await ctx.runner.sleep(250);
        const pane = await tmux.capture('usage');
        const state = classifyScreen(pane.stdout, settings);
        if (state === 'needs-trust') return remember(options.rememberNote ? `${label} probe: one-time wait for Marcin to trust/login: run ${id} in ${dir}; agentctl never answers dialogs` : `Kimi probe needs manual trust/login: run kimi in ${dir}; agentctl never answers the dialog`);
        if (state === 'idle' && inputVisible(pane.stdout, settings)) { ready = true; break; }
      }
      if (!ready) return `${label} probe did not become idle`;
      await tmux.pasteText('usage', '/usage');
      await ctx.runner.sleep(400);
      if (options.dialogResult) {
        const beforeEnter = await tmux.capture('usage');
        if (classifyScreen(beforeEnter.stdout, settings) !== 'idle' || !/^\s*❯\s*\/usage\s*$/m.test(beforeEnter.stdout)) {
          return remember(`${label} probe waiting: slash command not confirmed in an idle composer; agentctl never answers dialogs`);
        }
      }
      const submitted = await ctx.runner.exec('tmux', ['send-keys', '-t', tmux.target('usage'), 'C-m']);
      if (options.dialogResult && submitted.code !== 0) return remember(`${label} probe could not submit /usage`);
      for (let i = 0; i < (options.dialogResult ? 120 : 20); i++) {
        await ctx.runner.sleep(250);
        const pane = await tmux.capture('usage');
        if (options.dialogResult && classifyScreen(pane.stdout, settings) === 'needs-trust') return remember(options.rememberNote ? `${label} probe: one-time wait for Marcin to trust/login: run ${id} in ${dir}; agentctl never answers dialogs` : `Kimi probe needs manual trust/login: run kimi in ${dir}; agentctl never answers the dialog`);
        if (!options.dialogResult && classifyScreen(pane.stdout, settings) !== 'idle') continue;
        const snapshot = parse(pane.stdout, ctx.runner.now());
        if (!snapshot) continue;
        await ctx.runner.writeFile(file, JSON.stringify(snapshot));
        if (options.dialogResult) return null;
        await tmux.pasteText('usage', '/exit');
        await ctx.runner.sleep(400);
        await ctx.runner.exec('tmux', ['send-keys', '-t', tmux.target('usage'), 'C-m']);
        return null;
      }
      return `${label} /usage probe returned no plan percentages`;
    } finally {
      if (created) await ctx.runner.exec('tmux', ['kill-session', '-t', `=${tmux.session}`]).catch(() => undefined);
    }
  });
}
