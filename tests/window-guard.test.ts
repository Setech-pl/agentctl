import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { makeConfig, seedTask, useScratch, FakeTmux, DiskRunner } from './helpers.ts';
import { assertAgentSpawnAllowed, openAgentWindow } from '../src/core/window-guard.ts';

const scratch = useScratch();
const root = path.resolve(import.meta.dirname, '..');

describe('the one door of every agent window (FIX3 N1)', () => {
  it('refuses a review whose report or checkout is the author\'s, and makes no window', async () => {
    const dir = scratch.sub('door'), config = makeConfig(dir, 'capacity: {snapshot: false, codex_refresh: false}\n');
    const tmux = new FakeTmux(), runner = new DiskRunner({ dryRun: false, startTime: Date.now(), respond: (cmd, args, opts) => tmux.respond(cmd, args, opts) });
    const ctx = new Context(runner, config, () => {});
    const worktree = path.join(dir, 'author-wt'); fs.mkdirSync(worktree);
    const author = seedTask(config, 'AUTHOR', { repos: [{ path: dir, worktree, branch: 'author', base: 'a'.repeat(40) }] });
    const request = { task: 'AUTHOR-REV', window: 'author-rev', env: {}, reviewOf: 'AUTHOR', sessionUp: true, origin: 'new' as const };
    await assert.rejects(() => openAgentWindow(ctx, { ...request, cwd: worktree, report: author.report, repos: author.repos }), /start refused/);
    await assert.rejects(() => openAgentWindow(ctx, { ...request, cwd: worktree, report: path.join(dir, 'own.md'), repos: author.repos }), /overlaps the author's checkout/);
    assert.ok(!tmux.windows.some(w => w.name === 'author-rev'));
    await openAgentWindow(ctx, { ...request, cwd: path.join(dir, 'own-wt'), report: path.join(dir, 'own.md'), repos: [{ worktree: path.join(dir, 'own-wt') }] });
    assert.ok(tmux.windows.some(w => w.name === 'author-rev'), 'a review with its own report and checkout gets its window');
    assert.doesNotThrow(() => assertAgentSpawnAllowed(ctx, { task: 'PLAIN', report: author.report, repos: author.repos, origin: 'new' }), 'a task that reviews nothing is not checked');
  });
  it('inventory: only the door creates a window for a task; a path around it fails this test', () => {
    const allowed = new Set(['src/core/window-guard.ts', 'src/core/tmux.ts', 'src/core/manager.ts', 'src/core/windows.ts']);
    const found: string[] = [];
    const walk = (dir: string): void => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.ts') && /\.(?:newWindow|newSession|startWindow)\(/.test(fs.readFileSync(p, 'utf8')) && !allowed.has(path.relative(root, p))) found.push(path.relative(root, p)); } };
    walk(path.join(root, 'src'));
    assert.deepEqual(found, [], `these files create tmux windows without openAgentWindow: ${found.join(', ')}`);
    for (const name of ['new.ts', 'resume.ts']) assert.match(fs.readFileSync(path.join(root, 'src/core', name), 'utf8'), /openAgentWindow\(/, `${name} opens its window through the door`);
  });
});
