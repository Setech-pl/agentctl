import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { withHarness } from './live-harness.ts';

const cache = process.env.AGENTCTL_LIVE_CACHE;
const prefix = process.env.AGENTCTL_SMOKE_PREFIX;
if (!cache || !prefix) throw new Error('Set AGENTCTL_LIVE_CACHE and AGENTCTL_SMOKE_PREFIX to isolated task directories');
const executable = path.join(prefix, 'bin', 'agentctl');
const results: { command: string[]; code: number | null; stdout: string; stderr: string }[] = [];
await withHarness({ name: 'npm-smoke', cacheRoot: cache }, h => {
  h.env.PATH = `${path.join(prefix, 'bin')}:${h.env.PATH}`;
  h.check();
  for (const args of [['--version'], ['--help'], ['doctor'], ['mcp', 'install', '--desktop', '--dry-run']]) {
    const r = spawnSync(executable, args, { env: h.env, cwd: h.root, encoding: 'utf8', timeout: 60_000 });
    results.push({ command: args, code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' });
  }
  assert.equal(fs.existsSync(path.join(h.home, 'Library/Application Support/Claude/claude_desktop_config.json')), false, 'dry run must not write Desktop config');
  assert.match(results[0]!.stdout, /0\.16\.0/);
  assert.match(results[2]!.stdout, /npm global/);
  assert.match(results[2]!.stdout, /points to this package/);
  assert.match(results[3]!.stdout, /dist\/bin\/agentctl\.js/);
  assert.doesNotMatch(results[3]!.stdout, /not the stable copy/);
});
fs.writeFileSync(path.join(cache, 'smoke-results.json'), JSON.stringify(results, null, 2) + '\n');
for (const result of results) assert.equal(result.code, 0, JSON.stringify(result));
console.log(`${results.length}/${results.length} npm runtime smoke checks passed; doctor and Desktop dry run used harness fakes only`);
