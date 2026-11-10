import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { withHarness, defaultCacheRoot } from './live-harness.ts';
const cache = defaultCacheRoot();
const tarball = process.env.AGENTCTL_SMOKE_TARBALL;
const node22 = process.env.AGENTCTL_NODE22;
const node26 = process.env.AGENTCTL_NODE26;
if (!cache || !tarball || !node22 || !node26) throw new Error('Set AGENTCTL_LIVE_CACHE, AGENTCTL_SMOKE_TARBALL, AGENTCTL_NODE22 and AGENTCTL_NODE26');
const expectedVersion: string = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8')).version;
const results: unknown[] = [];
for (const [name, node, npm] of [
  ['node22', node22, path.resolve(node22, '../../lib/node_modules/npm/bin/npm-cli.js')],
  ['node26', node26, process.env.AGENTCTL_NPM26 ?? fs.realpathSync(path.join(path.dirname(node26), 'npm'))],
].filter(([name]) => !process.env.AGENTCTL_SMOKE_NODE || name === process.env.AGENTCTL_SMOKE_NODE)) {
  await withHarness({ name: `smoke-${name}`, cacheRoot: cache }, async (h) => {
    fs.unlinkSync(path.join(h.fakeBin, 'node')); fs.symlinkSync(node!, path.join(h.fakeBin, 'node'));
    h.check();
    const prefix = path.join(h.root, 'prefix');
    const installed = spawnSync(node!, [npm!, 'install', '-g', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '--cache', path.join(h.root, 'npm-cache'), tarball], { env: h.env, cwd: h.root, encoding: 'utf8', timeout: 120000 });
    fs.writeFileSync(path.join(cache, `smoke-${name}-install.log`), installed.stdout + installed.stderr);
    assert.equal(installed.status, 0, installed.stderr);
    const bin = path.join(prefix, 'bin', 'agentctl');
    const checks: { name: string; ok: boolean }[] = [];
    const run = (args: string[]) => { h.check(); return spawnSync(bin, args, { env: h.env, cwd: h.root, encoding: 'utf8', timeout: 120000 }); };
    const check = (name: string, ok: boolean) => { checks.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); assert.ok(ok, name); };
    const version = run(['version']); check(`version ${expectedVersion}`, version.status === 0 && version.stdout.trim() === expectedVersion);
    const vflag = run(['--version']); check('version alias', vflag.stdout === version.stdout);
    check('help', run(['--help']).stdout.includes('capacity'));
    const guide = run(['guide']); check('global packaged EN guide', guide.status === 0 && guide.stdout.startsWith('# Dispatcher guide\n'));
    const pl = run(['guide', '--lang', 'pl']); check('global packaged PL guide', pl.status === 0 && pl.stdout.startsWith('# Podręcznik agenta zlecającego'));
    const clip = run(['guide', '--clip']); check('guide clipboard', clip.status === 0 && /Copied the guide/.test(clip.stdout));
    const project = path.join(h.root, 'project'); fs.mkdirSync(project); fs.writeFileSync(path.join(project, '.agentctl.yaml'), 'guide: rules.md\n'); fs.writeFileSync(path.join(project, 'rules.md'), 'SMOKE-PROJECT-RULE\n');
    check('project overlay', run(['guide', '--project', project]).stdout.includes('SMOKE-PROJECT-RULE'));
    const capacity = run(['capacity', '--json']); const data = JSON.parse(capacity.stdout); check('global capacity JSON', capacity.status === 0 && data.providers.length === 2 && data.providers[0].estimate === null && !('tasks' in data));
    check('capacity clipboard', /Copied capacity/.test(run(['capacity', '--clip']).stdout));
    const dry = run(['mcp', 'install', '--desktop', '--config', path.join(h.root, 'desktop.json'), '--dry-run']); check('global MCP dry run', dry.status === 0 && !fs.existsSync(path.join(h.root, 'desktop.json')) && /Dry run/.test(dry.stdout));
    const doctor = run(['doctor']); check('doctor uses chosen Node', doctor.status === 0 && doctor.stdout.includes(spawnSync(node!, ['--version'], { encoding: 'utf8' }).stdout.trim().slice(1)));
    const starts = h.agentStarts(); check('no inference agent started', starts.every((l) => /^(?:codex app-server|(?:claude|codex) --(?:version|help)|claude mcp get agentctl)$/.test(l)));
    fs.writeFileSync(path.join(cache, `smoke-${name}.log`), `${version.stdout}${doctor.stdout}\n${JSON.stringify(checks, null, 2)}\n`);
    results.push({ node: name, version: spawnSync(node!, ['--version'], { encoding: 'utf8' }).stdout.trim(), passed: checks.length, failed: 0, checks, capacity: data, guideFirstLines: guide.stdout.split('\n').slice(0, 4) });
  });
}
fs.writeFileSync(path.join(cache, `smoke-results-${process.env.AGENTCTL_SMOKE_NODE ?? 'both'}.json`), JSON.stringify(results, null, 2) + '\n');
