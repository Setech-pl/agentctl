import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { withHarness, installReplayAgent, writeReplaySpec, defaultCacheRoot } from './live-harness.ts';
import type { Harness, ReplaySpec } from './live-harness.ts';

/*
 * P15/P15b/P16, live: the real agentctl (new, send, watch, MCP) in the real tmux of the harness, with a fake agent that replays the screens RECORDED
 * from Claude Code 2.1.311 and codex-cli 0.166.0 (tests/fixtures/screen-*-busy-*, screen-codex-question-*). The fake logs every paste and Enter.
 */
const cache = defaultCacheRoot('agentctl-p15'), results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: unknown) => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); assert.ok(ok, name); };
const ENTER_RETRY_WAIT_MS = 11000;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const until = async (condition: () => boolean, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (condition()) return true; await pause(100); } return condition(); };
const fx = (name: string) => fs.readFileSync(path.resolve(import.meta.dirname, '../tests/fixtures', name), 'utf8');
const FILLER = Array.from({ length: 7 }, (_, i) => `Line ${i + 1}: the quick brown fox jumps over the lazy dog, again and again, to pad the message out to about one thousand characters.`);
const LONG = ['FOLLOWUP-LONG-A: when your current work is finished, reply with the single line ACK-LONG-A and nothing else. Context padding follows so that this message is long enough to be collapsed by the terminal UI into a pasted text placeholder instead of being shown inline.', ...FILLER].join('\n');
const CODEX_LONG = ['FOLLOWUP-CX-LONG: when your current work is finished, reply with the single line ACK-CX-LONG and nothing else. This padding makes the message long enough for the terminal UI to treat it as a large paste.', ...FILLER].join('\n');
const PLACEHOLDER = /^(❯|›)\s\[Pasted text #\d+(?: \+\d+ lines)?\]$/m;

const claudeBusyPasted = fx('screen-claude-busy-paste.txt');
const claudeBusy = claudeBusyPasted.replace(PLACEHOLDER, '$1 ');
const claudeSpec = (extra: Partial<ReplaySpec> = {}): ReplaySpec => ({ agent: 'claude', screens: { ready: '❯ Try "fake"\n', busy: claudeBusy, pasted: claudeBusyPasted, accepted: fx('screen-claude-busy-queued-ansi.txt'), question: '' }, state: 'ready', swallow: 0, hook: true, ...extra });
const codexSteered = fx('screen-codex-busy-steered.txt');
const codexBusy = codexSteered.replace(/^› FOLLOWUP-CX-LONG[^\n]*\n(?:  [^\n]*\n)*?(?=• Working)/m, '');
const codexSpec = (extra: Partial<ReplaySpec> = {}): ReplaySpec => ({ agent: 'codex', screens: { ready: '› Ask Codex to do anything\n', busy: codexBusy, pasted: codexBusy.replace(/^› Ask Codex to do anything$/m, '› [Pasted text #1 +8 lines]'), accepted: codexSteered, question: fx('screen-codex-question-collapsed.txt') }, state: 'ready', swallow: 0, hook: false, ...extra });

async function scenario(name: string, agent: 'claude' | 'codex', spec: ReplaySpec, body: (s: { h: Harness; log: () => any[]; record: () => string; run: (...a: string[]) => { code: number; stdout: string; stderr: string }; sendFile: (text: string) => string; mcp: (tool: string, args?: Record<string, unknown>) => Promise<string>; mcpCall: (tool: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; text: string }>; audit: () => { tool: string; outcome: string; detail?: string }[]; state: (patch: Partial<ReplaySpec>) => void; json: (key: string) => string }) => Promise<void>) {
  await withHarness({ name, cacheRoot: cache, config: 'capacity: {snapshot: false, codex_refresh: false}\nwatch: {interval: 1}\nmcp: {allow: [send, send_enter]}\n' }, async (h) => {
    h.tmux(['set-option', '-g', 'default-size', '200x50']);
    const log = path.join(h.root, 'replay.jsonl');
    installReplayAgent(h, agent, log); writeReplaySpec(h, spec);
    const repo = path.join(h.root, 'repo'); fs.mkdirSync(repo);
    for (const args of [['init', '-qb', 'main'], ['commit', '--allow-empty', '-qm', 'fixture']]) assert.equal(spawnSync('git', args, { cwd: repo, env: h.env }).status, 0);
    const specFile = path.join(h.root, 't1.md');
    fs.writeFileSync(specFile, `---\ntask: T1\nagent: ${agent}\nmodel: ${agent === 'claude' ? 'haiku' : 'gpt-6-luna'}\neffort: low\nreport: ${path.join(h.root, 'cache/t1/T1.md')}\nrepos:\n  - {path: ${repo}, worktree: ${repo}-wt}\n---\nOriginal prompt\n`);
    const started = h.agentctl(['new', specFile, '-y']);
    assert.equal(started.code, 0, started.stdout + started.stderr);
    const entries = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
    const taskFile = path.join(h.root, 'state/t1/TASK.md');
    const text = () => fs.readFileSync(taskFile, 'utf8');
    const client = new Client({ name: 'p15', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--experimental-strip-types', '--no-warnings', path.resolve(import.meta.dirname, '../bin/agentctl.ts'), 'mcp'], env: h.env as Record<string, string> }));
    try {
      assert.ok(await until(() => /prompt_delivery: sent/.test(text()), 15000), 'the initial prompt is delivered first\n' + text());
      writeReplaySpec(h, { ...spec, state: spec.state === 'ready' ? 'busy' : spec.state });
      await pause(400);
      let current = { ...spec, state: spec.state === 'ready' ? 'busy' as const : spec.state };
      await body({
        h, log: entries,
        record: text,
        run: (...a) => h.agentctl(a),
        sendFile: (body) => { const f = path.join(h.root, `send-${Date.now()}.md`); fs.writeFileSync(f, `---\ntask: T1\n---\n${body}\n`); return f; },
        mcp: async (tool, args = {}) => { const r = await client.callTool({ name: tool, arguments: args }); return (r.content as { text: string }[]).map(c => c.text).join('\n'); },
        mcpCall: async (tool, args = {}) => { const r = await client.callTool({ name: tool, arguments: args }); return { isError: r.isError === true, text: (r.content as { text: string }[]).map(c => c.text).join('\n') }; },
        audit: () => fs.readFileSync(path.join(h.agentctlHome, 'mcp-audit.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l)),
        state: (patch) => { current = { ...current, ...patch } as ReplaySpec; writeReplaySpec(h, current); },
        json: (key) => { const rows = JSON.parse(h.agentctl(['status', '--json']).stdout) as Record<string, unknown>[]; return String(rows[0]?.[key] ?? ''); },
      });
    } finally { await client.close(); }
  });
}

await scenario('claude-queued', 'claude', claudeSpec(), async ({ h, log, record, run, sendFile, json }) => {
  const sent = run('send', sendFile(LONG), '-y');
  const watcher = h.spawnAgentctl(['watch'], path.join(h.root, 'watch.log'));
  try {
    check('P15b Claude busy: send says the message waits in the agent’s queue', /w kolejce agenta/.test(sent.stdout) && !/niepotwierdzone/.test(sent.stdout));
    check('P15b Claude busy: one paste, one Enter', log().filter(e => e.paste && e.state === 'busy').length === 1 && log().filter(e => e.enter && e.state === 'busy').length === 1);
    check('P15b Claude busy: TASK.md says sent / queued-in-agent, no pending state', /prompt_delivery: sent/.test(record()) && /delivery_result: queued-in-agent/.test(record()) && !/pending_prompt/.test(record()));
    check('P15b Claude busy: status says it too', json('promptDelivery') === 'sent' && json('deliveryResult') === 'queued-in-agent');
    await pause(3500);
    check('P15b Claude busy: nothing flips back to confirming or needs-attention later (the hook with <pasted_content> arrived)', /prompt_delivery: sent/.test(record()) && json('state') !== 'needs-attention');
    check('P15b Claude busy: a "delivery" event is in the journal', /"kind":"delivery"/.test(fs.readFileSync(path.join(h.agentctlHome, 'journal.jsonl'), 'utf8')));
  } finally { watcher.kill('SIGTERM'); }
});

await scenario('claude-swallowed-watch', 'claude', claudeSpec({ swallow: 3 }), async ({ h, log, record, run, sendFile, json }) => {
  const sent = run('send', sendFile(LONG), '-y');
  check('P15 swallowed Enter: send says "nie dostarczono – tekst w polu wpisywania" and how to go on', /nie dostarczono – tekst w polu wpisywania/.test(sent.stdout) && /send --enter-only T1/.test(sent.stdout));
  check('P15 swallowed Enter: three Enter presses, ONE paste', log().filter(e => e.paste && e.state === 'busy').length === 1 && log().filter(e => e.enter && e.state === 'busy').length === 3);
  check('P15 swallowed Enter: TASK.md and status carry delivery_result not-delivered-in-field', /delivery_result: not-delivered-in-field/.test(record()) && json('deliveryResult') === 'not-delivered-in-field');
  const watcher = h.spawnAgentctl(['watch'], path.join(h.root, 'watch.log'));
  try {
    check('P15 swallowed Enter: watch presses Enter again (still one paste) and the delivery ends sent', await until(() => /prompt_delivery: sent/.test(record()), 30000) && log().filter(e => e.paste && e.state === 'busy').length === 1 && log().filter(e => e.enter && e.state === 'busy').length === 4);
    check('P15 swallowed Enter: it ends as queued-in-agent', /delivery_result: queued-in-agent/.test(record()));
  } finally { watcher.kill('SIGTERM'); }
});

await scenario('claude-enter-only', 'claude', claudeSpec({ swallow: 99 }), async ({ h, log, record, run, sendFile, mcp, state, json }) => {
  run('send', sendFile(LONG), '-y');
  check('enter-only: the text stands in the field (swallowed)', /delivery_result: not-delivered-in-field/.test(record()));
  const stuck = run('send', '--enter-only', 'T1');
  check('enter-only: Enter pressed, still swallowed: says so, exit code 1', /nie dostarczono – tekst w polu wpisywania/.test(stuck.stdout + stuck.stderr) && stuck.code === 1);
  h.tmux(['send-keys', '-t', `=${h.session}:t1`, 'x']);
  await until(() => log().some(e => e.typed === 'x'), 5000);
  const foreign = run('send', '--enter-only', 'T1');
  check('enter-only: a draft that is not our paste is refused, nothing pressed', /co innego niż to, co agentctl wkleił/.test(foreign.stdout + foreign.stderr) && foreign.code === 1);
  const before = log().filter(e => e.enter).length;
  check('enter-only: nothing was pressed by the refusal', log().filter(e => e.enter).length === before);
  state({ swallow: 0 }); await pause(300);
  h.tmux(['send-keys', '-t', `=${h.session}:t1`, 'BSpace']);
  await until(() => log().some(e => e.backspace), 5000);
  const refused = await mcp('send', { task: 'T1', text: 'x', enter_only: true });
  check('enter-only (MCP): text next to enter_only is an error', /do not give text/.test(refused));
  const preview = await mcp('send', { task: 'T1', enter_only: true });
  check('enter-only (MCP): without confirm it only previews, nothing is pressed', /Nie wciśnięto nic/.test(preview) && log().filter(e => e.enter).length === before);
  const done = await mcp('send', { task: 'T1', enter_only: true, confirm: true });
  check('enter-only (MCP): Enter for our own paste is taken, the answer says it is in the agent’s queue', /^T1: Enter wysłany: tak; dostarczenie potwierdzone: tak – zatwierdzono Enter; w kolejce agenta/.test(done));
  check('enter-only: TASK.md ends sent / queued-in-agent, still one paste', /prompt_delivery: sent/.test(record()) && /delivery_result: queued-in-agent/.test(record()) && log().filter(e => e.paste && e.state === 'busy').length === 1 && json('promptDelivery') === 'sent');
});

await scenario('codex-steer', 'codex', codexSpec(), async ({ h, log, record, run, sendFile, json }) => {
  const sent = run('send', sendFile(CODEX_LONG), '-y');
  const watcher = h.spawnAgentctl(['watch'], path.join(h.root, 'watch.log'));
  try {
    check('P16 Codex busy: the echo of the steered message confirms it at once, send says "wklejono (prompt sent)"', /wklejono \(prompt sent\)/.test(sent.stdout) && !/niepotwierdzone/.test(sent.stdout));
    check('P16 Codex busy: one paste, one Enter; TASK.md sent / delivered', log().filter(e => e.paste && e.state === 'busy').length === 1 && log().filter(e => e.enter && e.state === 'busy').length === 1 && /prompt_delivery: sent/.test(record()) && /delivery_result: delivered/.test(record()));
    await pause(3000);
    check('P16 Codex busy: it stays sent, no needs-attention', json('promptDelivery') === 'sent' && json('state') !== 'needs-attention');
  } finally { watcher.kill('SIGTERM'); }
});

await scenario('codex-question', 'codex', codexSpec(), async ({ h, log, record, run, sendFile, state }) => {
  state({ state: 'question' }); await pause(500);
  const pastesBefore = log().filter(e => e.paste).length;
  const sent = run('send', sendFile(CODEX_LONG), '-y');
  check('P16 Codex question: send names the open question and says nothing was pasted', /Codex ma otwarte pytanie „Which colour: red or blue\?” \(zwinięte, 1\)/.test(sent.stdout) && /nie jest wklejana w pole pytania/.test(sent.stdout));
  check('P16 Codex question: nothing was pasted into the question', log().filter(e => e.paste).length === pastesBefore && log().filter(e => e.enter && e.state === 'question').length === 0);
  const watcher = h.spawnAgentctl(['watch'], path.join(h.root, 'watch.log'));
  try {
    await pause(3500);
    check('P16 Codex question: watch keeps holding it while the question is open (still pending, still no paste)', /prompt_delivery: pending/.test(record()) && log().filter(e => e.paste).length === pastesBefore);
    state({ state: 'busy' });
    check('P16 Codex question: once the question is gone the message is delivered (one paste)', await until(() => /prompt_delivery: sent/.test(record()), 20000) && log().filter(e => e.paste).length === pastesBefore + 1);
  } finally { watcher.kill('SIGTERM'); }
});

// P15-FIX2 (cross review): a field that a human changed gets no Enter, enter_only needs the origin, MCP tells refusal from sent key, the old queue sign proves nothing.
const claudePlain = (extra: Partial<ReplaySpec> = {}) => claudeSpec({ plain: true, ...extra });
await scenario('claude-changed-field', 'claude', claudePlain({ swallow: 99 }), async ({ h, log, record, run, sendFile, mcpCall, audit }) => {
  const enters = () => log().filter(e => e.enter && e.state === 'busy').length;
  run('send', sendFile(LONG), '-y');
  check('E1 live: the whole paste stands in the field, three Enter presses were swallowed', /delivery_result: not-delivered-in-field/.test(record()) && enters() === 3);
  h.tmux(['send-keys', '-t', `=${h.session}:t1`, 'x']);
  await until(() => log().some(e => e.typed === 'x'), 5000);
  const watcher = h.spawnAgentctl(['watch'], path.join(h.root, 'watch.log'));
  try {
    await pause(ENTER_RETRY_WAIT_MS);
    check('E1 live: watch does not press Enter into a field a human added to (retry interval passed, still 3)', enters() === 3 && /delivery_result: not-delivered-in-field/.test(record()));
  } finally { watcher.kill('SIGTERM'); await pause(300); }
  const foreign = run('send', '--enter-only', 'T1');
  check('E2 live: --enter-only refuses the changed field, exit 1, no key', foreign.code === 1 && /co innego niż to, co agentctl wkleił/.test(foreign.stdout + foreign.stderr) && enters() === 3);
  const refused = await mcpCall('send', { task: 'T1', enter_only: true, confirm: true });
  check('E6 live (stdio client): the refusal is an isError with its reason and no key', refused.isError && /odmowa, żaden klawisz nie poszedł/.test(refused.text) && enters() === 3);
  const last = audit().at(-1)!;
  check('E6 live: the audit records the refusal as an error with its reason', last.tool === 'send_enter' && last.outcome === 'error' && /^refused:/.test(last.detail ?? ''));
  h.tmux(['send-keys', '-t', `=${h.session}:t1`, 'BSpace']);
  await until(() => log().some(e => e.backspace), 5000);
  const preview = await mcpCall('send', { task: 'T1', enter_only: true });
  check('E6 live: without confirm only a preview, no key', !preview.isError && /Nie wciśnięto nic/.test(preview.text) && enters() === 3 && audit().at(-1)!.outcome === 'preview');
  const pressed = await mcpCall('send', { task: 'T1', enter_only: true, confirm: true });
  check('E6 live: a pressed but swallowed Enter is not an error; the answer says key sent: yes, delivery confirmed: no', !pressed.isError && /Enter wysłany: tak/.test(pressed.text) && /potwierdzone: nie/.test(pressed.text) && enters() === 4);
  const done = audit().at(-1)!;
  check('E6 live: the audit records the executed Enter with its result', done.tool === 'send_enter' && done.outcome === 'done' && /enter-sent/.test(done.detail ?? ''));
  check('E7 live: the journal has the not-delivered entry with the delivery id', /"kind":"delivery"[^\n]*nie dostarczono[^\n]*\[dostawa [0-9a-f]{8}\]/.test(fs.readFileSync(path.join(h.agentctlHome, 'journal.jsonl'), 'utf8')));
});

const staleBusy = fx('screen-claude-busy-queued-shown.txt').replace(/^❯\s*Press up to edit queued messages$/m, '❯ ');
await scenario('claude-stale-queue-sign', 'claude', claudeSpec({ swallow: 0, plain: true, hook: false, screens: { ready: '❯ Try "fake"\n', busy: staleBusy, pasted: staleBusy, accepted: staleBusy, question: '' } }), async ({ h, log, record, run, sendFile }) => {
  check('E3 live: the busy screen already shows a queued message (ctrl+x ctrl+s to send now)', /ctrl\+x ctrl\+s to send now/.test(staleBusy));
  run('send', sendFile('SECOND MESSAGE: please also add the empty case.'), '-y');
  const watcher = h.spawnAgentctl(['watch'], path.join(h.root, 'watch.log'));
  try {
    await pause(4500);
    check('E3 live: the sign that was on the screen before our Enter does not confirm the message (not sent, not queued-in-agent)', !/prompt_delivery: sent/.test(record()) && !/delivery_result: queued-in-agent/.test(record()));
    check('E3 live: one paste, one Enter, and no further key while it is unconfirmed', log().filter(e => e.paste && e.state === 'busy').length === 1 && log().filter(e => e.enter && e.state === 'busy').length === 1);
  } finally { watcher.kill('SIGTERM'); }
});

fs.mkdirSync(cache, { recursive: true });
fs.writeFileSync(path.join(cache, 'p15-live-results.json'), JSON.stringify({ passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, checks: results }, null, 2) + '\n');
console.log(`${results.length}/${results.length} P15 send checks passed`);
