import fs from 'node:fs';
import { findClipboardTool, writeClipboard } from './clipboard.ts';
import type { Context } from './context.ts';
import { syncMirror } from './mirror.ts';
import { collectStatus } from './status.ts';
import { readTaskRecord, setHeaderField, taskFile } from './taskstore.ts';
import { AgentctlError, windowName } from './util.ts';

export const PULL_FALLBACK_LINES = 40;

/** Copy the task's report to the clipboard and print its path; without a report, print the window's last lines. */
export async function pullTask(ctx: Context, taskArg: string, platform?: string): Promise<void> {
  const { config, runner, tmux } = ctx;
  const window = windowName(taskArg);
  const record = readTaskRecord(config, window);
  if (!record) {
    throw new AgentctlError(`unknown task ${taskArg}: no TASK.md in ${config.stateDir}/${window}`, `List known tasks with "agentctl status"; a task whose state file is lost can be restored with "agentctl adopt ${taskArg.toUpperCase()} --report <path>".`);
  }

  // With mirror_dir set, pull also refreshes the mirror (this report and status.json).
  if (config.mirrorDir) await syncMirror(ctx, await collectStatus(ctx));

  if (record.report && fs.existsSync(record.report)) {
    const text = fs.readFileSync(record.report, 'utf8');
    const clip = await findClipboardTool(runner, 'write', platform);
    if (clip) {
      const [cmd, ...args] = clip as [string, ...string[]];
      const r = await runner.exec(cmd, args, { input: text });
      if (r.code === 0) {
        ctx.out(`Copied ${text.length} characters to the clipboard (${cmd}).`);
        // Copied means pulled: `pull --ready` does not hand this report over again, and a finished task hides by itself.
        await setHeaderField(runner, taskFile(config, window), 'pulled', new Date(runner.now()).toISOString());
      } else ctx.out(`Clipboard command ${cmd} failed: ${r.stderr.trim()}`);
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

/** Above this the combined text is probably too much for one chat message. */
export const PULL_WARN_BYTES = 100 * 1024;

export interface PulledReport {
  task: string;
  /** "claude opus/high" */
  who: string;
  bytes: number;
}

export interface PullReadyResult {
  pulled: PulledReport[];
  totalBytes: number;
  /** The combined text; empty when nothing was pulled. */
  text: string;
  copied: boolean;
  warnedLarge: boolean;
}

/**
 * `pull --ready`: join the reports of all tasks in state report-ready that were not pulled yet
 * (`all`: pulled ones too) into one text, copy it to the clipboard and mark each task as pulled
 * in its TASK.md. Nothing is marked when the copy fails.
 */
export async function pullReady(ctx: Context, opts: { all?: boolean } = {}, platform?: string): Promise<PullReadyResult> {
  const { config, runner } = ctx;
  const rows = await collectStatus(ctx);
  if (config.mirrorDir) await syncMirror(ctx, rows);
  const chosen = rows.filter((r) => r.state === 'report-ready' && r.report === 'yes' && (opts.all || r.pulled === null));
  const empty: PullReadyResult = { pulled: [], totalBytes: 0, text: '', copied: false, warnedLarge: false };
  if (chosen.length === 0) {
    const already = rows.filter((r) => r.state === 'report-ready' && r.pulled !== null).length;
    ctx.out(already > 0 ? `No new reports (${already} already pulled; --all takes them again).` : 'No reports ready.');
    return empty;
  }

  const sections: string[] = [];
  const pulled: PulledReport[] = [];
  for (const row of chosen) {
    const body = fs.readFileSync(row.reportPath, 'utf8').trimEnd();
    sections.push(`=== ${row.task} (${row.agent} ${row.model}/${row.effort}) ===\n${body}\n`);
    pulled.push({ task: row.task, who: `${row.agent} ${row.model}/${row.effort}`, bytes: Buffer.byteLength(body) });
  }
  const text = sections.join('\n');
  const totalBytes = Buffer.byteLength(text);

  const copy = await writeClipboard(runner, text, platform);
  if (!copy.ok) {
    ctx.out(`${copy.error}; nothing was marked as pulled. Reports: ${chosen.map((r) => r.reportPath).join(', ')}`);
    return { pulled: [], totalBytes, text, copied: false, warnedLarge: false };
  }
  const when = new Date(runner.now()).toISOString();
  for (const row of chosen) await setHeaderField(runner, taskFile(config, row.task.toLowerCase()), 'pulled', when);

  ctx.out(`Copied ${pulled.length} report${pulled.length === 1 ? '' : 's'} to the clipboard (${copy.tool}), ${formatBytes(totalBytes)}:`);
  for (const p of pulled) ctx.out(`  ${p.task}  ${p.who}  ${formatBytes(p.bytes)}`);
  const warnedLarge = totalBytes > PULL_WARN_BYTES;
  if (warnedLarge) ctx.out(`warning: ${formatBytes(totalBytes)} is more than ${PULL_WARN_BYTES / 1024} KB; the chat may not take it in one paste. Pull fewer reports or trim them.`);
  return { pulled, totalBytes, text, copied: true, warnedLarge };
}

export function formatBytes(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;
}
