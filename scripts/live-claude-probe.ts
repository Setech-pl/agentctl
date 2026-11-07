import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withHarness, defaultCacheRoot } from './live-harness.ts';

const cache = defaultCacheRoot('agentctl-0181-p11');
const checks: string[] = [];
const check = (name: string, ok: boolean) => { assert.ok(ok, name); checks.push(name); console.log(`PASS ${name}`); };
await withHarness({ name: 'cp', cacheRoot: cache, config: 'capacity: {snapshot: false, codex_refresh: false, claude_usage_probe: true}\n' }, h => {
  const fixture = fs.readFileSync(new URL('../tests/fixtures/screen-claude-usage-2.1.311.txt', import.meta.url), 'utf8');
  const log = path.join(h.root, 'slash.log');
  const fake = path.join(h.fakeBin, 'claude');
  fs.writeFileSync(fake, `#!${process.execPath}
const fs = require('node:fs');
const fixture = ${JSON.stringify(fixture)}, log = ${JSON.stringify(log)};
let draft = '', stream = '';
const draw = () => process.stdout.write('\\x1b[2J\\x1b[H────────────────────\\n❯ ' + draft + '\\n────────────────────\\n');
process.stdin.setRawMode(true); process.stdin.resume(); process.stdout.write('\\x1b[?2004h'); draw();
process.stdin.on('data', data => {
  stream += data.toString();
  for (;;) {
    if (stream.startsWith('\\x1b[200~')) {
      const end = stream.indexOf('\\x1b[201~'); if (end < 0) return;
      draft = stream.slice(6, end); stream = stream.slice(end + 6); draw(); continue;
    }
    if (!stream.length) return;
    if ('\\x1b[200~'.startsWith(stream)) return;
    const key = stream[0]; stream = stream.slice(1);
    if (key === '\\r' || key === '\\n') {
      fs.appendFileSync(log, draft + '\\n');
      if (draft !== '/usage') process.exit(19);
      process.stdout.write('\\x1b[2J\\x1b[H' + fixture + '\\nEsc to cancel\\n'); draft = '';
    } else { draft += key; draw(); }
  }
});
`, { mode: 0o755 });
  check('active sentinel window starts', h.tmux(['new-session', '-d', '-s', h.session, '-n', 'active', 'printf "P11 ACTIVE SENTINEL\\n"; tmux wait-for -S p11-sentinel; sleep 180']).code === 0);
  h.tmux(['wait-for', 'p11-sentinel']);
  const before = h.tmux(['capture-pane', '-p', '-t', `=${h.session}:active`]).stdout;
  const result = h.agentctl(['capacity', '--json']);
  check('capacity reads isolated real-tmux fake-Claude probe', result.code === 0 && result.stdout.includes('claude-usage-probe') && result.stdout.includes('87'));
  fs.writeFileSync(path.join(cache, 'claude-capacity.json'), result.stdout);
  check('exactly one slash command and no prompt', fs.readFileSync(log, 'utf8') === '/usage\n');
  const usage = h.agentctl(['usage', '--json']);
  check('usage reuses cached reading', usage.code === 0 && usage.stdout.includes('claude-usage-probe') && fs.readFileSync(log, 'utf8') === '/usage\n');
  check('active task window is unchanged', h.tmux(['capture-pane', '-p', '-t', `=${h.session}:active`]).stdout === before);
  check('probe sessions cleaned up', !h.tmux(['list-sessions', '-F', '#{session_name}']).stdout.includes('agentctl-claude-probe-'));
  const script = path.join(h.agentctlHome, 'claude-usage-probe', 'start.sh');
  check('launch script private', (fs.statSync(script).mode & 0o777) === 0o700);
});
fs.writeFileSync(path.join(cache, 'claude-probe-results.json'), JSON.stringify({ passed: checks.length, failed: 0, checks }, null, 2) + '\n');
