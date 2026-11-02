// The buckets of the readers are local days: the tests pin the zone, so that a day boundary falls where the fixtures expect it.
process.env.TZ = 'UTC';

import fs from 'node:fs';
import path from 'node:path';
import { claudeProjectName } from '../src/core/usage-sources.ts';
import { makeConfig, REPO_ROOT, seedTask } from './helpers.ts';
import type { useScratch } from './helpers.ts';

const FIX = path.join(REPO_ROOT, 'tests', 'fixtures', 'usage');
export const readFixture = (name: string): string => fs.readFileSync(path.join(FIX, name), 'utf8');
const read = readFixture;

/** A world with a Claude home and a Codex home, tasks and their worktrees. */
export function makeWorld(scratch: ReturnType<typeof useScratch>, name: string, extraYaml = '') {
  const root = scratch.sub(name);
  const claudeHome = scratch.sub(`${name}/claude`);
  const codexHome = scratch.sub(`${name}/codex`);
  const config = makeConfig(root, `usage:\n  claude_dir: ${claudeHome}\n  codex_dir: ${codexHome}\n${extraYaml}`);
  const worktree = (w: string): string => {
    const dir = path.join(root, 'wt', w);
    fs.mkdirSync(dir, { recursive: true });
    return fs.realpathSync(dir);
  };
  /** A Claude transcript of `cwd`, with every `cwd`/session id in the fixture replaced. */
  const claudeSession = (cwd: string, id: string, startIso: string, opts: { sub?: boolean } = {}): string => {
    const dir = path.join(claudeHome, 'projects', claudeProjectName(cwd));
    fs.mkdirSync(dir, { recursive: true });
    const base = Date.parse('2026-11-01T10:00:00.000Z');
    const shift = Date.parse(startIso) - base;
    const text = read('claude-transcript.jsonl')
      .replaceAll('/Users/me/Projects/wt/nc-1', cwd)
      .replaceAll('11111111-2222-3333-4444-555555555555', id)
      .replace(/"timestamp":"([^"]+)"/g, (_m, t: string) => `"timestamp":"${new Date(Date.parse(t) + shift).toISOString()}"`);
    const file = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(file, text);
    if (opts.sub) {
      fs.mkdirSync(path.join(dir, id, 'subagents'), { recursive: true });
      fs.writeFileSync(path.join(dir, id, 'subagents', 'agent-aaa.jsonl'), read('claude-subagent.jsonl').replaceAll('/Users/me/Projects/wt/nc-1', cwd).replace(/"timestamp":"([^"]+)"/g, (_m, t: string) => `"timestamp":"${new Date(Date.parse(t) + shift).toISOString()}"`));
    }
    return file;
  };
  const codexSession = (cwd: string, id: string, startIso: string): string => {
    const start = new Date(startIso);
    const dir = path.join(codexHome, 'sessions', String(start.getFullYear()), String(start.getMonth() + 1).padStart(2, '0'), String(start.getDate()).padStart(2, '0'));
    fs.mkdirSync(dir, { recursive: true });
    const shift = start.getTime() - Date.parse('2026-11-01T11:00:00.000Z');
    const text = read('codex-session.jsonl')
      .replaceAll('/Users/me/Projects/wt/nc-2', cwd)
      .replaceAll('01a00000-aaaa-7bbb-8ccc-dddddddddddd', id)
      .replace(/"timestamp":"([^"]+)"/g, (_m, t: string) => `"timestamp":"${new Date(Date.parse(t) + shift).toISOString()}"`);
    const file = path.join(dir, `rollout-${startIso.replace(/[:.]/g, '-')}-${id}.jsonl`);
    fs.writeFileSync(file, text);
    return file;
  };
  const task = (id: string, wt: string, extra: Parameters<typeof seedTask>[2] = {}) => seedTask(config, id, { repos: [{ path: path.join(root, 'app'), worktree: wt }], ...extra });
  return { root, claudeHome, codexHome, config, worktree, claudeSession, codexSession, task };
}

