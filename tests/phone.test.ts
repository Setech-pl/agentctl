import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_QUESTION } from '../src/core/events.ts';
import { DEFAULT_NTFY_SERVER, PHONE_EVENTS } from '../src/core/config.ts';
import { buildNtfyRequest, headerValue, phoneMessage, safeVerdict, sendNtfy } from '../src/core/phone.ts';
import type { FetchLike } from '../src/core/phone.ts';
import { RecordingRunner } from '../src/core/runner.ts';
import { makeConfig, runCli, useScratch } from './helpers.ts';

const scratch = useScratch();
const ntfyOf = (name: string, yaml: string) => makeConfig(scratch.sub(name), yaml).notify.ntfy;

describe('phone: config notify.ntfy', () => {
  it('no ntfy section: no phone; defaults when there is one', () => {
    assert.equal(makeConfig(scratch.sub('p0')).notify.ntfy, undefined);
    const n = ntfyOf('p1', 'notify:\n  ntfy:\n    topic: agentctl-abc123\n');
    assert.ok(n);
    assert.equal(n.server, DEFAULT_NTFY_SERVER);
    assert.equal(n.topic, 'agentctl-abc123');
    assert.deepEqual(n.events, [...PHONE_EVENTS]);
    assert.equal(n.includeVerdict, true);
    assert.equal(n.includeQuestion, false);
    assert.equal(n.always, false);
    assert.equal(n.token, undefined);
    assert.equal(n.clickUrl, undefined);
  });

  it('include_question accepts only booleans and is opt-in', () => {
    for (const value of [false, true]) {
      assert.equal(ntfyOf(`question-${value}`, `notify:\n  ntfy:\n    include_question: ${value}\n`)?.includeQuestion, value);
    }
    for (const value of ['yes', '1', 'null', '"false"']) {
      assert.throws(() => ntfyOf(`question-bad-${value.replace(/"/g, '')}`, `notify:\n  ntfy:\n    include_question: ${value}\n`), /include_question must be true or false/);
    }
  });

  it('default priorities: high for needs-input, limited and usage-critical, the rest default', () => {
    const n = ntfyOf('p2', 'notify:\n  ntfy:\n    topic: t1\n');
    assert.ok(n);
    for (const e of PHONE_EVENTS) assert.equal(n.priority[e], ['needs-input', 'limited', 'usage-critical'].includes(e) ? 'high' : 'default', e);
  });

  it('events, priority, token, server, click_url and include_verdict are read; a trailing slash of the server goes', () => {
    const n = ntfyOf(
      'p3',
      'notify:\n  ntfy:\n    server: https://ntfy.example.com/\n    topic: t1\n    token: tk_abc\n    events: [report-ready, dead]\n    priority: {report-ready: low, dead: urgent}\n    include_verdict: false\n    click_url: https://chat.example.com/\n    always: true\n',
    );
    assert.ok(n);
    assert.equal(n.server, 'https://ntfy.example.com');
    assert.equal(n.token, 'tk_abc');
    assert.deepEqual(n.events, ['report-ready', 'dead']);
    assert.equal(n.priority['report-ready'], 'low');
    assert.equal(n.priority.dead, 'urgent');
    assert.equal(n.includeVerdict, false);
    assert.equal(n.clickUrl, 'https://chat.example.com/');
    assert.equal(n.always, true);
  });

  it('wrong values are reported together', () => {
    assert.throws(
      () => makeConfig(scratch.sub('p4'), 'notify:\n  ntfy:\n    server: ftp://x\n    topic: "a b"\n    events: [nope]\n    priority: {dead: loud}\n    mystery: 1\n'),
      (e: Error) => /server must be an http/.test(e.message) && /topic may have/.test(e.message) && /unknown nope/.test(e.message) && /priority.dead must be one of/.test(e.message) && /unknown key "mystery"/.test(e.message),
    );
  });

  it('away.auto_idle', () => {
    assert.equal(makeConfig(scratch.sub('p5')).away.autoIdle, null);
    assert.equal(makeConfig(scratch.sub('p6'), 'away:\n  auto_idle: 15\n').away.autoIdle, 15);
    assert.throws(() => makeConfig(scratch.sub('p7'), 'away:\n  auto_idle: 0\n'), /auto_idle must be a positive number/);
  });
});

const settings = { priority: ntfyOf('pm', 'notify:\n  ntfy:\n    topic: t1\n')!.priority, includeVerdict: true, includeQuestion: false };

describe('phone: the message', () => {
  it('has the task ID, the cohort and the verdict - nothing else', () => {
    const m = phoneMessage('report-ready', { task: 'NC-42', verdict: 'Werdykt: PASS' }, settings);
    assert.ok(m);
    assert.equal(m.body, 'NC-42: raport gotowy – Werdykt: PASS');
    assert.equal(m.priority, 'default');
    assert.deepEqual(m.tags, ['white_check_mark']);
    const c = phoneMessage('cohort-done', { cohort: 'neon' }, settings);
    assert.equal(c?.body, 'kohorta neon: wszystkie raporty gotowe');
    assert.equal(phoneMessage('needs-input', { task: 'NC-1' }, settings)?.priority, 'high');
  });

  it('a question, an error or a usage text of a task never reaches the phone; include_verdict false drops the verdict', () => {
    const q = phoneMessage('needs-input', { task: 'NC-1', verdict: 'Czy usunąć /Users/m/secret.txt?' }, settings);
    assert.doesNotMatch(q?.body ?? '', /secret|Users/);
    const f = phoneMessage('queue-failed', { task: 'NC-2' }, settings);
    assert.equal(f?.body, 'NC-2: start z kolejki nie powiódł się');
    const none = phoneMessage('report-ready', { task: 'NC-3', verdict: 'Werdykt: PASS' }, { ...settings, includeVerdict: false });
    assert.equal(none?.body, 'NC-3: raport gotowy');
  });

  it('question content is private by default, including expanded dialogs and session text', () => {
    const text = 'NC-1: Czy wysłać hunter2 z /Users/m/secret.txt?';
    const message = phoneMessage('needs-input', { task: 'NC-1', text }, settings)!;
    assert.equal(message.body, 'NC-1: pytanie agenta – otwórz okno');
    assert.doesNotMatch(JSON.stringify(buildNtfyRequest({ server: 'http://localhost', topic: 'test' }, message)), /hunter2|secret|Users/);
    const collapsed = phoneMessage('needs-input', { task: 'NC-1', text, collapsed: { count: 2, shortcut: '⇧↑' } }, settings)!;
    assert.equal(collapsed.body, 'Codex ma pytanie (2) – Enter → okno agenta, potem ⇧↑');
    assert.doesNotMatch(collapsed.title + collapsed.body, /hunter2|secret|Users/);
    const unsafe = phoneMessage('needs-input', { task: 'NC-1', text, collapsed: { count: 2, shortcut: 'hunter2' } }, settings)!;
    assert.doesNotMatch(unsafe.body, /hunter2/);
    assert.match(unsafe.body, /skrót przy/);
  });

  it('include_question true sends question text with the notification limit and the session hint', () => {
    const text = 'NC-1: Czy wysłać hunter2?';
    const enabled = { ...settings, includeQuestion: true };
    assert.equal(phoneMessage('needs-input', { task: 'NC-1', text, hint: 'Odpowiesz w aplikacji Claude: NC-1' }, enabled)?.body,
      `${text}\nOdpowiesz w aplikacji Claude: NC-1`);
    assert.ok(phoneMessage('needs-input', { task: 'NC-1', text: text.repeat(100) }, enabled)!.body.length <= MAX_QUESTION);
  });

  it('paths and file names inside the verdict line are cut', () => {
    const v = safeVerdict('PASS – see /Users/marcin/Projects/x/report.md and src/core/phone.ts (done), ~/cache/a.png ok');
    assert.doesNotMatch(v, /Users|report\.md|phone\.ts|cache|\.png|\//);
    assert.match(v, /^PASS/);
    assert.ok(safeVerdict('x'.repeat(500)).length <= 100);
  });

  it('an event without its task or cohort gives no message', () => {
    assert.equal(phoneMessage('dead', {}, settings), undefined);
    assert.equal(phoneMessage('cohort-done', { task: 'NC-1' }, settings), undefined);
  });

  it('click_url becomes the click target', () => {
    const m = phoneMessage('dead', { task: 'NC-9' }, { ...settings, clickUrl: 'https://chat.example.com/' });
    assert.equal(m?.click, 'https://chat.example.com/');
  });
});

describe('phone: the HTTP request', () => {
  it('POST <server>/<topic> with Title, Priority, Tags, Click and Bearer; the body is the text', () => {
    const m = phoneMessage('needs-input', { task: 'NC-7' }, { ...settings, clickUrl: 'https://chat.example.com/' });
    assert.ok(m);
    const r = buildNtfyRequest({ server: 'https://ntfy.example.com', topic: 'agentctl-xyz', token: 'tk_1' }, m);
    assert.equal(r.url, 'https://ntfy.example.com/agentctl-xyz');
    assert.equal(r.init.method, 'POST');
    assert.equal(r.init.body, 'NC-7: pytanie agenta – otwórz okno');
    const h = r.init.headers;
    assert.equal(h.Priority, 'high');
    assert.equal(h.Tags, 'question');
    assert.equal(h.Click, 'https://chat.example.com/');
    assert.equal(h.Authorization, 'Bearer tk_1');
    assert.match(h.Title ?? '', /^=\?UTF-8\?B\?/, 'a title with non-ASCII characters is RFC 2047 encoded');
    const decoded = Buffer.from((h.Title ?? '').slice('=?UTF-8?B?'.length, -2), 'base64').toString('utf8');
    assert.equal(decoded, 'agentctl · NC-7: pytanie');
    for (const v of Object.values(h)) assert.match(v, /^[\x20-\x7e]*$/, 'every header value is plain ASCII');
  });

  it('no token, no click: those headers are absent; plain ASCII stays as it is', () => {
    const r = buildNtfyRequest({ server: 'https://ntfy.sh', topic: 't' }, { event: 'dead', title: 'x', body: 'b', priority: 'default', tags: ['skull'] });
    assert.equal(r.init.headers.Authorization, undefined);
    assert.equal(r.init.headers.Click, undefined);
    assert.equal(r.init.headers.Title, 'x');
    assert.equal(headerValue('a\nb'), 'a b');
  });

  it('without a topic nothing is built', () => {
    assert.throws(() => buildNtfyRequest({ server: 'https://ntfy.sh' }, { event: 'dead', title: 'x', body: 'b', priority: 'default', tags: [] }), /topic is not set/);
  });
});

describe('phone: sending', () => {
  const message = { event: 'dead' as const, title: 't', body: 'b', priority: 'default' as const, tags: [] };
  const target = { server: 'https://ntfy.example.com', topic: 't1' };

  it('200 is ok and gives the code and the time', async () => {
    let t = 1000;
    const fetchFn: FetchLike = async () => ((t += 42), new Response('{}', { status: 200 }));
    const r = await sendNtfy(fetchFn, target, message, () => t);
    assert.deepEqual({ ok: r.ok, status: r.status, ms: r.ms }, { ok: true, status: 200, ms: 42 });
  });

  it('an HTTP error and a network error are results, not exceptions', async () => {
    const r429 = await sendNtfy(async () => new Response('', { status: 429 }), target, message);
    assert.deepEqual({ ok: r429.ok, status: r429.status, error: r429.error }, { ok: false, status: 429, error: 'HTTP 429' });
    const down = await sendNtfy(async () => { throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') }); }, target, message);
    assert.equal(down.ok, false);
    assert.equal(down.status, 0);
    assert.match(down.error ?? '', /fetch failed: ECONNREFUSED/);
  });

  it('no topic: not sent, no request', async () => {
    let calls = 0;
    const r = await sendNtfy(async () => (calls++, new Response('', { status: 200 })), { server: 'https://x' }, message);
    assert.equal(r.ok, false);
    assert.equal(calls, 0);
  });
});

describe('phone: notify-test', () => {
  const NTFY = 'notify:\n  ntfy:\n    server: https://ntfy.example.com\n    topic: agentctl-0123456789abcdef01234567\n    token: tk_1\n';
  const make = (name: string, yaml = NTFY) => {
    const config = makeConfig(scratch.sub(name), yaml);
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const answer = { status: 200 as number | 'down' };
    const fetchFn: FetchLike = async (url, init) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
      if (answer.status === 'down') throw new TypeError('fetch failed', { cause: new Error('ENOTFOUND') });
      return new Response('{}', { status: answer.status });
    };
    const runner = new RecordingRunner({ dryRun: false, startTime: Date.UTC(2026, 10, 2, 12, 0, 0), respond: (cmd) => (cmd === 'sh' ? { code: 1 } : undefined) });
    return { config, calls, answer, runner, fetchFn };
  };
  const notifier = async () => ({ notify: async () => ({ channel: 'osascript' as const, ok: true }) });

  it('--phone sends one request with the code and the time, whatever away says', async () => {
    const t = make('n1');
    const r = await runCli(t.config, t.runner, ['notify-test', '--phone'], { fetch: t.fetchFn, makeNotifier: notifier });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(t.calls.length, 1);
    assert.equal(t.calls[0]?.url, 'https://ntfy.example.com/agentctl-0123456789abcdef01234567');
    assert.equal(t.calls[0]?.headers.Authorization, 'Bearer tk_1');
    assert.match(t.calls[0]?.body ?? '', /Test powiadomienia agentctl/);
    assert.match(r.stdout, /Phone:  ntfy  ok  HTTP 200  \d+ ms  \(https:\/\/ntfy\.example\.com, topic agentctl-0123…\)/);
    assert.doesNotMatch(r.stdout, /Sent through/, '--phone does not touch the Mac');
    assert.match(r.stdout, /away is off/);
    assert.doesNotMatch(r.stdout, /abcdef01234567/, 'the whole topic is not printed');
  });

  it('--all reports both channels; a failure of the phone is exit code 1 with the reason', async () => {
    const t = make('n2');
    t.answer.status = 'down';
    const r = await runCli(t.config, t.runner, ['notify-test', '--all'], { fetch: t.fetchFn, makeNotifier: notifier });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /Mac:    osascript  ok  \d+ ms/);
    assert.match(r.stdout, /Phone:  ntfy  FAILED  no answer \(fetch failed: ENOTFOUND\)/);
    const bad = make('n3');
    bad.answer.status = 403;
    const r403 = await runCli(bad.config, bad.runner, ['notify-test', '--phone'], { fetch: bad.fetchFn });
    assert.equal(r403.code, 1);
    assert.match(r403.stdout, /FAILED  HTTP 403/);
  });

  it('--local and the default do not send to the phone; --phone without a topic says how to set it up', async () => {
    const t = make('n4');
    await runCli(t.config, t.runner, ['notify-test'], { fetch: t.fetchFn, makeNotifier: notifier });
    await runCli(t.config, t.runner, ['notify-test', '--local'], { fetch: t.fetchFn, makeNotifier: notifier });
    assert.equal(t.calls.length, 0);
    const none = make('n5', '');
    const r = await runCli(none.config, none.runner, ['notify-test', '--phone'], { fetch: none.fetchFn });
    assert.match(r.stdout, /not set up .*ntfy-setup/);
    assert.equal(none.calls.length, 0);
  });
});
