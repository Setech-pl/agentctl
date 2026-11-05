import YAML from 'yaml';
import type { GlobalConfig } from './config.ts';
import type { QueueEntry } from './queue.ts';
import { splitSpecs } from './spec.ts';
import { SECRET_KEY, secretRedactor } from './secret-redaction.ts';
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
  const walk = secretRedactor([config, ...specs.map(s => s.header), Object.fromEntries([...secrets].map((v, i) => [`SECRET_${i}`, v]))], taskIds);
  const cleanText = (text: string) => walk(text);
  const spec = specs.map(s => `---\n${YAML.stringify(walk(s.header)).trimEnd()}\n---\n${cleanText(s.prompt)}`).join('\n');
  return walk({ ...entry, spec });
}
