import type { LiveWindow } from './checks.ts';
import type { StatusRow } from './status.ts';

type AccountedTask = Pick<StatusRow, 'task' | 'state' | 'window' | 'report' | 'pulled' | 'closed' | 'cancelled' | 'archived' | 'finished'>;

/** The same lifecycle and slot rules for displays and admission. A pulled window can still occupy a configured provider slot. */
export function accountTasks<T extends AccountedTask>(rows: readonly T[], slots: readonly LiveWindow[] = []) {
  const active: T[] = [], working: T[] = [], reports: T[] = [];
  const byState = new Map<string, T[]>();
  for (const row of rows) {
    const state = row.state === 'report-ready' && row.pulled ? 'pulled' : row.state;
    const group = byState.get(state) ?? [];
    group.push(row);
    byState.set(state, group);
    if (row.closed || row.cancelled || row.archived || row.pulled || row.state === 'superseded') continue;
    if (row.state === 'report-ready' && row.report === 'yes') reports.push(row);
    if (row.window !== 'alive' || row.finished || row.state === 'dead' || row.state === 'report-ready') continue;
    active.push(row);
    if (row.state === 'working' || row.state === 'background') working.push(row);
  }
  return { active, working, reports, byState, slots: slots.filter(slot => slot.counted !== false) };
}

export function taskNames(ids: readonly string[]): string {
  return ids.length ? ` (${[...ids.slice(0, 5), ...(ids.length > 5 ? ['…'] : [])].join(', ')})` : '';
}
