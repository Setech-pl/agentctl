/*
 * Claude Code hands a collapsed paste to the UserPromptSubmit hook as `<pasted_content id="80b3">\n…\n</pasted_content id="80b3">`
 * (tests/fixtures/claude-user-prompt-submit-pasted.json). The wrapper is transport: it is taken off the text that the hook delivered, never off
 * the prompt that agentctl is waiting for, which is compared as written.
 */

const TAGS = /<pasted_content id="([^"]*)">|<\/pasted_content id="([^"]*)">/g;

/** Providers whose message-storage quirks the delivery comparison knows (glm behaves exactly like claude). */
export type DeliveryAgent = 'claude' | 'codex' | 'kimi' | 'glm' | 'unknown';

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

/** Line endings are the one thing normalised: \r\n and \r are \n. */
export const eol = (text: string) => text.replace(/\r\n?/g, '\n');

/**
 * What an agent keeps of a message that was pasted into it, recorded from the real CLIs (Claude Code 2.1.311, codex-cli 0.166.0): the
 * white space at the end of the message is dropped, the newlines in front of a collapsed paste are the wrapper's own padding, and Claude Code
 * stores a tab as four spaces. Nothing inside the message is compared loosely: no run of white space is squeezed or removed.
 */
export function storedForm(text: string, agent?: DeliveryAgent): string {
  const lines = eol(text);
  return (agent === 'claude' || agent === 'glm' ? lines.replace(/\t/g, '    ') : lines).replace(/^\n+/, '').trimEnd();
}

/**
 * Does the text of a hook or a transcript say exactly what was pasted? As written, or with the wrappers of the agent taken off; never with tags
 * taken out of the pending prompt.
 */
export function sameMessage(seen: string, pending: string, agent?: DeliveryAgent): boolean {
  const want = storedForm(pending, agent);
  if (want === '') return false;
  if (storedForm(seen) === want) return true;
  const unwrapped = unwrapPastedContent(seen);
  return unwrapped !== null && storedForm(unwrapped) === want;
}

/** Kept for the hook: the prompt of the hook against the pending prompt. */
export function hookPromptMatches(hookPrompt: string, pending: string, agent?: DeliveryAgent): boolean {
  return sameMessage(hookPrompt, pending, agent);
}
