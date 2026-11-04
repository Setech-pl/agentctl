import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { allRecords, collectTaskUsage, claudePlanFile, planState, readPlans, taskTokenMap } from '../src/core/usage.ts';
import { emptyStats, feedText, formatTokens, freshTokens, localDay, sumBuckets, windowKind } from '../src/core/usage-parse.ts';
import { claudeProjectName, UsageReader } from '../src/core/usage-sources.ts';
import { buildTapStatusLine, handleTap, parseClaudeRateLimits, userStatusLine } from '../src/core/usage-tap.ts';
import { buildClaudeSettings, planEventWiring } from '../src/core/events.ts';
import { DiskRunner, makeConfig, useScratch } from './helpers.ts';
import { makeWorld, readFixture } from './usage-world.ts';

const scratch = useScratch();
const read = readFixture;
const world = (name: string, extraYaml = '') => makeWorld(scratch, name, extraYaml);

/** The day the fixture timestamp falls on here (the buckets are local days). */
const dayOf = (iso: string): string => localDay(Date.parse(iso));

describe('Claude transcript parser', () => {
  const stats = emptyStats('claude');
  feedText(stats, read('claude-transcript.jsonl'));

  it('reads the session id, the working directory and the time span', () => {
    assert.equal(stats.id, '11111111-2222-3333-4444-555555555555');
    assert.equal(stats.cwd, '/Users/me/Projects/wt/nc-1');
    assert.equal(stats.firstAt, Date.parse('2026-11-01T10:00:00.000Z'));
    assert.equal(stats.lastAt, Date.parse('2026-11-02T08:00:10.000Z'));
  });

  it('counts a message once however many blocks it was written in, and takes the final output', () => {
    const sonnet = sumBuckets(stats.buckets, { model: 'claude-sonnet-5-5' });
    // msg a (3 lines: output grew 100 -> 276) + msg b
    assert.deepEqual(sonnet, { input: 5, output: 326, cacheRead: 17000, cacheWrite: 17200 });
  });

  it('keeps models and days apart, and skips synthetic messages', () => {
    const opus = stats.buckets[`${dayOf('2026-11-02T08:00:00.000Z')}|claude-opus-5-5`];
    assert.deepEqual(opus, { input: 5, output: 400, cacheRead: 17200, cacheWrite: 0 });
    assert.equal(Object.keys(stats.buckets).some((k) => k.includes('<synthetic>')), false);
    assert.equal(Object.keys(stats.buckets).filter((k) => k.includes('sonnet')).length, dayOf('2026-11-01T10:00:00.000Z') === dayOf('2026-11-01T10:01:00.000Z') ? 1 : 2);
  });

  it('headline tokens leave cache reads out', () => {
    assert.equal(freshTokens({ input: 5, output: 326, cacheRead: 17000, cacheWrite: 17200 }), 5 + 326 + 17200);
  });

  it('a line that is not JSON, or a half written last line, is skipped and left for the next read', () => {
    const s = emptyStats('claude');
    const text = read('claude-transcript.jsonl');
    const cut = text.slice(0, text.length - 20); // the last line loses its end, and with it its newline
    const used = feedText(s, `not json\n${cut}`);
    assert.ok(used < Buffer.byteLength(cut) + 9);
    assert.equal(s.id, '11111111-2222-3333-4444-555555555555');
  });
});

describe('Codex session parser', () => {
  const stats = emptyStats('codex');
  feedText(stats, read('codex-session.jsonl'));

  it('reads the thread id, the directory and the models of the turns', () => {
    assert.equal(stats.id, '01a00000-aaaa-7bbb-8ccc-dddddddddddd');
    assert.equal(stats.cwd, '/Users/me/Projects/wt/nc-2');
    const sol = sumBuckets(stats.buckets, { model: 'gpt-6.1-sol' });
    const mini = sumBuckets(stats.buckets, { model: 'gpt-6.1-mini' });
    // input_tokens contains the cached part: only the rest is fresh input
    assert.deepEqual(sol, { input: 1300, output: 150, cacheRead: 1700, cacheWrite: 0, reasoning_output_tokens: 0 });
    assert.deepEqual(mini, { input: 300, output: 50, cacheRead: 300, cacheWrite: 0, reasoning_output_tokens: 0 });
  });

  it('takes the cumulative total once: the token_count without info adds nothing', () => {
    const all = sumBuckets(stats.buckets);
    assert.deepEqual(all, { input: 1600, output: 200, cacheRead: 2000, cacheWrite: 0, reasoning_output_tokens: 0 });
  });

  it('keeps the newest plan: a 5 hour and a weekly window with their resets', () => {
    assert.ok(stats.plan);
    assert.equal(stats.plan.planType, 'prolite');
    assert.deepEqual(stats.plan.windows.map((w) => [w.kind, w.minutes, w.usedPercent, w.resetsAt]), [['session', 300, 7, 1793700000], ['week', 10080, 12, 1794300000]]);
  });

  it('a total that shrinks starts a new count instead of going negative', () => {
    const s = emptyStats('codex');
    const line = (i: number, o: number): string => `${JSON.stringify({ timestamp: '2026-11-01T12:00:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: i, cached_input_tokens: 0, output_tokens: o } } } })}\n`;
    feedText(s, line(1000, 100) + line(1500, 150) + line(200, 20));
    assert.deepEqual(sumBuckets(s.buckets), { input: 1700, output: 170, cacheRead: 0, cacheWrite: 0 });
  });
});

describe('formatting and windows', () => {
  it('formats token counts', () => {
    assert.deepEqual([950, 1234, 12_345, 1_234_567, 25_000_000].map(formatTokens), ['950', '1.2k', '12k', '1.2M', '25M']);
  });
  it('tells the 5 hour window from the weekly one by its length', () => {
    assert.deepEqual([300, 10080, 60, null].map(windowKind), ['session', 'week', 'other', 'other']);
  });
  it('names the Claude folder of a working directory', () => {
    assert.equal(claudeProjectName('/Users/me/.claude/projects/-x'), '-Users-me--claude-projects--x');
  });
});

describe('incremental reading', () => {
  it('reads on from the offset: a growing file is not parsed again from the start', () => {
    const s = scratch.sub('incr');
    const file = path.join(s, 'a.jsonl');
    const cache = path.join(s, 'cache.json');
    const text = read('claude-transcript.jsonl');
    const lines = text.split('\n').filter(Boolean);
    fs.writeFileSync(file, `${lines.slice(0, 4).join('\n')}\n`);
    const first = new UsageReader(cache);
    const a = first.stats(file, 'claude');
    assert.ok(a);
    const sizeAfterFirst = fs.statSync(file).size;
    first.save();
    // the rest arrives; a second reader (another process) continues from the cached offset
    fs.appendFileSync(file, `${lines.slice(4).join('\n')}\n`);
    const second = new UsageReader(cache);
    const cached = JSON.parse(fs.readFileSync(cache, 'utf8')) as { files: Record<string, { offset: number }> };
    assert.equal(cached.files[file]?.offset, sizeAfterFirst);
    const b = second.stats(file, 'claude');
    assert.ok(b);
    assert.deepEqual(sumBuckets(b.buckets, { model: 'claude-sonnet-5-5' }), { input: 5, output: 326, cacheRead: 17000, cacheWrite: 17200 });
    // the same totals as one read of the whole file
    const whole = emptyStats('claude');
    feedText(whole, text);
    assert.deepEqual(sumBuckets(b.buckets), sumBuckets(whole.buckets));
  });

  it('does not touch the file when it did not grow', () => {
    const s = scratch.sub('still');
    const file = path.join(s, 'a.jsonl');
    fs.writeFileSync(file, read('codex-session.jsonl'));
    const r1 = new UsageReader(path.join(s, 'c.json'));
    r1.stats(file, 'codex');
    r1.save();
    const before = fs.statSync(path.join(s, 'c.json')).mtimeMs;
    const r2 = new UsageReader(path.join(s, 'c.json'));
    assert.ok(r2.stats(file, 'codex'));
    r2.save(); // nothing new: the cache is not rewritten
    assert.equal(fs.statSync(path.join(s, 'c.json')).mtimeMs, before);
  });

  it('a file that got shorter is read again from the start', () => {
    const s = scratch.sub('short');
    const file = path.join(s, 'a.jsonl');
    fs.writeFileSync(file, read('codex-session.jsonl'));
    const r = new UsageReader(path.join(s, 'c.json'));
    r.stats(file, 'codex');
    r.save();
    const lines = read('codex-session.jsonl').split('\n').filter(Boolean);
    fs.writeFileSync(file, `${lines.slice(0, 4).join('\n')}\n`);
    const again = new UsageReader(path.join(s, 'c.json')).stats(file, 'codex');
    assert.ok(again);
    assert.deepEqual(sumBuckets(again.buckets), { input: 800, output: 50, cacheRead: 200, cacheWrite: 0, reasoning_output_tokens: 0 });
  });
});

const NOW = Date.parse('2026-11-02T12:00:00.000Z');

describe('sessions of a task', () => {
  it('Claude: the transcripts of the task worktree, subagents included, are the tokens of the task', () => {
    const w = world('claude-bind');
    const wt = w.worktree('nc-1');
    w.task('NC-1', wt, { started: '2026-11-01T09:59:00.000Z' });
    w.claudeSession(wt, 'sess-a', '2026-11-01T10:00:00.000Z', { sub: true });
    const tokens = taskTokenMap(w.config, NOW);
    const t = tokens.get('NC-1');
    assert.ok(t);
    assert.equal(t.sessions, 1);
    // main: in 5+5, out 326+400, cache write 17200 ; subagent: in 10, out 20, cache write 40
    assert.deepEqual(t.tokens, { input: 20, output: 746, cacheRead: 34200 + 300, cacheWrite: 17240 });
    assert.equal(t.fresh, 20 + 746 + 17240);
  });

  it('a session from before the task, in the same worktree, is not the task\'s', () => {
    const w = world('before');
    const wt = w.worktree('nc-1');
    w.task('NC-1', wt, { started: '2026-11-01T12:00:00.000Z' });
    w.claudeSession(wt, 'old', '2026-11-01T10:00:00.000Z');
    assert.equal(taskTokenMap(w.config, NOW).has('NC-1'), false);
  });

  it('a session of another worktree or of a sibling folder with the same prefix is not counted', () => {
    const w = world('siblings');
    const wt = w.worktree('nc-1');
    const other = w.worktree('nc-1-2');
    w.task('NC-1', wt, { started: '2026-11-01T09:00:00.000Z' });
    w.claudeSession(other, 'x', '2026-11-01T10:00:00.000Z');
    assert.equal(taskTokenMap(w.config, NOW).has('NC-1'), false);
  });

  it('a session that started in a folder below the worktree counts', () => {
    const w = world('below');
    const wt = w.worktree('nc-1');
    const sub = path.join(wt, 'packages', 'app');
    fs.mkdirSync(sub, { recursive: true });
    w.task('NC-1', wt, { started: '2026-11-01T09:00:00.000Z' });
    w.claudeSession(sub, 'deep', '2026-11-01T10:00:00.000Z');
    assert.equal(taskTokenMap(w.config, NOW).get('NC-1')?.sessions, 1);
  });

  it('Codex: the session log of the worktree, found by its working directory', () => {
    const w = world('codex-bind');
    const wt = w.worktree('nc-2');
    w.task('NC-2', wt, { agent: 'codex', model: 'gpt-6.1-sol', started: '2026-11-01T10:59:00.000Z' });
    w.codexSession(wt, 'thread-1', '2026-11-01T11:00:00.000Z');
    const t = taskTokenMap(w.config, NOW).get('NC-2');
    assert.ok(t);
    assert.deepEqual(t.tokens, { input: 1600, output: 200, cacheRead: 2000, cacheWrite: 0, reasoning_output_tokens: 0 });
  });

  it('a Claude task does not take a Codex session of its worktree', () => {
    const w = world('provider');
    const wt = w.worktree('nc-3');
    w.task('NC-3', wt, { started: '2026-11-01T09:00:00.000Z' });
    w.codexSession(wt, 'thread-x', '2026-11-01T11:00:00.000Z');
    assert.equal(taskTokenMap(w.config, NOW).has('NC-3'), false);
  });

  it('after move: both tasks share the worktree, each keeps the sessions of its own time', () => {
    const w = world('move');
    const wt = w.worktree('nc-4');
    w.task('NC-4', wt, { started: '2026-11-01T09:00:00.000Z', supersededBy: 'NC-4-2' });
    w.task('NC-4-2', wt, { agent: 'codex', model: 'gpt-6.1-sol', started: '2026-11-01T11:00:00.000Z', continues: 'NC-4' });
    w.claudeSession(wt, 'first', '2026-11-01T10:00:00.000Z');
    w.codexSession(wt, 'second', '2026-11-01T11:05:00.000Z');
    const map = taskTokenMap(w.config, NOW);
    assert.equal(map.get('NC-4')?.tokens.cacheWrite, 17200);
    assert.equal(map.get('NC-4-2')?.tokens.input, 1600);
    // a Claude session after the successor started belongs to nobody (the old task ended there)
    w.claudeSession(wt, 'late', '2026-11-01T12:00:00.000Z');
    assert.equal(taskTokenMap(w.config, NOW).get('NC-4')?.sessions, 1);
  });

  it('two tasks on one provider in one worktree: the later one gets the later session', () => {
    const w = world('reuse');
    const wt = w.worktree('nc-5');
    w.task('NC-5', wt, { started: '2026-11-01T09:00:00.000Z', closed: true, closedAt: '2026-11-01T10:30:00.000Z' });
    w.task('NC-6', wt, { started: '2026-11-01T13:00:00.000Z' });
    w.claudeSession(wt, 'one', '2026-11-01T10:00:00.000Z');
    w.claudeSession(wt, 'two', '2026-11-01T13:05:00.000Z');
    const map = taskTokenMap(w.config, NOW);
    assert.equal(map.get('NC-5')?.sessions, 1);
    assert.equal(map.get('NC-6')?.sessions, 1);
  });

  it('a session named by the agent\'s own events counts without the time and directory evidence', () => {
    const w = world('explicit');
    const wt = w.worktree('nc-7');
    w.task('NC-7', wt, { started: '2026-11-01T09:00:00.000Z' });
    const elsewhere = w.worktree('elsewhere');
    const file = w.claudeSession(elsewhere, 'named', '2026-10-30T10:00:00.000Z');
    assert.equal(taskTokenMap(w.config, NOW).has('NC-7'), false);
    fs.writeFileSync(path.join(w.config.stateDir, 'nc-7', 'sessions.json'), JSON.stringify({ claude: [{ id: 'named', transcript: file }], codex: [] }));
    assert.equal(taskTokenMap(w.config, NOW).get('NC-7')?.sessions, 1);
  });

  it('CLAUDE_CONFIG_DIR in the spec env moves the lookup to that home', () => {
    const w = world('envhome');
    const wt = w.worktree('nc-8');
    const other = scratch.sub('envhome/other-claude');
    w.task('NC-8', wt, { started: '2026-11-01T09:00:00.000Z', env: { CLAUDE_CONFIG_DIR: other } });
    const dir = path.join(other, 'projects', claudeProjectName(wt));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 's.jsonl'), read('claude-transcript.jsonl').replaceAll('/Users/me/Projects/wt/nc-1', wt));
    assert.equal(taskTokenMap(w.config, NOW).get('NC-8')?.sessions, 1);
  });

  it('a task with no session log has no tokens: n/d, not zero', () => {
    const w = world('none');
    w.task('NC-9', w.worktree('nc-9'), { started: '2026-11-01T09:00:00.000Z' });
    assert.equal(taskTokenMap(w.config, NOW).has('NC-9'), false);
    const usage = collectTaskUsage(w.config, new UsageReader(undefined), allRecords(w.config), NOW);
    assert.equal(usage.get('NC-9')?.sessions, 0);
  });
});

describe('plan state', () => {
  const sec = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

  it('windows after their reset are dropped; all dropped is n/d with the reason', () => {
    const snap = { at: Date.parse('2026-11-02T08:00:00.000Z'), planType: 'plus', windows: [{ kind: 'session' as const, minutes: 300, usedPercent: 40, resetsAt: sec('2026-11-02T10:00:00.000Z') }, { kind: 'week' as const, minutes: 10080, usedPercent: 20, resetsAt: sec('2026-11-07T10:00:00.000Z') }] };
    const mid = planState('codex', snap, Date.parse('2026-11-02T09:00:00.000Z'), 'x');
    assert.equal(mid.available, true);
    assert.equal(mid.maxPercent, 40);
    const after = planState('codex', snap, Date.parse('2026-11-02T10:30:00.000Z'), 'x');
    assert.deepEqual(after.windows.map((x) => x.kind), ['week']);
    assert.equal(after.maxPercent, 20);
    const gone = planState('codex', { ...snap, windows: [snap.windows[0]!] }, Date.parse('2026-11-02T10:30:00.000Z'), 'x');
    assert.equal(gone.available, false);
    assert.equal(gone.maxPercent, null);
    assert.match(gone.note, /reset since/);
  });

  it('a reading older than half an hour is marked as such', () => {
    const snap = { at: NOW - 40 * 60_000, planType: null, windows: [{ kind: 'session' as const, minutes: 300, usedPercent: 10, resetsAt: Math.floor(NOW / 1000) + 3600 }] };
    const s = planState('claude', snap, NOW, 'x');
    assert.equal(s.available, true);
    assert.equal(s.stale, true);
  });

  it('no reading at all is n/d and says why', () => {
    const w = world('plan-none');
    const plans = readPlans(w.config, new UsageReader(undefined), NOW);
    assert.equal(plans.claude.available, false);
    assert.equal(plans.codex.available, false);
    assert.match(plans.claude.note, /statusLine/);
    assert.match(plans.codex.note, /rate limits/);
    assert.equal(plans.claude.maxPercent, null);
  });

  it('Codex: reads the plan from the tail of the newest session log in the last three days', () => {
    const w = world('plan-tail');
    const start = new Date(NOW - 2 * 3600_000);
    const file = w.codexSession(w.worktree('y'), 'tail', start.toISOString());
    // resets of the fixture are far in the past relative to NOW: move them ahead
    const future = Math.floor(NOW / 1000) + 3600;
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('1793700000', String(future)).replaceAll('1794300000', String(future + 86_400 * 5)));
    const plans = readPlans(w.config, new UsageReader(undefined), NOW);
    assert.equal(plans.codex.available, true);
    assert.equal(plans.codex.planType, 'prolite');
    assert.deepEqual(plans.codex.windows.map((x) => [x.label, x.usedPercent]), [['5h', 7], ['week', 12]]);
  });

  it('Codex: a log whose newest rate_limits belong to the premium limit (no windows) says nothing', () => {
    const w = world('plan-premium');
    const dir = path.join(w.codexHome, 'sessions', ...localDay(NOW).split('-'));
    fs.mkdirSync(dir, { recursive: true });
    const line = { timestamp: new Date(NOW - 1000).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { limit_id: 'premium', primary: null, secondary: null, plan_type: 'plus' } } };
    fs.writeFileSync(path.join(dir, 'rollout-2026-11-02T10-00-00-aaa.jsonl'), `${JSON.stringify(line)}\n`);
    assert.equal(readPlans(w.config, new UsageReader(undefined), NOW).codex.available, false);
  });
});

describe('Claude statusLine tap', () => {
  const input = (extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ session_id: 'sid-1', transcript_path: '/t/sid-1.jsonl', rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1793700000 }, seven_day: { used_percentage: 41.2, resets_at: 1794300000 } }, ...extra });

  it('takes the two windows from the rate_limits of the input', () => {
    const r = parseClaudeRateLimits(JSON.parse(input()), 5);
    assert.deepEqual(r, { at: 5, windows: [{ minutes: 300, usedPercent: 23.5, resetsAt: 1793700000 }, { minutes: 10080, usedPercent: 41.2, resetsAt: 1794300000 }] });
  });

  it('an input without rate_limits (no subscription, or before the first answer) gives nothing', () => {
    assert.equal(parseClaudeRateLimits({ session_id: 'x' }, 1), undefined);
    assert.equal(parseClaudeRateLimits({ rate_limits: {} }, 1), undefined);
    assert.equal(parseClaudeRateLimits('nope', 1), undefined);
  });

  it('writes the plan where usage reads it, remembers the session, and prints the output of the user\'s own command', async () => {
    const w = world('tap');
    w.task('NC-1', w.worktree('nc-1'));
    const runner = new DiskRunner({ dryRun: false, startTime: NOW, respond: (cmd) => (cmd === 'sh' ? { stdout: 'my line\n' } : undefined) });
    const result = await handleTap(runner, w.config, { task: 'NC-1', window: 'nc-1', raw: input(), forward: 'echo hi' });
    assert.equal(result.output, 'my line\n');
    assert.equal(result.stored, true);
    assert.ok(fs.existsSync(claudePlanFile(w.config)));
    const sh = runner.commands.find((c) => c.startsWith('sh'));
    assert.ok(sh);
    const sessions = JSON.parse(fs.readFileSync(path.join(w.config.stateDir, 'nc-1', 'sessions.json'), 'utf8')) as { claude: { id: string; transcript: string }[] };
    assert.deepEqual(sessions.claude, [{ id: 'sid-1', transcript: '/t/sid-1.jsonl' }]);
    const plan = readPlans(w.config, new UsageReader(undefined), NOW - 60_000).claude;
    assert.equal(plan.available, true);
    assert.equal(plan.maxPercent, 41.2);
  });

  it('survives garbage on stdin and a command that fails', async () => {
    const w = world('tap-bad');
    const runner = new DiskRunner({ dryRun: false, startTime: NOW, respond: () => ({ code: 1, stderr: 'boom' }) });
    const result = await handleTap(runner, w.config, { task: 'NC-1', window: 'nc-1', raw: '{not json', forward: 'false' });
    assert.equal(result.output, '');
    assert.equal(result.stored, false);
  });

  it('the statusLine of a task window passes the user\'s own one on; none of its own: the tap alone', () => {
    const files: Record<string, string> = { '/home/.claude/settings.json': JSON.stringify({ statusLine: { type: 'command', command: '~/.claude/line.sh', padding: 1 } }) };
    const read = (f: string): string | undefined => files[f];
    assert.deepEqual(userStatusLine('/wt', '/home/.claude', read), { command: '~/.claude/line.sh', foreign: false, padding: 1 });
    assert.deepEqual(userStatusLine('/wt', '/elsewhere', read), { foreign: false });
    // the project's own settings win over the user's
    files['/wt/.claude/settings.json'] = JSON.stringify({ statusLine: { type: 'command', command: 'proj.sh' } });
    assert.equal(userStatusLine('/wt', '/home/.claude', read).command, 'proj.sh');
    files['/wt/.claude/settings.local.json'] = JSON.stringify({ statusLine: { type: 'static', text: 'x' } });
    assert.equal(userStatusLine('/wt', '/home/.claude', read).foreign, true);
  });

  it('new wires it into the settings file of a Claude window, unless usage.claude_tap is off or the user\'s statusLine cannot be passed on', () => {
    const w = world('wiring');
    const self = ['/bin/node', 'agentctl.ts'];
    const wire = (config = w.config, env: Record<string, string> = { CLAUDE_CONFIG_DIR: w.claudeHome }) => planEventWiring({ agent: 'claude', task: 'NC-1', window: 'nc-1', config, self, env, worktree: w.worktree('wiring-wt') });
    const settings = (e: ReturnType<typeof planEventWiring>): Record<string, unknown> => JSON.parse(e.files[0]?.content ?? '{}') as Record<string, unknown>;
    const withTap = settings(wire());
    assert.match(String((withTap.statusLine as { command: string }).command), /usage-tap --task NC-1$/);
    assert.ok(withTap.hooks);
    fs.writeFileSync(path.join(w.claudeHome, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'echo user' } }));
    assert.match(String((settings(wire()).statusLine as { command: string }).command), /usage-tap --task NC-1 --forward 'echo user'$/);
    fs.writeFileSync(path.join(w.claudeHome, 'settings.json'), JSON.stringify({ statusLine: { type: 'something' } }));
    assert.equal(settings(wire()).statusLine, undefined);
    const off = makeConfigOff(w.root);
    assert.equal(buildTapStatusLine('NC-1', self, off, undefined, {}), undefined);
    assert.deepEqual(Object.keys(buildClaudeSettings('NC-1', self)), ['hooks', 'promptSuggestionEnabled']);
  });
});

function makeConfigOff(root: string) {
  return makeConfig(path.join(root, 'off'), 'usage:\n  claude_tap: false\n');
}

describe('config usage section', () => {
  it('defaults: warn 80, critical 95, no queue hold, status line on', () => {
    const c = makeConfig(scratch.sub('cfg-default'));
    assert.deepEqual(c.usage.warn, { claude: 80, codex: 80 });
    assert.deepEqual(c.usage.critical, { claude: 95, codex: 95 });
    assert.deepEqual(c.usage.queueHold, {});
    assert.equal(c.usage.statusLine, true);
  });
  it('a number applies to both providers, a mapping to one', () => {
    const c = makeConfig(scratch.sub('cfg-map'), 'usage:\n  warn: 70\n  critical: {codex: 90}\n  queue_hold: {claude: 97}\n');
    assert.deepEqual(c.usage.warn, { claude: 70, codex: 70 });
    assert.deepEqual(c.usage.critical, { claude: 95, codex: 90 });
    assert.deepEqual(c.usage.queueHold, { claude: 97 });
  });
  it('rejects a critical below warn, a percentage out of range and unknown keys', () => {
    assert.throws(() => makeConfig(scratch.sub('cfg-bad1'), 'usage:\n  warn: 90\n  critical: 80\n'), /critical \(80\) for claude is below warn \(90\)/);
    assert.throws(() => makeConfig(scratch.sub('cfg-bad2'), 'usage:\n  warn: 120\n'), /usage.warn must be a percentage/);
    assert.throws(() => makeConfig(scratch.sub('cfg-bad3'), 'usage:\n  nope: 1\n'), /unknown key "nope"/);
  });
});
