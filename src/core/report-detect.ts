import { inspectReport } from './report-state.ts';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { Context } from './context.ts';
import { recordJournal } from './journal.ts';
import { readTaskRecord, setHeaderFields, taskFile } from './taskstore.ts';
import type { TaskRecord } from './taskstore.ts';
import { AgentctlError, expandHome, windowName } from './util.ts';

/*
 * Agents write their report where they like (docs/reports/<…>.md in the worktree, ~/Projects/cache/<other name>/…) instead of the
 * `report:` path of the spec. This finds it: in the last message of the agent, in the last lines of its window and in the `report:`
 * list of the spec/project (more paths and globs). A report found elsewhere is copied to the canonical path (the first `report:`
 * entry), the original stays and is remembered as `report_source`.
 */

/** Lines of the window (joined where tmux wrapped them) that are searched for paths. */
export const PANE_LINES = 400;

const QUOTED_MD = /(["'`])((?:~\/|\/|\.{1,2}\/)?[^"'`\n]*?\.md)\1/g;
const BARE_MD = /(?<![\w/.~@%+=,-])((?:~\/|\/|\.{1,2}\/)?[\w.@%+=,-]+(?:\/[\w.@%+=,-]+)*\.md)(?![\w/-])/g;

/** The `.md` paths in a text (absolute, `~/…`, relative, also after `pbcopy < `), in the order of their last mention (the last is the latest). */
export function extractMdPaths(text: string): string[] {
  const at = new Map<string, number>();
  const note = (raw: string, index: number): void => {
    const p = raw.trim();
    if (p === '' || /^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return;
    at.set(p, index);
  };
  // A quoted path may hold spaces; a quoted command line ("pbcopy < x.md") is not a path: the bare match finds the path inside it.
  const quoted: Array<[number, number]> = [];
  for (const m of text.matchAll(QUOTED_MD)) {
    const inner = m[2] as string;
    if (/[<>|;&$]/.test(inner) || /^\w+\s/.test(inner) && !inner.includes('/')) continue;
    const start = m.index ?? 0;
    quoted.push([start, start + m[0].length]);
    note(inner, start);
  }
  for (const m of text.matchAll(BARE_MD)) {
    const i = m.index ?? 0;
    if (quoted.some(([a, b]) => i >= a && i < b)) continue;
    note(m[1] as string, i);
  }
  return [...at.entries()].sort((a, b) => a[1] - b[1]).map(([p]) => p);
}

/** A glob over path segments: `*`, `?` and `**` (any depth, at most 6 levels). Returns the files only. */
export function globFiles(pattern: string): string[] {
  const parts = pattern.split('/');
  const out: string[] = [];
  const segmentRe = (seg: string): RegExp => new RegExp(`^${seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);
  const walk = (dir: string, i: number, depth: number): void => {
    const seg = parts[i];
    if (seg === undefined) return;
    const last = i === parts.length - 1;
    if (seg === '**') {
      if (depth > 6) return;
      walk(dir, i + 1, depth);
      for (const e of safeDir(dir)) if (e.isDirectory() && !e.name.startsWith('.')) walk(path.join(dir, e.name), i, depth + 1);
      return;
    }
    if (!/[*?]/.test(seg)) {
      const next = path.join(dir, seg);
      if (last) {
        if (isFile(next)) out.push(next);
      } else walk(next, i + 1, depth);
      return;
    }
    const re = segmentRe(seg);
    for (const e of safeDir(dir)) {
      if (!re.test(e.name)) continue;
      const next = path.join(dir, e.name);
      if (last) {
        if (isFile(next)) out.push(next);
      } else if (e.isDirectory()) walk(next, i + 1, depth);
    }
  };
  walk(pattern.startsWith('/') ? '/' : '.', pattern.startsWith('/') ? 1 : 0, 0);
  return [...new Set(out)];
}

function safeDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** A regular file, not a symbolic link (an agent could have made one). */
function isFile(file: string): boolean {
  try {
    const st = fs.lstatSync(file);
    return st.isFile() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

const worktreesOf = (record: Pick<TaskRecord, 'repos'>): string[] => record.repos.map((r) => r.worktree).filter((w) => w !== '');

/** The absolute path(s) a written path may mean: absolute and `~/` as they are, a relative one inside each worktree. */
function absolutes(raw: string, worktrees: string[]): string[] {
  const p = expandHome(raw);
  if (path.isAbsolute(p)) return [path.normalize(p)];
  return worktrees.map((w) => path.resolve(w, p));
}

export interface ReportCandidate {
  file: string;
  mtimeMs: number;
  /** Why it was chosen: the `report:` list, a name with the task ID or "report"/"raport", or just the latest one mentioned. */
  why: 'configured' | 'named' | 'mentioned';
}

const startedOf = (record: Pick<TaskRecord, 'started' | 'attemptStarted'>): number => Date.parse(record.attemptStarted ?? record.started);

/**
 * The files that may be the report of the task: existing files, not the canonical file itself; freshness is required only for confirmation.
 * Best first: the `report:` list (newest), then paths with the task ID or "report"/"raport" in them (latest mention first),
 * then the others (latest mention first).
 */
export function findCandidates(ctx: Context, record: TaskRecord, text: string): ReportCandidate[] {
  const worktrees = worktreesOf(record);
  const canonical = path.normalize(record.report);
  const stateDir = path.normalize(ctx.config.stateDir) + path.sep;
  const seen = new Set<string>();
  const out: ReportCandidate[] = [];
  const add = (file: string, why: ReportCandidate['why']): void => {
    if (seen.has(file) || file === canonical || file.startsWith(stateDir) || !isFile(file)) return;
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      return;
    }
    seen.add(file);
    out.push({ file, mtimeMs, why });
  };

  const configured: string[] = [];
  for (const pattern of record.reportAlt ?? []) for (const abs of absolutes(pattern, worktrees)) configured.push(...globFiles(abs));
  const fresh = (files: string[]): string[] => files.filter((f) => f !== canonical && isFile(f)).sort((a, b) => mtime(b) - mtime(a));
  for (const f of fresh(configured)) add(f, 'configured');

  const id = record.task.toLowerCase();
  const mentioned = extractMdPaths(text).flatMap((raw) => absolutes(raw, worktrees)).reverse(); // latest first
  const named = (f: string): boolean => {
    const base = f.toLowerCase();
    return base.includes(id) || /report|raport/.test(base);
  };
  for (const f of mentioned) if (named(f)) add(f, 'named');
  for (const f of mentioned) add(f, 'mentioned');
  return out;
}

function mtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** All evidence is required for automatic confirmation. Explicit --from is the human override. */
export function confirmedCandidate(ctx: Context, record: TaskRecord, candidate: ReportCandidate): boolean {
  const name = path.basename(candidate.file);
  if (/^(?:CLAUDE|AGENTS|CHANGELOG)\.md$|^README.*\.md$/i.test(name)) return false;
  if (!name.toLowerCase().includes(record.task.toLowerCase())) return false;
  if (candidate.mtimeMs <= startedOf(record) || candidate.why !== 'configured') return false;
  const first = fs.readFileSync(candidate.file, 'utf8').split('\n').find(l => l.trim()) ?? '';
  if (!new RegExp(ctx.config.notify.verdictPattern ?? '^Werdykt:', 'i').test(first)) return false;
  // HEAD at task start, rather than today's index: newly committed reports remain eligible.
  for (const root of worktreesOf(record)) {
    const rel = path.relative(root, candidate.file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const revision = spawnSync('git', ['-C', root, 'rev-list', '-1', `--before=${record.started}`, 'HEAD'], { encoding: 'utf8' });
    if (revision.status !== 0) return false;
    if (!revision.stdout.trim()) continue;
    const tracked = spawnSync('git', ['-C', root, 'cat-file', '-e', `${revision.stdout.trim()}:${rel}`]);
    if (tracked.status === 0) return false;
  }
  return true;
}

export interface SyncResult {
  action: 'copied' | 'updated' | 'none' | 'kept';
  source?: string | undefined;
  /** Why nothing was copied although a source exists (`kept`): the canonical file is there. */
  note?: string | undefined;
}

export interface SyncOptions {
  /** The last message of the agent (the full text, not the clipped line of the event). */
  message?: string | undefined;
  /** Search the last lines of the window too. */
  pane?: boolean | undefined;
  /** Use this file as the source (`agentctl report --from`). */
  from?: string | undefined;
  /** Copy over a canonical file even if the agent wrote it. */
  force?: boolean | undefined;
  /** Only look: copy nothing, change nothing. */
  dryRun?: boolean | undefined;
}

const canonicalFresh = (record: TaskRecord): boolean => {
  const startedMs = startedOf(record);
  const m = mtime(record.report);
  return isFile(record.report) && m > 0 && (Number.isNaN(startedMs) || m >= startedMs);
};

/** The canonical file is the copy agentctl made and nobody changed it since. */
const canonicalIsOurCopy = (record: TaskRecord): boolean => {
  if (!record.reportSource || !record.reportCopied) return false;
  const copied = Date.parse(record.reportCopied);
  return !Number.isNaN(copied) && mtime(record.report) <= copied + 1000;
};

/** Windows text for the search: the last lines of the pane, joined where tmux wrapped. */
async function paneText(ctx: Context, record: TaskRecord): Promise<string> {
  const screen = await ctx.tmux.capture(record.window, PANE_LINES, undefined, record.windowId, true).catch(() => undefined);
  return screen && screen.code === 0 ? screen.stdout : '';
}

/**
 * Find where the agent wrote the report and make the canonical file a copy of it. Never overwrites a canonical file that the agent (or
 * the user) wrote. A fresh canonical file always wins, including a prior detected copy. The task record keeps `report_source`; the journal
 * says "raport wykryty w <path>". Returns what happened; throws nothing for a missing file or a failed copy.
 */
export async function syncReport(ctx: Context, record: TaskRecord, opts: SyncOptions = {}): Promise<SyncResult> {
  const { runner } = ctx;
  const file = taskFile(ctx.config, record.window);
  let source: string | undefined;
  if (!opts.from && canonicalFresh(record)) return { action: 'none' };
  if (opts.from) {
    const found = absolutes(opts.from, worktreesOf(record)).find((f) => isFile(f));
    if (!found) return { action: 'none', note: `${opts.from} is not an existing file` };
    source = found;
  } else if (canonicalFresh(record)) {
    return { action: 'none' };
  } else {
    const text = `${opts.pane ? await paneText(ctx, record) : ''}\n${opts.message ?? ''}`;
    const candidates = findCandidates(ctx, record, text);
    source = candidates.find(c => confirmedCandidate(ctx, record, c) && inspectReport(ctx.config, record, ctx.runner.now(), Boolean(record.turnEndedAt), c.file).ready)?.file;
    const candidate = candidates[0]?.file;
    if (!source && candidate && candidate !== record.reportCandidate && !opts.dryRun) {
      record.reportCandidate = candidate;
      await setHeaderFields(runner, file, { report_candidate: candidate });
      await recordJournal(ctx, { kind: 'report-candidate', task: record.task, text: `${record.task}: report-candidate ${candidate}` });
    }
  }
  if (!source) return { action: 'none' };
  if (source === path.normalize(record.report)) return { action: 'none' };

  const sourceCompleteness = inspectReport(ctx.config, record, runner.now(), false, source);
  const exists = mtime(record.report) > 0;
  const ours = canonicalIsOurCopy(record);
  if (exists && !ours && !opts.force && canonicalFresh(record)) return { action: 'kept', source, note: `${record.report} exists and is not a copy of agentctl; it was not overwritten` };
  if (exists && !ours && !opts.force) return { action: 'kept', source, note: `${record.report} exists (from before the task started); it was not overwritten, --force replaces it` };
  if (opts.dryRun) return { action: exists ? 'updated' : 'copied', source };

  try {
    await runner.copyFile(source, record.report);
  } catch (e) {
    return { action: 'none', source, note: `copy failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  // The modification time of the copy itself (the clock of a test run is not the clock of the file system).
  const nowIso = new Date(mtime(record.report) || runner.now()).toISOString();
  const sourceMtime = new Date(mtime(source)).toISOString();
  const first = record.reportSource !== source;
  if (sourceCompleteness.ready) record.reportCompleteHash = sourceCompleteness.signature;
  record.reportSource = source;
  record.reportCopied = nowIso;
  record.reportSourceMtime = sourceMtime;
  await setHeaderFields(runner, file, { report_complete_hash: sourceCompleteness.ready ? sourceCompleteness.signature ?? null : null, report_candidate: null, report_source: source, report_copied: nowIso, report_source_mtime: sourceMtime });
  if (first) await recordJournal(ctx, { kind: 'report-detected', task: record.task, text: `${record.task}: raport wykryty w ${shortPath(source)}` });
  return { action: exists ? 'updated' : 'copied', source };
}

/** `~/…` for the home directory, so a line stays short and holds no user name. */
export function shortPath(file: string): string {
  const home = expandHome('~');
  return file.startsWith(`${home}/`) ? `~/${file.slice(home.length + 1)}` : file;
}

export interface ReportInfo {
  task: string;
  canonical: string;
  canonicalExists: boolean;
  /** Where the report was found and copied from (the record); undefined when the agent wrote the canonical file itself. */
  source: string | undefined;
  /** Without `--from`: what the search finds now (nothing is copied). */
  candidates: ReportCandidate[];
  /** With `--from`: what the copy did. */
  result?: SyncResult;
}

/**
 * `agentctl report <TASK>`: where the report is and what the search finds (nothing changes). With `from`: that file becomes the source
 * and is copied to the canonical path (`force` also over a canonical file the agent wrote).
 */
export async function reportInfo(ctx: Context, taskArg: string, opts: { from?: string | undefined; force?: boolean | undefined } = {}): Promise<ReportInfo> {
  const window = windowName(taskArg);
  const record = readTaskRecord(ctx.config, window);
  if (!record) throw new AgentctlError(`unknown task ${taskArg}: no TASK.md in ${ctx.config.stateDir}/${window}`, 'List known tasks with "agentctl status".');
  const result = opts.from ? await syncReport(ctx, record, { from: opts.from, force: opts.force, dryRun: ctx.runner.dryRun }) : undefined;
  const fresh = readTaskRecord(ctx.config, window) ?? record;
  const candidates = opts.from ? [] : findCandidates(ctx, fresh, `${await paneText(ctx, fresh)}`);
  return { task: fresh.task, canonical: fresh.report, canonicalExists: mtime(fresh.report) > 0, source: fresh.reportSource, candidates, ...(result ? { result } : {}) };
}
