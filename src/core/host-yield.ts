import fs from 'node:fs';
import path from 'node:path';
import type { Context } from './context.ts';
import { hostAvailability } from './host-availability.ts';
import { readHostsCache } from './hosts.ts';
import { listTaskRecords } from './taskstore.ts';

interface Process { pid: number; parent: number; started: string }
type Suspended = Record<string, Process[]>;
const active = new Set<string>();

/** Pause only process trees rooted at managed agent panes. Persist identities before signaling so a restarted watch can resume them. */
export async function reconcileHostYield(ctx: Context): Promise<void> {
  if (ctx.runner.dryRun || active.has(ctx.config.path)) return;
  const file = path.join(ctx.config.stateDir, 'host-yield.json');
  const policies = Object.entries({local: ctx.config.localHost, ...ctx.config.hosts});
  if (!fs.existsSync(file) && !policies.some(([, host]) => host?.availability?.yield === 'pause-all')) return;
  active.add(ctx.config.path);
  try {
    const records = listTaskRecords(ctx.config).filter(record => !record.closed && !record.cancelled);
    const health = readHostsCache()?.hosts ?? [];
    let suspended: Suspended = {};
    try { suspended = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first yield */ }
    for (const [name, host] of policies) {
      const now = ctx.runner.now();
      const sample = health.find(h => h.name === name);
      const hold = host?.availability?.yield === 'pause-all' && hostAvailability(ctx.config, name, sample, now);
      const pause = hold && !/brak |nie można/.test(hold);
      const current = suspended[name] ?? [];
      if (!pause && !current.length || name !== 'local' && ctx.hosts.connection(name).unreachable) continue;
      const run = name === 'local' ? ctx.runner : ctx.hosts.forHost(name);
      const opts = { readOnly: true, timeoutMs: 2500 };
      const ps = await run.exec('ps', ['-axo', 'pid=,ppid=,lstart='], opts);
      if (ps.code !== 0) continue;
      const rows = ps.stdout.split('\n').flatMap(row => {
        const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(row);
        return match ? [{pid: Number(match[1]), parent: Number(match[2]), started: match[3]!}] : [];
      });
      const known = new Map(rows.map(row => [row.pid, row.started]));
      if (!pause) {
        const resume = current.filter(row => row.pid > 1 && known.get(row.pid) === row.started);
        if (resume.length) {
          const result = await run.exec('kill', ['-s', 'CONT', ...resume.map(row => String(row.pid))], { timeoutMs: 2500 });
          if (result.code !== 0) continue;
        }
        delete suspended[name];
        await ctx.runner.writeFile(file, JSON.stringify(suspended));
        continue;
      }
      const roots = new Set<number>();
      for (const record of records.filter(r => (r.host ?? 'local') === name && r.windowId && r.promptDelivery === 'sent')) {
        const pane = await run.exec('tmux', ['display-message', '-p', '-t', record.windowId!, '#{pane_pid}'], opts);
        const pid = Number(pane.stdout.trim());
        if (pane.code === 0 && Number.isInteger(pid) && pid > 1 && known.has(pid)) roots.add(pid);
      }
      let growing = true;
      while (growing) {
        growing = false;
        for (const row of rows) if (row.pid > 1 && roots.has(row.parent) && !roots.has(row.pid)) {
          roots.add(row.pid);
          growing = true;
        }
      }
      const added = rows.filter(row => roots.has(row.pid) && !current.some(p => p.pid === row.pid && p.started === row.started));
      if (added.length) {
        suspended[name] = [...current, ...added];
        await ctx.runner.writeFile(file, JSON.stringify(suspended));
        await run.exec('kill', ['-s', 'STOP', ...added.map(row => String(row.pid))], { timeoutMs: 2500 });
      }
    }
  } finally {
    active.delete(ctx.config.path);
  }
}
