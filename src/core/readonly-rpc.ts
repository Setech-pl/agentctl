import { spawn } from 'node:child_process';
import type { ExecResult } from './runner.ts';

/** Bounded handshake for the single read method, with no thread or agent turn. */
export function readRateLimits(cmd: string, args: string[], cwd: string | undefined, timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    let result: ExecResult = { code: 1, stdout: '', stderr: 'RPC ended before a response' };
    let completed = false;
    let force: ReturnType<typeof setTimeout> | undefined;
    const finish = (r: ExecResult): void => {
      if (completed) return;
      completed = true;
      result = r;
      clearTimeout(timer);
      child.stdin.end();
      child.kill('SIGTERM');
      force = setTimeout(() => child.kill('SIGKILL'), 250);
    };
    const timer = setTimeout(() => finish({ code: 1, stdout: '', stderr: 'RPC timed out' }), timeoutMs);
    child.stdin.on('error', () => {});
    child.on('error', (e: NodeJS.ErrnoException) => finish({ code: e.code === 'ENOENT' ? 127 : 1, stdout: '', stderr: e.message }));
    child.on('close', () => { clearTimeout(timer); clearTimeout(force); resolve(result); });
    child.stderr.on('data', () => {}); // Do not expose auth/server diagnostics in capacity.
    const send = (value: unknown): void => { if (!completed) child.stdin.write(`${JSON.stringify(value)}\n`); };
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      if (buffer.length > 1024 * 1024) return finish({ code: 1, stdout: '', stderr: 'RPC output too large' });
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const msg = JSON.parse(line) as { id?: number; error?: unknown; result?: unknown };
          if (msg.id === 1) {
            if (msg.error) return finish({ code: 1, stdout: '', stderr: 'RPC initialization failed' });
            send({ method: 'initialized', params: {} });
            send({ id: 2, method: 'account/rateLimits/read' });
          } else if (msg.id === 2) finish(msg.error ? { code: 1, stdout: '', stderr: 'RPC request failed' } : { code: 0, stdout: JSON.stringify(msg.result), stderr: '' });
        } catch { /* non-JSON diagnostic */ }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agentctl_capacity', version: '0.17.0' }, capabilities: {} } });
  });
}
