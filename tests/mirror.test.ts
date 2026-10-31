import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadGlobalConfig } from '../src/core/config.ts';
import { syncMirror } from '../src/core/mirror.ts';
import { pullTask } from '../src/core/pull.ts';
import { resolveSpec, splitSpecs } from '../src/core/spec.ts';
import { collectStatus, reportStatus } from '../src/core/status.ts';
import { recordFromSpec, renderTaskMd, taskFile } from '../src/core/taskstore.ts';
import { makeConfig, makeContext, useScratch } from './helpers.ts';

const scratch = useScratch();

function setup(name: string, mirrorYaml: string) {
  const root = scratch.sub(name);
  const repo = scratch.sub(`${name}/app`);
  const config = makeConfig(root, mirrorYaml.replace('MIRROR', path.join(root, 'mirror')));
  const report = path.join(root, 'NC-1.md');
  const [spec] = splitSpecs(`---\ntask: NC-1\nagent: claude\nreport: ${report}\nrepos:\n  - {path: ${repo}, worktree: ${repo}-1}\n---\nGo\n`).map((raw) =>
    resolveSpec(raw, { config, loadProject: () => undefined }),
  );
  fs.mkdirSync(path.dirname(taskFile(config, 'nc-1')), { recursive: true });
  fs.writeFileSync(taskFile(config, 'nc-1'), renderTaskMd(recordFromSpec(spec!, config, Date.UTC(2026, 9, 31, 10)), 'Go'));
  return { root, config, report, mirror: path.join(root, 'mirror') };
}
const windows = (cmd: string, args: string[]) => (cmd === 'tmux' && args[0] === 'list-windows' ? { stdout: 'nc-1\n' } : undefined);

describe('mirror', () => {
  it('is off by default: nothing is copied or written', async () => {
    const { config, report } = setup('mirror-off', '');
    fs.writeFileSync(report, 'done');
    assert.equal(config.mirrorDir, undefined);
    const { ctx, runner } = makeContext(config, { respond: windows });
    const { mirror } = await reportStatus(ctx);
    assert.equal(mirror, undefined);
    assert.deepEqual(runner.commands, []);
  });

  it('status copies the report into <mirror_dir>/<task>/ and writes status.json', async () => {
    const { config, report, mirror } = setup('mirror-status', 'mirror_dir: MIRROR\n');
    fs.writeFileSync(report, '# Report');
    const { ctx, runner } = makeContext(config, { respond: windows });
    const result = await reportStatus(ctx);
    assert.deepEqual(runner.commands, [
      `mkdir -p ${mirror}/nc-1`,
      `cp ${report} ${mirror}/nc-1/NC-1.md`,
      `mkdir -p ${mirror}`,
      expectBytes(runner.written.get(`${mirror}/status.json`) as string, `${mirror}/status.json`),
    ]);
    assert.deepEqual(result.mirror?.copied, [`${mirror}/nc-1/NC-1.md`]);
    const json = JSON.parse(runner.written.get(`${mirror}/status.json`) as string);
    assert.equal(json.session, 'agentctl');
    assert.deepEqual(json.tasks.map((t: { task: string; state: string; report: string }) => [t.task, t.state, t.report]), [['NC-1', 'report-ready', 'yes']]);
  });

  it('copies a report only when it is new or changed, but always refreshes status.json', async () => {
    const { config, report, mirror } = setup('mirror-delta', 'mirror_dir: MIRROR\n');
    fs.writeFileSync(report, '# Report');
    fs.mkdirSync(path.join(mirror, 'nc-1'), { recursive: true });
    fs.copyFileSync(report, path.join(mirror, 'nc-1', 'NC-1.md'));
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(mirror, 'nc-1', 'NC-1.md'), future, future);
    const { ctx, runner } = makeContext(config, { respond: windows });
    const rows = await collectStatus(ctx);
    const result = await syncMirror(ctx, rows);
    assert.deepEqual(result?.copied, []);
    assert.ok(runner.written.has(`${mirror}/status.json`));
    assert.ok(!runner.commands.some((c) => c.startsWith('cp ')));

    fs.writeFileSync(report, '# Report, edited and longer');
    const again = await syncMirror(ctx, await collectStatus(ctx));
    assert.equal(again?.copied.length, 1);
  });

  it('skips tasks without a report', async () => {
    const { config, mirror } = setup('mirror-none', 'mirror_dir: MIRROR\n');
    const { ctx, runner } = makeContext(config, { respond: windows });
    const result = await syncMirror(ctx, await collectStatus(ctx));
    assert.deepEqual(result?.copied, []);
    assert.deepEqual(runner.commands.filter((c) => c.startsWith('cp ')), []);
    assert.ok(runner.written.has(`${mirror}/status.json`));
  });

  it('pull refreshes the mirror as well', async () => {
    const { config, report, mirror } = setup('mirror-pull', 'mirror_dir: MIRROR\n');
    fs.writeFileSync(report, '# Report');
    const { ctx, runner } = makeContext(config, { respond: (cmd, args) => (cmd === 'sh' ? { code: 0 } : windows(cmd, args)) });
    await pullTask(ctx, 'NC-1', 'darwin');
    assert.ok(runner.commands.includes(`cp ${report} ${mirror}/nc-1/NC-1.md`));
    assert.ok(runner.commands.includes('pbcopy'));
  });

  it('mirror_dir must be a non-empty string', () => {
    const dir = scratch.sub('mirror-bad');
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'mirror_dir: 5\n');
    assert.throws(() => loadGlobalConfig(dir), /config\.mirror_dir must be a non-empty string/);
  });
});

function expectBytes(content: string, file: string): string {
  return `write ${file} (${Buffer.byteLength(content)} bytes)`;
}
