import fs from 'node:fs';
import path from 'node:path';
import { Context } from '../src/core/context.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';
const scratch = useScratch();
export const now = Date.parse('2026-11-17T12:00:00Z');
export function world(name: string, extra = '') {
  const config = makeConfig(scratch.sub(name), `mcp: {allow: [close]}\n${extra}`);
  const tmux = new FakeTmux();
  const runner = new DiskRunner({ dryRun: false, startTime: now, respond: tmux.respond });
  const ctx = new Context(runner, config, () => {});
  const add = (task: string, age: number | null, cohort = 'wave') => {
    const record = seedTask(config, task, { cohort, turnEndedAt: new Date(now - 86400_000).toISOString(), ...(age !== null ? { pulled: new Date(now - age * 3600_000).toISOString() } : {}) });
    fs.mkdirSync(path.dirname(record.report), { recursive: true });
    fs.writeFileSync(record.report, 'Werdykt: PASS\n<!-- agentctl:report-end -->\n');
    fs.utimesSync(record.report, (now - 86400_000) / 1000, (now - 86400_000) / 1000);
    return record;
  };
  return { config, tmux, runner, ctx, add, deps: { context: () => ctx, notify: async () => {} } };
}
