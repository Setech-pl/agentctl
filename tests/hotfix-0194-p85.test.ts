import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, it } from 'node:test';
import { world, scratch } from './hotfix-0194-fixture.ts';
import { seedTask } from './helpers.ts';
import { performance } from 'node:perf_hooks';
const w = world('doctor'); const repo = scratch.sub('doctor/repo'); const wt = scratch.sub('doctor/worktree');
before(() => {
  // 300,000 regular-file paths exercise the same walk; reuse one inode per package
  // so inode allocation/freeing cannot dominate fixture setup and teardown.
  const seeds = scratch.sub('doctor/seeds');
  for (let d = 0; d < 300; d++) {
    const seed = path.join(seeds, `${d}.js`); fs.writeFileSync(seed, 'fixture');
    const dir = path.join(wt, 'node_modules', `pkg-${d}`); fs.mkdirSync(dir, { recursive: true });
    for (let f = 0; f < 1000; f++) fs.linkSync(seed, path.join(dir, `${f}.js`));
  }
  for (let i = 0; i < 400; i++) seedTask(w.config, `DOCTOR-${i}`, { repos: [{ path: repo, worktree: wt }], links: ['shared', 'deps', 'assets'].map(from => ({ from, to: repo })) });
});
it('P85: MCP doctor stays under 2 s on 400 records / 300k files and never walks worktrees', { timeout: 180_000 }, async () => {
  const readdir = fs.readdirSync; let walks = 0;
  fs.readdirSync = ((file: fs.PathLike, ...args: unknown[]) => { if (String(file).startsWith(wt)) walks++; return (readdir as Function)(file, ...args); }) as typeof fs.readdirSync;
  try {
    const start = performance.now(); const result = await w.call('doctor', {}); const ms = performance.now() - start;
    console.log(`HOTFIX_TIMING ${JSON.stringify({ name: 'MCP doctor', ms, records: 400, files: 300000 })}`);
    assert.equal(result.isError, undefined, result.text); assert.doesNotMatch(result.text, /Partial result/);
    assert.match(result.text, /per-task report\/link\/settings checks skipped/);
    assert.equal(walks, 0); assert.ok(ms < 2000, `${ms.toFixed(1)} ms >= 2000 ms`);
  } finally { fs.readdirSync = readdir; }
});
