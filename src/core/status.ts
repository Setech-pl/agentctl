import fs from 'node:fs';
import type { Context } from './context.ts';
import { formatModelEffort } from './equivalents.ts';
import { syncMirror } from './mirror.ts';
import type { MirrorResult } from './mirror.ts';
import { taskState } from './state.ts';
import type { TaskState } from './state.ts';
import { lastNonEmptyLine } from './tmux.ts';
import { listTaskRecords } from './taskstore.ts';
import { formatDuration } from './util.ts';

export interface StatusRow {
  task: string;
  /** Effective agent, model and effort: what is actually running. */
  agent: string;
  model: string;
  effort: string;
  /** "agent model/effort" as ordered in the spec, and as it runs. They differ after --agent or a limit switch. */
  requested: string;
  effective: string;
  switchedBy: 'flag' | 'limit' | null;
  state: TaskState;
  window: 'alive' | 'gone';
  started: string;
  /** Running time for live windows; for closed ones, time until the report was last written; "-" if unknown. */
  duration: string;
  /** The report file exists. */
  report: 'yes' | 'missing';
  reportPath: string;
  /** ISO time of the last pull that took the current report; null when never pulled or the report changed since. */
  pulled: string | null;
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
    // A leftover report from before this run does not count as "ready".
    const reportReady = reportMtime !== undefined && (Number.isNaN(startedMs) || reportMtime >= startedMs);
    let duration = '-';
    if (!Number.isNaN(startedMs)) {
      if (alive) duration = formatDuration(runner.now() - startedMs);
      else if (reportReady && reportMtime !== undefined) duration = formatDuration(reportMtime - startedMs);
    }
    let screenText = '';
    if (alive) {
      const screen = await tmux.capture(record.window);
      if (screen.code === 0) screenText = screen.stdout;
    }
    rows.push({
      task: record.task,
      agent: record.agent,
      model: record.model,
      effort: record.effort,
      requested: `${record.requested.agent} ${formatModelEffort(record.requested)}`,
      effective: `${record.agent} ${record.model}/${record.effort}`,
      switchedBy: record.switchedBy ?? null,
      state: taskState({ alive, screen: screenText, settings: config.agents[record.agent], reportReady }),
      window: alive ? 'alive' : 'gone',
      started: record.started ? record.started.replace('T', ' ').slice(0, 16) : '-',
      duration,
      report: reportMtime !== undefined ? 'yes' : 'missing',
      reportPath: record.report,
      pulled: record.pulled && reportMtime !== undefined && Date.parse(record.pulled) >= reportMtime ? record.pulled : null,
      lastLine: lastNonEmptyLine(screenText),
    });
  }
  return rows;
}

/** `status`: collect the rows and, when `mirror_dir` is configured, copy new reports and status.json there. */
export async function reportStatus(ctx: Context): Promise<{ rows: StatusRow[]; mirror: MirrorResult | undefined }> {
  const rows = await collectStatus(ctx);
  return { rows, mirror: await syncMirror(ctx, rows) };
}

/** Compact Markdown table of all tasks, to paste at the start of a planning chat. */
export function statusMarkdown(rows: StatusRow[]): string {
  const cell = (s: string): string => s.replace(/\|/g, '\\|');
  const pulled = (r: StatusRow): string => (r.report === 'missing' ? '-' : r.pulled ? `yes (${r.pulled.replace('T', ' ').slice(0, 16)})` : 'no');
  const lines = [
    '| task | agent/model/effort | state | time | report | pulled? |',
    '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${cell(r.task)} | ${cell(`${r.agent}/${r.model}/${r.effort}`)} | ${r.state} | ${r.duration} | ${r.report} | ${pulled(r)} |`),
  ];
  return `${lines.join('\n')}\n`;
}
