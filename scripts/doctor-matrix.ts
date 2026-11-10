import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { withHarness, defaultCacheRoot } from './live-harness.ts';

const cache = defaultCacheRoot();
const label = process.env.AGENTCTL_SMOKE_NODE;
assert.ok(label === 'node22' || label === 'node26', 'select one runtime');
const node = label === 'node22' ? process.env.AGENTCTL_NODE22! : process.env.AGENTCTL_NODE26!;
const prefix = path.join(cache, `live-smoke-${label}`, 'prefix');
// Harness may shorten long names to keep its socket below the OS limit.
import { Harness } from './live-harness.ts';
const installed = path.join(new Harness({ name: `smoke-${label}`, cacheRoot: cache }, path.resolve(import.meta.dirname, '..')).root, 'prefix/bin/agentctl');
assert.ok(fs.existsSync(installed), `run installed smoke first (${prefix})`);
const cases = [
  { name: 'default-required', code: 0 },
  { name: 'three-manual', code: 0 },
  { name: 'three-yolo-guarded', code: 0, mode: 'yolo' },
  { name: 'auto-refused', code: 1, mode: 'auto', match: /Never Ask/ },
  { name: 'toml-guard-disabled', code: 1, guard: false, match: /dangerous_command_guard=false/ },
  { name: 'env-guard-disabled', code: 1, env: { KIMI_CODE_DANGEROUS_COMMAND_GUARD: 'false' }, match: /forbidden/ },
  { name: 'env-trust-refused', code: 1, env: { KIMI_CODE_TRUST_WORKSPACE: '1' }, match: /trust must be manual/ },
  { name: 'malformed-toml', code: 1, toml: 'invalid = [', match: /invalid TOML/ },
  { name: 'malformed-yaml', code: 1, yaml: 'providers: [', match: /config/ },
  { name: 'guide-recovery', code: 0 },
];
const results: unknown[] = [];
for (const c of cases) {
  await withHarness({ name: `doctor-${label}-${c.name}`, cacheRoot: cache, config: c.name === 'default-required' ? '' : 'providers: [claude, codex, kimi]\n' }, h => {
    fs.unlinkSync(path.join(h.fakeBin, 'node')); fs.symlinkSync(node, path.join(h.fakeBin, 'node'));
    Object.assign(h.env, c.env);
    const toml = c.toml ?? `default_permission_mode = "${c.mode ?? 'manual'}"\n[permission]\ndangerous_command_guard = ${c.guard !== false}\n`;
    const config = path.join(h.env.KIMI_CODE_HOME!, 'config.toml'); fs.writeFileSync(config, toml);
    if (c.yaml) fs.writeFileSync(path.join(h.agentctlHome, 'config.yaml'), c.yaml);
    const run = () => { h.check(); return spawnSync(node, [installed, 'doctor'], { env: h.env, cwd: h.root, encoding: 'utf8', timeout: 240_000 }); };
    if (c.name === 'guide-recovery') fs.writeFileSync(path.join(h.root, '.agentctl.yaml'), 'guide: missing.md\n');
    const r = run();
    fs.writeFileSync(path.join(cache, `doctor-${label}-${c.name}.log`), r.stdout + r.stderr);
    assert.equal(r.status, c.code, `${c.name}: ${r.stdout}${r.stderr}`);
    if (c.match) assert.match(r.stdout + r.stderr, c.match);
    if (c.name === 'guide-recovery') {
      assert.match(r.stdout, /Project guide cannot be read:.*missing\.md/);
      fs.writeFileSync(path.join(h.root, 'missing.md'), 'Restored guide\n');
      const recovered = run(); assert.equal(recovered.status, 0); assert.doesNotMatch(recovered.stdout, /Project guide cannot be read/);
    }
    assert.equal(fs.readFileSync(config, 'utf8'), toml, 'doctor never edits Kimi config');
    assert.ok(h.agentStarts().every(l => /^(?:(?:claude|codex|kimi) --(?:version|help)|claude mcp get agentctl)$/.test(l)), 'doctor must not start inference');
    results.push({ name: c.name, expectedExit: c.code, actualExit: r.status, passed: true });
  });
}
fs.writeFileSync(path.join(cache, `doctor-${label}-results.json`), JSON.stringify({ node: process.version, passed: results.length, failed: 0, cases: results }, null, 2) + '\n');
console.log(`doctor ${label}: ${results.length}/10 passed`);
