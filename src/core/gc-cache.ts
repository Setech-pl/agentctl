import fs from 'node:fs';
import path from 'node:path';
import { parseRefYaml } from './ref-yaml.ts';
import type { TaskRecord } from './taskstore.ts';

const location = (p: string): string => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const overlaps = (a: string, b: string): boolean => a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Conservative: even prose and unfinished/invalid outputs can name the only copy of data. */
export function cacheProtection(record: TaskRecord, target: string): string | undefined {
  if (record.keepCache) return 'keep_cache: true in task spec';
  const reports = [...new Set([record.report, record.reportSource, ...(record.reportAlt ?? [])].filter((p): p is string => Boolean(p) && !/[?*]/.test(p!)))];
  for (const report of reports) {
    let text: string;
    try { text = fs.readFileSync(report, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; return `cannot verify report references: ${report}`; }
    const bases = [path.dirname(report), ...record.repos.map(r => r.worktree)];
    const protects = (value: string): boolean => {
      const decoded = value.replace(/^file:\/\//, '').replace(/^~\//, `${process.env.HOME}/`);
      return bases.some(base => overlaps(location(path.resolve(base, decoded)), location(target)));
    };
    const strings = (value: unknown): string[] => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
    for (const match of text.matchAll(/```(?:agentctl-outputs|ya?ml)?\s*\n([\s\S]*?)```/g)) {
      try {
        const data = parseRefYaml(match[1]!);
        if (data && typeof data === 'object') {
          const d = data as Record<string, unknown>;
          if (['persist', 'artifacts', 'refs'].some(k => strings(d[k]).some(protects))) return `referenced by report outputs: ${report}`;
        }
      } catch { /* Raw references below protect malformed declarations too. */ }
    }
    const name = path.basename(target);
    if (new RegExp(`(^|[\\s\\x22\\x27\\x60(\\[])${escape(name)}(?=$|[\\s/\\x22\\x27\\x60)\\],.;:])`, 'm').test(text)) return `referenced by report: ${report}`;
    for (const match of text.matchAll(/(?:file:\/\/|~\/|\/|\.\.?\/)?[^\s\x22\x27\x60<>()[\]{},;]+\/[^\s\x22\x27\x60<>()[\]{},;]*/g)) {
      if (protects(match[0].replace(/[.:]+$/, ''))) return `referenced by report: ${report}`;
    }
  }
  return undefined;
}
