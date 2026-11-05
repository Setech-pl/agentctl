import assert from 'node:assert/strict';
import { it } from 'node:test';
import { activeProviders, alternatives, isActive, perProvider, provider, PROVIDER_IDS } from '../src/core/providers/registry.ts';
import { DEFAULT_AGENT_SETTINGS } from '../src/core/config.ts';
import { makeConfig, useScratch } from './helpers.ts';
const scratch = useScratch();
it('registers the original providers and returns isolated default settings', () => {
  assert.deepEqual(PROVIDER_IDS, ['claude', 'codex', 'kimi']);
  for (const id of ['claude', 'codex'] as const) {
    const settings = provider(id).defaultSettings();
    assert.deepEqual(settings, DEFAULT_AGENT_SETTINGS[id]);
    settings.flags.push('--local');
    assert.deepEqual(provider(id).defaultSettings().flags, []);
  }
});
it('preserves configured provider order and maps alternatives and values', () => {
  const config = makeConfig(scratch.sub('order'), 'providers: [codex, claude]\n');
  assert.deepEqual(activeProviders(config), ['codex', 'claude']);
  assert.deepEqual(alternatives(config, 'claude'), ['codex']);
  assert.equal(isActive(config, 'codex'), true);
  assert.equal(isActive(config, 'other'), false);
  assert.deepEqual(perProvider(activeProviders(config), id => provider(id).letter), { codex: 'X', claude: 'C' });
});
it('defaults to both providers and rejects unknown, duplicate and incomplete provider lists', () => {
  assert.deepEqual(makeConfig(scratch.sub('default')).providers, ['claude', 'codex']);
  for (const [i, value] of ['[claude]', '[codex]', '[claude, codex, claude]', '[claude, unknown]', 'claude'].entries()) {
    assert.throws(() => makeConfig(scratch.sub(`bad-${i}`), `providers: ${value}\n`), /config.providers/);
  }
});

it('keeps Kimi registered but inactive in the default configuration', () => {
  const config = makeConfig(scratch.sub('active-default'));
  assert.deepEqual(activeProviders(config), ['claude', 'codex']);
  assert.equal(isActive(config, 'kimi'), false);
  assert.equal(provider('kimi').id, 'kimi');
});
