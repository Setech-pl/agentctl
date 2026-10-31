import fs from 'node:fs';
import path from 'node:path';
import { after } from 'node:test';
import { loadGlobalConfig } from '../src/core/config.ts';
import type { GlobalConfig } from '../src/core/config.ts';
import { Context } from '../src/core/context.ts';
import { RecordingRunner } from '../src/core/runner.ts';
import type { RecordingOptions } from '../src/core/runner.ts';

export const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SCRATCH = path.join(REPO_ROOT, '.cache');

/** Per-file scratch directory under the repo's own .cache/ (git-ignored); removed after the file's tests. */
export function useScratch(): { dir: string; sub: (name: string) => string } {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const dir = fs.mkdtempSync(path.join(SCRATCH, 'test-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    sub(name: string): string {
      const p = path.join(dir, name);
      fs.mkdirSync(p, { recursive: true });
      return p;
    },
  };
}

/** Write `<root>/home/config.yaml` (cache = <root>/cache) and load it. */
export function makeConfig(root: string, extraYaml = ''): GlobalConfig {
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.yaml'), `cache: ${path.join(root, 'cache')}\n${extraYaml}`);
  return loadGlobalConfig(home);
}

export function makeContext(config: GlobalConfig, options: RecordingOptions = {}): { ctx: Context; runner: RecordingRunner; out: string[] } {
  const out: string[] = [];
  const runner = new RecordingRunner({ dryRun: false, ...options });
  return { ctx: new Context(runner, config, (l) => out.push(l)), runner, out };
}

/** A spec file text for tests. */
export function specText(header: Record<string, string>, repoPath: string, prompt = 'Do the thing.'): string {
  const lines = Object.entries(header).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join('\n')}\nrepos:\n  - path: ${repoPath}\n    worktree: ${repoPath}-wt\n---\n${prompt}\n`;
}
