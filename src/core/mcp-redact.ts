import YAML from 'yaml';
import type { GlobalConfig } from './config.ts';
import type { QueueEntry } from './queue.ts';
import { splitSpecs } from './spec.ts';
const SECRET_KEY = /TOKEN|KEY|SECRET|PASSWORD|PASS|AUTH|COOKIE/i;
/** Env fields are always masked. Global text substitution applies to secrets, not common nonsecret env settings. */
export function redactQueue(entry: QueueEntry, config: GlobalConfig): unknown {
  const secrets = new Set<string>();
  const taskIds = new Set([entry.task, entry.reviewOf, entry.directAuthor, ...(entry.after ?? [])].filter((id): id is string => id !== undefined));
  const collect = (value: unknown, key = ''): void => {
    if (typeof value === 'string' && SECRET_KEY.test(key) && value) secrets.add(value);
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) collect(v, k);
  };
  collect(config);
  let specs: ReturnType<typeof splitSpecs> = [];
  try { specs = splitSpecs(entry.spec, 'queue_show redaction'); } catch {
    // A broken queued spec must not become a secret-bearing MCP error message.
    return { task: entry.task, status: entry.status, attempts: (entry.attempts ?? []).map(({ at, transient }) => ({ at, transient })), spec: '[invalid spec withheld; use owner CLI queue show]', error: '[invalid spec diagnostics withheld; use owner CLI queue show]' };
  }
  for (const spec of specs) {
    collect(spec.header);
    const env = spec.header.env;
    if (env && typeof env === 'object') for (const [key, value] of Object.entries(env)) {
      if (typeof value === 'string' && value && (SECRET_KEY.test(key) || (value.length >= 16 && /^[\w./+=:-]+$/.test(value) && /[0-9]/.test(value)))) secrets.add(value);
    }
  }
  const cleanText = (text: string): string => {
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) text = text.split(secret).join('***');
    return text.replace(/https?:\/\/[^\s"'<>]+/g, raw => {
      try { const u = new URL(raw); if (u.username || u.password) { u.username = '***'; u.password = '***'; } for (const k of [...u.searchParams.keys()]) if (SECRET_KEY.test(k)) u.searchParams.set(k, '***'); return u.toString(); } catch { return raw; }
    }).replace(/((?:[\w.-]*(?:TOKEN|KEY|SECRET|PASSWORD|PASS|AUTH|COOKIE)[\w.-]*)\s*[:=]\s*)([^\s,;]+)/gi, (all, prefix: string, value: string) => taskIds.has(prefix.trim().replace(/[:=]$/, '').trim()) || value.includes('***') ? all : `${prefix}***`);
  };
  const walk = (value: unknown, key = ''): unknown => {
    if (SECRET_KEY.test(key) && !taskIds.has(key)) return '***';
    if (typeof value === 'string') return cleanText(value);
    if (Array.isArray(value)) return value.map(v => walk(v));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, key === 'env' ? '***' : walk(v, k)]));
    return value;
  };
  const spec = specs.map(s => `---\n${YAML.stringify(walk(s.header)).trimEnd()}\n---\n${cleanText(s.prompt)}`).join('\n');
  return walk({ ...entry, spec });
}
