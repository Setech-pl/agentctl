import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Alerts } from '../src/core/alert.ts';
import { setAway } from '../src/core/away.ts';
import { renderEvents } from '../src/core/chat-events.ts';
import { ConfigStore } from '../src/core/config-store.ts';
import { loadGlobalConfig } from '../src/core/config.ts';
import { Context } from '../src/core/context.ts';
import { handleEvent } from '../src/core/event-command.ts';
import { readJournal, recordJournal } from '../src/core/journal.ts';
import type { Notifier } from '../src/core/notify.ts';
import { phoneLogPath, phoneQueuePath, phoneTick, queuedForPhone, RETRY_BACKOFF_MS, WARN_EVERY_MS } from '../src/core/phone-send.ts';
import type { FetchLike } from '../src/core/phone.ts';
import { reloadConfig, watchTick, WatchMemory } from '../src/core/watch.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();
const IDLE = 'Welcome\n❯ Try "x"\n  ⏵⏵ auto mode on';
const NTFY = 'notify:\n  ntfy:\n    server: https://ntfy.example.com\n    topic: agentctl-0123456789abcdef01234567\n';
const REPORT = '# Raport NC-1\n\nWerdykt: PASS – 12 testów\n\nZmieniłem /Users/marcin/Projects/secret-app/src/token.ts i sekret hunter2.\n';

class Quiet implements Notifier {
  readonly sent: string[] = [];
  async notify(_t: string, m: string): Promise<void> {
    this.sent.push(m);
  }
}

interface Request {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function setup(name: string, yaml = NTFY, { away = true }: { away?: boolean } = {}) {
  const config = makeConfig(scratch.sub(name), yaml);
  const fake = new FakeTmux();
  const runner = new DiskRunner({ dryRun: false, respond: fake.respond, startTime: Date.now() });
  const out: string[] = [];
  const ctx = new Context(runner, config, (l) => out.push(l));
  const requests: Request[] = [];
  const net = { down: false, status: 200 };
  ctx.fetch = (async (url, init) => {
    requests.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
    if (net.down) throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') });
    return new Response('{}', { status: net.status });
  }) as FetchLike;
  const record = seedTask(config, 'NC-1');
  fake.add('nc-1', IDLE);
  fs.mkdirSync(path.dirname(record.report), { recursive: true });
  fs.writeFileSync(record.report, REPORT);
  const notifier = new Quiet();
  const alerts = new Alerts(ctx, notifier, { env: {} });
  const stop = (payload: unknown = { last_assistant_message: 'ok' }) => handleEvent(ctx, alerts, { task: 'NC-1', agent: 'claude', kind: 'stop', payload });
  const ready = async () => {
    if (away) await setAway(ctx, true, 'cli');
  };
  return { config, ctx, runner, fake, out, requests, net, record, notifier, alerts, stop, ready };
}

const phoneLog = (config: Parameters<typeof phoneLogPath>[0]): string => (fs.existsSync(phoneLogPath(config)) ? fs.readFileSync(phoneLogPath(config), 'utf8') : '');

describe('phone: sending from the events', () => {
  for (const agent of ['claude', 'codex'] as const) {
    for (const include of [false, true]) {
      it(`${agent} expanded question: include_question=${include} only changes the phone`, async () => {
        const t = setup(`privacy-${agent}-${include}`, `${NTFY}    include_question: ${include}\n`);
        seedTask(t.config, 'NC-1', { agent });
        t.fake.windows[0]!.screen = 'Czy ujawnić hunter2?\n  1. Yes\n  2. No\n';
        await t.ready();
        await handleEvent(t.ctx, t.alerts, { task: 'NC-1', agent, ...(agent === 'claude' ? { kind: 'notification' as const } : {}),
          payload: agent === 'claude' ? { notification_type: 'permission_prompt', message: 'Czy ujawnić hunter2?' } : { type: 'question', question: 'Czy ujawnić hunter2?' } });
        assert.equal(t.requests.length, 1);
        assert.equal(t.requests[0]!.body.includes('hunter2'), include);
        assert.equal(t.requests[0]!.body, include ? 'NC-1: Czy ujawnić hunter2?' : 'NC-1: pytanie agenta – otwórz okno');
        assert.doesNotMatch(t.requests[0]!.headers.Title!, /hunter2/);
        assert.match(t.notifier.sent.join('\n'), /hunter2/, 'local notification keeps the question');
        assert.match(readJournal(t.config)[0]!.text, /hunter2/, 'local journal keeps the question');
      });
    }
  }

  it('a collapsed Codex question sends only count and binding, with the manager hint', async () => {
    const t = setup('private-collapsed');
    seedTask(t.config, 'NC-1', { agent: 'codex' });
    t.fake.windows[0]!.screen = 'Working (esc to interrupt)\n? 2 questions\n  ⇧↑ to answer\n';
    t.fake.add('manager', '❯ ready');
    await t.ready();
    await recordJournal(t.ctx, { kind: 'needs-input', task: 'NC-1', text: 'NC-1: session secret hunter2' });
    assert.equal(t.requests[0]?.body, 'Codex ma pytanie (2) – Enter → okno agenta, potem ⇧↑\nOtwórz sesję „agentctl manager” w aplikacji Claude.');
    assert.doesNotMatch(JSON.stringify(t.requests), /hunter2/);
  });

  it('live reload applies in both directions and redacts queued questions, including old queue entries', async () => {
    const t = setup('private-reload');
    await t.ready();
    const store = new ConfigStore(() => loadGlobalConfig(path.dirname(t.config.path)), t.config);
    const change = async (value: boolean) => {
      const text = fs.readFileSync(t.config.path, 'utf8').replace(/    include_question: (?:true|false)\n/g, '');
      fs.writeFileSync(t.config.path, `${text}    include_question: ${value}\n`);
      const r = await reloadConfig(t.ctx, store);
      assert.ok(r.changed);
      assert.ok(r.keys.includes('notify'));
      assert.equal(t.ctx.config.notify.ntfy?.includeQuestion, value);
    };
    await change(true);
    t.net.down = true;
    await recordJournal(t.ctx, { kind: 'needs-input', task: 'NC-1', text: 'NC-1: secret hunter2' });
    assert.match(t.requests[0]!.body, /hunter2/);
    const queue = JSON.parse(fs.readFileSync(phoneQueuePath(t.config), 'utf8'));
    const old = structuredClone(queue.items[0]);
    delete old.input;
    queue.items.push(old);
    for (const item of queue.items) item.next = 0;
    fs.writeFileSync(phoneQueuePath(t.config), JSON.stringify(queue));
    await change(false);
    t.net.down = false;
    await phoneTick(t.ctx);
    assert.equal(t.requests.length, 3);
    assert.ok(t.requests.slice(1).every(r => r.body === 'NC-1: pytanie agenta – otwórz okno'));
    assert.doesNotMatch(JSON.stringify(t.requests.slice(1)), /hunter2/);
    assert.equal(queuedForPhone(t.config), 0);
  });

  it('away off: the Mac is notified, the phone is not; away on: one request, the journal says so', async () => {
    const t = setup('s1', NTFY, { away: false });
    await t.stop();
    assert.equal(t.notifier.sent.length, 1);
    assert.equal(t.requests.length, 0);
    assert.equal(readJournal(t.config)[0]?.phone, undefined);

    const u = setup('s2');
    await u.ready();
    await u.stop();
    assert.equal(u.notifier.sent.length, 1, 'the Mac still gets it');
    assert.equal(u.requests.length, 1);
    const [r] = u.requests;
    assert.equal(r?.url, 'https://ntfy.example.com/agentctl-0123456789abcdef01234567');
    assert.equal(r?.body, 'NC-1: raport gotowy – Werdykt: PASS – 12 testów');
    assert.equal(r?.headers.Priority, 'default');
    assert.equal(r?.headers.Tags, 'white_check_mark');
    const entries = readJournal(u.config).filter(e => e.kind === 'report-ready');
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.phone, 'sent');
    assert.match(renderEvents({ has_more: false, next_cursor: '', client: 'cli', since: '', sinceLabel: 'x', cohort: null, events: entries, summary: { active: 0, working: 0, needYou: [], queued: 0, reportsToPull: [] }, away: { on: true, phone: true, always: false }, markerMoved: false }).join('\n'), /Werdykt: PASS.* 📱/);
  });

  it('nothing of the report except the verdict line reaches the request: no path, no file name, no other line', async () => {
    const t = setup('s3');
    await t.ready();
    await t.stop();
    const all = JSON.stringify(t.requests);
    for (const secret of ['hunter2', 'secret-app', 'token.ts', '/Users', 'NC-1.md', t.record.report, t.config.cache, 'Zmieniłem']) assert.ok(!all.includes(secret), `leaked: ${secret}`);
    for (const h of Object.values(t.requests[0]?.headers ?? {})) assert.ok(!h.includes('hunter2'));
  });

  it('include_verdict: false sends the ID only', async () => {
    const t = setup('s4', `${NTFY}    include_verdict: false\n`);
    await t.ready();
    await t.stop();
    assert.equal(t.requests[0]?.body, 'NC-1: raport gotowy');
  });

  it('a question on the screen reaches the phone only with include_question true', async () => {
    const t = setup('s5', `${NTFY}    include_question: true\n`);
    await t.ready();
    (t.fake.windows[0] as { screen: string }).screen = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'screen-claude-permission.txt'), 'utf8');
    await handleEvent(t.ctx, t.alerts, { task: 'NC-1', agent: 'claude', kind: 'notification', payload: JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'claude-notification-permission.json'), 'utf8')) });
    assert.match(t.notifier.sent[0] ?? '', /Do you want to proceed/);
    assert.equal(t.requests.length, 1);
    assert.equal(t.requests[0]?.body, 'NC-1: Do you want to proceed? touch approved-by-claude.txt');
    assert.equal(t.requests[0]?.headers.Priority, 'high');
    assert.match(JSON.stringify(t.requests), /touch approved|proceed/);
  });

  it('only the chosen events go; notify.ntfy.always sends without away', async () => {
    const t = setup('s6', `${NTFY}    events: [dead]\n`);
    await t.ready();
    await t.stop();
    assert.equal(t.requests.length, 0, 'report-ready is not in events');
    assert.equal(t.notifier.sent.length, 1);

    const a = setup('s7', `${NTFY}    always: true\n`, { away: false });
    await a.stop();
    assert.equal(a.requests.length, 1);
  });

  it('events that are not on the list of the phone (cancelled, queue-start, limits-changed, a plain usage warning) never go', async () => {
    const t = setup('s8');
    await t.ready();
    for (const entry of [
      { kind: 'cancelled' as const, task: 'NC-1', text: 'x' },
      { kind: 'queue-start' as const, task: 'NC-1', text: 'x' },
      { kind: 'limits-changed' as const, text: 'x' },
      { kind: 'usage' as const, text: 'claude 80%', level: 'warn' as const },
    ]) await recordJournal(t.ctx, entry);
    assert.equal(t.requests.length, 0);
    await recordJournal(t.ctx, { kind: 'usage', text: 'Claude: 93% limitu 5h – limit prawie wyczerpany', level: 'critical' });
    assert.equal(t.requests.length, 1);
    assert.equal(t.requests[0]?.headers.Priority, 'high');
  });

  it('a cohort and a dead window: the cohort name and the task ID only', async () => {
    const t = setup('s9');
    await t.ready();
    await recordJournal(t.ctx, { kind: 'cohort-done', cohort: 'neon', text: 'kohorta neon: wszystkie raporty gotowe (3)' });
    await recordJournal(t.ctx, { kind: 'dead', task: 'NC-1', text: 'NC-1: okno zniknęło bez raportu' });
    assert.deepEqual(t.requests.map((r) => r.body), ['kohorta neon: wszystkie raporty gotowe', 'NC-1: okno zniknęło bez raportu']);
  });
});

describe('phone: de-duplication with the Mac', () => {
  it('the agent\'s event and then the watcher\'s screen reading of the same report: one notification on the Mac, one request', async () => {
    const t = setup('d1');
    await t.ready();
    await t.stop();
    assert.equal(t.requests.length, 1);
    await watchTick(t.ctx, new WatchMemory(), t.notifier);
    // the first tick is a baseline; a second one sees nothing new either
    await watchTick(t.ctx, new WatchMemory(), t.notifier);
    assert.equal(t.requests.length, 1);
    assert.equal(t.notifier.sent.length, 1);
  });

  it('the watcher announces first, then the agent\'s event repeats it within the window: still one request', async () => {
    const t = setup('d2');
    await t.ready();
    const memory = new WatchMemory();
    (t.fake.windows[0] as { screen: string }).screen = 'Thinking…\nesc to interrupt';
    await watchTick(t.ctx, memory, t.notifier);
    (t.fake.windows[0] as { screen: string }).screen = IDLE;
    await watchTick(t.ctx, memory, t.notifier);
    assert.equal(t.requests.length, 1, 'the watcher saw report-ready');
    await t.stop();
    assert.equal(t.requests.length, 1, 'the event is a duplicate on the Mac, so it is on the phone');
    assert.equal(t.notifier.sent.length, 1);
  });
});

describe('phone: a network error', () => {
  it('does not stop the event or the watcher; the request is queued and the journal says queued', async () => {
    const t = setup('n1');
    await t.ready();
    t.net.down = true;
    const r = await t.stop();
    assert.equal(r.announced?.result, 'sent');
    assert.equal(t.notifier.sent.length, 1);
    assert.equal(readJournal(t.config).find(e => e.kind === 'report-ready')?.phone, 'queued');
    assert.equal(queuedForPhone(t.config), 1);
    assert.match(phoneLog(t.config), /report-ready {2}first try failed, queued: fetch failed: ECONNREFUSED/);
    await watchTick(t.ctx, new WatchMemory(), t.notifier);
  });

  it('retries after the backoff: 30 s, 2 min, 10 min; success on the 3rd try ends it', async () => {
    const t = setup('n2');
    await t.ready();
    t.net.down = true;
    await t.stop();
    assert.equal(t.requests.length, 1);
    await phoneTick(t.ctx);
    assert.equal(t.requests.length, 1, 'not due yet');
    await t.runner.sleep(RETRY_BACKOFF_MS[0]);
    await phoneTick(t.ctx);
    assert.equal(t.requests.length, 2, 'the 1st retry');
    await t.runner.sleep(RETRY_BACKOFF_MS[1] - 1);
    await phoneTick(t.ctx);
    assert.equal(t.requests.length, 2, 'the pause grew: not due after 2 min - 1 ms');
    await t.runner.sleep(1);
    t.net.down = false;
    await phoneTick(t.ctx);
    assert.equal(t.requests.length, 3, 'the 2nd retry');
    assert.equal(queuedForPhone(t.config), 0);
    assert.ok(!fs.existsSync(phoneQueuePath(t.config)) || JSON.parse(fs.readFileSync(phoneQueuePath(t.config), 'utf8')).items.length === 0);
    assert.match(phoneLog(t.config), /report-ready {2}sent after 3 tries/);
    assert.equal(t.requests[2]?.body, t.requests[0]?.body, 'the same notification');
  });

  it('gives up after three retries with a line in phone.log; nothing is sent after that', async () => {
    const t = setup('n3');
    await t.ready();
    t.net.down = true;
    await t.stop();
    for (const wait of RETRY_BACKOFF_MS) {
      await t.runner.sleep(wait);
      await phoneTick(t.ctx);
    }
    assert.equal(t.requests.length, 4, '1 try + 3 retries');
    assert.equal(queuedForPhone(t.config), 0);
    assert.match(phoneLog(t.config), /report-ready {2}dropped after 4 tries: fetch failed: ECONNREFUSED/);
    await t.runner.sleep(3_600_000);
    await phoneTick(t.ctx);
    assert.equal(t.requests.length, 4);
  });

  it('an HTTP error is a failure too (and is retried)', async () => {
    const t = setup('n4');
    await t.ready();
    t.net.status = 503;
    await t.stop();
    assert.equal(readJournal(t.config).find(e => e.kind === 'report-ready')?.phone, 'queued');
    assert.match(phoneLog(t.config), /HTTP 503/);
  });

  it('one warning an hour, shown by the watcher', async () => {
    const t = setup('n5');
    await t.ready();
    t.net.down = true;
    await t.stop();
    const first = await phoneTick(t.ctx);
    assert.equal(first.filter((l) => /^phone: .* did not take the notification/.test(l)).length, 1);
    // more failures within the hour: no second warning
    await t.runner.sleep(RETRY_BACKOFF_MS[0]);
    const second = await phoneTick(t.ctx);
    await t.runner.sleep(RETRY_BACKOFF_MS[1]);
    const third = await phoneTick(t.ctx);
    assert.equal([...second, ...third].filter((l) => /did not take/.test(l)).length, 0);
    // an hour later a new failure warns again
    await t.runner.sleep(WARN_EVERY_MS);
    await t.stop().catch(() => undefined);
    await recordJournal(t.ctx, { kind: 'dead', task: 'NC-1', text: 'x' });
    const later = await phoneTick(t.ctx);
    assert.equal(later.filter((l) => /did not take/.test(l)).length, 1);
  });

  it('watchTick prints the warning to the watch log and survives a dead network', async () => {
    const t = setup('n6');
    await t.ready();
    t.net.down = true;
    await t.stop();
    const ticks = await watchTick(t.ctx, new WatchMemory(), t.notifier);
    assert.ok(Array.isArray(ticks));
    assert.ok(t.out.some((l) => /did not take the notification/.test(l)), t.out.join('\n'));
  });
});
