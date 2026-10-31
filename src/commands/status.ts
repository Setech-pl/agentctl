import fs from 'node:fs';
import type { Context } from '../context.ts';
import { lastNonEmptyLine } from '../tmux.ts';
import { listTaskRecords } from '../taskstore.ts';
import { formatDuration } from '../util.ts';

export interface StatusRow {
  task: string;
  agent: string;
  model: string;
  effort: string;
  window: 'alive' | 'gone';
  started: string;
  /** Running time for live windows; for closed ones, time until the report was last written; "-" if unknown. */
  duration: string;
  report: 'yes' | 'missing';
  reportPath: string;
  lastLine: string;
}

export async function collectStatus(ctx: Context): Promise<StatusRow[]> {
  const { runner, tmux, config } = ctx;
  const live = new Set(await tmux.listWindows());
  const rows: StatusRow[] = [];
  for (const record of listTaskRecords(config)) {
    const alive = live.has(record.window);
    const startedMs = Date.parse(record.started);
    let reportMtime: number | undefined;
    try {
      reportMtime = record.report ? fs.statSync(record.report).mtimeMs : undefined;
    } catch {
      reportMtime = undefined;
    }
    let duration = '-';
    if (!Number.isNaN(startedMs)) {
      if (alive) duration = formatDuration(runner.now() - startedMs);
      else if (reportMtime !== undefined && reportMtime >= startedMs) duration = formatDuration(reportMtime - startedMs);
    }
    let lastLine = '';
    if (alive) {
      const screen = await tmux.capture(record.window);
      if (screen.code === 0) lastLine = lastNonEmptyLine(screen.stdout);
    }
    rows.push({
      task: record.task,
      agent: record.agent,
      model: record.model,
      effort: record.effort,
      window: alive ? 'alive' : 'gone',
      started: record.started ? record.started.replace('T', ' ').slice(0, 16) : '-',
      duration,
      report: reportMtime !== undefined ? 'yes' : 'missing',
      reportPath: record.report,
      lastLine,
    });
  }
  return rows;
}

export function renderStatusTable(rows: StatusRow[], maxLast = 60): string[] {
  const header = ['TASK', 'AGENT/MODEL/EFFORT', 'WINDOW', 'STARTED', 'DURATION', 'REPORT', 'LAST LINE'];
  const body = rows.map((r) => [
    r.task,
    `${r.agent}/${r.model}/${r.effort}`,
    r.window,
    r.started,
    r.duration,
    r.report,
    r.lastLine.length > maxLast ? `${r.lastLine.slice(0, maxLast - 1)}…` : r.lastLine,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => (row[i] as string).length)));
  const fmt = (cells: string[]): string => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] as number))).join('  ').trimEnd();
  return [fmt(header), ...body.map(fmt)];
}
