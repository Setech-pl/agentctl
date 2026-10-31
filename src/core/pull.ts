import fs from 'node:fs';
import os from 'node:os';
import type { Context } from './context.ts';
import { syncMirror } from './mirror.ts';
import { collectStatus } from './status.ts';
import { readTaskRecord } from './taskstore.ts';
import { AgentctlError, windowName } from './util.ts';

export const PULL_FALLBACK_LINES = 40;

/** First available clipboard command for this platform, as [command, ...args]. */
export async function findClipboardCommand(ctx: Context, platform: string = os.platform()): Promise<string[] | undefined> {
  const candidates: string[][] =
    platform === 'darwin' ? [['pbcopy']] : [['wl-copy'], ['xclip', '-selection', 'clipboard']];
  for (const candidate of candidates) {
    const r = await ctx.runner.exec('sh', ['-c', 'command -v "$1"', 'sh', candidate[0] as string], { readOnly: true });
    if (r.code === 0) return candidate;
  }
  return undefined;
}

/** Copy the task's report to the clipboard and print its path; without a report, print the window's last lines. */
export async function pullTask(ctx: Context, taskArg: string, platform?: string): Promise<void> {
  const { config, runner, tmux } = ctx;
  const window = windowName(taskArg);
  const record = readTaskRecord(config, window);
  if (!record) {
    throw new AgentctlError(`unknown task ${taskArg}: no TASK.md in ${config.cache}/${window}`, 'List known tasks with "agentctl status".');
  }

  // With mirror_dir set, pull also refreshes the mirror (this report and status.json).
  if (config.mirrorDir) await syncMirror(ctx, await collectStatus(ctx));

  if (record.report && fs.existsSync(record.report)) {
    const text = fs.readFileSync(record.report, 'utf8');
    const clip = await findClipboardCommand(ctx, platform);
    if (clip) {
      const [cmd, ...args] = clip as [string, ...string[]];
      const r = await runner.exec(cmd, args, { input: text });
      if (r.code === 0) ctx.out(`Copied ${text.length} characters to the clipboard (${cmd}).`);
      else ctx.out(`Clipboard command ${cmd} failed: ${r.stderr.trim()}`);
    } else {
      ctx.out('No clipboard tool found (pbcopy, wl-copy or xclip); read the report from the path below.');
    }
    ctx.out(record.report);
    return;
  }

  ctx.out(`No report at ${record.report || '(none configured)'}; last ${PULL_FALLBACK_LINES} lines of window ${window}:`);
  const screen = await tmux.capture(window, PULL_FALLBACK_LINES);
  if (screen.code !== 0) {
    throw new AgentctlError(`window "${window}" is gone and there is no report`, `Check ${config.cache}/${window}/ and the worktree for results.`);
  }
  const lines = screen.stdout.replace(/\s+$/, '').split('\n');
  for (const line of lines.slice(-PULL_FALLBACK_LINES)) ctx.out(line);
}
