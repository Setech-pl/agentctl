import fs from 'node:fs';
import { PATTERN_FLAGS } from './config.ts';
import { clip, stripMarkdown } from './events.ts';

/** Longest verdict in a notification. */
export const MAX_VERDICT = 100;

const FRONT_MATTER = /^---\n[\s\S]*?\n---\n/;
const HEADING = /^\s{0,3}#{1,6}\s/;
/** "Werdykt", "Verdict:", "Status – PASS": the label alone or followed by a separator; "Status raportu" is not one. */
const LABEL = /^(?:werdykt|verdict|status)\s*(?:[:：–—-]\s*(.*))?$/i;
const hasWords = (s: string): boolean => /[\p{L}\p{N}]/u.test(s);

/**
 * The line of a report that tells the result, for the "report ready" notification, without markdown and at most 100 characters.
 * In this order: the first line `pattern` matches (its first group, else the whole line); a "Werdykt"/"Verdict"/"Status" line
 * (when it stands alone as a heading, the line under it follows the label); else the first line of text after the heading.
 */
export function reportVerdict(report: string, pattern?: string): string | undefined {
  const text = report.replace(/\r\n/g, '\n').replace(FRONT_MATTER, '');
  const raw = text.split('\n');
  const clean = raw.map(stripMarkdown);

  if (pattern) {
    const re = new RegExp(pattern, PATTERN_FLAGS);
    for (const line of clean) {
      const m = re.exec(line);
      const hit = m ? (m[1] ?? m[0]).trim() : '';
      if (hit !== '') return clip(hit, MAX_VERDICT);
    }
  }

  for (const [i, line] of clean.entries()) {
    const m = LABEL.exec(line);
    if (!m) continue;
    const label = /^[^\s:：–—-]+/.exec(line)?.[0] ?? line;
    if (m[1] && hasWords(m[1])) return clip(`${label}: ${m[1].trim()}`, MAX_VERDICT);
    const next = clean.slice(i + 1).find((l) => hasWords(l));
    if (next) return clip(`${label}: ${next}`, MAX_VERDICT);
  }

  for (const [i, line] of raw.entries()) {
    if (HEADING.test(line) || !hasWords(clean[i] as string) || /^\s*\|?[\s:|-]+\|?\s*$/.test(line)) continue;
    return clip(clean[i] as string, MAX_VERDICT);
  }
  return undefined;
}

/** The verdict of the report file; undefined when it cannot be read or says nothing. */
export function readVerdict(file: string, pattern?: string): string | undefined {
  try {
    return reportVerdict(fs.readFileSync(file, 'utf8'), pattern);
  } catch {
    return undefined;
  }
}
