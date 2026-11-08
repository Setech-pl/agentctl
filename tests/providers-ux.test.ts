import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { reviewOrder } from '../src/core/review.ts';
import { planMove } from '../src/core/move.ts';
import { limitText } from '../src/core/event-command.ts';
import { usagePanel } from '../src/core/board.ts';
import { planStatusLine } from '../src/core/usage-report.ts';
import { readPlans } from '../src/core/usage.ts';
import { UsageReader } from '../src/core/usage-sources.ts';
import { kimiPlanFile } from '../src/core/providers/kimi-usage.ts';
import { provider } from '../src/core/providers/registry.ts';
import { providerHint, pendingAlerts, queueHolds } from '../src/core/usage-limits.ts';
import { collectCapacity } from '../src/core/capacity.ts';
import { makeConfig, makeContext, seedTask, useScratch, FakeTmux } from './helpers.ts';
const scratch = useScratch();
function setup(name: string, extra = '') {
  const dir = scratch.sub(name), home = path.join(dir, 'kimi'); fs.mkdirSync(home);
  const config = makeConfig(dir, `providers: [claude, codex, kimi]\ncapacity: {codex_refresh: false}\nusage: {kimi_dir: ${home}, queue_hold: {kimi: 90}}\n${extra}`);
  return { config, dir, home };
}
it('selects the first installed mapped reviewer using prefer or active order, skipping the author', async () => {
  const { config } = setup('review', 'review: {prefer: [codex, kimi, claude]}\n');
  const author = seedTask(config, 'AUTHOR', { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'high' });
  const { ctx } = makeContext(config, { respond: cmd => cmd === 'codex' ? { code: 1 } : undefined });
  assert.deepEqual(await reviewOrder(ctx, author, {}), { order: { agent: 'kimi', model: 'k3', effort: 'high' }, rule: 'different provider (kimi)' });
  const all = makeContext(config).ctx;
  assert.equal((await reviewOrder(all, author, { prefer: ['claude', 'kimi', 'codex'] })).order.agent, 'kimi');
  assert.equal((await reviewOrder(all, author, { prefer: ['codex', 'kimi'] })).order.agent, 'codex');
  config.equivalents.unshift({ claude: { model: 'claude-sonnet-5-5', effort: 'high' }, kimi: { model: 'k3', effort: 'high' } } as typeof config.equivalents[number]);
  config.equivalents = config.equivalents.filter(e => !e.codex || e.codex.model !== 'gpt-6.1-sol');
  assert.equal((await reviewOrder(all, author, { prefer: ['codex', 'kimi'] })).order.agent, 'kimi');
});
it('warns about inactive provider settings and validates review preferences', () => {
  const config = makeConfig(scratch.sub('inactive'), 'limits: {kimi: 2}\nagents: {kimi: {flags: []}}\n');
  assert.match(config.warnings?.join(' ') ?? '', /kimi is not in providers/);
  assert.throws(() => makeConfig(scratch.sub('bad-prefer'), 'review: {prefer: [kimi, kimi]}\n'), /review.prefer/);
});
it('requires an explicit move target among three providers and shows slots and percentages', async () => {
  const { config, dir } = setup('move', 'limits: {codex: 2, kimi: 1}\n');
  const wt = path.join(dir, 'wt'); fs.mkdirSync(wt);
  const author = seedTask(config, 'MOVE', { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'high', repos: [{ path: dir, worktree: wt }] });
  const tmux = new FakeTmux(config.session), { ctx } = makeContext(config, { respond: tmux.respond });
  await assert.rejects(planMove(ctx, author.task), /wybierz dostawcę: --agent codex\|kimi.*free slots 2.*usage n\/d.*free slots 1/);
  assert.equal((await planMove(ctx, author.task, { agent: 'kimi' })).to.agent, 'kimi');
  assert.match(limitText(author, config.providers), /--agent <codex\|kimi>.*\(codex, kimi\)/);
});
it('renders three-provider plans, queue holds, alerts, capacity and statusline', async () => {
  const { config } = setup('plans'), now = Date.now();
  for (const [id, percent] of [['claude', 62], ['codex', 18], ['kimi', 40]] as const) {
    const file = id === 'kimi' ? kimiPlanFile(config) : path.join(path.dirname(config.path), 'usage', `${id}-plan.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ at: now, windows: [{ kind: 'session', minutes: 300, usedPercent: percent, resetsAt: null }] }));
  }
  const plans = readPlans(config, new UsageReader(undefined), now);
  assert.equal(planStatusLine(plans), 'C 62% · X 18% · K 40%');
  assert.deepEqual(usagePanel(plans, config.usage, now).map(p => p.provider), ['claude', 'codex', 'kimi']);
  plans.kimi!.windows[0]!.usedPercent = 96; plans.kimi!.maxPercent = 96;
  assert.match(providerHint(config, plans, 'kimi')!, /claude ma zapas.*codex ma zapas/);
  assert.equal(pendingAlerts(config, plans, {}).filter(a => a.provider === 'kimi')[0]?.level, 'critical');
  assert.match(queueHolds(config, now, plans).kimi!, /kimi 96%/);
  const ctx = makeContext(config, { respond: new FakeTmux(config.session).respond }).ctx;
  config.equivalents.unshift({ claude: { model: 'special', effort: 'high' }, kimi: { model: 'custom', effort: 'high' } } as typeof config.equivalents[number]);
  assert.deepEqual((await collectCapacity(ctx)).providers.map(p => p.provider), ['claude', 'codex', 'kimi']);
});
it('uses dynamic Kimi display versions, ON for models without efforts, and explicit version overrides', () => {
  const { home } = setup('labels');
  fs.writeFileSync(path.join(home, 'config.toml'), `[models.'kimi-code/kimi-for-coding']\ndisplay_name='K2.8 Preview'\nsupport_efforts=['max']\n[models.'kimi-code/highspeed']\ndisplay_name='K2.7 Code Highspeed'\nsupport_efforts=[]\n`);
  const previous = process.env.KIMI_CODE_HOME; process.env.KIMI_CODE_HOME = home;
  try {
    const label = provider('kimi').models.label;
    assert.equal(label('kimi-for-coding', 'max'), 'K 2.8 MX');
    assert.equal(label('highspeed', 'high'), 'K 2.7 ON');
    assert.equal(label('kimi-for-coding', 'max', null, { 'kimi-for-coding': '3.1' }), 'K 3.1 MX');
  } finally { if (previous === undefined) delete process.env.KIMI_CODE_HOME; else process.env.KIMI_CODE_HOME = previous; }
});
