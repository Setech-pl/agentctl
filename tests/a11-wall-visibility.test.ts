import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { recordJournal } from '../src/core/journal.ts';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import { postMessage, wallIdentity } from '../src/core/wall.ts';
import { DiskRunner, FakeTmux, makeConfig, useScratch } from './helpers.ts';
const scratch = useScratch();
it('A11: unknown chat warning and own post markers on every readable channel and thread', async () => {
 const config = makeConfig(scratch.sub('a11'), 'wall:\n  channels:\n    nc: {authors: ["*"]}\n    shared:maps: {authors: ["*"]}\n  chats:\n    nc: {channels: [nc, agentctl, "shared:*"]}\n');
 const ctx = new Context(new DiskRunner({dryRun: false, respond: new FakeTmux().respond}), config, () => {});
 const deps = {context: () => ctx, notify: async () => {}, clientId: 'unmapped'};
 const call = (name: string, args = {}) => MCP_TOOLS.find(t => t.name === name)!.run(deps, args);
 for (const name of ['events_since', 'wall_read']) assert.match((await call(name)).text, /unknown chat – only channel agentctl visible; pass as: "chat:<name>"/);
 const who = wallIdentity(config, {as: 'chat:nc'});
 for (const channel of ['nc', 'agentctl', 'shared:maps']) {
  const m = await postMessage(ctx, who, {channel, kind: 'question', subject: 'mine', body: 'data'});
  assert.match((await call('wall_read', {as: 'chat:nc', channel})).text, /\(yours\)/);
  assert.match((await call('wall_read', {as: 'chat:nc', id: m.id})).text, /\(yours\)/);
 }
 assert.match((await call('events_since', {as: 'chat:nc'})).text, /\(yours\)/);
 await recordJournal(ctx, {kind: 'limits-changed', text: 'ordinary limits'});
 assert.doesNotMatch((await call('events_since')).text, /\(yours\)/, 'unknown identity never labels ordinary events as own posts');
});
