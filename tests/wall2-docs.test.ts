import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import YAML from 'yaml';
import { dispatcherGuide } from '../src/core/guide.ts';
import { Problems } from '../src/core/util.ts';
import { defaultWallSettings, parseWall } from '../src/core/wall-config.ts';

/* WALL-2 item 6: the owner's chats are the documented default, the README example is that config, and the guide names the agentctl channel. */
const readme = (name: string): string => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

describe('WALL-2: default chats, README example and guide', () => {
  it('the built-in chats are nc, hems and agentctl with their channels', () => {
    const chats = defaultWallSettings().chats;
    assert.deepEqual(Object.fromEntries(Object.entries(chats).map(([n, c]) => [n, c.channels])), { nc: ['nc', 'agentctl', 'shared:*'], hems: ['hems', 'agentctl', 'shared:*'], agentctl: ['agentctl', 'shared:*'] });
  });

  for (const name of ['docs/en/configuration.md', 'docs/pl/configuration.md']) {
    it(`${name}: the owner's config example parses and equals the default chats, with mcp.allow: [wall]`, () => {
      const block = /~~~yaml\n(mcp:\n {2}allow: \[wall\][\s\S]*?)~~~/.exec(readme(name))?.[1];
      assert.ok(block, 'the example is in the WALL section');
      const parsed = YAML.parse(block) as { mcp: { allow: string[] }; wall: unknown };
      assert.deepEqual(parsed.mcp.allow, ['wall']);
      const p = new Problems();
      const wall = parseWall(parsed.wall, p);
      assert.deepEqual(p.items, []);
      assert.deepEqual(Object.fromEntries(Object.entries(wall.chats).map(([n, c]) => [n, c.channels])), Object.fromEntries(Object.entries(defaultWallSettings().chats).map(([n, c]) => [n, c.channels])));
    });
  }

  it('the guide (en, pl) mentions the WALL, the owner\'s chats and the shared agentctl channel', () => {
    for (const lang of ['en', 'pl'] as const) {
      const g = dispatcherGuide(lang);
      assert.match(g, /## WALL/);
      assert.match(g, /chat:nc[\s\S]*chat:hems[\s\S]*chat:agentctl/);
      assert.match(g, lang === 'en' ? /The `agentctl` channel is shared by every chat and agent/ : /Kanał `agentctl` jest wspólny dla wszystkich czatów i agentów/);
      assert.match(g, /wall_posts/);
      assert.match(g, /wall: \[nc, "shared:\*"\]/);
    }
  });
});
