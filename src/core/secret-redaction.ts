/** Shared value, assignment and URL redaction for persisted diagnostics and MCP output. */
export const SECRET_KEY = /TOKEN|KEY|SECRET|PASSWORD|PASS|COOKIE|(?:^|[^a-z0-9])(?:AUTH(?:ORIZATION)?|OAUTH)(?=$|[^a-z0-9])/i;
const ASSIGNMENT = /([\w.-]*(?:TOKEN|KEY|SECRET|PASSWORD|PASS|AUTH|COOKIE)[\w.-]*\s*[:=]\s*)("(?:\\.|[^"\\])*"|'[^']*'|[^\s,;]+)/gi;
const assignmentKey = (prefix: string): string => prefix.trim().replace(/[:=]$/, '').trim();
const URL_TEXT = /https?:\/\/[^\s"'<>]+/g;

export function secretRedactor(sources: unknown[], taskIds = new Set<string>()): <T>(value: T) => T {
  const secrets = new Set<string>();
  const collectTaskIds = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, part] of Object.entries(value)) {
      if (['task', 'reviewOf', 'directAuthor'].includes(key) && typeof part === 'string') taskIds.add(part);
      else collectTaskIds(part);
    }
  };
  for (const source of sources) collectTaskIds(source);
  const collect = (value: unknown, key = ''): void => {
    if (typeof value === 'string') {
      if (SECRET_KEY.test(key) && value) secrets.add(value);
      for (const match of value.matchAll(ASSIGNMENT)) {
        if (!SECRET_KEY.test(assignmentKey(match[1]!)) || taskIds.has(assignmentKey(match[1]!))) continue;
        const literal = match[2]!.replace(/^(['"])(.*)\1$/s, '$2');
        if (literal && literal !== '***' && !literal.includes('$')) secrets.add(literal);
      }
      for (const match of value.matchAll(URL_TEXT)) {
        try {
          const url = new URL(match[0]);
          for (const part of [url.username, url.password, ...[...url.searchParams].filter(([k]) => SECRET_KEY.test(k)).map(([, v]) => v)]) {
            if (part) { secrets.add(part); secrets.add(decodeURIComponent(part)); }
          }
        } catch { /* not a complete URL */ }
      }
    } else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) collect(v, k);
  };
  for (const source of sources) collect(source);
  const cleanText = (input: string): string => {
    let text = input;
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) text = text.split(secret).join('***');
    return text.replace(URL_TEXT, raw => {
      try {
        const url = new URL(raw);
        if (url.username || url.password) { url.username = '***'; url.password = '***'; }
        for (const key of [...url.searchParams.keys()]) if (SECRET_KEY.test(key)) url.searchParams.set(key, '***');
        return url.toString();
      } catch { return raw; }
    }).replace(ASSIGNMENT, (all, prefix: string, value: string) => !SECRET_KEY.test(assignmentKey(prefix)) || taskIds.has(assignmentKey(prefix)) || value.includes('***') ? all : `${prefix}***`);
  };
  const walk = (value: unknown, key = ''): unknown => {
    if (SECRET_KEY.test(key) && !taskIds.has(key)) return '***';
    if (typeof value === 'string') return cleanText(value);
    if (Array.isArray(value)) return value.map(v => walk(v));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, key === 'env' ? '***' : walk(v, k)]));
    return value;
  };
  return <T>(value: T): T => walk(value) as T;
}
