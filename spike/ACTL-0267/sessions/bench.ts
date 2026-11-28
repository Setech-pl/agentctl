// ACTL-0267 spike: cost of state collection for N synthetic sessions: session-file tail parse vs tmux capture-pane.
// Runs only inside $AGENTCTL_LIVE_CACHE (fail closed), on an isolated tmux server (TMUX unset, own TMUX_TMPDIR), and removes what it created.
// Usage: AGENTCTL_LIVE_CACHE=… node --experimental-strip-types spike/ACTL-0267/sessions/bench.ts [N=90] [runs=5] [fileKB=2048] [out.json]
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { tailLines, parseClaude, parseCodex, readClaudeRegistry } from './parse.ts';

const run = promisify(execFile);
const cache = process.env.AGENTCTL_LIVE_CACHE;
if (!cache || !fs.existsSync(cache)) { console.error('AGENTCTL_LIVE_CACHE missing: refusing to run'); process.exit(3); }
const [N = 90, RUNS = 5, KB = 2048] = process.argv.slice(2, 5).map(Number);
const outFile = process.argv[5];
const root = fs.mkdtempSync(path.join(cache, 'bench-'));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;
const ms = async (f: () => Promise<unknown> | unknown) => { const t = performance.now(); await f(); return performance.now() - t; };

function makeSessions(): { claude: string[]; codex: string[]; registry: string } {
  const fx = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures');
  const cl = fs.readFileSync(path.join(fx, 'claude-turn-done.jsonl'), 'utf8').split('\n').filter(Boolean);
  const cx = fs.readFileSync(path.join(fx, 'codex-turn-done.jsonl'), 'utf8').split('\n').filter(Boolean);
  const filler = (lines: string[], from: number, to: number) => { const body = lines.slice(from, to).join('\n') + '\n'; return body.repeat(Math.ceil((KB * 1024) / body.length)); };
  const registry = path.join(root, 'registry'); fs.mkdirSync(registry);
  const claude: string[] = []; const codex: string[] = [];
  for (let i = 0; i < N; i++) {
    const f = path.join(root, `claude-${i}.jsonl`);
    fs.writeFileSync(f, cl.slice(0, 2).join('\n') + '\n' + filler(cl, 2, 5) + cl.slice(5).join('\n') + '\n');
    claude.push(f);
    const g = path.join(root, `codex-${i}.jsonl`);
    fs.writeFileSync(g, cx.slice(0, 2).join('\n') + '\n' + filler(cx, 2, 5) + cx.slice(5).join('\n') + '\n');
    codex.push(g);
    fs.writeFileSync(path.join(registry, `${10000 + i}.json`), JSON.stringify({ pid: 10000 + i, sessionId: `s${i}`, status: i % 3 ? 'idle' : 'busy', statusUpdatedAt: Date.now(), tmux: `bench:@${i}.%${i}` }));
  }
  return { claude, codex, registry };
}

async function tmuxBench(): Promise<Record<string, number>> {
  const env: NodeJS.ProcessEnv = { ...process.env, TMUX_TMPDIR: path.join(root, "tmx") };
  delete env.TMUX;
  fs.mkdirSync(env.TMUX_TMPDIR as string);
  const screen = path.join(root, 'screen.txt');
  fs.writeFileSync(screen, Array.from({ length: 48 }, (_, i) => `line ${i} ` + '─'.repeat(120)).join('\n') + '\n› Implement {feature}\n  gpt-6.1-sol high · 42% context left\n');
  const tmux = (...a: string[]) => run('tmux', ['-f', '/dev/null', ...a], { env, maxBuffer: 64 << 20 });
  await tmux('new-session', '-d', '-s', 'bench', '-x', '200', '-y', '50', `cat ${screen}; exec sleep 3600`);
  const sock = (await tmux('display', '-p', '#{socket_path}')).stdout.trim();
  if (!sock.startsWith(root)) { await tmux('kill-server').catch(() => {}); throw new Error(`tmux socket ${sock} is not isolated`); }
  try {
    for (let i = 1; i < N; i++) await tmux('new-window', '-d', '-t', 'bench', `cat ${screen}; exec sleep 3600`);
    const panes = (await tmux('list-panes', '-a', '-F', '#{pane_id}')).stdout.trim().split('\n');
    const seq: number[] = []; const par: number[] = []; const list: number[] = [];
    for (let r = 0; r < RUNS; r++) {
      seq.push(await ms(async () => { for (const p of panes) await tmux('capture-pane', '-p', '-J', '-t', p); }));
      par.push(await ms(async () => { const q = [...panes]; await Promise.all(Array.from({ length: 8 }, async () => { for (let p = q.shift(); p; p = q.shift()) await tmux('capture-pane', '-p', '-J', '-t', p); })); }));
      list.push(await ms(() => tmux('list-panes', '-a', '-F', '#{pane_id} #{pane_pid} #{pane_dead} #{pane_current_command} #{window_activity}')));
    }
    return { panes: panes.length, captureSequentialMs: median(seq), captureParallel8Ms: median(par), listPanesOnceMs: median(list) };
  } finally { await tmux('kill-server').catch(() => {}); }
}

const result: Record<string, unknown> = { at: new Date().toISOString(), host: `${os.platform()} ${os.arch()} load=${os.loadavg().map(l => l.toFixed(1)).join('/')} cpus=${os.cpus().length}`, N, runs: RUNS, fileKB: KB };
try {
  const s = makeSessions();
  const tail = [64, 256];
  for (const t of tail) {
    const c: number[] = []; const x: number[] = []; let phases = '';
    for (let r = 0; r < RUNS; r++) {
      c.push(await ms(() => { phases = s.claude.map(f => parseClaude(tailLines(f, t * 1024).lines, true).phase).filter(p => p === 'turn-done').length + '/' + N; }));
      x.push(await ms(() => s.codex.forEach(f => parseCodex(tailLines(f, t * 1024).lines, true))));
    }
    result[`claudeTail${t}KMs`] = median(c); result[`codexTail${t}KMs`] = median(x); result[`claudeTail${t}KTurnDone`] = phases;
  }
  const reg: number[] = [];
  for (let r = 0; r < RUNS; r++) reg.push(await ms(() => readClaudeRegistry(s.registry)));
  result.claudeRegistryMs = median(reg);
  const cpu0 = process.cpuUsage();
  Object.assign(result, await tmuxBench());
  result.benchSelfCpuMsDuringTmux = Math.round((process.cpuUsage(cpu0).user + process.cpuUsage(cpu0).system) / 1000);
} finally {
  fs.rmSync(root, { recursive: true, force: true }); // the bench removes only its own mkdtemp directory
}
console.log(JSON.stringify(result, null, 1));
if (outFile) fs.writeFileSync(outFile, JSON.stringify(result, null, 1) + '\n');
