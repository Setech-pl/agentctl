import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import { Context } from '../src/core/context.ts';
import { areaKey, fieldArea } from '../src/core/input-field.ts';
import { saveEntry } from '../src/core/queue.ts';
import { taskFile } from '../src/core/taskstore.ts';
import { DiskRunner, makeConfig, seedTask } from './helpers.ts';

export const WRITE_NAMES = ['close', 'cancel', 'interrupt', 'hide', 'unhide', 'archive', 'mark', 'report_from', 'adopt', 'send', 'answer', 'queue_rm', 'queue_retry', 'gc'];
export async function writePreviewFixture(root: string, count = 400, files = 300_000) {
  const config = makeConfig(root, `providers: [claude, codex, kimi]\nmcp: {allow: [${WRITE_NAMES.join(', ')}, send_enter], max_response_kb: 256}\ncapacity: {snapshot: false, codex_refresh: false}\ncancel: {grace: 0}\n`);
  const repo = path.join(root, 'repo'), wt = path.join(root, 'worktree');
  fs.mkdirSync(repo, { recursive: true }); fs.mkdirSync(wt, { recursive: true });
  for (let d = 0; d < Math.ceil(files / 1000); d++) {
    const dir = path.join(wt, 'node_modules', `pkg-${d}`); fs.mkdirSync(dir, { recursive: true });
    for (let f = 0; f < Math.min(1000, files - d * 1000); f++) fs.writeFileSync(path.join(dir, `${f}.js`), 'fixture');
  }
  fs.mkdirSync(path.join(wt, '.cache'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.cache/keep-until-watch'), 'watch owns cleanup');
  const draft = fs.readFileSync(new URL('./fixtures/screen-claude-draft.txt', import.meta.url), 'utf8');
  const menu = fs.readFileSync(new URL('./fixtures/screen-kimi-04-zgoda.txt', import.meta.url), 'utf8');
  const active = new Set(['close', 'cancel', 'interrupt', 'hide', 'mark-a', 'mark-b', 'report', 'send', 'answer']);
  for (let i = 0; i < count; i++) {
    const name = [...active][i] ?? `other-${i}`;
    const record = seedTask(config, name.toUpperCase(), { repos: [{ path: repo, worktree: wt }], turnEndedAt: new Date(Date.now() + 60_000).toISOString(), closed: i >= active.size && i % 2 === 0,
      ...(name === 'answer' ? { agent: 'kimi', model: 'k3' } : {}),
      ...(name === 'send' ? { deliveryId: 'fixture-delivery', deliveryField: areaKey(fieldArea(draft, [], 'claude')), promptDelivery: 'needs-attention' } : {}) });
    fs.mkdirSync(path.dirname(record.report), { recursive: true });
    fs.writeFileSync(record.report, `Verdict: PASS\n${'x'.repeat(i % 2 ? 500_000 : 1000)}\n<!-- agentctl:report-end -->\n`);
    // Large prompt bodies prove inventory/preview reads stop at the YAML boundary.
    fs.appendFileSync(taskFile(config, record.window), 'p'.repeat(500_000));
  }
  let gitWalks = 0;
  const runner = new DiskRunner({ dryRun: false, startTime: Date.now(), respond: (cmd, args) => {
    if (cmd === 'git') {
      if (args.includes('status')) gitWalks++;
      if (args.includes('worktree')) return { stdout: `worktree ${wt}\nbranch refs/heads/fixture\n` };
      if (args.includes('--show-toplevel')) return { stdout: wt };
      if (args.includes('--abbrev-ref')) return { stdout: 'fixture' };
      return { stdout: '' };
    }
    if (cmd !== 'tmux') return {};
    if (args[0] === 'list-windows') return { stdout: [...active].map((n, i) => `@${i + 1}\t${n}\ttask`).join('\n') };
    if (args[0] === 'capture-pane') return { stdout: args.includes('@9') ? menu : args.includes('@8') ? draft : 'Working (esc to interrupt)\n' };
    return {};
  } });
  const ctx = new Context(runner, config, () => {});
  for (const [i, name] of ['WAITING', 'FAILED'].entries()) await saveEntry(ctx, { seq: i + 1, order: i + 1, task: name, status: name === 'FAILED' ? 'failed' : 'queued', priority: 'normal', queuedAt: new Date().toISOString(), agent: 'claude', model: 'opus', effort: 'high', after: [], spec: `---\ntask: ${name}\nagent: claude\nrepos:\n - path: ${repo}\n   worktree: ${wt}-retry\n---\nWait.` });
  const source = path.join(wt, 'SOURCE.md'); fs.writeFileSync(source, 'Verdict: PASS\nCopied.\n<!-- agentctl:report-end -->\n');
  const deps = { context: (out: (line: string) => void) => new Context(runner, config, out), notify: async () => {} };
  const scenarios: [string, Record<string, unknown>, boolean][] = [
    ['close', { task: 'CLOSE' }, true], ['cancel', { task: 'CANCEL' }, true], ['interrupt', { task: 'INTERRUPT' }, true],
    ['hide', { tasks: ['HIDE'] }, true], ['unhide', { tasks: ['HIDE'] }, true], ['archive', {}, true],
    ['mark', { tasks: ['MARK-A', 'MARK-B'], result: 'ok' }, true], ['report_from', { task: 'REPORT', from: source, force: true }, true],
    ['adopt', { task: 'ADOPT', report: path.join(config.cache, 'ADOPT.md'), worktree: wt }, true],
    ['send', { task: 'SEND', enter_only: true }, false], ['answer', { task: 'ANSWER', option: 1 }, false],
    ['queue_rm', { task: 'WAITING' }, true], ['queue_retry', { task: 'FAILED' }, true], ['gc', {}, false],
  ];
  return { config, ctx, deps, wt, scenarios, gitWalks: () => gitWalks };
}

export async function measureWritePreviews(f: Awaited<ReturnType<typeof writePreviewFixture>>) {
  const results: { tool: string; phase: string; ms: number; error?: string }[] = [];
  for (const [name, args, confirm] of f.scenarios) {
    const tool = MCP_TOOLS.find(t => t.name === name)!;
    const call = async (phase: string, input: Record<string, unknown>) => {
      const start = performance.now();
      const result = await tool.run(f.deps, z.object(tool.input).parse(input));
      const error = result.isError || /Partial result:/.test(result.text) ? result.text : undefined;
      results.push({ tool: name, phase, ms: performance.now() - start, ...(error ? { error } : {}) });
      console.log(`WRITE_TIMING ${JSON.stringify(results.at(-1))}`);
      return result;
    };
    const preview = await call('preview', args);
    const token = /preview_token: (\S+)/.exec(preview.text)?.[1];
    if (confirm && token) await call('confirm', { confirm: true, preview_token: token });
    else if (confirm) results.at(-1)!.error ??= 'missing preview_token';
    else if (!preview.data && !token) results.at(-1)!.error ??= 'missing preview token/data';
  }
  return results;
}
export function assertWriteTimings(results: Awaited<ReturnType<typeof measureWritePreviews>>) {
  assert.equal(results.filter(r => r.phase === 'preview').length, WRITE_NAMES.length);
  assert.deepEqual(results.filter(r => r.error), [], 'every preview/confirm must succeed and return a token');
  for (const row of results) assert.ok(row.ms < 2000, `${row.tool} ${row.phase}: ${row.ms.toFixed(1)} ms >= 2000 ms`);
}
