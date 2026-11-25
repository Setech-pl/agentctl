import { spawn } from 'node:child_process';
import type { Context } from './context.ts';
import { appendStartLog, startLogPath } from './boardstart.ts';
import { recordJournal } from './journal.ts';
import { WATCH_STALL_MS } from './watch-steps.ts';

const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 600_000;

export async function superviseWatch(ctx: Context, worker: () => Promise<string>, signal?: AbortSignal): Promise<void> {
  const log = startLogPath(ctx.config, 'watch');
  const restarts: number[] = [];
  let reason: string | undefined;
  while (!signal?.aborted) {
    const running = worker();
    if (reason !== undefined) {
      restarts.push(ctx.runner.now());
      const text = `Watch uruchomiony ponownie (${restarts.length}/${MAX_RESTARTS} w ciągu 10 min): ${reason}`;
      appendStartLog(log, text, ctx.runner.now());
      ctx.out(text);
      void recordJournal(ctx, { kind: 'watch-resumed', text }).catch(() => undefined);
    }
    reason = await running;
    if (signal?.aborted) return;
    const now = ctx.runner.now();
    while (restarts.length && restarts[0]! <= now - RESTART_WINDOW_MS) restarts.shift();
    if (restarts.length >= MAX_RESTARTS) {
      const text = `Watch stopped after ${MAX_RESTARTS} restarts in 10 minutes: ${reason}. Run agentctl watch --tmux --restart.`;
      appendStartLog(log, text, now);
      throw new Error(text);
    }
    const delay = 1000 * 2 ** restarts.length;
    appendStartLog(log, `Watch worker exited (${reason}); restarting in ${delay / 1000}s`, now);
    await ctx.runner.sleep(delay, signal);
  }
}

/** The parent can terminate a worker whose event loop is blocked and reap its command groups. */
export function runWatchWorker(argv: string[], signal?: AbortSignal): Promise<string> {
  const [executable, ...args] = argv;
  if (!executable) throw new Error('Watch worker command is missing');
  return new Promise(resolve => {
    const child = spawn(executable, [...args, 'watch'], {
      env: { ...process.env, AGENTCTL_WATCH_WORKER: '1' },
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    });
    const groups = new Set<number>();
    let lastHeartbeat = Date.now();
    let reason: string | undefined;
    let escalation: NodeJS.Timeout | undefined;
    const killGroups = () => {
      for (const pid of groups) {
        try { process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL'); }
        catch { /* command already exited */ }
      }
    };
    const stop = () => {
      if (escalation) return;
      child.kill('SIGTERM');
      escalation = setTimeout(() => { killGroups(); child.kill('SIGKILL'); }, 5000);
    };
    const watchdog = setInterval(() => {
      if (Date.now() - lastHeartbeat < WATCH_STALL_MS) return;
      reason = 'event loop unresponsive for 10 minutes';
      if (!escalation) process.stderr.write(`Watch exiting: ${reason} (PID ${child.pid})\n`);
      stop();
    }, 5000);
    const finish = (code: number | null, exitSignal?: string | null) => {
      clearInterval(watchdog);
      clearTimeout(escalation);
      signal?.removeEventListener('abort', stop);
      killGroups();
      resolve(reason ?? exitSignal ?? `exit ${code ?? 1}`);
    };
    child.on('message', (data: { heartbeat?: boolean; watchCommand?: number; active?: boolean }) => {
      if (data.heartbeat) lastHeartbeat = Date.now();
      if (Number.isSafeInteger(data.watchCommand) && data.watchCommand! > 1) {
        if (data.active) groups.add(data.watchCommand!);
        else groups.delete(data.watchCommand!);
      }
    });
    child.once('error', error => { reason = error.message; finish(null); });
    child.once('exit', finish);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
  });
}

export function watchWorkerHeartbeat(): () => void {
  if (process.env.AGENTCTL_WATCH_WORKER !== '1' || !process.send) return () => {};
  const beat = () => { if (process.connected) process.send?.({ heartbeat: true }, () => {}); };
  const disconnected = () => process.kill(process.pid, 'SIGTERM');
  process.on('disconnect', disconnected);
  beat();
  const timer = setInterval(beat, 5000);
  timer.unref();
  return () => {
    clearInterval(timer);
    process.off('disconnect', disconnected);
    if (process.connected) process.disconnect?.();
  };
}
