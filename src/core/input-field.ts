import { createHash } from 'node:crypto';
import { storedForm } from './paste-wrapper.ts';

/*
 * The input field of the agent as an exact area of the screen: from its structural upper edge to its structural lower edge,
 * with every line in between (empty lines included). agentctl does not infer from it whose text it is. It only asks two things:
 *  - right after our own paste: does the area show this paste (`pasteImage`), and is it the same, byte for byte, before every Enter;
 *  - for `send --enter-only`: is the area, byte for byte, what the human was shown in the preview and what was recorded after our paste.
 * A difference, an unreadable area or an unrecognised shape means: no Enter.
 */

/** Structural border: its column and width must match the composer's top border. */
const BORDER = /^[─━═╌╍┄┅┈┉]{3,}$/u;
const CODEX_MODEL = /^  [\w.-]+ (?:low|medium|high|xhigh|minimal|none) · .+$/;
const CODEX_STATUS = /^ *(?:⚠ \d+ warnings? · f2 to view)?$/;
const CODEX_HINT = /^  (?:← for agents · )?(?:\? for shortcuts(?:\s+.*)?|tab to queue message)$/;
/** A paste the TUI folded into one placeholder: "[Pasted text #2 +7 lines]" (Claude Code), "[Pasted Content 1004 chars]" (Codex). */
const PLACEHOLDER = /^\[Pasted (?:text|content)\b[^\]\n]*\]$/i;
/** What an agent shows in an empty field (a suggestion, the placeholder) and the options of a dialog: not a draft (see screenMetadata). */
const NOT_A_DRAFT = /^Try\s|^Ask Codex to do anything$|^\d+\./;

const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 24);

/** top is the structural upper edge: Claude border, or Codex prompt row. */
export interface FieldCapture { area: string[]; readable: boolean; top?: number; reason?: string }

/** Read the composer by its geometry, never by a footer-like line in its body. */
export function inspectField(screen: string): FieldCapture {
  const lines = screen.split('\n').map(line => line.trimEnd());
  const lastMarker = lines.findLastIndex(line => /^[❯›>](?:\s|$)/.test(line));
  const areaOf = (start: number, end: number, top = start): FieldCapture => {
    const area = lines.slice(start, end);
    while (area.length > 1 && area.at(-1) === '') area.pop();
    const empty = area.length === 1 && (stripMarker(area[0]!).trim() === '' || NOT_A_DRAFT.test(stripMarker(area[0]!).trim()));
    return { readable: true, area: empty ? [] : area, top };
  };
  // Claude: the marker immediately follows the upper border. Continuation rows (including markers or footer text typed by the user) are body.
  for (let top = lines.length - 2; top >= 0; top--) {
    if (top + 1 !== lastMarker || !BORDER.test(lines[top]!)) continue;
    const bottom = lines.findLastIndex((line, i) => i > top + 1 && line === lines[top]);
    if (bottom > top + 1) return areaOf(top + 1, bottom, top);
    return { area: [], readable: false, reason: 'brak dolnej ramki composera (ucięty ekran albo inna szerokość)' };
  }
  // Codex 0.166.0 has no box: its two-row model/hints footer is a separate bottom region (recorded fixtures).
  // Pick the LAST complete footer at the bottom, so identical user text higher up stays inside the field.
  for (let model = lines.length - 2; model >= 0; model--) {
    if (!CODEX_MODEL.test(lines[model]!) || !(CODEX_HINT.test(lines[model + 1]!) || CODEX_STATUS.test(lines[model + 1]!)) || lines.slice(model + 2).some(line => line !== '')) continue;
    const start = lastMarker < model && /^›(?:\s|$)/.test(lines[lastMarker] ?? '') ? lastMarker : -1;
    if (start >= 0 && lines.slice(start + 1, model).every(line => line === '' || line.startsWith('  '))) return areaOf(start, model);
  }
  // Compact startup screen: the banner, cwd and permissions precede the bottom composer.
  // No conversation/dialog rows are allowed in this startup-only shape.
  const banner = lines.findIndex(line => /^  >_ OpenAI Codex \(v0\.166\.0\)$/.test(line));
  if (banner >= 0 && /^     \S.*$/.test(lines[banner + 1] ?? '') &&
      /^  permissions: .+$/.test(lines[banner + 2] ?? '') && lastMarker > banner + 2 &&
      /^›(?:\s|$)/.test(lines[lastMarker]!) &&
      lines.slice(0, banner).every(line => line === '') &&
      lines.slice(banner + 3, lastMarker).every(line => line === '') &&
      lines.slice(lastMarker + 1).every(line => line === '' || line.startsWith('  '))) {
    return areaOf(lastMarker, lines.length);
  }
  return { area: [], readable: false, reason: 'nie można jednoznacznie ustalić strukturalnych granic composera; brak pełnej ramki lub stopki Codexa' };
}

/** Compatibility API: an unreadable area is never an owned field. Call inspectField before any Enter to distinguish it from empty. */
export function fieldArea(screen: string, _footerPatterns: string[] = []): string[] { return inspectField(screen).area; }

/** The marker and the one space (or no-break space) after it; Claude Code draws a no-break space. */
const stripMarker = (line: string) => line.replace(/^\s*[❯›>][ \u00a0]?/, '');

/** The text the area shows, without marker and indentation, as a person would read it. */
export function fieldText(area: string[]): string {
  return area.map((line, i) => i === 0 ? stripMarker(line) : line.replace(/^ {1,2}/, '')).join('\n');
}

/** The identity of the area: the same bytes give the same value. */
export function areaKey(area: string[]): string {
  return area.length ? `image:${digest(area.join('\n'))}` : '';
}

/**
 * Do the rows the TUI shows read back as exactly this text? Each logical line of the text is shown as one row, or as several when the TUI wrapped it:
 * then the space the wrap swallows is the only difference allowed. With `whole` false the TUI may show only the first lines of the text.
 */
export function readsAs(shown: string[], text: string, agent: 'claude' | 'codex' | 'unknown' | undefined, whole: boolean): boolean {
  const want = storedForm(text, agent).split('\n');
  let row = 0;
  for (const line of want) {
    if (row >= shown.length) return !whole;
    let pos = 0;
    for (;;) {
      const part = shown[row]!;
      if ((part === '' && line !== '') || !line.startsWith(part, pos)) return false;
      pos += part.length;
      row++;
      if (pos >= line.length) break;
      if (line[pos] === ' ') pos++;
      if (row >= shown.length) return !whole;
    }
  }
  return row >= shown.length;
}

/**
 * Does the area, right after our paste, show this paste? One placeholder, or the lines of the prompt - possibly fewer than all of them (a TUI
 * may show only the start), but each shown line exactly as written. A changed, extra or other line is not our paste.
 */
export function pasteImage(area: string[], prompt: string, agent?: 'claude' | 'codex' | 'unknown'): boolean {
  if (!area.length) return false;
  const shown = fieldText(area).split('\n');
  if (shown.length === 1 && PLACEHOLDER.test(shown[0]!.trim())) return true;
  return readsAs(shown, prompt, agent, false);
}
