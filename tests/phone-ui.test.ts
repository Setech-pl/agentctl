import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { awayPath, readAway, setAway } from '../src/core/away.ts';
import { applySnapshot, awayLabel, handleKey, HELP_LINES, initialBoardState, KEY_HINTS, loadBoard, ProgressCache, promptText, runBoardEffect } from '../src/core/board.ts';
import type { BoardState } from '../src/core/board.ts';
import { collectEvents, eventsMarkdown, renderEvents } from '../src/core/chat-events.ts';
import { loadGlobalConfig } from '../src/core/config.ts';
import { Context } from '../src/core/context.ts';
import { auditPath, MCP_TOOLS } from '../src/core/mcp-tools.ts';
import type { McpDeps, McpToolDef } from '../src/core/mcp-tools.ts';
import { statusTmuxLine, tmuxLine } from '../src/core/statusline.ts';
import { DiskRunner, FakeTmux, makeConfig, runCli, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();
const NTFY = 'notify:\n  ntfy:\n    topic: agentctl-0123456789abcdef01234567\n';

const press = (state: BoardState, input: string) => handleKey(state, input, {});

describe('phone: the board', () => {
  const awayOf = (on: boolean, phone = true, always = false) => ({ ...initialBoardState(100, 30), refreshedAt: '09:00:00', away: { on, phone, always } });

  it('w asks first; y turns away on, n does nothing; with away on it asks to turn it off', () => {
    const asked = press(awayOf(false), 'w');
    assert.equal(asked.state.mode.kind, 'confirm');
    assert.deepEqual(asked.effects, []);
    assert.match(promptText(asked.state) ?? '', /^Away on\? .*phone as well.* \[y\/N\]$/);
    const yes = press(asked.state, 'y');
    assert.deepEqual(yes.effects, [{ type: 'away', on: true }]);
    assert.equal(yes.state.mode.kind, 'list');
    const no = press(asked.state, 'n');
    assert.deepEqual(no.effects, []);
    assert.equal(no.state.notice?.text, 'Cancelled.');
    const off = press(awayOf(true), 'w');
    assert.match(promptText(off.state) ?? '', /^Away off\?/);
    assert.deepEqual(press(off.state, 'y').effects, [{ type: 'away', on: false }]);
  });

  it('without a phone the question says so', () => {
    assert.match(promptText(press(awayOf(false, false), 'w').state) ?? '', /ntfy-setup/);
  });

  it('the indicator: 📱 away / 📱 always / dimmed 📱 off / nothing without a phone', () => {
    assert.deepEqual(awayLabel(awayOf(true).away), { text: '📱 away', dim: false });
    assert.deepEqual(awayLabel(awayOf(false, true, true).away), { text: '📱 always', dim: false });
    assert.deepEqual(awayLabel(awayOf(false).away), { text: '📱 off', dim: true });
    assert.equal(awayLabel(awayOf(false, false).away), null);
    assert.equal(awayLabel(null), null);
  });

  it('the key is in the hints and in the help', () => {
    assert.match(KEY_HINTS, /\bR w u\/d\/p\b/);
    assert.ok(HELP_LINES.some((l) => /^ {2}w {11}away on or off/.test(l)));
  });

  it('the effect switches away and the next snapshot shows it', async () => {
    const config = makeConfig(scratch.sub('b1'), NTFY);
    const tmux = new FakeTmux();
    const runner = new DiskRunner({ dryRun: false, respond: tmux.respond });
    const notice = await runBoardEffect(runner, config, { type: 'away', on: true }, { insideTmux: false });
    assert.deepEqual(notice, { level: 'info', text: 'away on' });
    assert.equal(readAway(config).on, true);
    assert.equal(readAway(config).by, 'board');
    const ctx = new Context(runner, config, () => {});
    const snap = await loadBoard(ctx, null, new ProgressCache());
    assert.deepEqual(applySnapshot(initialBoardState(100, 30), snap).away, { on: true, phone: true, always: false });
    await runBoardEffect(runner, config, { type: 'away', on: false }, { insideTmux: false });
    assert.equal(readAway(config).on, false);
  });

  it('away on with no phone is done, and says what is missing', async () => {
    const config = makeConfig(scratch.sub('b2'));
    const notice = await runBoardEffect(new DiskRunner({ dryRun: false }), config, { type: 'away', on: true }, { insideTmux: false });
    assert.match(notice.text, /away on - but no phone is set up/);
  });
});

describe('phone: the tmux line', () => {
  const row = { state: 'working', pulled: null } as never;

  it('📱 in front while away is on, alone when nothing else is shown', () => {
    assert.equal(tmuxLine([row, row], null, 0, '', true), '📱 2⚙');
    assert.equal(tmuxLine([row], null, 2, 'C 62%', true), '📱 1⚙ 2⧗ │ C 62%');
    assert.equal(tmuxLine([], null, 0, '', true), '📱');
    assert.equal(tmuxLine([row], null, 0, '', false), '1⚙');
  });

  it('statusTmuxLine follows the state in AGENTCTL_HOME', async () => {
    const config = makeConfig(scratch.sub('t1'), NTFY);
    const tmux = new FakeTmux();
    tmux.add('nc-9');
    seedTask(config, 'NC-9');
    const runner = new DiskRunner({ dryRun: false, respond: tmux.respond });
    const ctx = new Context(runner, config, () => {});
    assert.ok(!(await statusTmuxLine(ctx)).includes('📱'));
    await setAway(ctx, true, 'cli');
    assert.match(await statusTmuxLine(ctx), /^📱 /);
    const r = await runCli(config, runner, ['status', '--tmux-line']);
    assert.match(r.stdout, /^📱 /);
    await setAway(ctx, false, 'cli');
    assert.ok(!(await statusTmuxLine(ctx)).includes('📱'));
  });
});

describe('phone: MCP', () => {
  function mcpSetup(name: string, extra = NTFY) {
    const config = makeConfig(scratch.sub(name), extra);
    const tmux = new FakeTmux();
    const runner = new DiskRunner({ dryRun: false, respond: tmux.respond });
    const notified: string[] = [];
    const deps: McpDeps = { context: (out) => new Context(runner, { ...loadGlobalConfig(path.dirname(config.path)), notify: { ...loadGlobalConfig(path.dirname(config.path)).notify, mcpWrites: 'all' } }, out), notify: async (m) => void notified.push(m), self: ['/usr/bin/env', '/opt/node/bin/node', '/opt/agentctl/bin/agentctl.ts'] as never };
    const call = (tool: string, args: Record<string, unknown> = {}) => {
      const t = MCP_TOOLS.find((x) => x.name === tool) as McpToolDef;
      return t.run(deps, z.object(t.input).parse(args) as never);
    };
    return { config, call, notified, runner };
  }

  it('away is a write tool: off by default (denied and audited), then on/off without confirm, audited and announced', async () => {
    const s = mcpSetup('m1');
    const denied = await s.call('away', { on: true });
    assert.equal(denied.isError, true);
    assert.match(denied.text, /not in mcp\.allow/);
    assert.equal(readAway(s.config).on, false);
    fs.appendFileSync(s.config.path, 'mcp:\n  allow: [away]\n');
    const on = await s.call('away', { on: true });
    assert.equal(on.isError, undefined);
    assert.match(on.text, /Away is on/);
    assert.equal(readAway(s.config).on, true);
    assert.equal(readAway(s.config).by, 'mcp');
    assert.match((await s.call('away', { on: true })).text, /already on/);
    await s.call('away', { on: false });
    assert.equal(readAway(s.config).on, false);
    assert.deepEqual(s.notified, ['czat zlecił: away on', 'czat zlecił: away off']);
    const audit = fs.readFileSync(auditPath(s.config), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(audit.map((a: { tool: string; outcome: string }) => `${a.tool}:${a.outcome}`), ['away:denied', 'away:requested', 'away:done', 'away:requested', 'away:preview', 'away:requested', 'away:done']);
  });

  it('status says whether away is on; events_since carries the state and marks events that went to the phone', async () => {
    const s = mcpSetup('m2');
    assert.match((await s.call('status')).text, /Away: off; the phone is quiet\./);
    await setAway(new Context(s.runner, s.config, () => {}), true, 'cli');
    const status = await s.call('status');
    assert.match(status.text, /Away: ON since .* \(set by cli\); the phone gets the notifications\./);
    const ev = await s.call('events_since', { peek: true });
    assert.match(ev.text, /Away włączone/);
    assert.equal(JSON.parse((await s.call('events_since', { peek: true, format: 'json' })).text).away.on, true);
  });

  it('events: the journal field phone shows as 📱 in the text and the markdown', async () => {
    const s = mcpSetup('m3');
    const ctx = new Context(s.runner, s.config, () => {});
    fs.writeFileSync(path.join(path.dirname(s.config.path), 'journal.jsonl'), `${JSON.stringify({ at: new Date(ctx.runner.now() - 60_000).toISOString(), kind: 'report-ready', task: 'NC-1', text: 'NC-1: raport gotowy', verdict: 'PASS', phone: 'sent' })}\n${JSON.stringify({ at: new Date(ctx.runner.now() - 30_000).toISOString(), kind: 'dead', task: 'NC-2', text: 'NC-2: okno zniknęło' })}\n`);
    const report = await collectEvents(ctx, { client: 'cli', keep: true });
    const lines = renderEvents(report);
    assert.match(lines.find((l) => l.includes('NC-1')) ?? '', /PASS 📱$/);
    assert.doesNotMatch(lines.find((l) => l.includes('NC-2')) ?? '', /📱/);
    assert.match(eventsMarkdown(report), /NC-1 – PASS 📱/);
    assert.ok(fs.existsSync(awayPath(s.config)) === false);
  });
});
