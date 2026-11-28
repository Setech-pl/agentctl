import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, DEFAULTS, type Observation, type Driver } from './driver-auto.ts';

const key = { provider: 'codex', version: '0.167.2', host: 'darwin-arm64', cls: 'review' as const };
const day = 24 * 3600_000;
const now = 100 * day;
function obs(driver: Driver, n: number, okRate: number, extra: Partial<Observation> = {}): Observation[] {
  return Array.from({ length: n }, (_, i) => ({ provider: 'codex', version: '0.167.0', host: 'darwin-arm64', driver, cls: 'review', at: now - i * 60_000, outcome: i < Math.round(n * okRate) ? 'report' : 'failed', deliveryAcked: true, lostPrompt: false, interventions: 1, unknownEvents: 0, ...extra }));
}

test('too few observations: keep screen', () => {
  assert.equal(decide([...obs('screen', 30, 0.8), ...obs('protocol', 10, 1)], key, undefined, now).driver, 'screen');
});

test('candidate clearly better with enough N: promote', () => {
  const d = decide([...obs('screen', 30, 0.8), ...obs('protocol', 25, 0.92)], key, undefined, now);
  assert.equal(d.driver, 'protocol');
  assert.match(d.reason, /promote/);
});

test('hysteresis: a marginal gain does not promote, a marginal loss does not demote', () => {
  assert.equal(decide([...obs('screen', 30, 0.8), ...obs('protocol', 25, 0.83)], key, undefined, now).driver, 'screen');
  assert.equal(decide([...obs('screen', 30, 0.8), ...obs('protocol', 25, 0.74)], key, { driver: 'protocol', since: now - 3 * day }, now).driver, 'protocol');
});

test('fail closed: two incidents send the incumbent protocol driver back to screen even during cooldown', () => {
  const p = obs('protocol', 25, 0.95); p[0]!.lostPrompt = true; p[1]!.stuckMin = 30;
  const d = decide([...obs('screen', 30, 0.8), ...p], key, { driver: 'protocol', since: now - 1000 }, now);
  assert.equal(d.driver, 'screen');
  assert.match(d.reason, /incidents/);
});

test('cooldown blocks a fresh promotion; a minor version bump starts history over; pin wins', () => {
  const data = [...obs('screen', 30, 0.8), ...obs('protocol', 25, 0.95)];
  assert.equal(decide(data, key, { driver: 'screen', since: now - 1000 }, now).reason, 'cooldown since last switch');
  assert.equal(decide(data, { ...key, version: '0.168.0' }, undefined, now).driver, 'screen');
  assert.equal(decide(data, key, undefined, now, { ...DEFAULTS, pin: { driver: 'screen', version: '0.167.*' } }).driver, 'screen');
});

test('headless is never chosen for interactive tasks', () => {
  const data = [...obs('screen', 30, 0.5), ...obs('headless', 30, 1)].map(o => ({ ...o, cls: 'interactive' as const }));
  assert.equal(decide(data, { ...key, cls: 'interactive' }, undefined, now, { ...DEFAULTS, allowed: ['screen', 'headless'] }).driver, 'screen');
});
