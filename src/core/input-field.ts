import { createHash } from 'node:crypto';
import { PATTERN_FLAGS } from './config.ts';
import { storedForm } from './paste-wrapper.ts';

/*
 * The input field of the agent as an exact area of the screen: from the line of its marker down to the first border, footer or hint line,
 * with every line in between (empty lines included). agentctl does not infer from it whose text it is. It only asks two things:
 *  - right after our own paste: does the area show this paste (`pasteImage`), and is it the same, byte for byte, before every Enter;
 *  - for `send --enter-only`: is the area, byte for byte, what the human was shown in the preview and what was recorded after our paste.
 * A difference, an unreadable area or an unrecognised shape means: no Enter.
 */

const MARKER = /^\s*[❯›>](?:\s|$)/;
/** Lines that end the field when a footer pattern of the agent does not know them. */
const FIELD_END = [/^\s*tab to queue message\s*$/i, /^\s*paste again to expand\s*$/i, /^\s*ctrl\+x ctrl\+s to send now\s*$/i];
/** The border of the composer: a run of box-drawing characters, or the corner of a box. Not a line of hyphens: that is text. */
const BORDER = /^\s*(?:[─━═╌╍┄┅┈┉]{3,}|[╭╰┌└][─━═╌╍┄┅┈┉]*[╮╯┐┘]?)\s*$/u;
/** A paste the TUI folded into one placeholder: "[Pasted text #2 +7 lines]" (Claude Code), "[Pasted Content 1004 chars]" (Codex). */
const PLACEHOLDER = /^\[Pasted (?:text|content)\b[^\]\n]*\]$/i;
/** What an agent shows in an empty field (a suggestion, the placeholder) and the options of a dialog: not a draft (see screenMetadata). */
const NOT_A_DRAFT = /^Try\s|^Ask Codex to do anything$|^\d+\./;

const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 24);

/**
 * The area of the input field, line by line as the screen shows it (only the end of each line is trimmed: tmux does that itself). Empty array:
 * the field is empty (no marker, a suggestion, nothing after the marker). Lines inside stay, empty ones too; empty lines at its end do not.
 */
export function fieldArea(screen: string, footerPatterns: string[] = []): string[] {
  const lines = screen.split('\n').map(line => line.trimEnd());
  const at = lines.findLastIndex(line => MARKER.test(line));
  if (at < 0) return [];
  const footers = footerPatterns.map(p => new RegExp(p, PATTERN_FLAGS));
  const area = [lines[at]!];
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (BORDER.test(line) || FIELD_END.some(re => re.test(line)) || footers.some(re => re.test(line))) break;
    area.push(line);
  }
  while (area.length > 1 && area.at(-1) === '') area.pop();
  if (area.length === 1 && NOT_A_DRAFT.test(stripMarker(area[0]!).trim())) return [];
  return stripMarker(area[0]!).trim() === '' && area.length === 1 ? [] : area;
}

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
