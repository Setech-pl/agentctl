/** Compact facts for task lists; versions are never inferred from an unversioned alias. */
export const EFFORT_LABELS: Record<string, string> = { minimal: 'MN', low: 'LO', medium: 'MD', high: 'HI', xhigh: 'XH', max: 'MX', none: 'NO' };

function parts(model: string): { family: string; version?: string } {
  const words = model.toLowerCase().replace(/-\d{4}-\d{2}-\d{2}$/, '').split(/[-_\s]+/).filter(Boolean);
  const family = words.find(w => /^(sol|luna|astra|sonnet|opus|haiku|fable)$/.test(w))
    ?? [...words].reverse().find(w => /\p{L}/u.test(w))?.replace(/[\d.]/g, '') ?? '';
  const numbers = words.flatMap(w => w.match(/\d+(?:\.\d+)*/g) ?? []);
  // Dates (e.g. 20251101) are release suffixes, not model versions.
  const version = numbers.filter(w => !/^\d{6,}$/.test(w)).join('.');
  return { family, ...(version ? { version } : {}) };
}

export function modelLabel(model: string | null | undefined, effort: string | null | undefined, observed?: string | null, versions: Readonly<Record<string, string>> = {}): string {
  const value = model?.trim() ?? '';
  const e = EFFORT_LABELS[effort?.toLowerCase() ?? ''] ?? '–';
  if (!value || /^(default|unknown)$/i.test(value)) return `– ${e}`;
  const selected = parts(value);
  const actual = observed && !/^(unknown|default)$/i.test(observed) ? parts(observed) : undefined;
  const version = selected.version ?? (actual?.family === selected.family ? actual.version : undefined) ?? versions[value.toLowerCase()];
  const letter = [...selected.family][0]?.toUpperCase() ?? '–';
  return `${letter}${version ? ` ${version}` : ''} ${e}`;
}

export const providerLabel = (provider: string): string => provider === 'claude' ? 'cl' : provider === 'codex' ? 'cx' : provider.slice(0, 2).toLowerCase();
