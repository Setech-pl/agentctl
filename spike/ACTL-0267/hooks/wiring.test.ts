import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeHooks, codexHookArgs, mayBypassTrust, hookEnv, CLAUDE_EVENTS } from './wiring.ts';

const self = ['/opt/homebrew/bin/node', '/x/agentctl.js'];

test('claude: every event is a command hook; task identity is not in the settings file', () => {
  const s = claudeHooks(self) as { hooks: Record<string, { hooks: { type: string; command: string }[] }[]> };
  assert.deepEqual(Object.keys(s.hooks), [...CLAUDE_EVENTS]);
  for (const g of Object.values(s.hooks)) assert.equal(g[0]!.hooks[0]!.type, 'command');
  assert.ok(!JSON.stringify(s).includes('AGENTCTL_TASK='));
});

test('codex: hook argv is byte-identical across tasks (one trust hash), task travels in env', () => {
  assert.deepEqual(codexHookArgs(self), codexHookArgs(self));
  assert.ok(codexHookArgs(self).every(a => a === '-c' || a.startsWith('hooks.')));
  assert.notDeepEqual(hookEnv('a'), hookEnv('b'));
});

test('codex: trust bypass only when no foreign hooks are configured', () => {
  assert.equal(mayBypassTrust([{ source: 'sessionFlags' }]), true);
  assert.equal(mayBypassTrust([{ source: 'sessionFlags' }, { source: 'project' }]), false);
});
