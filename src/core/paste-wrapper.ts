/*
 * Claude Code hands a collapsed paste to the UserPromptSubmit hook as `<pasted_content id="80b3">\n…\n</pasted_content id="80b3">`
 * (tests/fixtures/claude-user-prompt-submit-pasted.json). The wrapper is transport: it is taken off the text that the hook delivered, never off
 * the prompt that agentctl is waiting for, which is compared as written.
 */

const TAGS = /<pasted_content id="([^"]*)">|<\/pasted_content id="([^"]*)">/g;

/**
 * The text of the hook with every wrapper replaced by its content. Null when the wrapping is ambiguous: a wrapper inside a wrapper (the user's
 * own text holds such tags), a closing tag with another id than the opening one, an unclosed or a stray tag. Several separate wrappers are fine.
 */
export function unwrapPastedContent(text: string): string | null {
  let out = '', last = 0, start = -1, id = '';
  for (const tag of text.matchAll(TAGS)) {
    if (tag[1] !== undefined) {
      if (start >= 0) return null;
      out += text.slice(last, tag.index);
      start = tag.index + tag[0].length;
      id = tag[1];
    } else {
      if (start < 0 || tag[2] !== id) return null;
      out += text.slice(start, tag.index).replace(/^\n/, '').replace(/\n$/, '');
      start = -1;
      last = tag.index + tag[0].length;
    }
  }
  return start >= 0 ? null : out + text.slice(last);
}

const plain = (text: string) => text.replace(/\r\n?/g, '\n').trim();

/** Does the prompt of the hook say the same as the pending prompt? As written, or with the hook's own wrappers taken off; never with tags taken out of the pending prompt. */
export function hookPromptMatches(hookPrompt: string, pending: string): boolean {
  if (plain(hookPrompt) === plain(pending)) return true;
  const unwrapped = unwrapPastedContent(hookPrompt);
  return unwrapped !== null && plain(unwrapped) === plain(pending);
}
