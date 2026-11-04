import fs from 'node:fs';
import path from 'node:path';
import type { Context } from './context.ts';
import type { AgentName, ReviewSettings } from './config.ts';
import type { Order } from './equivalents.ts';
import { translate } from './equivalents.ts';
import { inspectReport } from './report-state.ts';
import { listTaskRecords, listArchivedRecords } from './taskstore.ts';
import type { TaskRecord } from './taskstore.ts';
import { commitQueueAdd, readQueue } from './queue.ts';
import { resolveSpec } from './spec.ts';
import type { RawSpec } from './spec.ts';
import { planBatch } from './plan.ts';
import { recordJournal } from './journal.ts';
import { withFileLock } from './file-lock.ts';
import { AgentctlError, errorMessage, fillPlaceholders, resolvePath } from './util.ts';
import { buildReviewRaw, DEFAULT_REVIEW_TEMPLATE } from './review-gate.ts';

export { DEFAULT_REVIEW_TEMPLATE };

/** Prefer a different installed provider. Fallback uses only an explicitly configured, different model. */
export async function reviewOrder(ctx: Context, author: TaskRecord, review: ReviewSettings): Promise<{ order: Order; rule: string }> {
  if (author.agent === 'unknown') throw new AgentctlError(`${author.task}: review author provider is n/d`);
  const other: AgentName = author.agent === 'claude' ? 'codex' : 'claude';
  const target = review.agent ?? other;
  const available = async (agent: AgentName) => (await ctx.runner.exec(agent, ['--version'], { readOnly: true })).code === 0;
  if (await available(target)) {
    const mapped = translate({ agent: author.agent, model: author.model, effort: author.effort === 'unknown' ? 'high' : author.effort }, target, ctx.config.equivalents);
    const model = review.model ?? (mapped.ok ? mapped.order.model : undefined);
    const effort = review.effort ?? (mapped.ok ? mapped.order.effort : undefined);
    if (model && effort && (target !== author.agent || model !== author.model)) return { order: { agent: target, model, effort }, rule: target !== author.agent ? 'different provider' : 'explicit different model' };
  }
  const fallback = review.model && review.model !== author.model && review.agent === author.agent ? { model: review.model, effort: review.effort ?? (author.effort === 'unknown' ? 'high' : author.effort) } : ctx.config.equivalents.map(e => e[author.agent as AgentName]).find(m => m.model !== author.model);
  if (fallback && await available(author.agent)) return { order: { agent: author.agent, ...fallback }, rule: `${target} unavailable or unmapped; different configured model on ${author.agent}` };
  throw new AgentctlError(`${author.task}: no available different review provider/model; configure review.agent/model/effort or equivalents`);
}

interface ReviewRun { hash: string; task: string; heads: Record<string, string> }
/** The queue entry is durable before the ledger: an interrupted tick recovers by deterministic review ID. */
export async function reviewTick(ctx: Context): Promise<string[]> {
  if (ctx.runner.dryRun) return [];
  const file = path.join(path.dirname(ctx.config.path), 'auto-reviews.json');
  return withFileLock(`${file}.lock`, async () => {
    let state: Record<string, ReviewRun[]> = {};
    try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first tick */ }
    const added: string[] = [];
    for (const author of listTaskRecords(ctx.config).filter(r => r.review && !r.reviewOf && !r.cancelled && !r.supersededBy)) {
      const report = inspectReport(ctx.config, author, ctx.runner.now(), !author.attemptId);
      if (!report.ready || !report.sentinel || !report.signature) continue;
      const runs = state[author.task] ??= [];
      if (runs.some(r => r.hash === report.signature) || (runs.length && !author.review!.rerun)) continue;
      const task = `${author.task}-REV${runs.length ? runs.length + 1 : ''}`;
      try {
        const { order, rule } = await reviewOrder(ctx, author, author.review!);
        const heads: Record<string, string> = {};
        const previous = runs.at(-1);
        const bases: Record<string, string> = {};
        for (const repo of author.repos) {
          if (!repo.branch) throw new AgentctlError(`${author.task}: review branch for ${repo.path} is n/d`);
          const git = async (ref: string) => {
            const r = await ctx.runner.exec('git', ['-C', repo.path, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], { readOnly: true });
            if (r.code !== 0 || !/^[a-f0-9]{40}$/i.test(r.stdout.trim())) throw new AgentctlError(`${author.task}: review cannot resolve ${ref} in ${repo.path}`);
            return r.stdout.trim();
          };
          heads[repo.path] = await git(`refs/heads/${repo.branch}`);
          const base = previous?.heads[repo.path] ?? repo.base;
          if (!base) throw new AgentctlError(`${author.task}: review base for ${repo.path} is n/d`);
          bases[repo.path] = await git(base);
        }
        const { raw, delta } = buildReviewRaw(ctx, author, task, { task, ...order, review_of: author.task, review: false, after: [author.task], ...(author.cohort ? { cohort: author.cohort } : {}) }, heads, bases);
        const known = [...listTaskRecords(ctx.config), ...listArchivedRecords(ctx.config), ...readQueue(ctx.config)].find(r => r.task === task);
        if (known && (known.autoReview?.author !== author.task || known.autoReview.hash !== report.signature)) throw new AgentctlError(`${task} already exists and is not this automatic review; choose another task ID for the existing task`);
        if (!known) {
          const spec = (await planBatch(ctx, [resolveSpec(raw, { config: ctx.config })], { ignoreLimits: true, skipAfter: true }))[0]!;
          await commitQueueAdd(ctx, [{ raw, spec }], { autoReview: { author: author.task, hash: report.signature, heads, bases, delta } });
          await recordJournal(ctx, { kind: 'review-added', task, ...(author.cohort ? { cohort: author.cohort } : {}), text: `dodano przegląd ${task} dla ${author.task}: ${order.agent}/${order.model}/${order.effort}; ${rule}; ${delta}` });
          added.push(task);
        }
        runs.push({ hash: report.signature, task, heads: known?.autoReview?.heads ?? heads });
        await ctx.runner.writeFile(file, JSON.stringify(state));
      } catch (e) {
        // Keep the author ready; the failure is visible, and retried when availability/config changes.
        const text = `${author.task}: auto review pending: ${errorMessage(e)}`;
        const errorsFile = path.join(ctx.config.stateDir, author.window, 'review-error.json');
        let last = ''; try { last = JSON.parse(fs.readFileSync(errorsFile, 'utf8')).text; } catch { /* first */ }
        if (last !== text) { await recordJournal(ctx, { kind: 'needs-attention', task: author.task, text }); await ctx.runner.writeFile(errorsFile, JSON.stringify({ text, at: new Date(ctx.runner.now()).toISOString() })); }
      }
    }
    return added;
  });
}
