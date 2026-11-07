// SYNTHETIC Kimi Code 2.5.0 TTY double; session paths and wire records are hypotheses.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('kimi 2.5.0 (fake)'); process.exit(0); }
if (args.includes('--help')) { console.log('-m --model -S --session -c --continue --plan'); process.exit(0); }
const log = '__KIMI_LOG__', initial = '__KIMI_MODE__';
let lastControl = '', mode = initial, draft = '', stream = '', trusted = initial !== 'trust', submitted = false;
const note = value => fs.appendFileSync(log, JSON.stringify(value) + '\n');
const home = process.env.KIMI_CODE_HOME;
const workspace = createHash('sha256').update(process.cwd()).digest('hex').slice(0, 10);
const id = args.includes('--session') ? args[args.indexOf('--session') + 1] : 'synthetic-' + (process.env.AGENTCTL_TASK ?? 'probe');
const session = path.join(home, 'sessions', workspace, 'session_' + id), dir = path.join(session, 'agents/main');
fs.mkdirSync(dir, { recursive: true });
const wire = record => fs.appendFileSync(path.join(dir, 'wire.jsonl'), JSON.stringify({ timestamp: new Date().toISOString(), session_id: id, ...record }) + '\n');
wire({ type: 'metadata', protocol_version: '1.5', cwd: process.cwd(), synthetic: true });
fs.appendFileSync(path.join(home, 'session_index.jsonl'), JSON.stringify({ id, cwd: process.cwd(), synthetic: true }) + '\n');
fs.writeFileSync(path.join(session, 'state.json'), JSON.stringify({ id, cwd: process.cwd(), synthetic: true }));
note({ start: args, cwd: process.cwd(), env: { KIMI_CODE_NO_AUTO_UPDATE: process.env.KIMI_CODE_NO_AUTO_UPDATE, KIMI_DISABLE_TELEMETRY: process.env.KIMI_DISABLE_TELEMETRY, AGENTCTL_TASK: process.env.AGENTCTL_TASK, KIMI_MODEL_THINKING_EFFORT: process.env.KIMI_MODEL_THINKING_EFFORT } });
const editor = () => ' ╭' + '─'.repeat(76) + '╮\n' + (' │ > ' + (draft ? '[paste #1 +' + draft.split('\n').length + ' lines]' : '')).padEnd(78) + '│\n ╰' + '─'.repeat(76) + '╯\n';
const draw = () => {
 let body = '';
 if (!trusted) body = 'Trust this folder?\n❯ Trust and continue\nExit\n';
 else if (mode === 'auth') body = 'OAuth login expired\nRun /login or /provider\n';
 else if (mode === 'approval') body = '▶ Run this command?\ncwd: ' + process.cwd() + '\n$ git status\n▶ 1. Approve once\n2. Approve for this session\n3. Reject\n4. Reject with feedback\n↑/↓ select · 1/2/3/4 choose · ↵ confirm\n';
 else if (mode === 'question') body = 'question\n? Which language?\n→ [1] Polski (Recommended)\n[2] English\n[3] French\n[4] Other\n';
 else if (mode === 'question-submit') body = 'Review your answer before submit\nReady to submit your answers?\n[1] Submit [2] Cancel\n';
 else if (mode === 'working' && submitted) body = '🌕 · Tip: synthetic work\n' + editor();
 else if (mode === 'background') body = '[2 tasks running]\n' + editor();
 else if (mode === 'limit') body = 'Error: [provider.rate_limit]\n' + editor();
 else if (mode === 'overloaded') body = 'Error: [provider.overloaded]\n' + editor();
 else if (mode === 'interrupted') body = 'Interrupted by user\n' + editor();
 else if (mode === 'usage') body = 'Plan usage\n5h limit 26% used resets in 1h 21m\nMonthly limit 3% used resets in 16d 4h\n' + editor();
 else body = (submitted ? '● Done (synthetic)\n' : 'Welcome to Kimi Code!\nKimi Code updated to v2.5.0\n') + editor();
 process.stdout.write('\x1b[2J\x1b[H' + body + (trusted ? 'K2.7 Code Highspeed thinking · context: 0% (0/256k)\n' : ''));
};
const endTurn = () => { wire({ type: 'usage.record', id: 'usage-' + Date.now(), model: 'kimi-code/k3', inputOther: 10, output: 20, inputCacheRead: 30, inputCacheCreation: 0 }); wire({ type: 'turn.ended', reason: 'completed' }); };
process.stdout.write('\x1b[?2004h'); process.stdin.setRawMode(true); process.stdin.resume();
process.stdin.on('data', data => {
 stream += data.toString();
 for (;;) {
  if (stream.startsWith('\x1b[200~')) { const end = stream.indexOf('\x1b[201~'); if (end < 0) return; draft = stream.slice(6, end); stream = stream.slice(end + 6); note({ paste: draft }); draw(); continue; }
  if (!stream.length) return;
  if ('\x1b[200~'.startsWith(stream) && stream !== '\x1b') return;
  const key = stream[0]; stream = stream.slice(1);
  if (!trusted) { note({ trustKey: key }); if (key === 'y') { trusted = true; mode = 'idle'; draw(); } continue; }
  if (key === '\x1b') { draft = ''; submitted = false; mode = 'interrupted'; wire({ type: 'turn.ended', reason: 'cancelled' }); note({ interrupted: true }); draw(); continue; }
  if (mode === 'approval' && key === '1') { mode = 'complete'; submitted = true; endTurn(); draw(); continue; }
  if (mode === 'question' && key === '1') { mode = 'question-submit'; note({ questionSelected: true }); draw(); continue; }
  if (mode === 'question-submit' && key === '1') { mode = 'complete'; submitted = true; endTurn(); note({ questionSubmitted: true }); draw(); continue; }
  if (key === '\r' || key === '\n') {
   note({ enter: true, draft });
   if (!draft) { draw(); continue; }
   if (draft === '/exit') { note({ exit: true }); process.exit(0); }
   if (draft === '/usage') { draft = ''; mode = 'usage'; note({ usage: true }); draw(); continue; }
   wire({ type: 'turn.prompt', prompt: draft }); wire({ type: 'llm.request', model: 'kimi-code/k3', effort: process.env.KIMI_MODEL_THINKING_EFFORT, cli_version: '2.5.0' });
   draft = ''; submitted = true;
   if (mode !== 'working') endTurn();
   note({ submitted: true }); draw();
  }
 }
});
setInterval(() => {
 try {
  const next = fs.readFileSync(log + '.mode', 'utf8').trim();
  if (next !== lastControl) { lastControl = next; mode = next; if (mode === 'complete') { endTurn(); submitted = true; }
  if (mode.startsWith('wire-')) {
   const errors = { 'wire-quota': { name: 'APIProviderQuotaExhaustedError' }, 'wire-overloaded': { name: 'APIProviderOverloadedError' }, 'wire-error': { name: 'SyntheticUnknownError' }, 'wire-shape': { unknown: true } };
   wire({ type: 'turn.ended', reason: 'failed', error: errors[mode] });
  } draw(); }
 } catch { /* no steering */ }
}, 80).unref();
draw();
