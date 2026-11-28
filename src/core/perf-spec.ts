import path from 'node:path';
import { CLOCK_TIME } from './host-availability.ts';
import { isObject, TASK_ID } from './util.ts';
import type { Problems } from './util.ts';

export interface PerfArtifact { fromTask?: string; path: string; dest: string }
export interface PerfSpec { artifacts: PerfArtifact[]; results?: string; startAfter?: string; at?: string; onPass?: string }

export function safeRelative(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/[\\\x00-\x1f]/.test(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

export function parsePerfSpec(raw: Record<string, unknown>, isPerf: boolean, p: Problems): PerfSpec | undefined {
  const keys = ['artifacts', 'results', 'start_after', 'at', 'on_pass'];
  if (!isPerf) {
    for (const key of keys) if (raw[key] !== undefined) p.add(`${key} requires class: perf`);
    return;
  }
  const artifacts: PerfArtifact[] = [];
  if (raw.artifacts !== undefined) {
    if (!Array.isArray(raw.artifacts)) p.add('artifacts must list build directories');
    else for (const entry of raw.artifacts) {
      if (!isObject(entry) || Object.keys(entry).some(key => !['from_task', 'path', 'dest'].includes(key))) {
        p.add('artifacts entries must have path, optionally from_task and dest');
        continue;
      }
      const fromTask = entry.from_task;
      const source = entry.path;
      const dest = entry.dest ?? (typeof source === 'string' ? path.basename(source) : '');
      if (typeof source !== 'string' || /[\\\x00-\x1f]/.test(source) || (fromTask === undefined ? !path.isAbsolute(source) : typeof fromTask !== 'string' || !TASK_ID.test(fromTask) || !safeRelative(source)) || !safeRelative(dest)) {
        p.add('artifacts require an absolute Mac path or from_task with a relative path, and a safe relative dest');
        continue;
      }
      if (artifacts.some(a => a.dest === dest || a.dest.startsWith(dest + '/') || dest.startsWith(a.dest + '/'))) p.add(`overlapping artifact destination ${dest}`);
      artifacts.push({ fromTask: fromTask as string | undefined, path: source, dest });
    }
  }
  if (raw.results !== undefined && !safeRelative(raw.results)) p.add('results must be a relative directory inside the perf workspace');
  if (raw.start_after !== undefined && (typeof raw.start_after !== 'string' || !Number.isFinite(Date.parse(raw.start_after)))) p.add('start_after must be an ISO date or timestamp');
  if (raw.at !== undefined && (typeof raw.at !== 'string' || !CLOCK_TIME.test(raw.at))) p.add('at must be HH:MM');
  if (raw.on_pass !== undefined && (typeof raw.on_pass !== 'string' || !raw.on_pass.trim() || raw.on_pass.length > 120)) p.add('on_pass must name a cohort or task pattern');
  return { artifacts, results: raw.results as string | undefined, startAfter: raw.start_after as string | undefined, at: raw.at as string | undefined, onPass: raw.on_pass as string | undefined };
}
