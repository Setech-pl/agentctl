import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { applySnapshot, boardColumns, headerCells, initialBoardState, loadBoard, ProgressCache, rowCells, usageBar, usagePanel } from '../src/core/board.ts';
import type { BoardRow } from '../src/core/board.ts';
import { Context } from '../src/core/context.ts';
import { statusTmuxLine, tmuxLine } from '../src/core/statusline.ts';
import { planState } from '../src/core/usage.ts';
import { makeConfig } from './helpers.ts';
import { DiskRunner, FakeTmux, runCli, useScratch } from './helpers.ts';
import { makeWorld } from './usage-world.ts';

const scratch = useScratch();
const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const sec = (ms: number): number => Math.floor(ms / 1000);
const WORKING = '● Reading src/menu.ts\n  esc to interrupt\n';

function plans(claude: number | null, codex: number | null) {
  const state = (p: 'claude' | 'codex', pct: number | null) =>
    planState(p, pct === null ? undefined : { at: NOW - 60_000, planType: null, windows: [{ kind: 'session', minutes: 300, usedPercent: pct, resetsAt: sec(NOW + 3600_000) }, { kind: 'week', minutes: 10080, usedPercent: 10, resetsAt: sec(NOW + 4 * 86_400_000) }] }, NOW, 'no reading');
  return { claude: state('claude', claude), codex: state('codex', codex) };
}

describe('board usage panel', () => {
  const config = makeConfig(scratch.sub('panel'));

  it('a bar in tenths', () => {
    assert.deepEqual([0, 4, 62, 100, 130].map(usageBar), ['░░░░░░░░░░', '░░░░░░░░░░', '▓▓▓▓▓▓░░░░', '▓▓▓▓▓▓▓▓▓▓', '▓▓▓▓▓▓▓▓▓▓']);
  });

  it('one line per provider: windows with bar, percentage and reset; n/d with the reason when nothing is known', () => {
    const lines = usagePanel(plans(62, null), config.usage, NOW);
    assert.equal(lines.length, 2);
    assert.match(lines[0]!.text, /^claude\s+5h ▓▓▓▓▓▓░░░░ 62% ↻\d\d:\d\d\s+week ▓░░░░░░░░░ 10% ↻\w{3} \d\d:\d\d$/);
    assert.match(lines[1]!.text, /^codex\s+n\/d – no reading$/);
    assert.equal(lines[1]!.color, undefined);
  });

  it('green below warn, yellow from usage.warn, red from usage.critical (per provider)', () => {
    const color = (pct: number, cfg = config): string | undefined => usagePanel(plans(pct, null), cfg.usage, NOW)[0]?.color;
    assert.deepEqual([50, 80, 96].map((p) => color(p)), ['green', 'yellow', 'red']);
    const custom = makeConfig(scratch.sub('panel2'), 'usage:\n  warn: {claude: 50}\n  critical: {claude: 60}\n');
    assert.deepEqual([40, 55, 65].map((p) => color(p, custom)), ['green', 'yellow', 'red']);
  });

  it('no plans yet (before the first refresh): no panel', () => {
    assert.deepEqual(usagePanel(null, config.usage, NOW), []);
  });

  it('applySnapshot keeps the plans of the snapshot', () => {
    const state = applySnapshot(initialBoardState(100, 30), { rows: [], plans: plans(10, 20), preview: null, refreshedAt: '09:00:00' });
    assert.equal(state.plans?.codex.maxPercent, 20);
  });
});

describe('board TOKENS column', () => {
  const row = (extra: Partial<BoardRow>): BoardRow => ({
    task: 'NC-1', agent: 'claude', model: 'opus', effort: 'high', requested: 'claude opus/high', effective: 'claude opus/high', switchedBy: null,
    state: 'working', window: 'alive', windowName: 'nc-1', windowId: '@1', started: '', startedLocal: '', duration: '12m 04s', report: 'missing', reportPath: '', pulled: null,
    lastLine: '', progress: null, hint: null, question: null, pin: false, finished: false, hidden: false, hiddenBy: null, closed: false, closedAt: null, archived: false,
    cancelled: false, cancelledAt: null, cancelReason: null, cohort: null, supersededBy: null, continues: null, worktrees: [], collide: [], ...extra,
  });

  it('the list has it from 69 columns on and still fits (the list beside the preview is 71)', () => {
    for (const width of [71, 80, 100]) {
      const cols = boardColumns(width);
      assert.equal(cols.tokens, 7);
      const total = (cells: { width: number }[]): number => cells.reduce((n, c) => n + c.width + 1, -1);
      assert.ok(total(headerCells(cols)) <= width, `header ${total(headerCells(cols))} > ${width}`);
    }
    assert.equal(boardColumns(60).tokens, undefined);
    assert.equal(headerCells(boardColumns(60)).some((c) => c.key === 'tokens'), false);
  });

  it('shows 1.2M for a task with tokens, n/d for one without', () => {
    const cols = boardColumns(80);
    const text = (r: BoardRow): string => rowCells(r, false, cols).find((c) => c.key === 'tokens')?.text ?? '';
    const tokens = { fresh: 1_234_567, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, sessions: 1 };
    assert.equal(text(row({ tokens })), '1.2M');
    assert.equal(text(row({ tokens: null })), 'n/d');
    assert.equal(text(row({})), 'n/d');
  });
});

describe('loadBoard with usage', () => {
  it('rows carry tokens, the snapshot the plans of both providers', async () => {
    const w = makeWorld(scratch, 'load');
    const wt = w.worktree('nc-1');
    w.task('NC-1', wt, { started: '2026-11-01T09:00:00.000Z' });
    w.claudeSession(wt, 's1', '2026-11-01T10:00:00.000Z');
    const tmux = new FakeTmux();
    tmux.add('nc-1', WORKING);
    const runner = new DiskRunner({ dryRun: false, startTime: NOW, respond: tmux.respond });
    const ctx = new Context(runner, w.config, () => {});
    const snap = await loadBoard(ctx, null, new ProgressCache());
    assert.equal(snap.rows[0]?.tokens?.fresh, 5 + 326 + 17200 + 5 + 400);
    assert.equal(snap.plans?.claude.available, false);
    assert.equal(snap.plans?.codex.available, false);
  });
});

describe('tmux status line', () => {
  it('tasks, then the plans after a bar; the plans alone when there is no task', () => {
    assert.equal(tmuxLine([], null, 0, 'C 62% · X 18%'), 'C 62% · X 18%');
    assert.equal(tmuxLine([], null, 3, 'C 62%'), '3⧗ │ C 62%');
    assert.equal(tmuxLine([], null, 0, ''), '');
  });

  it('statusTmuxLine shows the plans that have a reading, and usage.status_line: false turns them off', async () => {
    const w = makeWorld(scratch, 'line');
    const file = w.codexSession(w.worktree('x'), 'live', new Date(NOW - 3600_000).toISOString());
    const future = sec(NOW) + 3600;
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('1793700000', String(future)).replaceAll('1794300000', String(future + 86_400 * 3)));
    const runner = new DiskRunner({ dryRun: false, startTime: NOW, respond: new FakeTmux().respond });
    const ctx = new Context(runner, w.config, () => {});
    assert.equal(await statusTmuxLine(ctx), 'X 12%');
    const r = await runCli(w.config, runner, ['status', '--tmux-line']);
    assert.equal(r.stdout.trim(), 'X 12%');
    const off = makeWorld(scratch, 'line-off', '  status_line: false\n');
    assert.equal(await statusTmuxLine(new Context(runner, off.config, () => {})), '');
  });
});
