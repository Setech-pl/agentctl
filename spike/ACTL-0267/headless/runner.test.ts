import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeClaude, normalizeCodex, reduce, headlessArgv } from './runner.ts';

const F = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const stream = (n: string, norm: typeof normalizeClaude) => fs.readFileSync(path.join(F, n), 'utf8').split('\n').filter(Boolean).flatMap(norm);

test('claude success: verdict from the stream when no report file, usage and cost from result, retries counted', () => {
  const o = reduce(stream('claude-success.stream.jsonl', normalizeClaude), 0);
  assert.equal(o.state, 'report-ready');
  assert.equal(o.reportSource, 'stream');
  assert.equal(o.verdict, 'PASS');
  assert.equal(o.usage.cacheRead, 3000);
  assert.equal(o.usage.costUsd, 0.0412);
  assert.equal(o.retries, 1);
  assert.equal(o.sessionId, '22222222-3333-4444-8555-666666666666');
});

test('canonical report file wins over the stream; a half-written report does not count', () => {
  const ev = stream('claude-success.stream.jsonl', normalizeClaude);
  const full = reduce(ev, 0, { path: path.join(F, 'REPORT-complete.md'), attempt: 'a-1' });
  assert.equal(full.reportSource, 'file');
  assert.equal(full.verdict, 'PASS with findings');
  const wrongAttempt = reduce(ev, 0, { path: path.join(F, 'REPORT-complete.md'), attempt: 'b-2' });
  assert.equal(wrongAttempt.reportSource, 'stream');
  assert.equal(reduce(ev, 0, { path: path.join(F, 'REPORT-partial.md'), attempt: 'a-1' }).reportSource, 'stream');
});

test('claude failure modes: limit, permission denial under --permission-prompts none, crash without result', () => {
  assert.equal(reduce(stream('claude-limit.stream.jsonl', normalizeClaude), 1).state, 'limited');
  const denied = reduce(stream('claude-denied.stream.jsonl', normalizeClaude), 0);
  assert.equal(denied.state, 'needs-attention');
  assert.equal(denied.denials, 1);
  assert.equal(reduce(stream('claude-crash.stream.jsonl', normalizeClaude), null).state, 'dead');
});

test('codex exec: success maps usage incl. reasoning; turn.failed with limit text is limited', () => {
  const ok = reduce(stream('codex-success.stream.jsonl', normalizeCodex), 0);
  assert.equal(ok.state, 'turn-done');
  assert.equal(ok.usage.reasoning, 300);
  assert.equal(ok.lastMessage, 'Report written to the canonical path.');
  const bad = reduce(stream('codex-failed.stream.jsonl', normalizeCodex), 1);
  assert.equal(bad.state, 'limited');
  assert.equal(bad.retries, 1);
});

test('argv never carries the prompt', () => {
  const c = headlessArgv({ provider: 'claude', worktree: '/w', settingsFile: '/t/s.json', sessionId: 'x' });
  assert.ok(c.args.includes('stream-json') && c.args.includes('--settings'));
  const x = headlessArgv({ provider: 'codex', worktree: '/w', lastMessageFile: '/t/last.txt' });
  assert.deepEqual(x.args.slice(0, 2), ['exec', '--json']);
  assert.equal(x.args.at(-1), '-');
});
