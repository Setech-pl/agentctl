import fs from 'node:fs';
import { PATTERN_FLAGS } from './config.ts';
import { clip, stripMarkdown } from './events.ts';
import { parseOutputs } from './outputs.ts';

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
      const hit = m ? (m[1] ?? line).trim() : '';
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
    if (HEADING.test(line) || !hasWords(clean[i] as string) || line.trimStart().startsWith('|')) continue;
    return clip(clean[i] as string, MAX_VERDICT);
  }
  return undefined;
}

const VERDICT_WORD = /^(PASS|PARTIAL|FAIL|BLOCKED)\b/i;
/** How many leading lines of a report count as its header: a "Werdykt:" further down is prose, not the verdict. */
const HEADER_LINES = 12;

/**
 * The verdict a notification shows. First the declared `agentctl-outputs` verdict; then the user's `notify.verdict_pattern`; then a
 * "Werdykt:"/"Verdict:"/"Status:" line in the header of the report (its first lines). Never a sentence from the body. A declared or
 * recognised verdict is always written "Werdykt: PASS", whatever label the report used.
 */
export function eventVerdict(report: string, pattern?: string): string | undefined {
  const declared = parseOutputs(report).outputs?.verdict;
  if (declared) return `Werdykt: ${declared}`;
  const text = report.replace(/\r\n/g, '\n').replace(FRONT_MATTER, '');
  const clean = text.split('\n').map(stripMarkdown);
  if (pattern) {
    const re = new RegExp(pattern, PATTERN_FLAGS);
    for (const line of clean) {
      const m = re.exec(line);
      const hit = m ? (m[1] ?? line).trim() : '';
      if (hit !== '') return clip(hit, MAX_VERDICT);
    }
  }
  const head = clean.filter((l) => l.trim() !== '').slice(0, HEADER_LINES);
  for (const [i, line] of head.entries()) {
    const m = LABEL.exec(line);
    if (!m) continue;
    const label = /^[^\s:：–—-]+/.exec(line)?.[0] ?? line;
    const value = m[1] && hasWords(m[1]) ? m[1].trim() : head.slice(i + 1).find((l) => hasWords(l));
    if (!value) continue;
    return VERDICT_WORD.test(value) ? clip(`Werdykt: ${value.replace(VERDICT_WORD, (w) => w.toUpperCase())}`, MAX_VERDICT) : clip(`${label}: ${value}`, MAX_VERDICT);
  }
  return undefined;
}

/** The verdict of the report file; undefined when it cannot be read or says nothing. */
export function readVerdict(file: string, pattern?: string): string | undefined {
  try {
    return eventVerdict(fs.readFileSync(file, 'utf8'), pattern);
  } catch {
    return undefined;
  }
}
