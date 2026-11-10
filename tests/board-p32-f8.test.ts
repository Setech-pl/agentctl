import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { PassThrough } from 'node:stream';
import { it } from 'node:test';
import React from 'react';
import { render } from 'ink';
import { Board } from '../src/board/app.ts';
import { FakeTmux, makeConfig, makeContext, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();
class Terminal extends EventEmitter {
  columns = 150;
  rows = 30;
  isTTY = true;
  frame = '';
  observe: (frame: string) => void = () => {};
  write(chunk: string, ...rest: unknown[]): boolean {
    this.frame = String(chunk).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
    this.observe(this.frame);
    this.emit('frame');
    (rest.find(r => typeof r === 'function') as (() => void) | undefined)?.();
    return true;
  }
  async until(predicate: () => boolean): Promise<void> {
    while (!predicate()) await new Promise<void>(resolve => this.once('frame', resolve));
  }
}
class Keyboard extends PassThrough {
  isTTY = true;
  setRawMode(): this { return this; }
  ref(): this { return this; }
  unref(): this { return this; }
}

for (const phase of ['scan', 'status'] as const) it(`F8: real Ink/stdin arrows change populated selection during ${phase}`,  { timeout: 15000 }, async () => {
  const config = makeConfig(scratch.sub(`stdin-${phase}`));
  const reports = new Set<string>();
  const tasks: string[] = [];
  for (let i = 1; i <= 130; i++) {
    const record = seedTask(config, `KEY-${String(i).padStart(3, '0')}`, i > 2 ? { closed: true } : {});
    reports.add(record.report);
    tasks.push(`${config.stateDir}/${record.window}/TASK.md`);
  }
  const tmux = new FakeTmux();
  tmux.add('key-001', '● Working\n  esc to interrupt\n');
  tmux.add('key-002', '● Working\n  esc to interrupt\n');
  const { ctx } = makeContext(config, { respond: tmux.respond });
  const terminal = new Terminal();
  const stdin = new Keyboard();
  const app = render(React.createElement(Board, { ctx, insideTmux: false }), {
    stdout: terminal as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true, interactive: true, patchConsole: false, exitOnCtrlC: false,
  });
  const originalStat = fs.statSync;
  const originalOpen = fs.openSync;
  const visited = new Set<string>();
  const handled: { task: string; records: number }[] = [];
  let taskReads = 0;
  let scanReads = -1;
  let armed = false;
  const recordVisited = (name: string): void => {
    if (visited.has(name)) return;
    visited.add(name);
    const index = [25, 50, 75].indexOf(visited.size);
    if (index !== -1) setImmediate(() => stdin.write(index === 1 ? '\u001b[A' : '\u001b[B'));
  };
  const expected = ['KEY-002', 'KEY-001', 'KEY-002'];
  try {
    await terminal.until(() => /▸\s+KEY-001/.test(terminal.frame) && terminal.frame.includes('KEY-001 · last'));
    // Force a cold parse in the scan case; keep the cache warm for the independent status case.
    if (phase === 'scan') for (const file of tasks) fs.appendFileSync(file, '\nchanged prompt\n');
    // Header readers use bounded fd reads; opening a TASK.md marks one scan visit.
    fs.openSync = ((file: unknown, ...args: unknown[]) => {
      const fd = Reflect.apply(originalOpen, fs, [file, ...args]);
      if (armed && tasks.includes(String(file))) {
        taskReads++;
        if (phase === 'scan') recordVisited(String(file));
      }
      return fd;
    }) as typeof fs.openSync;
    fs.statSync = ((file: unknown, ...args: unknown[]) => {
      const name = String(file);
      if (armed && phase === 'status' && reports.has(name) && !visited.has(name)) {
        if (visited.size === 0) scanReads = taskReads;
        recordVisited(name);
      }
      return Reflect.apply(originalStat, fs, [file, ...args]);
    }) as typeof fs.statSync;
    terminal.observe = frame => {
      const task = expected[handled.length];
      if (task && new RegExp(`▸\\s+${task}`).test(frame)) handled.push({ task, records: visited.size });
    };
    armed = true;
    stdin.write('a'); // Real refresh effect, with selection still on KEY-001.
    await terminal.until(() => visited.size === reports.size && terminal.frame.includes('KEY-002 · last'));
    if (phase === 'status') assert.equal(scanReads, 0, 'the warm record scan reads no TASK.md before the status phase');
    assert.deepEqual(handled.map(h => h.task), expected, 'each real arrow changes selection and requests a preview refresh');
    for (const key of handled) assert.ok(key.records > 0 && key.records < reports.size,
      `${key.task} was rendered at ${phase} record ${key.records}/${reports.size}, before ${phase} completed`);
    console.log(`Ink/stdin selection at ${phase} records: ${handled.map(h => `${h.task}=${h.records}/130`).join(', ')}; ${phase === 'status' ? `scan TASK.md reads=${scanReads}` : 'cold parse'}`);
    stdin.write('q');
    await app.waitUntilExit();
  } finally {
    fs.statSync = originalStat;
    fs.openSync = originalOpen;
    app.unmount(); app.cleanup(); stdin.destroy();
  }
});
