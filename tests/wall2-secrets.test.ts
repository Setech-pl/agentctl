import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { channelMessages, OWNER_IDENTITY, postMessage, secretFindings } from '../src/core/wall.ts';
import { DiskRunner, makeConfig, useScratch } from './helpers.ts';

/*
 * WALL-1-f2 (WALL-2 item 5): the WALL secret scan refused plain prose such as "Token: x" or "Key: the building height", because it used
 * the report redaction's rule (any word with TOKEN/KEY/PASSWORD followed by ":" and a value). Real secret shapes stay refused; a prose label
 * is refused only when its value looks like a credential. Only imports that WALL-1 had, so the scenario runs (and fails) against it.
 */
const scratch = useScratch();

function world(name: string) {
  const config = makeConfig(scratch.sub(name), 'notify: {ntfy: {topic: agentctl-topic, token: tk_ntfysecret123456}}\n');
  const ctx = new Context(new DiskRunner({ dryRun: false }), config, () => {});
  return { config, ctx };
}

const PROSE = [
  'Token: x',
  'Key: the building height in @neon-city/sim is 120 m',
  'Auth: OAuth through the hub, nothing changes for HEMS',
  'Password: ask the owner, never on the WALL',
  'Secret: none needed for the weather API v1',
  'API key: rotate monthly',
  'Cookie: SameSite=Lax stays',
  'Token budget: 2000 per call; key points below',
];

const SECRETS: Array<[string, RegExp]> = [
  ['TOKEN=abcdefgh12345678', /secret assignment/],
  ['export API_TOKEN: abcd1234efgh5678', /secret assignment/],
  ['{"token": "abc123def"}', /secret assignment/],
  ['token:abcdef1', /secret assignment/],
  ['PASSWORD: correcthorsebattery', /secret assignment/],
  ['Token: 9f8e7d6c5b4a3f2e1d0c9b8a', /credential-like value after a label/],
  ['Password: s3cr3tP4ssw0rd', /credential-like value after a label/],
  ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123', /bearer token/],
  ['see https://user:hunter22hunter@example.com/', /credentials in a URL/],
  ['key ghp_abcdefghijklmnopqrstuvwxyz0123456789', /GitHub token/],
  ['the phone token is tk_ntfysecret123456', /secret config or environment key/],
  ['ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic', /Z\.ai\/Anthropic credential assignment/],
];

describe('WALL-1-f2: the secret scan keeps real secrets out and lets prose through', () => {
  it('plain-prose labels ("Token: x", "Key: …") are posted', async () => {
    const w = world('prose');
    for (const body of PROSE) assert.deepEqual(secretFindings(w.config, { body }), [], body);
    const m = await postMessage(w.ctx, OWNER_IDENTITY, { channel: 'agentctl', kind: 'info', subject: 'Token: x', body: PROSE.join('\n') });
    assert.equal(m.subject, 'Token: x');
    assert.equal(channelMessages(w.config, 'agentctl').length, 1);
  });

  it('real secret shapes are still refused and nothing is stored; the finding never repeats the value', async () => {
    const w = world('secrets');
    for (const [body, why] of SECRETS) {
      const found = secretFindings(w.config, { body });
      assert.ok(found.some((f) => why.test(f)), `${body} → ${found.join('; ') || 'nothing'}`);
      assert.ok(found.every((f) => !f.includes('abcdefgh12345678') && !f.includes('tk_ntfysecret123456')), 'never the value');
      await assert.rejects(postMessage(w.ctx, OWNER_IDENTITY, { channel: 'agentctl', kind: 'info', subject: 'config', body }), /rejected by the secret scan, nothing was posted/, body);
    }
    assert.equal(channelMessages(w.config, 'agentctl').length, 0);
  });
});
