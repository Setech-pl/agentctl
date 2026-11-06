import assert from 'node:assert/strict';
import fs from 'node:fs';
import { it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { recordJournal, journalPath } from '../src/core/journal.ts';
import { collectEvents } from '../src/core/chat-events.ts';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import { secretRedactor } from '../src/core/secret-redaction.ts';
import { queueDir, queueDiagnosticSources, readQueue, describeQueue, directStartText } from '../src/core/queue.ts';
import { setupProgressFile, writeSetupProgress, readSetupProgress } from '../src/core/setup-progress.ts';
import { DiskRunner, makeConfig, useScratch } from './helpers.ts';
const scratch = useScratch();
it('shared redaction masks quoted assignments, URL secrets and bare known output values', () => {
  const clean = secretRedactor([{ env: { NPM_TOKEN: 'sentinel-known' } }, "PASSWORD='sentinel with spaces'", 'https://sentinel-user:sentinel-pass@host/path?token=sentinel-query']);
  const result = clean({ command: "PASSWORD='sentinel with spaces' npm ci", output: 'sentinel-known sentinel with spaces sentinel-user sentinel-pass sentinel-query', url: 'https://alice:anotherpass@host/?api_key=anotherkey' });
  assert.ok(!JSON.stringify(result).includes('sentinel')); assert.ok(!result.url.includes('anotherpass')); assert.ok(!result.url.includes('anotherkey'));
});
it('persistence and MCP reads sanitize legacy raw setup objects and journal events', async () => {
  const config = makeConfig(scratch.sub('legacy'), 'capacity: {snapshot: false, codex_refresh: false}\n');
  const runner = new DiskRunner({ dryRun: false }); const ctx = new Context(runner, config, () => {});
  const command = 'NPM_TOKEN=legacy-sentinel npm ci';
  const progress = { task: 'T1', phase: 'setup' as const, command, startedAt: new Date().toISOString(), stepAt: new Date().toISOString() };
  await writeSetupProgress(ctx, 't1', progress);
  assert.ok(!fs.readFileSync(setupProgressFile(config, 't1'), 'utf8').includes('legacy-sentinel'));
  await recordJournal(ctx, { kind: 'setup-started', text: command });
  assert.ok(!fs.readFileSync(journalPath(config), 'utf8').includes('legacy-sentinel'));
  fs.writeFileSync(setupProgressFile(config, 't1'), JSON.stringify(progress));
  fs.appendFileSync(journalPath(config), JSON.stringify({ at: new Date().toISOString(), kind: 'setup-started', text: command }) + '\n');
  const events = await collectEvents(ctx, { client: 'mcp', since: '1h', keep: true });
  assert.ok(!JSON.stringify(events).includes('legacy-sentinel'));
  // queue_list must sanitize the setup object appended after queue entry redaction.
  fs.mkdirSync(queueDir(config), { recursive: true });
  fs.writeFileSync(`${queueDir(config)}/0001-t1.json`, JSON.stringify({ seq: 1, task: 'T1', order: 1, priority: 'normal', status: 'starting', queuedAt: new Date().toISOString(), agent: 'claude', model: 'sonnet', effort: 'high', after: [], spec: '---\ntask: T1\nagent: claude\n---\nWork' }));
  const tool = MCP_TOOLS.find(t => t.name === 'queue_list')!;
  const result = await tool.run({ context: () => ctx, notify: async () => {} }, {} as never);
  assert.ok(!result.text.includes('legacy-sentinel')); assert.ok(result.text.includes('NPM_TOKEN=***'));
});

it('R2 N1: legacy setup and queue diagnostics redact at read time for every view', () => {
  const config = makeConfig(scratch.sub('r2-n1'), 'env: {CONFIG_TOKEN: config-only-sentinel}\n');
  const now = new Date().toISOString();
  const progress = { task: 'LEGACY', phase: 'setup', command: 'NPM_TOKEN=legacy-command-sentinel npm ci; echo config-only-sentinel process-only-sentinel queue-only-sentinel', startedAt: now, stepAt: now };
  fs.mkdirSync(`${config.stateDir}/legacy`, { recursive: true });
  const file = setupProgressFile(config, 'legacy');
  fs.writeFileSync(file, JSON.stringify(progress));
  fs.mkdirSync(queueDir(config), { recursive: true });
  const entryFile = `${queueDir(config)}/0001-legacy.json`;
  const raw = { seq: 1, task: 'LEGACY', order: 1, priority: 'normal', status: 'starting', queuedAt: now, agent: 'claude', model: 'sonnet', effort: 'high', direct: true, after: [], spec: '---\ntask: LEGACY\nenv: {API_TOKEN: queue-only-sentinel}\n---\nWork' };
  fs.writeFileSync(entryFile, JSON.stringify(raw));
  const previous = process.env.R2_SECRET;
  process.env.R2_SECRET = 'process-only-sentinel';
  try {
    const entries = readQueue(config), entry = entries[0]!;
    const texts = [readSetupProgress(config, 'LEGACY', queueDiagnosticSources(entries)), directStartText(config, entry, Date.now()), describeQueue(config, entries, [])[0]!.condition.text];
    for (const value of texts) {
      assert.doesNotMatch(JSON.stringify(value), /legacy-command-sentinel|config-only-sentinel|process-only-sentinel|queue-only-sentinel/);
      assert.match(JSON.stringify(value), /NPM_TOKEN=\*\*\*/);
    }
    for (const status of ['failed', 'queued'] as const) {
      fs.writeFileSync(entryFile, JSON.stringify({ ...raw, status, retryAt: new Date(Date.now() + 60000).toISOString(), error: 'failed config-only-sentinel process-only-sentinel queue-only-sentinel NPM_TOKEN=legacy-command-sentinel\nsecond line' }));
      const failed = readQueue(config);
      const text = JSON.stringify([directStartText(config, failed[0]!, Date.now()), describeQueue(config, failed, [])[0]!.condition.text]);
      assert.doesNotMatch(text, /legacy-command-sentinel|config-only-sentinel|process-only-sentinel|queue-only-sentinel/);
    }
    assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(progress), 'read must not rewrite legacy data');
  } finally { if (previous === undefined) delete process.env.R2_SECRET; else process.env.R2_SECRET = previous; }
});
