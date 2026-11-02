import fs from 'node:fs';
import path from 'node:path';
import type { Runner } from './runner.ts';

/*
 * The Claude app starts `agentctl mcp` once and keeps that process for as long as the app runs. After `agentctl-update` the files of the stable
 * copy are new, the process is not: it still runs the code it loaded. Nothing inside the process can see that, so the check looks at the
 * processes from outside (ps) and compares when they started with when the stable copy was last updated.
 */

export const STALE_MCP_MESSAGE = 'serwer MCP w aplikacji działa na starej wersji – zamknij aplikację Claude (⌘Q) i otwórz ponownie';

export interface McpProcess {
  pid: number;
  /** ms since the epoch. */
  started: number;
  /** The script it runs, as written on its command line. */
  script: string;
  command: string;
}

/** `ps -axww -o pid=,lstart=,command=`: one process per line, `lstart` is "Mon Nov  2 08:30:08 2026". */
export const PS_ARGS = ['-axww', '-o', 'pid=,lstart=,command='];

const PS_LINE = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*\S)\s*$/;
/** `node [flags] <path>/agentctl[.ts] mcp [serve]`: the server, not `mcp install` and not another command. */
const MCP_COMMAND = /(?:^|\s)(\S*agentctl(?:\.ts)?)\s+mcp(?:\s+serve)?\s*$/;

/** The `agentctl … mcp` server processes in the output of `ps`. */
export function parsePs(stdout: string): McpProcess[] {
  const found: McpProcess[] = [];
  for (const line of stdout.split('\n')) {
    const m = PS_LINE.exec(line);
    if (!m) continue;
    const command = m[3] as string;
    const script = MCP_COMMAND.exec(command)?.[1];
    if (!script) continue;
    const started = Date.parse(m[2] as string);
    if (Number.isNaN(started)) continue;
    found.push({ pid: Number(m[1]), started, script, command });
  }
  return found;
}

export async function findMcpProcesses(runner: Runner): Promise<McpProcess[]> {
  const r = await runner.exec('ps', PS_ARGS, { readOnly: true, dryResult: { code: 0, stdout: '' } });
  return r.code === 0 ? parsePs(r.stdout) : [];
}

const realOrSelf = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

/** The stable copy's root (`…/agentctl-stable`) from its script (`…/bin/agentctl.ts`). */
const rootOf = (script: string): string => path.dirname(path.dirname(script));

/** Version in the package.json of the copy that `script` belongs to; undefined when it cannot be read. */
export function versionOf(script: string): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootOf(realOrSelf(script)), 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

/** When the copy was last updated: the newer of package.json and node_modules (`npm ci` rebuilds it on every update). ms; undefined when neither exists. */
export function updatedAt(script: string): number | undefined {
  const root = rootOf(realOrSelf(script));
  const times: number[] = [];
  for (const name of ['package.json', 'node_modules']) {
    try {
      times.push(fs.statSync(path.join(root, name)).mtimeMs);
    } catch {
      // not there
    }
  }
  return times.length > 0 ? Math.max(...times) : undefined;
}

/** Server processes that run the stable copy's script and started before the copy was last updated: they run old code. */
export function staleProcesses(procs: readonly McpProcess[], stable: string): McpProcess[] {
  const updated = updatedAt(stable);
  if (updated === undefined) return [];
  const target = realOrSelf(stable);
  return procs.filter((p) => realOrSelf(p.script) === target && p.started < updated);
}

/** The warning for the processes, or undefined when there is nothing to say. */
export function staleWarning(stale: readonly McpProcess[], stable: string): string | undefined {
  if (stale.length === 0) return undefined;
  const now = versionOf(stable);
  return `${STALE_MCP_MESSAGE} (pid ${stale.map((p) => p.pid).join(', ')}; the stable copy is ${now ? `now ${now}` : 'newer'}; agentctl does not stop it for you)`;
}
