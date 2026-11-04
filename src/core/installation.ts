import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

/** Locate metadata from either src/ or dist/src/, without assuming a global prefix. */
export function packageRoot(start: string = import.meta.dirname): string {
  let dir = start;
  while (!fs.existsSync(path.join(dir, 'package.json'))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`package.json not found above ${start}`);
    dir = parent;
  }
  return dir;
}

export function realPath(file: string): string {
  try { return fs.realpathSync(file); } catch { return path.resolve(file); }
}

export function installation(root = packageRoot(), env: NodeJS.ProcessEnv = process.env): { source: string; executable: string; found?: string; matches: boolean } {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { bin: { agentctl: string } };
  const executable = path.join(root, pkg.bin.agentctl);
  let found: string | undefined;
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, 'agentctl');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) { found = candidate; break; }
    } catch { /* next PATH directory */ }
  }
  const matches = found !== undefined && realPath(found) === realPath(executable);
  const clone = fs.existsSync(path.join(root, '.git'));
  return { source: clone ? (matches && fs.lstatSync(found!).isSymbolicLink() ? 'npm link klonu' : 'repo dev') : 'npm global', executable, ...(found ? { found } : {}), matches };
}

/** A separate state home or a different executable is an intentional dev environment. */
export function developmentEnvironment(configPath?: string, script?: string, stable?: string, home = os.homedir()): boolean {
  const customHome = configPath !== undefined && realPath(path.dirname(configPath)) !== realPath(path.join(home, '.agentctl'));
  const otherScript = script !== undefined && stable !== undefined && realPath(script) !== realPath(stable);
  return customHome || otherScript;
}
