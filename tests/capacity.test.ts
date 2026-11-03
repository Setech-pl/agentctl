import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { collectCapacity, capacitySnapshot, capacityTrend, renderCapacity } from '../src/core/capacity.ts';
import { collectGuide, dispatcherGuide } from '../src/core/guide.ts';
import { readJournal } from '../src/core/journal.ts';
import { openReader, readPlans } from '../src/core/usage.ts';
import { readSamples, recordSamples, samplesPath } from '../src/core/usage-samples.ts';
import type { UsageSample } from '../src/core/usage-samples.ts';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import { loadViewLines } from '../src/core/board.ts';
import { Context } from '../src/core/context.ts';
import { DiskRunner, FakeTmux, makeConfig, runCli, useScratch } from './helpers.ts';
import { makeWorld, setClaudePlan } from './usage-world.ts';
const scratch = useScratch();
const NOW = Date.parse('2026-11-03T12:00:00Z');
const w = { kind: 'session' as const, minutes: 300, label: '5h', usedPercent: 40, resetsAt: NOW + 3_600_000 };
const samples = (values = [20, 30, 40]): UsageSample[] => values.map((usedPercent, i) => ({ provider: 'claude', at: NOW - (values.length - 1 - i) * 300_000, capturedAt: NOW - (values.length - 1 - i) * 300_000, taskTokens: i * 10000, windows: [{ ...w, usedPercent }] }));
const world = (name: string, yaml = '') => {
  const config = makeConfig(scratch.sub(name), yaml);
  const fake = new FakeTmux();
  const runner = new DiskRunner({ dryRun: false, startTime: NOW, respond: fake.respond });
  return { config, fake, runner, ctx: new Context(runner, config, () => {}) };
};

describe('capacity: honest trends and estimates', () => {
  it('uses same-window sample deltas; explicitly estimates fresh tokens and exposes unknown attribution', () => {
    const result = capacityTrend(samples(), 'claude', w);
    assert.equal(result.percentPerHour, 120);
    assert.equal(result.projectedExhaustAt, new Date(NOW + 1_800_000).toISOString());
    assert.equal(result.estimate?.tokensPerPercent, 1000);
    assert.equal(result.estimate?.remainingTokens, 60000);
    assert.equal(result.estimate?.basis.samples, 3);
    assert.equal(result.estimate?.basis.agentctlTokenShare, null);
    assert.equal(result.estimate?.confidence, 'low');
  });
  it('insufficient samples and flat usage cannot imply exhaustion or token budget', () => {
    assert.equal(capacityTrend(samples([20]), 'claude', w).percentPerHour, null);
    const flat = capacityTrend(samples([40, 40, 40]), 'claude', w);
    assert.equal(flat.percentPerHour, 0);
    assert.equal(flat.projectedExhaustAt, null);
    assert.equal(flat.estimate, null);
  });
  it('does not bridge resets, decreasing counters or percentage corrections', () => {
    const reset = samples(); reset[1]!.windows[0]!.resetsAt = NOW + 99;
    assert.equal(capacityTrend(reset, 'claude', w).percentPerHour, null);
    assert.equal(capacityTrend(samples([80, 10, 40]), 'claude', w).estimate, null);
    const correction = samples(); correction[1]!.taskTokens = 30000;
    assert.equal(capacityTrend(correction, 'claude', w).estimate, null);
  });
  it('does not use delayed historical readings, tiny percentages or short intervals for token estimates', () => {
    const delayed = samples(); delayed[0]!.capturedAt += 61_000;
    assert.equal(capacityTrend(delayed, 'claude', w).estimate, null);
    assert.equal(capacityTrend(samples([39, 39.5, 40]), 'claude', w).estimate, null);
    const fast = samples().map((s, i) => ({ ...s, at: NOW + i * 1000, capturedAt: NOW + i * 1000 }));
    assert.equal(capacityTrend(fast, 'claude', w).percentPerHour, null);
  });
});

describe('capacity: current facts and bounded history', () => {
  it('missing windows are n/d, unconfigured slots unbounded, no history of closed tasks', async () => {
    const t = world('empty');
    const c = await collectCapacity(t.ctx);
    assert.equal(c.providers.length, 2);
    assert.equal(c.providers[0]!.ageSeconds, null);
    assert.deepEqual(c.providers[0]!.windows, []);
    assert.equal(c.providers[0]!.slots.free, null);
    assert.equal(c.providers[0]!.limited, null);
    assert.equal(c.providers[0]!.estimate, null);
    assert.ok(!('tasks' in c));
    assert.match(renderCapacity(c).join('\n'), /n\/d/);
  });
  it('reads a changing plan on every call, counts free and reserved slots and marks the order', async () => {
    const t = world('fresh', 'limits: {claude: 3}\n');
    setClaudePlan(t.config.path, NOW, { session: 30, week: 60 }, 0);
    const c = await collectCapacity(t.ctx);
    assert.equal(c.providers[0]!.windows[1]!.remainingPercent, 40);
    assert.equal(c.providers[0]!.ageSeconds, 0);
    assert.equal(c.providers[0]!.slots.free, 3);
    const snap = capacitySnapshot(c, ['claude']);
    assert.equal(snap[0]!.remainingPercent, 40);
    assert.equal(snap[0]!.ordered, true);
    assert.equal(snap[1]!.ordered, false);
    await t.runner.sleep(1000);
    setClaudePlan(t.config.path, NOW + 1000, { session: 90, week: 60 }, 0);
    const next = await collectCapacity(t.ctx);
    assert.equal(next.providers[0]!.windows[0]!.usedPercent, 90);
    assert.equal(next.providers[0]!.ageSeconds, 0);
    assert.deepEqual(next.providers[0]!.hints.filter((h) => h.includes('usage >=')), ['5h usage >= 80%']);
  });
  it('records usage reads once per source timestamp, bounds the sample file and emits thresholds and resets once', () => {
    const t = world('samples', 'capacity: {sample_limit: 3}\n');
    const plan = (at: number, percent: number) => {
      setClaudePlan(t.config.path, at, { session: percent, week: 2 }, 0);
      const file = path.join(path.dirname(t.config.path), 'usage/claude-plan.json');
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')); raw.windows[0].resetsAt = (NOW + 7200000) / 1000; raw.windows[1].resetsAt = (NOW + 4 * 86400000) / 1000;
      fs.writeFileSync(file, JSON.stringify(raw));
      const r = openReader(t.config); const p = readPlans(t.config, r, at); r.save(); return p;
    };
    plan(NOW, 79); plan(NOW + 1000, 96); plan(NOW + 1000, 96);
    assert.equal(readSamples(t.config).filter((s) => s.provider === 'claude').length, 2);
    assert.equal(readJournal(t.config).filter((e) => /crossed/.test(e.text)).length, 2);
    const p = plan(NOW + 2000, 96);
    recordSamples(t.config, p, { claude: 0, codex: 0 }, NOW + 8_000_000);
    recordSamples(t.config, p, { claude: 0, codex: 0 }, NOW + 8_000_000);
    assert.equal(readJournal(t.config).filter((e) => /5h: window reset/.test(e.text)).length, 1, 'the expired window is announced once');
    plan(NOW + 9000, 5);
    assert.equal(readSamples(t.config).length, 3);
    assert.ok(fs.statSync(samplesPath(t.config)).size < 5000);
  });
  it('invalid/torn samples are ignored', () => {
    const t = world('corrupt');
    fs.writeFileSync(samplesPath(t.config), '{bad\n{}\n');
    assert.deepEqual(readSamples(t.config), []);
  });
  it('calls only the read RPC, labels provenance and falls back without a false fresh timestamp', async () => {
    const config = makeConfig(scratch.sub('rpc'));
    let calls = 0;
    const runner = new DiskRunner({ dryRun: false, startTime: NOW, respond: (cmd, args, opts) => {
      if (cmd === 'codex') {
        assert.deepEqual(args, ['app-server']);
        assert.equal(opts.rpc?.method, 'account/rateLimits/read'); calls++;
        return calls === 1 ? { stdout: JSON.stringify({ rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: (NOW + 3_600_000) / 1000 } } }) } : { code: 1, stdout: '' };
      }
      return { code: 1 };
    } });
    const ctx = new Context(runner, config, () => {});
    assert.equal((await collectCapacity(ctx)).providers[1]!.source, 'codex-app-server:account/rateLimits/read');
    await runner.sleep(5000);
    const fallback = (await collectCapacity(ctx)).providers[1]!;
    assert.equal(fallback.ageSeconds, 5);
    assert.match(fallback.note, /unavailable/);
    assert.equal(calls, 2);
  });
  it('board C uses the same capacity data', async () => {
    const t = world('board');
    assert.match((await loadViewLines(t.ctx, 'capacity')).join('\n'), /capacity: claude/);
  });
  it('configuration validates thresholds, language, bounds and disabling the snapshot', () => {
    const t = world('cfg', 'guide: {lang: pl}\ncapacity: {snapshot: false, thresholds: [70, 90], stale_minutes: 10, sample_limit: 10, codex_refresh: false}\n');
    assert.equal(t.config.guideLang, 'pl'); assert.equal(t.config.capacity.snapshot, false);
    assert.deepEqual(t.config.capacity.thresholds, [70, 90]);
    assert.throws(() => makeConfig(scratch.sub('badcfg'), 'capacity: {sample_limit: 10001, thresholds: [101]}\n'), /sample_limit/);
  });
});

describe('guide: one source across fronts', () => {
  it('supports EN/PL, project-relative and missing overlays without failing', () => {
    const t = world('guide');
    const repo = scratch.sub('guide-project');
    fs.writeFileSync(path.join(repo, '.agentctl.yaml'), 'guide: rules.md\n');
    fs.writeFileSync(path.join(repo, 'rules.md'), 'Project-specific constraint.\n');
    const g = collectGuide(t.config, { project: repo, lang: 'pl' });
    assert.ok(g.text.startsWith(dispatcherGuide('pl'))); assert.match(g.text, /Zasady projektu[\s\S]*Project-specific/);
    fs.unlinkSync(path.join(repo, 'rules.md'));
    assert.equal(collectGuide(t.config, { project: repo }).warnings.length, 1);
  });
  it('CLI JSON, version alias and MCP read tools work without mcp.allow', async () => {
    const t = world('fronts');
    const cli = await runCli(t.config, t.runner, ['guide', '--lang', 'pl', '--json']);
    assert.equal(cli.code, 0); assert.equal(JSON.parse(cli.stdout).text, dispatcherGuide('pl'));
    const cap = await runCli(t.config, t.runner, ['capacity', '--json']);
    assert.equal(cap.code, 0); assert.equal(JSON.parse(cap.stdout).providers.length, 2);
    const deps = { context: () => t.ctx, notify: async () => {} };
    for (const name of ['guide', 'capacity']) {
      const tool = MCP_TOOLS.find((t) => t.name === name)!;
      assert.equal(tool.kind, 'read'); const result = await tool.run(deps, {});
      assert.notEqual(result.isError, true); assert.ok(result.text.length > 100);
    }
    const v = await runCli(t.config, t.runner, ['version']);
    const flag = await runCli(t.config, t.runner, ['--version']);
    assert.equal(v.stdout, flag.stdout);
  });
});
