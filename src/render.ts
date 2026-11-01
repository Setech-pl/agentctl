import type { Check } from './core/doctor.ts';
import type { StatusRow } from './core/status.ts';

/** Plain-text status table. The core returns rows (data); this is only presentation. */
export function renderStatusTable(rows: StatusRow[], maxLast = 60): string[] {
  const header = ['TASK', 'AGENT/MODEL/EFFORT', 'STATE', 'WINDOW', 'STARTED', 'DURATION', 'PROGRESS', 'REPORT', 'LAST LINE'];
  const body = rows.map((r) => [
    r.hidden ? `${r.task} (hidden)` : r.task,
    r.switchedBy ? `${r.agent}/${r.model}/${r.effort} (ordered ${r.requested})` : `${r.agent}/${r.model}/${r.effort}`,
    r.state,
    r.window,
    r.startedLocal,
    r.duration,
    r.progress?.text ?? '-',
    r.report,
    r.lastLine.length > maxLast ? `${r.lastLine.slice(0, maxLast - 1)}…` : r.lastLine,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => (row[i] as string).length)));
  const fmt = (cells: string[]): string => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] as number))).join('  ').trimEnd();
  return [fmt(header), ...body.map(fmt)];
}

/** Lines under the status table: what to do about rows that need an action (orphans). */
export function renderStatusHints(rows: StatusRow[]): string[] {
  return rows.filter((r) => r.hint).map((r) => `${r.task}: ${r.hint}`);
}

const MARK = { ok: '✓', warn: '!', fail: '✗' } as const;

export function renderChecks(checks: Check[]): string[] {
  return checks.map((c) => `${MARK[c.status]} ${c.name.padEnd(15)} ${c.detail}`);
}
