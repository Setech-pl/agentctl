import { createHash } from 'node:crypto';
import { PATTERN_FLAGS } from './config.ts';

/*
 * What stands in the agent's input field, as a whole (not only its first line), and whether it is exactly what agentctl pasted.
 * An Enter that agentctl presses later than the paste (watch, `send --enter-only`) is only allowed while the field still has the
 * signature recorded right after the paste: any other line, an addition, a partial paste or another paste placeholder changes it.
 */

const PROMPT_LINE = /^\s*[❯›>](?:\s|$)/;
/** Lines that end the field when a footer pattern of the agent does not know them. */
const FIELD_END = [/^\s*tab to queue message\s*$/i, /^\s*paste again to expand\s*$/i];
/** A border or separator around the field, and an empty line. */
const BORDER_OR_BLANK = /^[\s─━═│┃║╭╮╰╯┌┐└┘├┤┬┴┼╌╍┄┅┈┉-]*$/u;
/** A paste the TUI folded into one placeholder: "[Pasted text #2 +7 lines]" (Claude Code), "[Pasted Content 1004 chars]" (Codex). */
const PLACEHOLDER = /^\[Pasted (?:text|content)\b[^\]\n]*\]$/i;

/** What an agent shows in an empty field (a suggestion, the placeholder) and the options of a dialog: not a draft (see screenMetadata). */
const NOT_A_DRAFT = /^Try\s|^Ask Codex to do anything$|^\d+\./;

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
/** Wrapping, indentation and no-break spaces are the TUI's own: what counts is every other character. */
export const compact = (text: string) => text.replace(/\s+/g, '');

/** The lines of the input field: the text after the marker of the last prompt line, and the lines that continue it down to the border, the footer or an empty line. Empty array: the field is empty. */
export function inputFieldLines(screen: string, footerPatterns: string[] = []): string[] {
  const lines = screen.split('\n');
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (PROMPT_LINE.test(lines[i]!)) { at = i; break; }
  if (at < 0) return [];
  const footers = footerPatterns.map((p) => new RegExp(p, PATTERN_FLAGS));
  const field: string[] = [];
  const first = lines[at]!.replace(/^\s*[❯›>]\s*/, '').trimEnd();
  if (NOT_A_DRAFT.test(first.trim())) return [];
  if (first.trim()) field.push(first.trim());
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i]!.trimEnd();
    if (BORDER_OR_BLANK.test(line) || FIELD_END.some(re => re.test(line)) || footers.some(re => re.test(line))) break;
    if (!field.length) break;
    field.push(line.trim());
  }
  return field;
}

const digest = (text: string) => createHash('sha256').update(compact(text)).digest('hex').slice(0, 24);

/** The signature of what the field shows: one placeholder, or the text of all its lines. Null for an empty field. */
export function fieldSignature(field: string[]): string | null {
  if (!field.length) return null;
  if (field.length === 1 && PLACEHOLDER.test(field[0]!)) return `collapsed:${squash(field[0]!)}`;
  return `text:${digest(field.join('\n'))}`;
}

/** The signature of the field right after our paste of `text`, or null when the field does not show exactly that paste (one placeholder, or all of `text`). */
export function ownPasteSignature(field: string[], text: string): string | null {
  const signature = fieldSignature(field);
  if (!signature) return null;
  if (signature.startsWith('collapsed:')) return signature;
  return compact(field.join('')) === compact(text) ? signature : null;
}

/** Does the field of `screen` have exactly the signature that was recorded after our paste? */
export function fieldIsOurs(screen: string, footerPatterns: string[], recorded: string | undefined): boolean {
  return Boolean(recorded) && fieldSignature(inputFieldLines(screen, footerPatterns)) === recorded;
}
