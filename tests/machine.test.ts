import assert from 'node:assert/strict';
import { it } from 'node:test';
import { collectMachine, recordMachineLoad, machineLine } from '../src/core/machine.ts';
import { Context } from '../src/core/context.ts';
import { readJournal } from '../src/core/journal.ts';
import { DiskRunner, makeConfig, runCli, useScratch } from './helpers.ts';
const scratch = useScratch();
it('machine metrics and threshold transitions persist and deduplicate across reads', async () => {
  const config = makeConfig(scratch.sub('machine'), 'capacity: {load_threshold: 6}\n');
  const ctx = new Context(new DiskRunner({dryRun: false}), config, () => {});
  const sample = collectMachine(config, {loadavg: () => [7, 4, 2], freemem: () => 1024, cpus: () => Array(2)});
  assert.equal(sample.threshold, 6); assert.deepEqual(sample.loadAverage, [7, 4, 2]); assert.equal(sample.freeMemoryBytes, 1024);
  assert.match(machineLine(sample), /7.*4.*2.*free memory/);
  await recordMachineLoad(ctx, {...sample, overloaded: false});
  await recordMachineLoad(ctx, sample); await recordMachineLoad(ctx, sample);
  await recordMachineLoad(ctx, {...sample, overloaded: false});
  assert.deepEqual(readJournal(config).filter(e => e.kind.startsWith('machine-load')).map(e => e.kind), ['machine-load-high', 'machine-load-recovered']);
  assert.equal(collectMachine(makeConfig(scratch.sub('default')), {loadavg: () => [6, 0, 0], freemem: () => 1, cpus: () => Array(2)}).threshold, 6);
  assert.equal(collectMachine(config, {loadavg: () => [6, 9, 9], freemem: () => 1, cpus: () => Array(2)}).overloaded, false);
  const cli = await runCli(config, ctx.runner, ['status', '--detail']);
  assert.equal(cli.code, 0, cli.stderr);
  assert.match(cli.stdout, /load \(1\/5\/15 min\).*free memory/);
  const capacity = await runCli(config, ctx.runner, ['capacity', '--json']);
  assert.equal(capacity.code, 0, capacity.stderr);
  assert.equal(JSON.parse(capacity.stdout).machine.loadAverage.length, 3);
  assert.throws(() => makeConfig(scratch.sub('bad'), 'capacity: {load_threshold: -1}\n'), /load_threshold/);
});

it('R4: an unchanged machine-load state is not rewritten on every tick; a crossing writes once', async () => {
  const config = makeConfig(scratch.sub('machine-r4'), 'capacity: {load_threshold: 6}\n');
  const runner = new class extends DiskRunner {
    writes = 0;
    override async writeFile(file: string, content: string): Promise<void> {
      if (file.endsWith('machine-load.json')) this.writes++;
      await super.writeFile(file, content);
    }
  }({ dryRun: false });
  const ctx = new Context(runner, config, () => {});
  const calm = { loadAverage: [1, 1, 1], freeMemoryBytes: 1, cpuCount: 2, threshold: 6, overloaded: false };
  await recordMachineLoad(ctx, calm);
  await recordMachineLoad(ctx, calm);
  await recordMachineLoad(ctx, calm);
  assert.equal(runner.writes, 1, 'only the first observation writes the state file');
  const hot = { ...calm, overloaded: true };
  await recordMachineLoad(ctx, hot);
  await recordMachineLoad(ctx, hot);
  assert.equal(runner.writes, 2, 'a crossing writes once');
  await recordMachineLoad(ctx, calm);
  assert.equal(runner.writes, 3, 'the return below the threshold writes once');
});
