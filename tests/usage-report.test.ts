import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { renderStatusTable } from '../src/render.ts';
import { collectStatus, statusMarkdown } from '../src/core/status.ts';
import { collectUsage, planStatusLine, renderUsage, usageMarkdown } from '../src/core/usage-report.ts';
import { UsageReader } from '../src/core/usage-sources.ts';
import { DiskRunner, FakeTmux, runCli, useScratch } from './helpers.ts';
import { makeWorld } from './usage-world.ts';

const scratch = useScratch();
const NOW = Date.parse('2026-11-02T12:00:00.000Z');

function setup(name: string, extraYaml = '') {
  const w = makeWorld(scratch, name, extraYaml);
  const tmux = new FakeTmux();
  const runner = new DiskRunner({ dryRun: false, startTime: NOW, respond: tmux.respond });
  const out: string[] = [];
  const ctx = new Context(runner, w.config, (l) => out.push(l));
  return { ...w, tmux, runner, ctx, out };
}

/** Two tasks: NC-1 on Claude (cohort sprint), NC-2 on Codex (cohort sprint), a Codex plan that is in the future. */
function twoTasks(name: string) {
  const s = setup(name);
  const w1 = s.worktree('nc-1');
  const w2 = s.worktree('nc-2');
  s.task('NC-1', w1, { started: '2026-11-01T09:00:00.000Z', cohort: 'sprint' });
  s.task('NC-2', w2, { agent: 'codex', model: 'gpt-6.1-sol', started: '2026-11-01T10:00:00.000Z', cohort: 'sprint' });
  s.claudeSession(w1, 'sess-1', '2026-11-01T10:00:00.000Z', { sub: true });
  const file = s.codexSession(w2, 'thread-2', new Date(NOW - 3 * 3600_000).toISOString());
  const future = Math.floor(NOW / 1000) + 3600;
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('1793700000', String(future)).replaceAll('1794300000', String(future + 86_400 * 4)).replace(/"timestamp":"2026-11-0[12]T[^"]*"/g, (m) => m));
  s.tmux.add('nc-1', '● Reading src/menu.ts\n  esc to interrupt\n');
  s.tmux.add('nc-2', '● Reading src/menu.ts\n  esc to interrupt\n');
  return s;
}

describe('collectUsage', () => {
  it('per provider, model, task, cohort and day; the plan with its windows', async () => {
    const s = twoTasks('report');
    const report = await collectUsage(s.ctx, { since: '30d' });
    assert.equal(report.sinceDay, '2026-10-03');
    // claude: sonnet in 5 out 326 cw 17200 + opus in 5 out 400 + subagent haiku in 10 out 20 cw 40
    assert.equal(report.providers.claude.window.output, 746);
    assert.deepEqual(Object.keys(report.providers.claude.byModel).sort(), ['claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5']);
    assert.equal(report.providers.codex.window.input, 1600);
    assert.deepEqual(Object.keys(report.providers.codex.byModel).sort(), ['gpt-6.1-mini', 'gpt-6.1-sol']);
    assert.equal(Object.keys(report.providers.claude.byDay).length >= 2, true);
    assert.deepEqual(report.tasks.map((t) => [t.task, t.known, t.active]).sort(), [['NC-1', true, true], ['NC-2', true, true]]);
    assert.deepEqual(report.cohorts.map((c) => [c.cohort, c.tasks]), [['sprint', 2]]);
    assert.equal(report.cohorts[0]?.fresh, report.tasks.reduce((n, t) => n + t.fresh, 0));
    assert.equal(report.plans.codex.available, true);
    assert.equal(report.plans.codex.maxPercent, 12);
    assert.equal(report.plans.claude.available, false);
  });

  it('--since limits the token columns to whole days; today is a column of its own', async () => {
    const s = twoTasks('since');
    const wide = await collectUsage(s.ctx, { since: '30d' });
    const narrow = await collectUsage(s.ctx, { since: '12h' });
    assert.ok(narrow.providers.claude.window.output < wide.providers.claude.window.output);
    assert.equal(narrow.sinceDay, '2026-11-02');
    assert.ok(wide.providers.codex.today.input > 0);
  });

  it('--cohort keeps the tasks of one cohort only', async () => {
    const s = twoTasks('cohort');
    s.task('NC-3', s.worktree('nc-3'), { started: '2026-11-01T09:00:00.000Z', cohort: 'other' });
    const report = await collectUsage(s.ctx, { cohort: 'SPRINT', since: '30d' });
    assert.deepEqual(report.tasks.map((t) => t.task).sort(), ['NC-1', 'NC-2']);
  });

  it('a task with no session log says n/d, not 0; a finished task without tokens in the period is left out', async () => {
    const s = setup('nd');
    s.task('NC-1', s.worktree('nc-1'), { started: '2026-11-01T09:00:00.000Z' });
    s.tmux.add('nc-1', '● Reading src/menu.ts\n  esc to interrupt\n');
    const report = await collectUsage(s.ctx);
    assert.equal(report.tasks[0]?.known, false);
    const text = renderUsage(report).join('\n');
    assert.match(text, /NC-1\s+claude\/opus\s+working\s+n\/d/);
    assert.match(text, /claude: limit n\/d/);
    assert.match(text, /codex: limit n\/d/);
  });

  it('renders the table, the active tasks, the cohorts and the models', async () => {
    const s = twoTasks('render');
    const lines = renderUsage(await collectUsage(s.ctx, { since: '30d' }));
    const text = lines.join('\n');
    assert.match(lines[0] as string, /^PROVIDER\s+5H LIMIT\s+WEEK LIMIT\s+TODAY\s+30D$/);
    assert.match(text, /codex\s+7% ↻ \d\d:\d\d\s+12% ↻ \w{3} \d\d:\d\d/);
    assert.match(text, /Active tasks:/);
    assert.match(text, /Cohorts:\n.*COHORT\s+TASKS\s+TOKENS\nsprint\s+2/);
    assert.match(text, /By model:/);
    assert.match(text, /claude-sonnet-5-5/);
  });

  it('Markdown and the tmux line', async () => {
    const s = twoTasks('md');
    const report = await collectUsage(s.ctx);
    assert.match(usageMarkdown(report), /^\| provider \| 5h limit \| week limit \| today \| 7d \|/);
    assert.equal(planStatusLine(report.plans), 'X 12%');
    assert.equal(planStatusLine({ ...report.plans, claude: { ...report.plans.claude, available: true, maxPercent: 62.4 } }), 'C 62% · X 12%');
  });
});

describe('status TOKENS', () => {
  it('collectStatus adds the tokens of each task when asked; the table has the column only then', async () => {
    const s = twoTasks('status');
    const plain = await collectStatus(s.ctx, { progress: false });
    assert.equal(plain.every((r) => r.tokens === undefined), true);
    assert.equal(renderStatusTable(plain)[0]?.includes('TOKENS'), false);
    const rows = await collectStatus(s.ctx, { progress: false, tokens: true });
    const nc1 = rows.find((r) => r.task === 'NC-1');
    assert.equal(nc1?.tokens?.fresh, 20 + 746 + 17240);
    const header = renderStatusTable(rows)[0] as string;
    assert.match(header, /DURATION\s+TOKENS\s+PROGRESS/);
    assert.match(renderStatusTable(rows).join('\n'), /18\.\dk|18k/);
    assert.match(statusMarkdown(rows), /\| tokens \|/);
  });

  it('a row without a session log says n/d in the column', async () => {
    const s = twoTasks('status-nd');
    s.task('NC-9', s.worktree('nc-9'), { started: '2026-11-01T09:00:00.000Z' });
    s.tmux.add('nc-9', '● x\n  esc to interrupt\n');
    const rows = await collectStatus(s.ctx, { progress: false, tokens: true });
    assert.match(renderStatusTable(rows).find((l) => l.startsWith('NC-9')) as string, /n\/d/);
  });

  it('agentctl status prints the column, agentctl status --json carries the tokens', async () => {
    const s = twoTasks('status-cli');
    const text = await runCli(s.config, s.runner, ['status']);
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /TOKENS/);
    const json = JSON.parse((await runCli(s.config, s.runner, ['status', '--json'])).stdout) as { task: string; tokens: { fresh: number } | null }[];
    assert.equal(json.find((r) => r.task === 'NC-2')?.tokens?.fresh, 1600 + 200);
  });
});

describe('agentctl usage', () => {
  it('prints the table; --json the report; --clip goes through the clipboard tool, never the real one', async () => {
    const s = twoTasks('cli');
    const plain = await runCli(s.config, s.runner, ['usage', '--since', '30d']);
    assert.equal(plain.code, 0, plain.stderr);
    assert.match(plain.stdout, /PROVIDER\s+5H LIMIT/);
    assert.match(plain.stdout, /NC-1\s+claude\/opus\s+working/);
    const json = JSON.parse((await runCli(s.config, s.runner, ['usage', '--json', '--cohort', 'sprint'])).stdout) as { plans: { codex: { available: boolean } }; tasks: unknown[] };
    assert.equal(json.plans.codex.available, true);
    assert.equal(json.tasks.length, 2);
    const clipped: string[] = [];
    const runner = new DiskRunner({
      dryRun: false,
      startTime: NOW,
      respond: (cmd, args, opts) => {
        if (cmd === 'pbcopy') {
          clipped.push(opts?.input ?? '');
          return {};
        }
        return s.tmux.respond(cmd, args, opts);
      },
    });
    const clip = await runCli(s.config, runner, ['usage', '--clip']);
    assert.match(clip.stdout, /Copied the usage to the clipboard/);
    assert.match(clipped[0] ?? '', /^\| provider \|/);
    assert.equal((await runCli(s.config, s.runner, ['usage', '--json', '--clip'])).code, 1);
    assert.equal((await runCli(s.config, s.runner, ['usage', '--cohort', 'nope'])).code, 1);
    assert.equal((await runCli(s.config, s.runner, ['usage', '--since', 'soon'])).code, 1);
  });

  it('the reader cache is written next to the config and not rewritten when nothing grew', async () => {
    const s = twoTasks('cache');
    await collectUsage(s.ctx);
    const cache = path.join(path.dirname(s.config.path), 'usage-cache.json');
    assert.ok(fs.existsSync(cache));
    const before = fs.statSync(cache).mtimeMs;
    await collectUsage(s.ctx, { reader: new UsageReader(cache) });
    assert.equal(fs.statSync(cache).mtimeMs, before);
  });
});
