/** Release documentation: real Ink screens on the isolated live harness, synthetic provider output only. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { withHarness } from './live-harness.ts';
import { TASKS, FIXED_MS, CLAUDE_PROMPT, CODEX_PROMPT, buildDemo, writeScreens, writeReports, writePlans, queueReviews, specText } from './demo-board.ts';
import { parseAnsi, renderSvg, FONT_STACK } from './render-ansi.ts';
import { shellQuote } from '../src/core/util.ts';
import { packageVersion } from '../src/core/version.ts';
const repoRoot = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { Resvg } = require('@resvg/resvg-js');
const fontRoot = path.dirname(require.resolve('dejavu-fonts-ttf/package.json'));
const fontFiles = ['DejaVuSansMono.ttf', 'DejaVuSansMono-Bold.ttf', 'DejaVuSans.ttf'].map(f => path.join(fontRoot, 'ttf', f));
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const extra = (id: string, screen: string, report?: string) => ({ id, cohort: 'sprint-2', agent: 'claude' as const, model: 'sonnet', effort: 'medium', runningMin: 7, commits: [], dirty: [], tokens: { input: 2000, output: 800, cacheRead: 9000 }, screen, ...(report ? { report: () => report } : {}) });
TASKS.push(
  extra('TRUST-DEMO', 'Quick safety check\n\n  ~/Projects/demo\n\n  ❯ 1. Yes, I trust this folder\n    2. No, exit\n'),
  extra('LIMIT-DEMO', `You've hit your session limit · resets 14:00\n${CLAUDE_PROMPT}`),
  extra('WAIT-DEMO', `● Waiting for the next instruction.\n${CLAUDE_PROMPT}`),
  extra('FAIL-DEMO', `● Validation failed; report written.\n${CLAUDE_PROMPT}`, 'Verdict: FAIL\n\nThe synthetic rollback check fails.\n\n<!-- agentctl:report-end -->\n'),
);
await withHarness({ name: 'docs-gallery', session: 'agentctl-demo', config: 'limits: {claude: 12, codex: 8}\ncapacity: {codex_refresh: false}\nwatch: {interval: 2}\n' }, async h => {
  // mktemp-equivalent unique demo home, entirely within the task-owned sandbox.
  const demoHome = path.join(fs.mkdtempSync(path.join(h.root, 'tmp', 'demo-')), 'agentctl-demo');
  fs.mkdirSync(demoHome);
  fs.copyFileSync(path.join(h.agentctlHome, 'config.yaml'), path.join(demoHome, 'config.yaml'));
  Object.defineProperty(h, 'agentctlHome', { value: demoHome });
  h.env.AGENTCTL_HOME = demoHome;
  h.tmux(['set-environment', '-g', 'AGENTCTL_HOME', demoHome]);
  const { repo, screens } = buildDemo(h);
  writeScreens(screens); writeReports(h);
  for (const task of TASKS) {
    const file = path.join(h.root, 'state', task.id.toLowerCase(), 'TASK.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^prompt_delivery: .*$/m, 'prompt_delivery: sent'));
  } h.agentctl(['mark', 'API-AUTH-1', 'ok']); queueReviews(h, repo); writePlans(h, FIXED_MS);
  fs.appendFileSync(path.join(demoHome, 'config.yaml'), 'usage:\n  claude_dir: ' + path.join(h.root, 'claude-logs') + '\n  codex_dir: ' + h.codexHome + '\n  queue_hold: {codex: 80}\n');
  // Replace the first usage block, rather than leaving duplicate YAML mappings.
  const configFile = path.join(demoHome, 'config.yaml');
  let conf = fs.readFileSync(configFile, 'utf8');
  conf = conf.replace(/usage:\n  claude_dir: [^\n]+\n  codex_dir: [^\n]+\n/, '');
  fs.writeFileSync(configFile, conf);
  const run = (args: string[]) => { const r = h.agentctl(args); if (r.code) throw new Error(args.join(' ') + ': ' + r.stdout + r.stderr); return r.stdout; };
  const held = path.join(h.root, 'held.md');
  fs.writeFileSync(held, specText(h, repo, { id: 'HOLD-DEMO', cohort: 'sprint-2', agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium' }));
  run(['queue', held, '-y']);
  const consult = path.join(h.root, 'consult.yaml');
  fs.writeFileSync(consult, `consult: CACHE-CHOICE\nquestion: Which cache invalidation contract should we adopt?\nrepos: [{path: ${repo}, base: main}]\npanel:\n  - {agent: claude, model: sonnet, effort: medium}\n  - {agent: codex, model: gpt-6.1-sol, effort: medium}\nrounds: 2\nsynthesis: {agent: claude, model: sonnet, effort: high}\n`);
  run(['consult', consult, '--confirm']);
  const post = (channel: string, kind: string, subject: string, body: string) => run(['wall', 'post', channel, '--kind', kind, '--subject', subject, '--body', body]);
  post('agentctl', 'info', 'Demo release ready', 'Synthetic tasks and reports are ready for review.');
  post('shared:sim', 'question', 'Cache TTL units?', 'Should the public contract use seconds?');
  run(['wall', 'reply', 'shared:sim-1', '--body', 'Use explicit seconds; update both ends together.']);
  post('nc', 'decision-request', 'Approve rollback window', 'May the demo migration use a short maintenance window?');
  run(['wall', 'status', 'nc-1', 'accepted', '--note', 'Owner approved the synthetic window.']);
  post('agentctl', 'question', 'Which demo task needs review?', 'Please review API-AUTH-1 first.');
  run(['wall', 'reply', 'agentctl-2', '--body', 'Reviewed: the synthetic acceptance checks pass.']);
  post('agentctl', 'decision-request', 'Choose release window', 'Choose the synthetic documentation release window.');
  const cli = path.join(repoRoot, 'bin/agentctl.ts');
  const command = ['env', 'TZ=UTC', 'FORCE_COLOR=2', `DEMO_FIXED_MS=${FIXED_MS}`, process.execPath, '--experimental-strip-types', '--no-warnings', '--import', path.join(repoRoot, 'scripts/demo-preload.mjs'), cli, 'board'].map(shellQuote).join(' ');
  h.tmux(['new-window', '-d', '-t', `=${h.session}:`, '-n', 'board', command]);
  const target = `=${h.session}:board`;
  h.tmux(['resize-window', '-t', target, '-x', '160', '-y', '45']);
  const plain = () => h.tmux(['capture-pane', '-p', '-t', target]).stdout;
  const until = async (label: string, predicate: (s: string) => boolean) => {
    for (let i = 0; i < 150; i++) { if (predicate(plain())) return; await pause(200); }
    throw new Error(`${label} not visible:\n${plain()}`);
  };
  const captures: { name: string; bytes: number }[] = [];
  const helpOnly = process.argv.includes('--help-only');
  const capture = async (name: string) => {
    if (helpOnly && name !== 'board-help') return;
    h.tmux(['resize-window', '-t', target, '-x', '161', '-y', '45']);
    await pause(250);
    h.tmux(['resize-window', '-t', target, '-x', '160', '-y', '45']);
    await pause(600);
    const ansi = h.tmux(['capture-pane', '-e', '-p', '-t', target]).stdout;
    if (/\/Users\/|marcin|cache-dev|agentctl-wt|\/private\/tmp/i.test(ansi)) throw new Error(`non-generic path in ${name}:\n${plain()}`);
    const svg = renderSvg(parseAnsi(ansi, 160), { title: `agentctl ${packageVersion()} · ${name}` });
    const png = new Resvg(svg.replaceAll(FONT_STACK, "'DejaVu Sans Mono'"), { font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'DejaVu Sans Mono' } }).render().asPng();
    fs.writeFileSync(path.join(repoRoot, 'docs/img', `${name}.png`), png);
    fs.writeFileSync(path.join(h.root, `${name}.ansi`), ansi);
    captures.push({ name, bytes: png.length });
  };
  const key = async (...keys: string[]) => { h.tmux(['send-keys', '-t', target, ...keys]); await pause(400); };
  const select = async (id: string) => {
    h.tmux(['send-keys', '-N', '40', '-t', target, 'Up']); await pause(300);
    for (let i = 0; i < 40; i++) {
      // A collision warning keeps its marker when selected, so read the matching preview heading.
      if (new RegExp(`▸\\s*${id}|│\\s+${id} · ⚠`).test(plain())) return;
      await key('Down');
    }
    throw new Error(`cannot select ${id}`);
  };
  if (helpOnly) {
    await until('main', s => s.includes('TRUST-DEMO') && s.includes('Queue'));
    await key('?'); await until('help', s => s.includes('Press any other key'));
    await capture('board-help');
    console.log('Recaptured help only; fake providers; sandbox stopped in finally.');
    return;
  }
  await until('main', s => s.includes('TRUST-DEMO') && s.includes('Queue') && s.includes('83%'));
  await select('TRUST-DEMO');
  await until('waiting and preview', s => /WAIT-DEMO[^\n]*waiting/.test(s) && s.includes('Quick safety check')); await capture('board-main');
  await select('UI-CART-2'); await pause(2300); await capture('board-peek');
  await key('m'); await key('Please add the synthetic edge case.'); await capture('board-message'); await key('Escape');
  await key('x'); await capture('board-confirm'); await key('Escape');
  await key('X'); await capture('board-cancel-reason'); await key('Escape');
  await key('?'); await until('help', s => s.includes('Press any other key')); await capture('board-help'); await key('Escape');
  await key('k'); await capture('board-cohorts'); await key('Escape');
  for (const [k, name, text] of [['L', 'board-limits', 'Limits'], ['C', 'board-capacity', 'Capacity'], ['G', 'board-gc', 'Clean-up preview'], ['l', 'board-log', 'Log']]) {
    await key(k); await until(name, s => s.includes(text) && !s.includes('Loading…')); await capture(name); await key('Escape');
  }
  await select('REVIEW-UI-CART-2'); await pause(2300); await capture('board-queue');
  await key('W'); await until('WALL', s => s.includes('shared:sim') && s.includes('channels')); await capture('wall-channels');
  await key('Enter'); await until('messages', s => s.includes('Choose release window')); await capture('wall-messages');
  await key('s'); await capture('wall-filter-status'); await key('t'); await key('t'); await key('t'); await capture('wall-filter-kind');
  await key('Escape'); await key('Enter'); // reset filters on channel re-entry
  await key('Down'); await key('Down'); await key('Enter');
  await until('thread', s => s.includes('Reviewed:') && !s.includes('Loading…')); await capture('wall-thread');
  await key('Escape'); await key('Escape'); await key('Escape');
  await select('FAIL-DEMO'); await pause(2300); await capture('board-report-fail');
  h.tmux(['kill-window', '-t', '='+h.session+':fail-demo']);
  await pause(2500); await key('z'); await select('FAIL-DEMO'); await key('Enter');
  await capture('board-finished-menu'); await key('Escape');
  await key('a'); await capture('board-all');
  const manifest = { session: h.session, columns: 160, rows: 45, inference: false, captures, taskStates: JSON.parse(run(['status', '--json'])), queue: JSON.parse(run(['queue', 'list', '--json'])) };
  // Keep only generic task/state facts in evidence, not sandbox paths.
  fs.writeFileSync(path.join(process.env.AGENTCTL_LIVE_CACHE!, 'gallery.json'), JSON.stringify({ ...manifest, taskStates: (Array.isArray(manifest.taskStates) ? manifest.taskStates : manifest.taskStates.rows).map((r: any) => ({ task: r.task, state: r.state })), queue: 'after + queue_hold; CONSULT accepted', syntheticDelivery: 'Marked fixture initial prompts sent; no real model turn' }, null, 2));
  console.log(`Captured ${captures.length} real TUI views; fake providers only; sandbox stopped in finally.`);
});
