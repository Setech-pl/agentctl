import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { liveCacheRoot } from './live-cache.ts';
import { cleanLiveCache, humanSize } from './gate-clean.ts';
import { checkRuntime, homebrewNode26, node22Path, runtimesDir } from './runtime.ts';

import { acquireLock } from './gate-lock.ts';
export { acquireLock } from './gate-lock.ts';

export type Tier = 'quick' | 'full' | 'release';
export interface Options { tier: Tier; base?: string; dryRun: boolean; allowDirty: boolean; skipLive: boolean; node26Only?: boolean }
export function parseArgs(args: string[]): Options {
  const tier = args.shift();
  if (!['quick', 'full', 'release'].includes(tier ?? '')) throw new Error('Usage: npm run gate -- <quick|full|release> [--base ref] [--dry-run] [--allow-dirty] [--skip-live] [--node26-only]');
  const opts: Options = { tier: tier as Tier, dryRun: false, allowDirty: false, skipLive: false };
  while (args.length) {
    const arg = args.shift();
    if (arg === '--base') { opts.base = args.shift(); if (!opts.base || opts.base.startsWith('-')) throw new Error('--base needs a ref'); }
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--allow-dirty') opts.allowDirty = true;
    else if (arg === '--skip-live') opts.skipLive = true;
    else if (arg === '--node26-only') opts.node26Only = true;
    else throw new Error(`Unknown gate option: ${arg}`);
  }
  if (opts.node26Only && tier !== 'full') throw new Error('--node26-only belongs to full');
  return opts;
}
export function assertClean(opts: Options, dirty: boolean): void {
  if (opts.tier !== 'quick' && dirty && !opts.allowDirty) throw new Error(`${opts.tier} refuses a dirty tree; use --allow-dirty to record the exception`);
}
export function planTier(tier: Tier, tests: string[], live: string[], skipLive = false, node26Only = false): string[] {
  if (tier === 'quick') return ['typecheck', 'build', 'git diff --check', `tests current: ${tests.join(' ') || '(none)'}`];
  if (tier === 'full') return [...(node26Only ? [] : ['tests Node 22.14.0 (full)']), 'tests Node 26 (full)'];
  return ['build', 'pack', 'installed-tarball smoke Node 22.14.0', 'doctor 10-case matrix Node 22.14.0', 'installed-tarball smoke Node 26', 'doctor 10-case matrix Node 26', ...(skipLive ? ['SKIP live entries'] : live)];
}
/** Static relative import closure plus exact test naming. Unknown inputs always widen to the full suite. */
export function affectedTests(changed: string[], sources: Record<string, string>, tests: string[]): { tests: string[]; uncertain: boolean } {
  const all = () => ({ tests, uncertain: true });
  if (!changed.length) return { tests: [], uncertain: false };
  if (changed.some(f => !f.startsWith('src/') && !tests.includes(f))) return all();
  const deps = (file: string): string[] => [...(sources[file] ?? '').matchAll(/(?:from\s*|import\s*\(|import\s*)['"]([^'"]+)['"]/g)]
    .map(m => m[1]!).filter(s => s.startsWith('.')).map(s => path.posix.normalize(path.posix.join(path.posix.dirname(file), s)).replace(/\.js$/, '.ts'));
  const reaches = (file: string, target: string, seen = new Set<string>()): boolean => {
    if (file === target) return true;
    if (seen.has(file)) return false;
    seen.add(file);
    return deps(file).some(dep => reaches(dep, target, seen));
  };
  const selected = new Set<string>();
  for (const file of changed) {
    if (!(file in sources)) return all();
    // Nonliteral imports cannot establish a safe impact boundary.
    if (Object.values(sources).some(s => /import\s*\(\s*[^'"\s]/.test(s))) return all();
    const stem = path.posix.basename(file, '.ts');
    const matches = tests.filter(t => reaches(t, file) || path.posix.basename(t) === `${stem}.test.ts`);
    if (!matches.length) return all();
    matches.forEach(t => selected.add(t));
  }
  return { tests: [...selected].sort(), uncertain: false };
}
export function heavyCommand(command: string, args: string[], platform = process.platform): [string, string[]] {
  return ['nice', ['-n', '10', ...(platform === 'darwin' ? ['taskpolicy', '-b'] : []), command, ...args]];
}
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? filesUnder(`${dir}/${e.name}`) : [`${dir}/${e.name}`]);
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  // P54: the only cleanup agents are allowed to run; it is not a tier and records no gate result.
  if (args[0] === 'clean') {
    if (args.length > 1) throw new Error('Usage: npm run gate -- clean');
    const cache = liveCacheRoot();
    const summary = cleanLiveCache(cache);
    for (const socket of summary.stoppedServers) console.log(`gate clean: stopped leftover sandbox tmux server ${socket}`);
    console.log(`gate clean: removed ${summary.removed.length ? summary.removed.join(', ') : '(nothing)'}; kept ${summary.kept.length ? summary.kept.join(', ') : '(nothing)'}`);
    console.log(`gate clean: before ${humanSize(summary.before)} after ${humanSize(summary.after)} (${cache})`);
    return;
  }
  const opts = parseArgs([...args]);
  const cache = liveCacheRoot(); // P29 refusal before any writes or runtime provisioning.
  const sha = git('rev-parse', 'HEAD');
  const dirty = Boolean(git('status', '--porcelain'));
  const tests = filesUnder('tests').filter(f => f.endsWith('.test.ts')).sort();
  const live = filesUnder('scripts').filter(f => /\/live-.*\.ts$/.test(f)).sort();
  const base = opts.base ? git('rev-parse', '--verify', opts.base) : git('merge-base', 'HEAD', 'agentctl-0181-rc1');
  const changed = [...new Set([...git('diff', '--name-only', base, '--').split('\n'), ...git('ls-files', '--others', '--exclude-standard').split('\n')].filter(Boolean))];
  const sources = Object.fromEntries([...filesUnder('src'), ...filesUnder('tests')].filter(f => f.endsWith('.ts')).map(f => [f, fs.readFileSync(f, 'utf8')]));
  const affected = affectedTests(changed, sources, tests);
  const plan = planTier(opts.tier, affected.tests, live, opts.skipLive, opts.node26Only);
  const result: any = { sha, dirty, allowDirty: opts.allowDirty, tier: opts.tier, node26Only: Boolean(opts.node26Only), base, dryRun: opts.dryRun, uncertainMapping: affected.uncertain, plan, nodeVersions: {}, counts: { pass: 0, fail: 0, skip: 0 }, retriedFiles: [], steps: [], status: 'FAIL', durationMs: 0 };
  const started = Date.now();
  const runId = `${started}-${process.pid}`;
  result.runId = runId;
  const output = path.join(cache, 'gate-results', sha, `${opts.tier}.json`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const work = path.join(cache, `gate-work-${process.pid}`);
  let release: (() => void) | undefined;
  let interrupted = false;
  let stopChild: (() => void) | undefined;
  const interrupt = () => { interrupted = true; stopChild?.(); };
  process.on('SIGTERM', interrupt); process.on('SIGINT', interrupt);
  const env: NodeJS.ProcessEnv & { TMPDIR: string; AGENTCTL_TEST_TMP: string } = { ...process.env, TMPDIR: path.join(work, 'tmp'), AGENTCTL_TEST_TMP: path.join(work, 'tests'), npm_config_cache: path.join(work, 'npm-cache'), NODE_COMPILE_CACHE: path.join(work, 'compile-cache'), XDG_CACHE_HOME: path.join(work, 'cache') };
  for (const key of ['AGENTCTL_REAL_CODEX', 'AGENTCTL_REAL_CLAUDE', 'AGENTCTL_REAL_KIMI', 'AGENTCTL_BASELINE_ROOT']) delete env[key as keyof typeof env];
  async function run(name: string, command: string, argv: string[], extra: NodeJS.ProcessEnv = {}, required = true): Promise<{ code: number; text: string }> {
    const log = path.join(path.dirname(output), `${opts.tier}-${runId}-${result.steps.length}-${name.replace(/[^a-z0-9-]/gi, '-')}.log`);
    const [cmd, wrapped] = heavyCommand(command, argv);
    console.log(`gate: ${name}`);
    const stepStart = Date.now();
    const stream = fs.createWriteStream(log);
    let text = '';
    if (interrupted) throw new Error('Gate interrupted');
    const child = spawn(cmd, wrapped, { env: { ...env, ...extra }, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    stopChild = () => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    };
    const code = await new Promise<number>((resolve, reject) => {
      child.stdout.on('data', b => { text += b; stream.write(b); });
      child.stderr.on('data', b => { text += b; stream.write(b); });
      child.once('error', reject); child.once('close', c => resolve(c ?? 1));
    }).finally(() => { stopChild = undefined; stream.end(); });
    if (interrupted) throw new Error('Gate interrupted');
    result.steps.push({ name, command: [cmd, ...wrapped], code, log, durationMs: Date.now() - stepStart });
    if (required && code !== 0) { result.counts.fail++; throw new Error(`${name} failed (${code}); see ${log}`); }
    return { code, text };
  }
  async function testSuite(node: string, label: string, selected: string[]): Promise<void> {
    if (!selected.length) return;
    const invoke = (files: string[], suffix: string) => run(`tests-${label}${suffix}`, node, ['--experimental-strip-types', '--no-warnings', '--import', './tests/isolation.ts', '--test', '--test-concurrency=2', '--test-reporter=./scripts/gate-reporter.ts', ...files], {}, false);
    const first = await invoke(selected, '');
    const events = (text: string) => text.split('\n').filter(l => l.startsWith('GATE_EVENT ')).map(l => JSON.parse(l.slice(11)));
    const parsed = events(first.text);
    result.steps.at(-1).testEvents = parsed;
    const summary = parsed.filter(e => e.type === 'test:summary' && !e.data.file).at(-1)?.data;
    if (!summary) throw new Error(`Missing Node test summary: ${label}`);
    result.counts.pass += summary.counts.passed;
    result.counts.fail += summary.counts.failed;
    result.counts.skip += summary.counts.skipped;
    const failed = [...new Set<string>(parsed.filter(e => e.type === 'test:fail').map(e => e.data.file).filter(Boolean).map(f => path.relative(process.cwd(), f)))];
    let retryFailed = false;
    for (const file of failed) {
      result.retriedFiles.push({ node: label, file });
      const retry = await invoke([file], '-retry');
      result.retriedFiles.at(-1).code = retry.code;
      result.steps.at(-1).testEvents = events(retry.text);
      retryFailed ||= retry.code !== 0;
    }
    // Initial failures remain visible in counts; a successful retry is explicitly recorded.
    if (first.code !== 0 && (!failed.length || retryFailed)) throw new Error(`Tests failed on ${label}`);
  }
  try {
    assertClean(opts, dirty);
    if (opts.dryRun) { result.status = 'PASS'; console.log(JSON.stringify({ ...result, runtimes: [node22Path(), 'Homebrew Node 26'], loadPolicy: 'nice -n 10; macOS taskpolicy -b; no load waiting', lock: path.join(runtimesDir(), '.gate.lock') }, null, 2)); result.status = 'PASS'; return; }
    fs.mkdirSync(env.TMPDIR, { recursive: true }); fs.mkdirSync(env.AGENTCTL_TEST_TMP, { recursive: true });
    if (opts.tier !== 'quick') release = await acquireLock(path.join(runtimesDir(), '.gate.lock'), undefined, async () => {
      if (interrupted) throw new Error('Gate interrupted while waiting for lock');
      await new Promise<void>(r => setTimeout(r, 1000));
    });
    if (opts.tier === 'quick') {
      result.nodeVersions.current = checkRuntime(process.execPath, `${process.versions.node}`);
      await run('typecheck', process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit']);
      await run('build', process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json', '--outDir', path.join(work, 'dist')]);
      await run('finish-build', process.execPath, ['scripts/finish-build.js', path.join(work, 'dist')]);
      await run('diff-check', 'git', ['diff', '--check']);
      await testSuite(process.execPath, 'current', affected.tests);
    } else {
      if (!opts.node26Only) await run('runtime-node22', process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/runtime.ts', work]);
      const node22 = node22Path(), node26 = homebrewNode26();
      result.nodeVersions = { ...(!opts.node26Only ? { node22: checkRuntime(node22, '22.14.0') } : {}), node26: checkRuntime(node26, '26.') };
      if (opts.tier === 'full') { if (!opts.node26Only) await testSuite(node22, 'node22', tests); await testSuite(node26, 'node26', tests); }
      else {
        await run('build', node26, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json', '--outDir', path.join(work, 'dist')]);
        await run('finish-build', node26, ['scripts/finish-build.js', path.join(work, 'dist')]);
        const npm = fs.realpathSync(path.join(path.dirname(node26), 'npm'));
        const staging = path.join(work, 'package');
        fs.mkdirSync(staging);
        const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
        for (const file of ['package.json', ...pkg.files]) {
          const source = file === 'dist' ? path.join(work, 'dist') : file;
          fs.cpSync(source, path.join(staging, file), { recursive: true });
        }
        const packed = await run('pack', node26, [npm, 'pack', staging, '--ignore-scripts', '--json', '--pack-destination', work]);
        const tarball = path.join(work, JSON.parse(packed.text)[0].filename);
        for (const [label, node] of [['node22', node22], ['node26', node26]]) {
          const runtimeEnv = { AGENTCTL_SMOKE_NODE: label, AGENTCTL_SMOKE_TARBALL: tarball, AGENTCTL_NODE22: node22, AGENTCTL_NODE26: node26, AGENTCTL_NPM26: npm, PATH: `${path.dirname(node)}:${env.PATH}` };
          await run(`smoke-${label}`, node!, ['--experimental-strip-types', '--no-warnings', 'scripts/smoke-package.ts'], runtimeEnv);
          result.counts.pass += 12;
          await run(`doctor-${label}`, node!, ['--experimental-strip-types', '--no-warnings', 'scripts/doctor-matrix.ts'], runtimeEnv);
          result.counts.pass += 10;
        }
        if (opts.skipLive) result.counts.skip += live.length;
        else for (const file of live) await run(file, node26, ['--experimental-strip-types', '--no-warnings', file]);
      }
    }
    result.status = 'PASS';
  } catch (error) { result.error = String(error); throw error; }
  finally {
    process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt);
    release?.(); fs.rmSync(work, { recursive: true, force: true });
    result.durationMs = Date.now() - started;
    const json = JSON.stringify(result, null, 2) + '\n';
    fs.writeFileSync(output, json);
    fs.writeFileSync(path.join(path.dirname(output), `${opts.tier}-${runId}.json`), json);
    console.log(`gate ${opts.tier} ${result.status} sha=${sha} dirty=${dirty} dryRun=${opts.dryRun} pass=${result.counts.pass} fail=${result.counts.fail} skip=${result.counts.skip} duration=${result.durationMs}ms result=${output}`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(String(error)); process.exitCode = 1; });
