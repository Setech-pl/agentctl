import assert from 'node:assert/strict';
import fs from 'node:fs';
import { it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { recordJournal, journalPath } from '../src/core/journal.ts';
import { collectEvents } from '../src/core/chat-events.ts';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import { secretRedactor } from '../src/core/secret-redaction.ts';
import { queueDir } from '../src/core/queue.ts';
import { setupProgressFile, writeSetupProgress } from '../src/core/setup-progress.ts';
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
