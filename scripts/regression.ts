import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { liveCacheRoot } from './live-cache.ts';
import { BUGS, NOT_BUGS } from '../tests/regression/catalog.ts';
import type { BugEntry, Scenario } from '../tests/regression/catalog.ts';

/*
 * `npm run regression` — every known fixed bug has a deterministic scenario (tests/regression/catalog.ts).
 *   (no flag)                  run all scenarios; any failure, or a scenario that ran no test, fails the run
 *   --catalog                  write tests/regression/CATALOG.md from the catalog and prefix-proof.json
 *   --against REV [--ids a,b]  run the scenarios of the current tests against src/ of REV (the version before the fix)
 *                              and record whether they fail there (tests/regression/prefix-proof.json)
 */
export const CATALOG_FILE = 'tests/regression/CATALOG.md';
export const PROOF_FILE = 'tests/regression/prefix-proof.json';
/** Release that precedes each fixed-in version: the "before the fix" side of the proof. */
export const PREVIOUS_RELEASE: Record<string, string> = { '0.19.5': 'v0.19.4', '0.19.4': 'v0.19.3', '0.19.3': 'v0.19.2', '0.19.2': 'v0.19.1', '0.19.1': 'v0.19.0', '0.19.0': 'v0.18.2', '0.18.3': 'v0.18.2', '0.18.2': 'v0.17.3' };

export interface ProofRecord { rev: string; outcome: 'FAILS' | 'IMPORT-ERROR' | 'PASSES' | 'NO-TESTS'; failed: number; passed: number; failing: string[] }
export type Proof = Record<string, ProofRecord>;
export interface RunResult { scenario: Scenario; code: number; pass: number; fail: number; skipped: number; text: string }

const root = path.resolve(import.meta.dirname, '..');
const testsDir = (base: string) => path.join(base, 'tests');

/** One node process per file in a normal run: names of that file are joined; a scenario without a name selects the whole file. */
export function groupScenarios(entries: BugEntry[]): Scenario[] {
  const byFile = new Map<string, Set<string> | 'all'>();
  for (const sc of entries.flatMap(e => e.scenarios)) {
    const have = byFile.get(sc.file);
    if (have === 'all') continue;
    if (!sc.name) byFile.set(sc.file, 'all');
    else byFile.set(sc.file, new Set([...(have ?? []), sc.name]));
  }
  return [...byFile].map(([file, names]) => names === 'all' ? { file } : { file, name: [...names].map(n => `(?:${n})`).join('|') });
}
export function parseSummary(text: string): { pass: number; fail: number; skipped: number } {
  const n = (label: string) => Number(new RegExp(`^ℹ ${label} (\\d+)`, 'm').exec(text)?.[1] ?? 0);
  return { pass: n('pass'), fail: n('fail'), skipped: n('skipped') };
}
const IMPORT_ERROR = /ERR_MODULE_NOT_FOUND|Cannot find module|does not provide an export|ERR_UNKNOWN_FILE_EXTENSION|SyntaxError/;
export function classify(results: RunResult[], rev: string): ProofRecord {
  const pass = results.reduce((n, r) => n + r.pass, 0), fail = results.reduce((n, r) => n + r.fail, 0);
  const failing = results.flatMap(r => [...r.text.matchAll(/^\s*✖ (.+?) \(\d/gm)].map(m => m[1]!)).slice(0, 5);
  const crashed = results.some(r => r.code !== 0 && IMPORT_ERROR.test(r.text));
  const outcome = crashed && !results.some(r => r.fail > 1 && !IMPORT_ERROR.test(r.text)) ? 'IMPORT-ERROR' : fail > 0 ? 'FAILS' : pass > 0 ? 'PASSES' : 'NO-TESTS';
  return { rev, outcome, failed: fail, passed: pass, failing };
}

function run(cwd: string, scenario: Scenario, env: NodeJS.ProcessEnv): Promise<RunResult> {
  const args = ['--experimental-strip-types', '--no-warnings', '--import', './tests/isolation.ts', '--test', '--test-reporter=spec'];
  if (scenario.name) args.push(`--test-name-pattern=${scenario.name}`);
  args.push(path.join('tests', scenario.file));
  return new Promise(resolve => {
    const child = spawn('nice', ['-n', '10', process.execPath, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    child.stdout.on('data', b => { text += b; });
    child.stderr.on('data', b => { text += b; });
    child.once('error', error => resolve({ scenario, code: 1, pass: 0, fail: 1, skipped: 0, text: String(error) }));
    child.once('close', code => resolve({ scenario, code: code ?? 1, ...parseSummary(text), text }));
  });
}
async function pool<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { for (let i = next++; i < items.length; i = next++) out[i] = await work(items[i]!); }));
  return out;
}
function testEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['AGENTCTL_REAL_CODEX', 'AGENTCTL_REAL_CLAUDE', 'AGENTCTL_REAL_KIMI', 'AGENTCTL_BASELINE_ROOT']) delete env[key];
  if (!env.AGENTCTL_TEST_TMP) {
    env.AGENTCTL_TEST_TMP = path.join(liveCacheRoot(), 'regression-tests'); // fails closed without AGENTCTL_LIVE_CACHE
    fs.mkdirSync(env.AGENTCTL_TEST_TMP, { recursive: true });
  }
  return env;
}

function readProof(): Proof { try { return JSON.parse(fs.readFileSync(path.join(root, PROOF_FILE), 'utf8')); } catch { return {}; } }
const cell = (text: string) => text.replace(/\|/g, '\\|');
export function renderCatalog(proof: Proof = readProof()): string {
  const rows = BUGS.map(bug => {
    const scenario = bug.scenarios.map(sc => `\`tests/${sc.file}\`${sc.name ? ` (\`${cell(sc.name)}\`)` : ''}`).join('<br>');
    const record = proof[bug.id];
        const status = bug.noProof ? `not proven: ${bug.noProof}`
      : !record ? 'pre-fix proof not run (time budget)'
      : record.outcome === 'FAILS' ? `fails on ${record.rev} (${record.failed} failing of ${record.failed + record.passed})`
      : record.outcome === 'IMPORT-ERROR' ? `cannot run on ${record.rev}: the code under test did not exist there (import error)`
      : record.outcome === 'PASSES' ? `NOT PROVEN: passes on ${record.rev}`
      : `not proven: no test ran on ${record.rev}`;
    return `| ${bug.id} | ${cell(bug.symptom)} | ${scenario} | ${bug.fixedIn} | ${cell(status)} |`;
  });
  const excluded = Object.entries(NOT_BUGS).map(([id, why]) => `- ${id}: ${why}`);
  return [
    '# Regression catalog',
    '',
    'One scenario per known, fixed bug. `npm run regression` runs them all (also as part of every `npm run gate` tier) and fails on any regression.',
    'Scenarios are deterministic (fake tmux/agent fixtures, no inference, no network). Most are the tests that were written with the fix; this catalog',
    'references them instead of copying them. Source: `tests/regression/catalog.ts`; proof column: `tests/regression/prefix-proof.json`,',
    'produced by `npm run regression -- --against <release>` (the current scenarios run against `src/` of the release before the fix).',
    'Regenerate this file with `npm run regression -- --catalog`.',
    '',
    '**Rule:** every bug fix adds its scenario and one catalog entry in the same commit (AGENTS.md).',
    '',
    '| Bug | Symptom | Scenario | Fixed in | Pre-fix proof |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    '## Not catalogued',
    '',
    'CHANGELOG identifiers that are features, improvements or studies rather than fixed bugs:',
    '',
    ...excluded,
    '',
  ].join('\n');
}

async function against(rev: string, ids: string[] | undefined, record: boolean): Promise<void> {
  const cache = liveCacheRoot();
  const entries = BUGS.filter(b => !b.noProof && (ids ? ids.includes(b.id) : PREVIOUS_RELEASE[b.fixedIn] === rev));
  if (!entries.length) throw new Error(`no catalog entry has ${rev} as its previous release (use --ids)`);
  const scratch = path.join(cache, `gate-work-${process.pid}`) // the name `gate clean` removes;
  fs.mkdirSync(scratch, { recursive: true });
  try {
    const present = new Set(execFileSync('git', ['ls-tree', '--name-only', rev], { cwd: root, encoding: 'utf8' }).split('\n'));
    const paths = ['src', 'data', 'bin', 'package.json', 'tsconfig.json'].filter(p => present.has(p));
    const archive = execFileSync('git', ['archive', rev, ...paths], { cwd: root, maxBuffer: 256 * 1024 * 1024 });
    execFileSync('tar', ['-x', '-C', scratch], { input: archive });
    fs.cpSync(testsDir(root), testsDir(scratch), { recursive: true });
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(scratch, 'node_modules'));
    const env = testEnv();
    const results = await pool(entries, 2, async entry => {
      const runs = await Promise.all(entry.scenarios.map(sc => run(scratch, sc, env)));
      return { entry, proof: classify(runs, rev) };
    });
    const proof = readProof();
    for (const { entry, proof: p } of results) {
      console.log(`${entry.id.padEnd(16)} ${p.outcome.padEnd(13)} failed=${p.failed} passed=${p.passed}${p.failing.length ? `  e.g. ${p.failing[0]}` : ''}`);
      proof[entry.id] = p;
    }
    if (record) fs.writeFileSync(path.join(root, PROOF_FILE), JSON.stringify(Object.fromEntries(Object.entries(proof).sort(([a], [b]) => a.localeCompare(b))), null, 2) + '\n');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.includes('--catalog')) { fs.writeFileSync(path.join(root, CATALOG_FILE), renderCatalog()); console.log(`wrote ${CATALOG_FILE}`); return; }
  const rev = args.indexOf('--against') >= 0 ? args[args.indexOf('--against') + 1] : undefined;
  if (rev) {
    const idArg = args.indexOf('--ids') >= 0 ? args[args.indexOf('--ids') + 1] : undefined;
    return against(rev, idArg?.split(','), args.includes('--record'));
  }
  const env = testEnv();
  const scenarios = groupScenarios(BUGS);
  const results = await pool(scenarios, 2, sc => run(root, sc, env));
  let failed = 0;
  for (const r of results) {
    const bad = r.code !== 0 || r.fail > 0 || r.pass === 0;
    if (bad) { failed++; console.log(r.text); }
    console.log(`regression: ${bad ? 'FAIL' : 'ok  '} ${r.scenario.file}${r.scenario.name ? ` [${r.scenario.name}]` : ''} pass=${r.pass} fail=${r.fail}${r.pass === 0 ? ' (no test ran)' : ''}`);
  }
  console.log(`regression ${failed ? 'FAIL' : 'PASS'}: ${BUGS.length} bugs, ${scenarios.length} scenario runs, ${results.reduce((n, r) => n + r.pass, 0)} tests`);
  if (failed) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(String(error)); process.exitCode = 1; });
