import assert from 'node:assert/strict';
import fs from 'node:fs';
import { it } from 'node:test';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import { readTaskRecord } from '../src/core/taskstore.ts';
import { runCli } from './helpers.ts';
import { world, now } from './ux0228-fixture.ts';
const tool = (name: string) => MCP_TOOLS.find(t => t.name === name)!;
it('UX0228: MCP pulled cohort close previews only read reports, confirms exact scope and refuses removal', async () => {
  const w = world('mcp'); w.add('READ', 3); w.add('NEW', null); w.add('OTHER', 3, 'other');
  const close = tool('close');
  const preview = await close.run(w.deps, { cohort: 'wave', pulled: true });
  assert.ok(!preview.isError, preview.text);
  assert.match(preview.text, /READ/); assert.doesNotMatch(preview.text, /NEW|OTHER/);
  assert.equal(readTaskRecord(w.config, 'read')?.closed, undefined);
  const token = /preview_token: (\S+)/.exec(preview.text)![1];
  const done = await close.run(w.deps, { confirm: true, preview_token: token });
  assert.ok(!done.isError, done.text);
  assert.equal(readTaskRecord(w.config, 'read')?.closed, true);
  assert.equal(readTaskRecord(w.config, 'new')?.closed, undefined);
  const refused = await close.run(w.deps, { cohort: 'wave', pulled: true, remove_worktree: true });
  assert.ok(refused.isError, refused.text);
  assert.ok((await close.run(w.deps, { pulled: true })).isError);
  w.add('NEXT', 3);
  const next = await close.run(w.deps, { cohort: 'wave', pulled: true });
  const nextToken = /preview_token: (\S+)/.exec(next.text)![1];
  const record = readTaskRecord(w.config, 'next')!;
  fs.utimesSync(record.report, now / 1000, now / 1000);
  assert.ok((await close.run(w.deps, { confirm: true, preview_token: nextToken })).isError);
  assert.equal(readTaskRecord(w.config, 'next')?.closed, undefined);
});
it('UX0228: CLI pulled close previews, confirms and rejects worktree removal', async () => {
  const w = world('cli'); w.add('READ', 3); w.add('NEW', null);
  const preview = await runCli(w.config, w.runner, ['close', '--cohort', 'wave', '--pulled'], { confirm: async () => false });
  assert.equal(preview.code, 0, preview.stderr);
  assert.match(preview.stdout, /READ/); assert.doesNotMatch(preview.stdout, /NEW/);
  assert.equal(readTaskRecord(w.config, 'read')?.closed, undefined);
  const done = await runCli(w.config, w.runner, ['close', '--cohort', 'wave', '--pulled', '--yes']);
  assert.equal(done.code, 0, done.stderr);
  assert.equal(readTaskRecord(w.config, 'read')?.closed, true);
  const refused = await runCli(w.config, w.runner, ['close', '--cohort', 'wave', '--pulled', '--rm-worktree', '--yes']);
  assert.equal(refused.code, 1);
});
it('UX0228: pulled cohort preview never reads unrelated report bodies', async () => {
  const w = world('bounded-pulled'); w.add('READ', 3); w.add('NEW', null);
  const other = w.add('OTHER', 3, 'other');
  const read = fs.readFileSync;
  let unrelatedReads = 0;
  fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (String(file) === other.report) unrelatedReads++;
    return (read as Function)(file, ...args);
  }) as typeof read;
  try {
    const preview = await tool('close').run(w.deps, {cohort: 'wave', pulled: true});
    assert.ok(!preview.isError, preview.text);
    assert.match(preview.text, /preview_token:/);
    assert.match(preview.text, /READ/);
    assert.doesNotMatch(preview.text, /NEW|OTHER/);
    assert.equal(unrelatedReads, 0, 'only selected-cohort reports may be inspected');
  } finally { fs.readFileSync = read; }
});
it('UX0228: CLI refuses a changed pulled scope after confirmation', async () => {
  const w = world('cli-scope'); const read = w.add('READ', 3); w.add('NEW', null);
  const result = await runCli(w.config, w.runner, ['close', '--cohort', 'wave', '--pulled'], {
    confirm: async () => { fs.utimesSync(read.report, now / 1000, now / 1000); return true; },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /scope changed/);
  assert.equal(readTaskRecord(w.config, 'read')?.closed, undefined);
  assert.equal(readTaskRecord(w.config, 'new')?.closed, undefined);
});
