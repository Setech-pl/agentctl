// ACTL-0267 spike: Claude Code stream-json control handshake WITHOUT a user message (no inference).
// Sends only {"type":"control_request","request":{"subtype":"initialize"}} and closes stdin after the response.
// Usage: node --experimental-strip-types claude-control-probe.ts <out.jsonl> [cwd]
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const [out, cwd = process.cwd()] = process.argv.slice(2);
if (!out) { console.error('usage: claude-control-probe.ts out.jsonl [cwd]'); process.exit(2); }
const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--safe-mode', '--no-session-persistence', '--permission-prompts', 'none'];
const t0 = Date.now();
const frames: unknown[] = [];
const child = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
const send = (v: Record<string, unknown>) => {
  if (v.type === 'user') throw new Error('the probe never sends a user message');
  frames.push({ t: Date.now() - t0, dir: 'out', msg: v });
  child.stdin.write(JSON.stringify(v) + '\n');
};
let buf = '';
const timer = setTimeout(() => { frames.push({ t: Date.now() - t0, dir: 'err', msg: 'timeout' }); child.kill('SIGTERM'); }, 30000);
child.stdout.on('data', (c: Buffer) => {
  buf += c.toString();
  for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let msg: Record<string, unknown>; try { msg = JSON.parse(line); } catch { frames.push({ t: Date.now() - t0, dir: 'err', msg: line.slice(0, 300) }); continue; }
    frames.push({ t: Date.now() - t0, dir: 'in', msg });
    if (msg.type === 'control_response') child.stdin.end();
  }
});
child.stderr.on('data', (c: Buffer) => frames.push({ t: Date.now() - t0, dir: 'err', msg: c.toString().slice(0, 1000) }));
child.on('close', (code) => {
  clearTimeout(timer);
  frames.push({ t: Date.now() - t0, dir: 'err', msg: { exit: code } });
  fs.writeFileSync(out, frames.map(f => JSON.stringify(f)).join('\n') + '\n');
  console.log(JSON.stringify(frames.map(f => { const m = (f as { msg: Record<string, unknown> }).msg; return `${(f as { dir: string }).dir}:${m?.type ?? ''}${m?.subtype ? '/' + m.subtype : ''}`; })));
});
send({ type: 'control_request', request_id: 'init-1', request: { subtype: 'initialize' } });
