import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Alerts, trustNotifiedPath } from '../src/core/alert.ts';
import { handleKey, initialBoardState, visibleRows } from '../src/core/board.ts';
import type { BoardRow, BoardState } from '../src/core/board.ts';
import fs from 'node:fs';
import { Context } from '../src/core/context.ts';
import type { Notifier } from '../src/core/notify.ts';
import { FakeTmux, DiskRunner, makeConfig, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();

function row(task: string, extra: Partial<BoardRow> = {}): BoardRow {
  return {
    task, agent: 'kimi', model: 'k3', effort: 'high', requested: 'kimi k3/high', effective: 'kimi k3/high', switchedBy: null,
    state: 'working', window: 'alive', windowName: task.toLowerCase(), windowId: '@1', started: '2026-11-01 08:00', startedLocal: '2026-11-01 09:00',
    duration: '12m 04s', report: 'missing', reportPath: `/r/${task}.md`, pulled: null, lastLine: '', progress: { commits: 0, files: 0, text: '', repos: [] },
    hint: null, question: null, pin: false, finished: false, hidden: false, hiddenBy: null, closed: false, closedAt: null, archived: false, cancelled: false, cancelledAt: null, cancelReason: null, cohort: null, supersededBy: null, continues: null, worktrees: [], collide: [], ...extra,
  };
}

const boardOf = (rows: BoardRow[], selected: string | null = rows[0]?.task ?? null): BoardState =>
  ({ ...initialBoardState(100, 30), rows, selected, refreshedAt: '09:00:00' });

describe('P55: a task waiting for folder trust is announced on the desktop once per task', () => {
  const setup = (name: string) => {
    const config = makeConfig(scratch.sub(name));
    const runner = new DiskRunner({ dryRun: false, respond: new FakeTmux().respond });
    const ctx = new Context(runner, config, () => {});
    seedTask(config, 'NC-1');
    const sent: string[] = [];
    const notifier: Notifier = { notify: async (_t, m) => void sent.push(m) };
    return { ctx, config, sent, alerts: new Alerts(ctx, notifier, { env: {} }) };
  };

  it('a second needs-trust announcement (re-entry, watch restart) is a duplicate; other states are unaffected', async () => {
    const t = setup('once');
    const target = { task: 'NC-1', window: 'nc-1' };
    assert.equal(await t.alerts.send(target, 'needs-trust', 'NC-1 czeka na zaufanie folderu (trust)', 'watch'), 'sent');
    assert.equal(await t.alerts.send(target, 'needs-trust', 'NC-1 czeka na zaufanie folderu (trust)', 'event'), 'duplicate');
    // A restarted watcher (a fresh Alerts over the same state dir) still does not re-notify.
    const again = new Alerts(t.ctx, { notify: async (_ti, m) => void t.sent.push(m) } as Notifier, { env: {} });
    assert.equal(await again.send(target, 'needs-trust', 'NC-1 czeka na zaufanie folderu (trust)', 'watch'), 'duplicate');
    assert.equal(t.sent.length, 1);
    assert.ok(fs.existsSync(trustNotifiedPath(t.ctx, 'nc-1')));
    // Another state of the same task still notifies.
    assert.equal(await t.alerts.send(target, 'needs-input', 'NC-1 zadaje pytanie', 'watch'), 'sent');
    assert.equal(t.sent.length, 2);
  });

  it('the trust notification points at the board: row on top, Enter opens the dialog', async () => {
    const t = setup('text');
    // The exact watch text (product language: Polish).
    const { NOTIFY_ON_TRUST } = await import('../src/core/watch.ts');
    const text = NOTIFY_ON_TRUST(row('NC-1', { state: 'needs-trust' }));
    assert.match(text, /^NC-1 czeka na zaufanie folderu \(trust\)/);
    assert.match(text, /Enter/);
  });
});

describe('P55: the board puts a task waiting for trust on top and Enter opens its dialog', () => {
  it('needs-trust rows jump to the top of the active list, the order of the rest is kept', () => {
    const rows = [row('NC-1'), row('NC-2', { state: 'needs-trust' }), row('NC-3'), row('NC-4', { state: 'needs-trust' })];
    assert.deepEqual(visibleRows(boardOf(rows), 20).rows.map((r) => r.task), ['NC-2', 'NC-4', 'NC-1', 'NC-3']);
  });

  it('grouped by cohort: the group that waits for trust leads, the trust row leads its group', () => {
    const rows = [
      row('NC-1', { cohort: 'beta' }), row('NC-2', { cohort: 'alfa' }),
      row('NC-3', { cohort: 'alfa', state: 'needs-trust' }), row('NC-4', { cohort: 'beta' }),
    ];
    assert.deepEqual(visibleRows(boardOf(rows), 20).rows.map((r) => r.task), ['NC-3', 'NC-2', 'NC-1', 'NC-4']);
  });

  it('Enter on a needs-trust row switches to the task window, where the dialog waits for the human', () => {
    const s = boardOf([row('NC-1', { state: 'needs-trust' })]);
    const r = handleKey(s, '', { return: true });
    assert.deepEqual(r.effects, [{ type: 'switch', task: 'NC-1', window: 'nc-1' }]);
  });
});
