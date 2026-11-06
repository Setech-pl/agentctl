import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { archiveDir, renderTaskMd, snapshotRecords, taskDir, recordScanStats } from '../src/core/taskstore.ts';
import type { TaskRecord } from '../src/core/taskstore.ts';
import { makeConfig, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();

/** A minimal archived record (the archive counts it as closed, whatever the header says). */
function archiveTask(config: ReturnType<typeof makeConfig>, task: string, extra: Partial<TaskRecord> = {}): void {
  const window = task.toLowerCase();
  const record: TaskRecord = {
    task,
    window,
    session: config.session,
    agent: 'claude',
    model: 'opus',
    effort: 'high',
    repos: [],
    links: [],
    env: {},
    report: path.join(config.cache, window, `${task}.md`),
    started: new Date(Date.UTC(2026, 9, 31, 11, 0, 0)).toISOString(),
    closed: true,
    closedAt: new Date(Date.UTC(2026, 10, 1, 11, 0, 0)).toISOString(),
    turnEndedAt: new Date(Date.UTC(2026, 10, 1, 11, 0, 0)).toISOString(),
    requested: { agent: 'claude', model: 'opus', effort: 'high' },
    ...extra,
  };
  const dir = path.join(archiveDir(config), window);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'TASK.md'), renderTaskMd(record, `Do ${task}.`));
}

describe('p32: record scan cache', () => {
  it('parses each TASK.md once; an unchanged scan parses nothing again', async () => {
    const config = makeConfig(scratch.sub('rc1'));
    seedTask(config, 'RC-1');
    seedTask(config, 'RC-2');
    archiveTask(config, 'RC-3');
    const first = await snapshotRecords(config);
    assert.equal(first.parsed, 3);
    assert.deepEqual(first.current.map((r) => r.task), ['RC-1', 'RC-2']);
    assert.deepEqual(first.archived.map((r) => r.task), ['RC-3']);
    assert.deepEqual(first.all.map((r) => r.task), ['RC-1', 'RC-2', 'RC-3']);
    const second = await snapshotRecords(config);
    assert.equal(second.parsed, 0, 'no TASK.md changed: nothing is read or parsed again');
    assert.deepEqual(second.all.map((r) => r.task), ['RC-1', 'RC-2', 'RC-3']);
  });

  it('re-parses only the TASK.md that changed, and drops removed tasks', async () => {
    const config = makeConfig(scratch.sub('rc2'));
    seedTask(config, 'RC-1');
    seedTask(config, 'RC-2');
    const first = await snapshotRecords(config);
    assert.equal(first.parsed, 2);
    // A different size makes the change visible even inside one mtime tick.
    const file = path.join(taskDir(config, 'rc-1'), 'TASK.md');
    fs.appendFileSync(file, '\nmore prompt text\n');
    const second = await snapshotRecords(config);
    assert.equal(second.parsed, 1, 'only the appended TASK.md is read again');
    fs.rmSync(taskDir(config, 'rc-2'), { recursive: true, force: true });
    const third = await snapshotRecords(config);
    assert.equal(third.parsed, 0);
    assert.deepEqual(third.all.map((r) => r.task), ['RC-1'], 'the removed task leaves the snapshot');
  });

  it('counts the parses cumulatively for the tick regression assertions', async () => {
    const config = makeConfig(scratch.sub('rc3'));
    seedTask(config, 'RC-1');
    const before = recordScanStats.parsed;
    await snapshotRecords(config);
    assert.equal(recordScanStats.parsed, before + 1);
    await snapshotRecords(config);
    assert.equal(recordScanStats.parsed, before + 1, 'cached: no further parses');
  });
});
