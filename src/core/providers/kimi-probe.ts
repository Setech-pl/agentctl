import { openAgentWindow } from '../window-guard.ts';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Context } from '../context.ts';
import type { PlanSnapshot, PlanWindow } from '../usage-parse.ts';
import { homeDir } from '../usage-sources.ts';
import { kimiPlanFile, readKimiSnapshot } from './kimi-usage.ts';
import { Tmux } from '../tmux.ts';
import { kimiSettings } from './kimi-settings.ts';
import { classifyScreen, inputVisible } from '../state.ts';
import { launchEnvironment } from '../safety.ts';
import { withFileLock } from '../file-lock.ts';

/** Real 2.5.0 /usage text. Only percentages and reset times are persisted. */
export function parseKimiUsage(screen: string, now: number): PlanSnapshot | undefined {
  const windows: PlanWindow[] = [];
  for (const line of screen.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\n')) {
    const m = /\b(5h|Weekly|Monthly) limit\b.*?\b(\d+(?:\.\d+)?)% used\b/i.exec(line);
    if (!m || Number(m[2]) > 100) continue;
    const reset = /resets in\s+(.+?)(?:│|$)/i.exec(line)?.[1];
    let duration = 0;
    if (reset) for (const t of reset.matchAll(/(\d+(?:\.\d+)?)\s*(d|h|m|s)\b/g)) duration += Number(t[1]) * ({ d: 86400, h: 3600, m: 60, s: 1 }[t[2]!] ?? 0);
    const kind = m[1]!.toLowerCase();
    windows.push({ kind: kind === '5h' ? 'session' : kind === 'weekly' ? 'week' : 'other', minutes: kind === '5h' ? 300 : kind === 'weekly' ? 10080 : 43200, usedPercent: Number(m[2]), resetsAt: duration ? Math.floor(now / 1000 + duration) : null });
  }
  return windows.length ? { at: now, planType: null, windows } : undefined;
}

export const kimiProbeDir = (config: Context['config']): string => path.join(homeDir(config), 'kimi-usage-probe');

/** No API/OAuth/credentials, no task window and no model turn. Every exit path kills its own session. */
export async function refreshKimiPlan(ctx: Context): Promise<string | null> {
  if (!ctx.config.capacity.kimiUsageProbe || ctx.runner.dryRun) return null;
  const file = kimiPlanFile(ctx.config);
  return withFileLock(`${file}.probe.lock`, async () => {
    const now = ctx.runner.now(), cached = readKimiSnapshot(ctx.config);
    if (cached && now - cached.at < 300_000) return null;
    const stamp = path.join(homeDir(ctx.config), 'usage', 'kimi-probe-at.json');
    try { if (now - JSON.parse(fs.readFileSync(stamp, 'utf8')).at < 300_000) return 'Kimi probe rate-limited (5 minutes)'; } catch { /* first probe */ }
    const env = launchEnvironment(ctx.config, { agent: 'kimi', model: 'default', effort: 'high', task: 'usage-probe' }, {});
    const dir = kimiProbeDir(ctx.config), settings = kimiSettings();
    await ctx.runner.mkdir(dir);
    await ctx.runner.writeFile(stamp, JSON.stringify({ at: now }));
    const probeCtx = new Context(ctx.runner, { ...ctx.config, session: `agentctl-kimi-probe-${randomUUID().slice(0, 8)}` }, () => {});
    const tmux = probeCtx.tmux;
    let created = false;
    try {
      // Start the process directly: no prompt or Enter is ever typed into an unready shell.
      const start = await openAgentWindow(probeCtx, { task: 'usage-probe', window: 'usage', cwd: dir, env, report: file, repos: [], origin: 'new', sessionUp: false, command: 'exec kimi' });
      if (start.code !== 0) return 'Kimi probe could not start';
      created = true;
      let ready = false;
      for (let i = 0; i < 20; i++) {
        await ctx.runner.sleep(250);
        const pane = await tmux.capture('usage');
        const state = classifyScreen(pane.stdout, settings);
        if (state === 'needs-trust') return `Kimi probe needs manual trust/login: run kimi in ${dir}; agentctl never answers the dialog`;
        if (state === 'idle' && inputVisible(pane.stdout, settings)) { ready = true; break; }
      }
      if (!ready) return 'Kimi probe did not become idle';
      await tmux.pasteText('usage', '/usage');
      await ctx.runner.sleep(400);
      await ctx.runner.exec('tmux', ['send-keys', '-t', tmux.target('usage'), 'C-m']);
      for (let i = 0; i < 20; i++) {
        await ctx.runner.sleep(250);
        const pane = await tmux.capture('usage');
        if (classifyScreen(pane.stdout, settings) !== 'idle') continue;
        const snapshot = parseKimiUsage(pane.stdout, ctx.runner.now());
        if (!snapshot) continue;
        await ctx.runner.writeFile(file, JSON.stringify(snapshot));
        await tmux.pasteText('usage', '/exit');
        await ctx.runner.sleep(400);
        await ctx.runner.exec('tmux', ['send-keys', '-t', tmux.target('usage'), 'C-m']);
        return null;
      }
      return 'Kimi /usage probe returned no plan percentages';
    } finally {
      if (created) await ctx.runner.exec('tmux', ['kill-session', '-t', `=${tmux.session}`]).catch(() => undefined);
    }
  });
}
