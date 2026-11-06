import assert from 'node:assert/strict';
import { it } from 'node:test';
import { RefreshScheduler } from '../src/board/refresh-scheduler.ts';
import type { RefreshClock } from '../src/board/refresh-scheduler.ts';
import { boardRefreshMs } from '../src/core/board.ts';

class Clock implements RefreshClock {
  now = 0;
  next = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  set(callback: () => void, delay: number): number {
    const id = ++this.next;
    this.timers.set(id, { at: this.now + delay, callback });
    assert.equal(this.timers.size, 1, 'never stack timers');
    return id;
  }
  clear(timer: unknown): void { this.timers.delete(timer as number); }
  advance(ms: number): void {
    this.now += ms;
    for (const [id, timer] of [...this.timers]) if (timer.at <= this.now) {
      this.timers.delete(id);
      timer.callback();
    }
  }
  due(): number[] { return [...this.timers.values()].map(t => t.at); }
}
// Drain only promise continuations; time is controlled exclusively by Clock.
async function settle(): Promise<void> { for (let i = 0; i < 10; i++) await Promise.resolve(); }

it('F7: all refresh sources own the completion timer; coalesce, recover, change cadence and stop', async () => {
  const clock = new Clock();
  let alive = true;
  let calls = 0;
  let complete!: () => void;
  let fail!: (error: Error) => void;
  const errors: unknown[] = [];
  const scheduler = new RefreshScheduler(() => {
    calls++;
    assert.equal(clock.timers.size, 0, 'no timer while loading');
    return new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
  }, () => boardRefreshMs(alive ? [{ closed: false, cancelled: false, finished: false }] : []), e => errors.push(e), clock);
  scheduler.start();
  assert.equal(calls, 1);
  assert.deepEqual(clock.due(), []);
  clock.advance(9000);
  complete(); await settle();
  assert.deepEqual(clock.due(), [11000]);
  clock.advance(1000);
  scheduler.request(); // Watch/manual load cancels the periodic deadline.
  assert.equal(calls, 2);
  assert.deepEqual(clock.due(), []);
  scheduler.request(); scheduler.request(); // A storm requests exactly one follow-up.
  clock.advance(10000);
  assert.equal(calls, 2);
  assert.deepEqual(clock.due(), []);
  complete(); await settle();
  assert.equal(calls, 3);
  assert.deepEqual(clock.due(), []);
  alive = false;
  fail(new Error('load failed')); await settle();
  assert.equal(errors.length, 1);
  assert.deepEqual(clock.due(), [25000], 'failure re-arms using the idle cadence');
  clock.advance(5000);
  assert.equal(calls, 4);
  alive = true;
  complete(); await settle();
  assert.deepEqual(clock.due(), [27000], 'periodic completion switches back to active cadence');
  scheduler.stop();
  assert.deepEqual(clock.due(), []);
  scheduler.request(); clock.advance(10000); await settle();
  assert.equal(calls, 4, 'stopped scheduler ignores requests');
});

it('F7: exit during an in-flight refresh discards follow-up and never re-arms', async () => {
  const clock = new Clock();
  let complete!: () => void;
  let calls = 0;
  const scheduler = new RefreshScheduler(() => { calls++; return new Promise<void>(r => { complete = r; }); }, () => 2000, assert.fail, clock);
  scheduler.start(); scheduler.request(); scheduler.stop(); complete(); await settle();
  clock.advance(10000);
  assert.equal(calls, 1);
  assert.deepEqual(clock.due(), []);
});
