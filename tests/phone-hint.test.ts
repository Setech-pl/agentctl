import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Alerts } from '../src/core/alert.ts';
import { setAway } from '../src/core/away.ts';
import { Context } from '../src/core/context.ts';
import { handleEvent } from '../src/core/event-command.ts';
import type { Notifier } from '../src/core/notify.ts';
import { phoneHint } from '../src/core/phone-send.ts';
import { HINTED_EVENTS, phoneMessage, safeVerdict } from '../src/core/phone.ts';
import type { FetchLike } from '../src/core/phone.ts';
import { managerPhoneHint, rcAnswerHint } from '../src/core/remote-control.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();
const IDLE = 'Welcome\n❯ Try "x"\n  ⏵⏵ auto mode on';
const NTFY = 'notify:\n  ntfy:\n    server: https://ntfy.example.com\n    topic: agentctl-0123456789abcdef01234567\n';
const REPORT = '# Raport NC-1\n\nWerdykt: PASS – 12 testów\n';
const ntfy = { priority: { 'needs-input': 'high', 'report-ready': 'default', 'cohort-done': 'default' }, includeVerdict: true } as never;

class Quiet implements Notifier {
  async notify(): Promise<void> {}
}

function setup(name: string, task: Parameters<typeof seedTask>[2] = {}, yaml = NTFY) {
  const config = makeConfig(scratch.sub(name), yaml);
  const fake = new FakeTmux();
  const runner = new DiskRunner({ dryRun: false, respond: fake.respond, startTime: Date.now() });
  const ctx = new Context(runner, config, () => {});
  const bodies: string[] = [];
  ctx.fetch = (async (_url, init) => {
    bodies.push(String(init.body));
    return new Response('{}', { status: 200 });
  }) as FetchLike;
  const record = seedTask(config, 'NC-1', task);
  fake.add('nc-1', IDLE);
  fs.mkdirSync(path.dirname(record.report), { recursive: true });
  fs.writeFileSync(record.report, REPORT);
  const alerts = new Alerts(ctx, new Quiet(), { env: {} });
  const event = (kind: 'stop' | 'notification', payload: unknown) => handleEvent(ctx, alerts, { task: 'NC-1', agent: 'claude', kind, payload });
  return { config, ctx, fake, bodies, event, record };
}

describe('phone: the hint where to answer', () => {
  it('the pure message: a hint goes under the body of the three events that wait for a human, and under no other', () => {
    const hint = managerPhoneHint('agentctl manager');
    assert.equal(hint, 'Otwórz sesję „agentctl manager” w aplikacji Claude.');
    assert.equal(phoneMessage('report-ready', { task: 'NC-1', verdict: 'PASS', hint }, ntfy)?.body, `NC-1: raport gotowy – PASS\n${hint}`);
    assert.equal(phoneMessage('needs-input', { task: 'NC-1', hint }, ntfy)?.body, `NC-1: pytanie agenta – otwórz okno\n${hint}`);
    assert.equal(phoneMessage('cohort-done', { cohort: 'sprint', hint }, ntfy)?.body, `kohorta sprint: wszystkie raporty gotowe\n${hint}`);
    assert.equal(phoneMessage('limited', { task: 'NC-1', hint }, ntfy)?.body, 'NC-1: agent wyczerpał limit użycia');
    assert.deepEqual([...HINTED_EVENTS], ['needs-input', 'report-ready', 'cohort-done']);
    assert.equal(phoneMessage('report-ready', { task: 'NC-1' }, ntfy)?.body, 'NC-1: raport gotowy', 'no hint, no change');
    assert.equal(rcAnswerHint('NC-1'), 'Odpowiesz w aplikacji Claude: NC-1');
  });

  it('report-ready while the manager runs: the verdict, then "open the session in the Claude app" (no link)', async () => {
    const t = setup('h1');
    t.fake.add('manager', '❯ x\n  /rc active\n');
    await setAway(t.ctx, true, 'cli');
    await t.event('stop', { last_assistant_message: 'ok' });
    assert.deepEqual(t.bodies, ['NC-1: raport gotowy – Werdykt: PASS – 12 testów\nOtwórz sesję „agentctl manager” w aplikacji Claude.']);
    assert.doesNotMatch(t.bodies[0] as string, /https?:|claude\.ai|session_/);
  });

  it('the name is the one in manager.name', async () => {
    const t = setup('h2', {}, `${NTFY}manager:\n  name: Dyspozytor\n`);
    t.fake.add('manager', '❯ x');
    assert.equal(await phoneHint(t.ctx, 'report-ready', 'NC-1'), 'Otwórz sesję „Dyspozytor” w aplikacji Claude.');
  });

  it('without a running manager there is no hint (it would send you to a session that is not there)', async () => {
    const t = setup('h3');
    await setAway(t.ctx, true, 'cli');
    await t.event('stop', { last_assistant_message: 'ok' });
    assert.deepEqual(t.bodies, ['NC-1: raport gotowy – Werdykt: PASS – 12 testów']);
    assert.equal(await phoneHint(t.ctx, 'limited', 'NC-1'), undefined);
  });

  it('a question of a task with Remote Control says which session to answer in, whatever the manager does', async () => {
    const t = setup('h4', { remoteControl: true });
    t.fake.add('manager', '❯ x');
    assert.equal(await phoneHint(t.ctx, 'needs-input', 'NC-1'), 'Odpowiesz w aplikacji Claude: NC-1');
    assert.equal(await phoneHint(t.ctx, 'report-ready', 'NC-1'), 'Otwórz sesję „agentctl manager” w aplikacji Claude.', 'a report is read in the manager, not answered in the task');
    const plain = setup('h5');
    plain.fake.add('manager', '❯ x');
    assert.match((await phoneHint(plain.ctx, 'needs-input', 'NC-1')) ?? '', /Otwórz sesję/);
  });

  for (const include of [false, true]) {
    it(`include_question=${include} preserves the Remote Control hint`, async () => {
      const t = setup(`h6-${include}`, { remoteControl: true }, `${NTFY}    include_question: ${include}\n`);
      await setAway(t.ctx, true, 'cli');
      (t.fake.windows[0] as { screen: string }).screen = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'screen-claude-permission.txt'), 'utf8');
      await t.event('notification', JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'claude-notification-permission.json'), 'utf8')));
      assert.deepEqual(t.bodies, [`${include ? 'NC-1: Do you want to proceed? touch approved-by-claude.txt' : 'NC-1: pytanie agenta – otwórz okno'}\nOdpowiesz w aplikacji Claude: NC-1`]);
      assert.equal(safeVerdict('PASS /Users/x/y.ts').includes('/Users'), false);
    });
  }
});
