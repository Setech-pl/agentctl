import path from 'node:path';
import type { Runner } from './runner.ts';
import { shellLine, shellQuote } from './util.ts';

/** Keep environment values in a private file, never in tmux argv or dry-run logs. */
export function launchScript(argv: string[], env: Record<string, string> = {}): string {
  const args = [...argv], exports = { ...env };
  // Event commands use stableSelfArgv's /usr/bin/env prefix. Move its values off argv too.
  if (args[0] === '/usr/bin/env') {
    args.shift();
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0] ?? '')) {
      const assignment = args.shift()!, at = assignment.indexOf('=');
      exports[assignment.slice(0, at)] = assignment.slice(at + 1);
    }
  }
  const lines = Object.entries(exports).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid launch environment key: ${key}`);
    return `export ${key}=${shellQuote(value)}`;
  });
  return `#!/bin/sh\n${lines.join('\n')}\nexec ${shellLine(args[0]!, args.slice(1))}\n`;
}

export async function writeLaunchScript(runner: Runner, dir: string, argv: string[], env: Record<string, string>): Promise<string> {
  const file = path.join(dir, 'start.sh');
  await runner.writeFile(file, launchScript(argv, { ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }), ...env }));
  const result = await runner.exec('chmod', ['0700', file]);
  if (result.code !== 0) throw new Error(`Cannot protect launch script: ${file}`);
  return `exec ${shellLine('sh', [file])}`;
}
