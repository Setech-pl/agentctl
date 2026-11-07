import fs from 'node:fs';
import path from 'node:path';
import type { Context } from './context.ts';
import type { GlobalConfig } from './config.ts';
import type { AutoReviewSource, RawSpec, ResolvedSpec } from './spec.ts';
import type { QueueEntry } from './queue.ts';
import type { StatusRow } from './status.ts';
import type { TaskRecord } from './taskstore.ts';
import { findRecordAnywhere } from './taskstore.ts';
import { inspectReport } from './report-state.ts';
import { withFileLock } from './file-lock.ts';
import { loadProjectConfig } from './config.ts';
import { AgentctlError, fillPlaceholders, resolvePath, windowName } from './util.ts';

/*
 * An automatic review reads the author's finished work. It starts only when the author's turn is really over, and it runs in its own
 * checkout (detached at the author's commit) with its own report, so it never shares a worktree, an index, a branch or a report file with
 * the author. The spec of a review is built in ONE place (`buildReviewRaw`): for a new review, for a review whose author committed again,
 * and for an entry written by an earlier build (rebuilt from scratch, never patched).
 */

export const DEFAULT_REVIEW_TEMPLATE = `Review the commits of {task} ({delta}) in your own detached checkout (path below).\nAuthor report: {report}\nRecord evidence, checks, problems and proposed actions.\nDo not merge, do not run mark or any other agentctl action; write the decisions for the owner into the decisions of your agentctl-outputs block.\nDo not modify the author's files or branch. Write only your review report at the canonical path in the report protocol.\n{checkout}`;

export const LEGACY_REVIEW_HINT = 'stary wpis auto-review – usuń (queue_rm) i zakolejkuj przegląd ponownie';
export const LEGACY_RECORD_HINT = 'stary rekord przeglądu – zamknij go (close) i zakolejkuj przegląd ponownie';

const BUSY_STATES = new Set(['working', 'background', 'limited', 'overloaded', 'needs-trust']);

type GateConfig = Pick<GlobalConfig, 'stateDir' | 'cache' | 'reportSettleS'>;

/** The author of a review: a current task, else one in the archive. The same lookup serves migration and the `review_of` check. */
export const findAuthorRecord = (config: GlobalConfig, task: string): TaskRecord | undefined => findRecordAnywhere(config, task);

/** Has the author delivered a finished report of the current attempt: an explicit report-end directive, not only a settled turn. */
export function authorReportEnded(config: GateConfig, author: TaskRecord, nowMs: number): { ended: boolean; reason: string; mtime?: number } {
  const state = inspectReport(config, author, nowMs, !author.attemptId);
  const mtime = state.mtime !== undefined ? { mtime: state.mtime } : {};
  if (!state.ready) return { ended: false, reason: `raport niegotowy (${state.reason})`, ...mtime };
  if (!state.sentinel) return { ended: false, reason: 'raport bez jawnego report-end bieżącej próby', ...mtime };
  return { ended: true, reason: '', ...mtime };
}

/** Why the review of `autoReview` must wait for its author; undefined when the author is quiet (or gone) and the review may start. */
export function authorWaitReason(config: GlobalConfig, autoReview: AutoReviewSource | undefined, rows: StatusRow[], nowMs: number): string | undefined {
  if (!autoReview) return undefined;
  const row = rows.find((r) => r.task === autoReview.author);
  if (!row) return undefined;
  const author = findAuthorRecord(config, autoReview.author);
  const alive = row.window === 'alive' && !row.closed && !row.cancelled;
  const why: string[] = [];
  if (alive) {
    if (BUSY_STATES.has(row.state)) why.push(`stan ${row.state}`);
    if ((row.promptQueue?.length ?? 0) > 0) why.push(`follow-up w kolejce (${row.promptQueue!.length})`);
    if (row.promptDelivery && row.promptDelivery !== 'sent') why.push(`wiadomość niepotwierdzona (${row.promptDelivery})`);
    if (row.draft_input) why.push('szkic w polu wpisywania');
  }
  if (author) {
    const end = authorReportEnded(config, author, nowMs);
    // A closed or cancelled author without a finished report is not waited for: `authorTerminal` fails the review. Everyone else needs report-end and settle, window or not.
    if (!end.ended) { if (alive || !(row.closed || row.cancelled)) why.push(end.reason); }
    else if (config.reportSettleS > 0 && end.mtime !== undefined && nowMs - end.mtime < config.reportSettleS * 1000) why.push(`raport ustala się (${Math.ceil(config.reportSettleS - (nowMs - end.mtime) / 1000)} s)`);
  } else if (alive) why.push('brak rekordu autora');
  return why.length > 0 ? `czeka na autora ${autoReview.author}: ${why.join('; ')}` : undefined;
}

/** The author is closed or cancelled and never delivered a finished report: the review cannot happen by itself. */
export function authorTerminal(config: GlobalConfig, autoReview: AutoReviewSource | undefined, rows: StatusRow[], nowMs: number): { state: 'closed' | 'cancelled'; text: string } | undefined {
  if (!autoReview) return undefined;
  const row = rows.find((r) => r.task === autoReview.author);
  if (!row || (!row.closed && !row.cancelled)) return undefined;
  const author = findAuthorRecord(config, autoReview.author);
  if (author && authorReportEnded(config, author, nowMs).ended) return undefined;
  const state = row.cancelled ? 'cancelled' : 'closed';
  return { state, text: `${state}: autor ${autoReview.author} ${state === 'cancelled' ? 'anulowany' : 'zamknięty'} bez zakończonego raportu bieżącej próby; przegląd wstrzymany – gdy autor dostarczy nowy raport z report-end, uruchom queue_retry tego przeglądu` };
}

/** `after` of a queued entry as the queue must read it: an automatic review does not wait for a report of a cancelled author that has already delivered a finished one. */
export function effectiveAfter(config: GlobalConfig, entry: Pick<QueueEntry, 'after' | 'autoReview'>, rows: readonly StatusRow[], nowMs: number): string[] {
  const ar = entry.autoReview;
  if (!ar || !entry.after.includes(ar.author)) return entry.after;
  const row = rows.find((r) => r.task === ar.author);
  if (!row?.cancelled) return entry.after;
  const author = findAuthorRecord(config, ar.author);
  return author && authorReportEnded(config, author, nowMs).ended ? entry.after.filter((t) => t !== ar.author) : entry.after;
}

export function sameDelta(heads: Record<string, string>, bases: Record<string, string>): string {
  return Object.keys(heads).map((p) => `${path.basename(p)}: ${bases[p] ?? '?'}..${heads[p]}`).join(', ');
}

/** The review's own checkout of an author repository: <worktree_root>/<repo>-<task-rev>, else next to the author's checkout. */
export function reviewWorktree(ctx: Context, repoPath: string, authorWorktree: string, task: string): string {
  let root = ctx.config.worktreeRoot;
  try { root = loadProjectConfig(resolvePath(repoPath))?.worktreeRoot ?? root; } catch { /* a broken project config fails the spec later, with its own message */ }
  const dir = root ? resolvePath(fillPlaceholders(root, { task, cache: ctx.config.cache })) : path.dirname(authorWorktree);
  return path.join(dir, `${path.basename(repoPath)}-${windowName(task)}`);
}

/** The prompt of a review (the author's `review.prompt_template`, else the default), always naming the reviewer's own checkout and the delta. */
function reviewPrompt(author: TaskRecord, repos: { worktree: string }[], delta: string): string {
  let template = DEFAULT_REVIEW_TEMPLATE;
  if (author.review?.promptTemplate) template = fs.readFileSync(resolvePath(author.review.promptTemplate, author.repos[0]?.path), 'utf8');
  const checkout = `Your own checkout (detached at the author's commit, do not use the author's worktree): ${repos.map((r) => r.worktree).join(', ')}`;
  const vars = { task: author.task, report: author.report, delta, checkout };
  return (template.includes('{checkout}') ? template : `${template}\n{checkout}`).replace(/\{(task|report|delta|checkout)\}/g, (_, key: keyof typeof vars) => vars[key]);
}

/**
 * The one builder of a review spec: its own detached worktrees at the author's `heads`, its own canonical report, the delta from `bases`,
 * and the prompt for exactly these. `header` carries task, agent/model/effort, cohort, after, review_of.
 */
export function buildReviewRaw(ctx: Context, author: TaskRecord, task: string, header: Record<string, unknown>, heads: Record<string, string>, bases: Record<string, string>): { raw: RawSpec; delta: string } {
  const repos = author.repos.map((repo) => {
    if (!heads[repo.path]) throw new AgentctlError(`${task}: no commit of ${repo.path} to review`, LEGACY_REVIEW_HINT);
    return { path: repo.path, worktree: reviewWorktree(ctx, repo.path, repo.worktree, task), base: heads[repo.path]! };
  });
  const delta = sameDelta(heads, bases);
  const report = fillPlaceholders('{cache}/{task}/{TASK}.md', { task, cache: ctx.config.cache });
  const { repos: _r, report: _p, ...rest } = header;
  return { raw: { index: 1, header: { ...rest, report, repos }, prompt: reviewPrompt(author, repos, delta) }, delta };
}

const norm = (p: string): string => path.resolve(p);
const inside = (p: string, dir: string): boolean => norm(p) === norm(dir) || norm(p).startsWith(`${norm(dir)}${path.sep}`);

/** The hard invariant of every review start: its report is not the author's, and none of its worktrees is (or lies in, or contains) an author's worktree. */
export function assertReviewIsolated(spec: { task: string; report: string; repos: { worktree: string }[]; reportAlt?: string[] | undefined }, author: TaskRecord): void {
  const reports = [spec.report, ...(spec.reportAlt ?? [])].map(norm);
  if (reports.includes(norm(author.report))) throw new AgentctlError(`${spec.task}: start refused – the review's report ${spec.report} is the author's report (${author.task}); a review never writes the author's file`, LEGACY_REVIEW_HINT);
  for (const repo of spec.repos) for (const theirs of author.repos) {
    if (inside(repo.worktree, theirs.worktree) || inside(theirs.worktree, repo.worktree)) throw new AgentctlError(`${spec.task}: start refused – the review's worktree ${repo.worktree} overlaps the author's checkout ${theirs.worktree}; a review runs only in its own checkout`, LEGACY_REVIEW_HINT);
  }
}

export interface RepinResult { raw: RawSpec; autoReview: AutoReviewSource; reuse: boolean; changed: true; reason: string }

const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : x));

/** An entry written by 0.17.4 before the own-checkout rule: no own report, the author's worktree/branch, no recorded delta or bases. */
export function isLegacyReview(raw: RawSpec, autoReview: AutoReviewSource, author: TaskRecord): boolean {
  const repos = Array.isArray(raw.header.repos) ? (raw.header.repos as Record<string, unknown>[]) : [];
  return !raw.header.report || !autoReview.delta || !autoReview.bases || repos.some((r) => Boolean(r.branch) || author.repos.some((a) => a.worktree === r.worktree));
}

/**
 * Before a review starts (or is retried): rebuild its spec from the author's record with the shared builder when the author committed again
 * or the entry is in the old format. Idempotent: a spec that is already what the builder yields is left alone (undefined). Throws when the
 * data to rebuild it safely is not there.
 */
export async function repinReview(ctx: Context, raw: RawSpec, autoReview: AutoReviewSource, reuse: boolean, head: (repoPath: string, branch: string) => Promise<string | undefined>): Promise<RepinResult | undefined> {
  const task = String(raw.header.task);
  const author = findAuthorRecord(ctx.config, autoReview.author);
  if (!author) throw new AgentctlError(`${task}: no record of the author ${autoReview.author}, not even in the archive`, LEGACY_REVIEW_HINT);
  const legacy = isLegacyReview(raw, autoReview, author);
  const specRepos = Array.isArray(raw.header.repos) ? (raw.header.repos as Record<string, unknown>[]) : [];
  const heads: Record<string, string> = {}, bases: Record<string, string> = {};
  let moved = false;
  for (const a of author.repos) {
    const recorded = autoReview.heads[a.path];
    if (!recorded) throw new AgentctlError(`${task}: the entry does not say which commit of ${a.path} to review`, LEGACY_REVIEW_HINT);
    const now = a.branch ? await head(a.path, a.branch) : undefined;
    heads[a.path] = now ?? recorded;
    if (now && now !== recorded) moved = true;
    // The start of the delta: recorded, else the old spec's base, else the merge-base of the author's own base with the commit.
    const old = specRepos.find((r) => r.path === a.path)?.base;
    let base = autoReview.bases?.[a.path] ?? (legacy && typeof old === 'string' && /^[0-9a-f]{7,40}$/i.test(old) ? old : undefined);
    if (!base && a.base) {
      const mb = await ctx.runner.exec('git', ['-C', a.path, 'merge-base', '--end-of-options', a.base, heads[a.path]!], { readOnly: true });
      if (mb.code === 0 && /^[0-9a-f]{40}$/i.test(mb.stdout.trim())) base = mb.stdout.trim();
    }
    if (!base) throw new AgentctlError(`${task}: the start of the reviewed delta of ${a.path} cannot be recovered`, LEGACY_REVIEW_HINT);
    bases[a.path] = base;
  }
  const { repos: _r, report: _p, ...header } = raw.header;
  const built = buildReviewRaw(ctx, author, task, header, heads, bases);
  const next: AutoReviewSource = { ...autoReview, heads, bases, delta: built.delta };
  const nextReuse = legacy ? false : reuse;
  if (canon([built.raw.header, built.raw.prompt, next]) === canon([raw.header, raw.prompt, autoReview]) && nextReuse === reuse) return undefined;
  return { raw: built.raw, autoReview: next, reuse: nextReuse, changed: true, reason: legacy ? 'przegląd odbudowany od nowa (stary format wpisu)' : moved ? 'autor dodał commit: przegląd przypięty do nowego SHA' : 'przegląd odświeżony' };
}

/** Another process is changing the author's checkout right now: a git command (or its child) whose cwd is in the author's worktree, or a lock. */
export async function authorCheckoutBusy(ctx: Context, authorTask: string): Promise<string | undefined> {
  const author = findAuthorRecord(ctx.config, authorTask);
  if (!author || ctx.runner.dryRun) return undefined;
  const worktrees = author.repos.map((r) => r.worktree).filter((w) => fs.existsSync(w));
  if (worktrees.length === 0) return undefined;
  for (const worktree of worktrees) {
    const lock = await ctx.runner.exec('git', ['-C', worktree, 'rev-parse', '--git-path', 'index.lock'], { readOnly: true });
    if (lock.code === 0 && lock.stdout.trim() && fs.existsSync(path.resolve(worktree, lock.stdout.trim()))) return `index.lock w ${worktree}`;
  }
  const ps = await ctx.runner.exec('ps', ['-axo', 'pid=,ppid=,args='], { readOnly: true });
  if (ps.code !== 0) return 'nie można sprawdzić procesów (ps) w checkoucie autora';
  const procs = ps.stdout.split('\n').flatMap((line) => { const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line); return m ? [{ pid: m[1]!, ppid: m[2]!, args: m[3]! }] : []; });
  const isGit = (args: string): boolean => /(?:^|\/)git$/.test(args.split(/\s+/)[0] ?? '');
  // git processes and everything below them (an alias or hook spawns children with the same cwd).
  const suspects = new Set(procs.filter((p) => isGit(p.args)).map((p) => p.pid));
  for (let grew = true; grew;) { grew = false; for (const p of procs) if (!suspects.has(p.pid) && suspects.has(p.ppid)) { suspects.add(p.pid); grew = true; } }
  suspects.delete(String(process.pid));
  for (const pid of suspects) {
    const proc = procs.find((p) => p.pid === pid)!;
    const named = worktrees.find((w) => proc.args.includes(w));
    if (named) return `proces ${pid} (${proc.args.slice(0, 60)}) w ${named}`;
    const cwd = await ctx.runner.exec(process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], { readOnly: true });
    if (cwd.code !== 0) {
      const alive = await ctx.runner.exec('ps', ['-p', pid, '-o', 'pid='], { readOnly: true });
      if (alive.code !== 0 || !alive.stdout.trim()) continue; // gone between ps and lsof
      return `nie można sprawdzić katalogu procesu ${pid} (${proc.args.slice(0, 40)})`;
    }
    const dirs = cwd.stdout.split('\n').filter((l) => l.startsWith('n')).map((l) => l.slice(1));
    const hit = worktrees.find((w) => dirs.some((d) => inside(d, w)));
    if (hit) return `proces ${pid} (${proc.args.slice(0, 60)}) działa w ${hit}`;
  }
  return undefined;
}

/** The ledger of automatic reviews follows a rebuilt review, so that the next review's delta starts at the commit this one read. */
export async function syncReviewLedger(ctx: Context, authorTask: string, task: string, heads: Record<string, string>): Promise<void> {
  const file = path.join(path.dirname(ctx.config.path), 'auto-reviews.json');
  await withFileLock(`${file}.lock`, async () => {
    let state: Record<string, { hash: string; task: string; heads: Record<string, string> }[]> = {};
    try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
    const run = state[authorTask]?.find((r) => r.task === task);
    if (!run) return;
    run.heads = heads;
    await ctx.runner.writeFile(file, JSON.stringify(state));
  });
}
