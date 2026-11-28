// ACTL-0267 spike: bounded JSON-RPC (newline-delimited) handshake probe. NO prompts: the script refuses any method that starts a turn.
// Usage: node --experimental-strip-types spike/ACTL-0267/protocol/jsonrpc-probe.ts <plan.json> <out.jsonl> -- <cmd> [args…]
// plan.json: { "steps": [{ "method": "initialize", "params": {...} }, { "notify": "initialized" }, ...], "settleMs": 1500, "timeoutMs": 20000 }
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const FORBIDDEN = /^(turn\/start|turn\/steer|review\/start|session\/prompt|thread\/inject_items|command\/exec|thread\/shellCommand)$/;

export interface Step { method?: string; notify?: string; params?: unknown }
export interface Plan { steps: Step[]; settleMs?: number; timeoutMs?: number }
export interface Frame { t: number; dir: 'out' | 'in' | 'err'; msg: unknown }

export function assertNoPrompt(plan: Plan): void {
  for (const s of plan.steps) {
    const m = s.method ?? s.notify ?? '';
    if (FORBIDDEN.test(m)) throw new Error(`refusing ${m}: the spike never starts a model turn`);
  }
}

export function runProbe(plan: Plan, cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<Frame[]> {
  assertNoPrompt(plan);
  const frames: Frame[] = [];
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    let next = 0;
    let id = 0;
    let waiting: number | undefined;
    const log = (dir: Frame['dir'], msg: unknown) => frames.push({ t: Date.now() - t0, dir, msg });
    const done = () => { clearTimeout(timer); try { child.stdin.end(); } catch {} child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 500).unref(); };
    const timer = setTimeout(() => { log('err', 'probe timeout'); done(); }, plan.timeoutMs ?? 20000);
    const send = (v: unknown) => { log('out', v); child.stdin.write(JSON.stringify(v) + '\n'); };
    const advance = () => {
      while (next < plan.steps.length) {
        const s = plan.steps[next++] as Step;
        if (s.notify) { send({ jsonrpc: '2.0', method: s.notify, params: s.params ?? {} }); continue; }
        waiting = ++id;
        send({ jsonrpc: '2.0', id: waiting, method: s.method, params: s.params ?? {} });
        return;
      }
      waiting = undefined;
      setTimeout(done, plan.settleMs ?? 1500);
    };
    child.stdin.on('error', () => {});
    child.on('error', (e) => { log('err', String(e)); resolve(frames); });
    child.on('close', (code, signal) => { log('err', { exit: code, signal }); resolve(frames); });
    child.stderr.on('data', (c: Buffer) => log('err', c.toString().slice(0, 2000)));
    child.stdout.on('data', (c: Buffer) => {
      buf += c.toString();
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(line); } catch { log('err', line.slice(0, 500)); continue; }
        log('in', msg);
        // Server→client requests (approvals, permission asks) would be answered by agentctl `answer`; the probe declines them.
        if (msg.id !== undefined && typeof msg.method === 'string') send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'spike probe: declined' } });
        else if (msg.id === waiting) advance();
      }
    });
    advance();
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [planFile, outFile, sep, cmd, ...args] = process.argv.slice(2);
  if (!planFile || !outFile || sep !== '--' || !cmd) { console.error('usage: jsonrpc-probe.ts plan.json out.jsonl -- cmd args…'); process.exit(2); }
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8')) as Plan;
  const frames = await runProbe(plan, cmd, args);
  fs.writeFileSync(outFile, frames.map(f => JSON.stringify(f)).join('\n') + '\n');
  const methods = frames.filter(f => f.dir === 'in').map(f => (f.msg as { method?: string; id?: number }).method ?? `response#${(f.msg as { id?: number }).id}`);
  console.log(JSON.stringify({ frames: frames.length, in: methods }, null, 1));
}
