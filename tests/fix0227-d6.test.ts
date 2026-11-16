import assert from 'node:assert/strict';
import { it } from 'node:test';
import { z } from 'zod';
import { Context } from '../src/core/context.ts';
import { MCP_TOOLS, providerToolInput } from '../src/core/mcp-tools.ts';
import { channelMessages, findMessage, postMessage, OWNER_IDENTITY } from '../src/core/wall.ts';
import { awayReport } from '../src/core/away.ts';
import { DiskRunner, makeConfig, useScratch } from './helpers.ts';

const scratch = useScratch();
const token = (text: string) => /preview_token: (\S+)/.exec(text)![1]!;
const writes = MCP_TOOLS.filter(t => t.kind === 'write');
function world(name: string) {
  const config = makeConfig(scratch.sub(name), `providers: [claude, codex, kimi, glm]\nmcp: {allow: [${writes.map(t => t.name).join(', ')}]}\n`);
  const runner = new DiskRunner({dryRun: false});
  const ctx = new Context(runner, config, () => {});
  const deps = {context: () => ctx, notify: async () => {}, clientId: 'test-session'};
  const call = (name: string, args: Record<string, unknown>, session = deps) => {
    const tool = MCP_TOOLS.find(t => t.name === name)!;
    return tool.run(session, z.object(providerToolInput(tool, config)).parse(args));
  };
  return {config, runner, ctx, deps, call};
}

it('D6: every write accepts token-only at the registered schema and returns a confirmation refusal for an unknown token', async () => {
  const f = world('matrix');
  for (const tool of writes) {
    assert.ok(tool.input.preview_token, tool.name);
    for (const context of [{}, ...('as' in tool.input ? [{as: 'chat:nc'}] : [])]) {
      const result = await f.call(tool.name, {...context, confirm: true, preview_token: 'missing-token'});
      assert.equal(result.isError, true, tool.name);
      assert.match(result.text, /Confirmation refused:/, `${tool.name}: ${result.text}`);
      assert.doesNotMatch(result.text, /invalid_type|expected.*received|channel.*required/i, tool.name);
    }
  }
});

for (const name of ['wall_post', 'wall_reply', 'wall_set_status']) it(`D6: ${name} restores arguments with matching as; guards identity/session/TTL and replays once`, async () => {
  const f = world(name);
  const parent = await postMessage(f.ctx, OWNER_IDENTITY, {channel: 'nc', kind: 'question', subject: 'D6 parent', body: 'Question for the isolated test.'});
  const args = name === 'wall_post' ? {channel: 'nc', kind: 'info', subject: 'D6 post', body: 'Stored message body.'} : name === 'wall_reply' ? {reply_to: parent.id, body: 'Stored reply body.'} : {id: parent.id, status: 'superseded'};
  const preview = await f.call(name, {as: 'chat:nc', ...args});
  assert.equal(preview.isError, undefined, preview.text);
  const confirm = {as: 'chat:nc', preview_token: token(preview.text), confirm: true};
  assert.equal((await f.call(name, {...confirm, as: 'chat:hems'})).isError, true, 'a different author cannot use this preview');
  assert.equal((await f.call(name, confirm, {...f.deps})).isError, true, 'another session cannot use this preview');
  const before = channelMessages(f.config, 'nc').length;
  const done = await f.call(name, confirm);
  assert.equal(done.isError, undefined, done.text);
  assert.equal(channelMessages(f.config, 'nc').length, before + (name === 'wall_set_status' ? 0 : 1));
  assert.equal((await f.call(name, confirm)).isError, undefined, 'retry returns the receipt');
  assert.equal(channelMessages(f.config, 'nc').length, before + (name === 'wall_set_status' ? 0 : 1));
  assert.equal((await f.call(name, {...confirm, as: 'chat:hems'})).isError, true, 'receipt cannot be replayed as another author');
  if (name === 'wall_set_status') assert.equal(findMessage(f.config, parent.id).status, 'superseded');
  const fresh = await f.call(name, {as: 'chat:nc', ...args, ...(name === 'wall_set_status' ? {status: 'answered'} : {})});
  assert.equal(fresh.isError, undefined, fresh.text);
  await f.runner.sleep((f.config.preview.ttlS + 1) * 1000);
  const expired = await f.call(name, {as: 'chat:nc', preview_token: token(fresh.text), confirm: true});
  assert.equal(expired.isError, true);
  assert.match(expired.text, /TTL expired/);
});

it('D6: away also supports preview and token-only confirmation without a preview side effect', async () => {
  const f = world('away');
  const preview = await f.call('away', {on: true});
  assert.equal(preview.isError, undefined, preview.text);
  assert.equal(awayReport(f.config).on, false);
  const done = await f.call('away', {preview_token: token(preview.text), confirm: true});
  assert.equal(done.isError, undefined, done.text);
  assert.equal(awayReport(f.config).on, true);
});
