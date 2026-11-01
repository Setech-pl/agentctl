import os from 'node:os';
import type { Runner } from './runner.ts';
import { AgentctlError } from './util.ts';

type Direction = 'read' | 'write';

const COMMANDS: Record<string, Record<Direction, string[][]>> = {
  darwin: { read: [['pbpaste']], write: [['pbcopy']] },
  linux: {
    read: [['wl-paste', '--no-newline'], ['xclip', '-selection', 'clipboard', '-o']],
    write: [['wl-copy'], ['xclip', '-selection', 'clipboard']],
  },
};

/** First clipboard command available on this platform, as [command, ...args]. */
export async function findClipboardTool(runner: Runner, direction: Direction, platform: string = os.platform()): Promise<string[] | undefined> {
  const candidates = (COMMANDS[platform] ?? COMMANDS.linux!)[direction];
  for (const candidate of candidates) {
    const r = await runner.exec('sh', ['-c', 'command -v "$1"', 'sh', candidate[0] as string], { readOnly: true });
    if (r.code === 0) return candidate;
  }
  return undefined;
}

/** Text on the clipboard; throws when there is no clipboard tool or the command fails. */
export async function readClipboard(runner: Runner, platform?: string): Promise<string> {
  const tool = await findClipboardTool(runner, 'read', platform);
  if (!tool) throw new AgentctlError('no clipboard tool found (pbpaste, wl-paste or xclip)', 'Save the spec to a file and pass it as an argument instead.');
  const [cmd, ...args] = tool as [string, ...string[]];
  const r = await runner.exec(cmd, args, { readOnly: true });
  if (r.code !== 0) throw new AgentctlError(`${cmd} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  return r.stdout;
}

/** Copy text to the clipboard; false when there is no clipboard tool or it failed (the reason goes to `ctx.out`-style callers via the return value). */
export async function writeClipboard(runner: Runner, text: string, platform?: string): Promise<{ ok: boolean; tool?: string; error?: string }> {
  const tool = await findClipboardTool(runner, 'write', platform);
  if (!tool) return { ok: false, error: 'no clipboard tool found (pbcopy, wl-copy or xclip)' };
  const [cmd, ...args] = tool as [string, ...string[]];
  const r = await runner.exec(cmd, args, { input: text });
  if (r.code !== 0) return { ok: false, tool: cmd, error: `${cmd} failed: ${r.stderr.trim() || `exit ${r.code}`}` };
  return { ok: true, tool: cmd };
}

/**
 * A spec taken from the clipboard: trimmed, with a surrounding Markdown code fence removed (a chat
 * may hand it over fenced). Throws a readable error for an empty clipboard or text without a YAML header.
 */
export function specFromClipboard(raw: string): string {
  let text = raw.replace(/\r\n/g, '\n').trim();
  const fenced = /^```[\w-]*\n([\s\S]*)\n```$/.exec(text);
  if (fenced) text = (fenced[1] as string).trim();
  if (text === '') throw new AgentctlError('the clipboard is empty', 'Copy the spec block from the chat first.');
  if (text.split('\n')[0]?.trimEnd() !== '---') {
    throw new AgentctlError(
      'the clipboard does not start with a YAML header ("---")',
      'Copy the whole spec block: a "---" line, the header, a second "---", then the prompt. See "agentctl spec example".',
    );
  }
  return `${text}\n`;
}

/**
 * Show a summary and ask y/N. `yes` (-y) skips the question. Returns false when the user declines.
 * Without a terminal and without -y it refuses rather than guess.
 */
export async function confirmAction(
  ctx: { out: (line: string) => void; confirm: ((q: string) => Promise<boolean>) | undefined },
  summary: string[],
  question: string,
  yes: boolean,
): Promise<boolean> {
  for (const l of summary) ctx.out(l);
  if (yes) return true;
  if (!ctx.confirm) throw new AgentctlError('no terminal to ask on', 'Pass -y to go ahead without the question.');
  if (await ctx.confirm(`${question} [y/N] `)) return true;
  ctx.out('Aborted, nothing was done.');
  return false;
}
