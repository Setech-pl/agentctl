import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

test('REL0244-KIMI-HOLD: the trust admission uses a fresh fixture home after quota', () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR!, 'kimi-gate-'));
  fs.copyFileSync(new URL('../scripts/live-kimi.ts', import.meta.url), path.join(root, 'live-kimi.ts'));
  // Run the real gate entry point, substituting only the harness. The first callback's quota
  // outcome is seeded directly so the regression has no pane polling or wall-clock waits.
  fs.writeFileSync(path.join(root, 'live-harness.ts'), `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
export const defaultCacheRoot = () => import.meta.dirname;
export const installPromptAgent = (_h, agent, mode) => {
  assert.equal(agent, 'kimi');
  assert.equal(mode, 'trust');
};
let quotaHome;
export async function withHarness({ name }, run) {
  const root = path.join(defaultCacheRoot(), name);
  const agentctlHome = path.join(root, 'agentctl-home');
  const kimiHome = path.join(root, 'kimi-home');
  fs.mkdirSync(agentctlHome, { recursive: true });
  fs.mkdirSync(kimiHome);
  if (!quotaHome) {
    quotaHome = agentctlHome;
    fs.writeFileSync(path.join(quotaHome, 'provider-holds.json'), JSON.stringify({
      holds: { kimi: { until: '2099-01-01T00:00:00Z', source: 'automatic', scope: 'global' } }, seen: {},
    }));
    return;
  }
  assert.notEqual(agentctlHome, quotaHome);
  assert.ok(fs.existsSync(path.join(quotaHome, 'provider-holds.json')));
  await run({ root, agentctlHome, env: { ...process.env, AGENTCTL_HOME: agentctlHome, KIMI_CODE_HOME: kimiHome,
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Fixture',
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'fixture@example.invalid' },
    agentctl(_args, { input }) {
      assert.ok(!fs.existsSync(path.join(agentctlHome, 'provider-holds.json')));
      const stderr = input.includes('task: KI-TRUST') ? 'waiting for folder trust' : 'trust env forbidden';
      return { code: 1, stdout: '', stderr };
    },
  });
}
`);
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', path.join(root, 'live-kimi.ts')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS trust is never answered automatically/);
  assert.match(result.stderr, /KI-TRUST: admission exited 1\nwaiting for folder trust/);
});
