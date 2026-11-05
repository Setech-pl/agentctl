import fs from 'node:fs';

// Screen data only. Copy the structural rows verbatim from the hotfix's real CLI captures.
const claude = fs.readFileSync(new URL('./fixtures/screen-claude-busy-paste.txt', import.meta.url), 'utf8').split('\n');
const codex = fs.readFileSync(new URL('./fixtures/screen-codex-busy-steered.txt', import.meta.url), 'utf8').trimEnd().split('\n');
export const CLAUDE_COMPOSER_BORDER = claude.find(line => /^─+$/.test(line))!;
export const CODEX_COMPOSER_BOTTOM = codex.slice(-2);

/** Add only the missing structural rows around the existing single-row fake input. All original rows/bytes stay in order. */
export function composerFixture(screen: string): string {
  const rows = screen.split('\n');
  const at = rows.findLastIndex(line => /^[❯›](?:\s|$)/.test(line));
  if (at < 0) return screen;
  if (rows[at]!.startsWith('❯')) {
    rows.splice(at + 1, 0, CLAUDE_COMPOSER_BORDER);
    rows.splice(at, 0, CLAUDE_COMPOSER_BORDER);
  } else rows.splice(at + 1, 0, ...CODEX_COMPOSER_BOTTOM);
  return rows.join('\n');
}
