import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runDoctor } from '../src/core/doctor.ts';
import { loadGlobalConfig } from '../src/core/config.ts';
import { generateTopic, MIN_TOPIC_LENGTH, planNtfySetup, setupInstructions, subscriptionLink, weakTopic } from '../src/core/ntfy-setup.ts';
import { RecordingRunner } from '../src/core/runner.ts';
import { DiskRunner, makeConfig, runCli, useScratch } from './helpers.ts';

const scratch = useScratch();

describe('ntfy-setup: the topic', () => {
  it('is random, long enough and different every time', () => {
    const topics = new Set(Array.from({ length: 50 }, () => generateTopic()));
    assert.equal(topics.size, 50);
    for (const t of topics) {
      assert.ok(t.length >= MIN_TOPIC_LENGTH, t);
      assert.match(t, /^agentctl-[0-9a-f]{24}$/);
      assert.equal(weakTopic(t), undefined);
    }
  });

  it('a short or word-like topic is weak', () => {
    assert.match(weakTopic('agentctl') ?? '', /only 8 characters/);
    assert.match(weakTopic('marcin-phone-notifications-here') ?? '', /words/);
    assert.match(weakTopic('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1') ?? '', /repeats/);
  });

  it('the instructions name the topic, the apps, and warn about the public server only', () => {
    const pub = setupInstructions('https://ntfy.sh', 'agentctl-abc').join('\n');
    assert.match(pub, /App Store/);
    assert.match(pub, /Google Play/);
    assert.match(pub, /topic: agentctl-abc/);
    assert.match(pub, /WARNING: on the public ntfy\.sh/);
    assert.match(pub, /only protection/);
    const own = setupInstructions('https://ntfy.example.com', 'agentctl-abc').join('\n');
    assert.match(own, /Use another server" and enter https:\/\/ntfy\.example\.com/);
    assert.doesNotMatch(own, /WARNING/);
    assert.equal(subscriptionLink('https://ntfy.sh', 'agentctl-abc'), 'ntfy://ntfy.sh/agentctl-abc');
  });
});

describe('ntfy-setup: config.yaml', () => {
  const COMMENTED = '# my agentctl\ncache: CACHE\nstate_dir: STATE\n\n# desktop notifications\nnotify:\n  backend: auto   # keep this\n  turn_end: false\n\n# limits\nlimits:\n  claude: 2\n';

  const withText = (name: string, extra = '') => {
    const root = scratch.sub(name);
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'config.yaml'), COMMENTED.replace('CACHE', path.join(root, 'cache')).replace('STATE', path.join(root, 'state')) + extra);
    return { home, config: loadGlobalConfig(home), file: path.join(home, 'config.yaml') };
  };

  it('writes the topic, keeps every comment and the order of the keys, and the result loads', async () => {
    const t = withText('s1');
    const r = await runCli(t.config, new DiskRunner({ dryRun: false }), ['ntfy-setup']);
    assert.equal(r.code, 0, r.stderr);
    const text = fs.readFileSync(t.file, 'utf8');
    for (const kept of ['# my agentctl', '# desktop notifications', 'backend: auto # keep this', '# limits', 'claude: 2']) assert.ok(text.includes(kept), `lost: ${kept}`);
    assert.ok(text.indexOf('notify:') < text.indexOf('limits:'));
    const loaded = loadGlobalConfig(t.home);
    assert.match(loaded.notify.ntfy?.topic ?? '', /^agentctl-[0-9a-f]{24}$/);
    assert.equal(loaded.notify.turnEnd, false);
    assert.ok(fs.existsSync(`${t.file}.bak`));
    assert.match(r.stdout, new RegExp(`Topic:  ${loaded.notify.ntfy?.topic}`));
    assert.match(r.stdout, /WARNING: on the public ntfy\.sh/);
  });

  it('a topic that is set is kept; --regenerate makes a new one', async () => {
    const t = withText('s2');
    const runner = new DiskRunner({ dryRun: false });
    await runCli(t.config, runner, ['ntfy-setup']);
    const first = loadGlobalConfig(t.home);
    const kept = await runCli(first, runner, ['ntfy-setup']);
    assert.match(kept.stdout, /already set.*kept/);
    assert.equal(loadGlobalConfig(t.home).notify.ntfy?.topic, first.notify.ntfy?.topic);
    await runCli(first, runner, ['ntfy-setup', '--regenerate']);
    assert.notEqual(loadGlobalConfig(t.home).notify.ntfy?.topic, first.notify.ntfy?.topic);
  });

  it('--server is written, and the instructions are for that server', async () => {
    const t = withText('s3');
    const r = await runCli(t.config, new DiskRunner({ dryRun: false }), ['ntfy-setup', '--server', 'https://ntfy.example.com/']);
    assert.equal(loadGlobalConfig(t.home).notify.ntfy?.server, 'https://ntfy.example.com');
    assert.doesNotMatch(r.stdout, /WARNING/);
  });

  it('--dry-run writes nothing', async () => {
    const t = withText('s4');
    const before = fs.readFileSync(t.file, 'utf8');
    const r = await runCli(t.config, new RecordingRunner({ dryRun: true }), ['ntfy-setup', '--dry-run']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fs.readFileSync(t.file, 'utf8'), before);
    assert.match(r.stdout, /Would write/);
  });

  it('a config with a YAML error is not touched', () => {
    const t = withText('s5');
    fs.writeFileSync(t.file, 'a: [\n');
    assert.throws(() => planNtfySetup(t.config), /cannot edit/);
  });

  it('--show-qr prints the QR of qrencode when it is there, and says so when it is not', async () => {
    const t = withText('s6');
    const withTool = new DiskRunner({ dryRun: false, respond: (cmd) => (cmd === 'qrencode' ? { code: 0, stdout: '█▀▀█\n█▄▄█\n' } : undefined) });
    assert.match((await runCli(t.config, withTool, ['ntfy-setup', '--show-qr'])).stdout, /█▀▀█/);
    const without = new DiskRunner({ dryRun: false, respond: (cmd) => (cmd === 'qrencode' ? { code: 127, stderr: 'not found' } : undefined) });
    assert.match((await runCli(loadGlobalConfig(t.home), without, ['ntfy-setup', '--show-qr'])).stdout, /No QR code: it needs the qrencode tool/);
  });
});

describe('doctor: phone', () => {
  const run = async (name: string, yaml: string) => {
    const config = makeConfig(scratch.sub(name), yaml);
    const checks = await runDoctor(new DiskRunner({ dryRun: false }), () => config, scratch.dir, '22.12.0', 'linux', scratch.dir, {});
    return checks.filter((c) => c.name === 'phone' || c.name === 'away');
  };

  it('no ntfy: ok and the hint', async () => {
    const [phone, away] = await run('d1', '');
    assert.deepEqual([phone?.status, away], ['ok', undefined]);
    assert.match(phone?.detail ?? '', /ntfy-setup/);
  });

  it('a short topic on the public server and a private server without a token are warnings', async () => {
    const [short] = await run('d2', 'notify:\n  ntfy:\n    topic: marcin\n');
    assert.equal(short?.status, 'warn');
    assert.match(short?.detail ?? '', /guessable/);
    const [priv] = await run('d3', 'notify:\n  ntfy:\n    server: https://ntfy.example.com\n    topic: agentctl-0123456789abcdef01234567\n');
    assert.equal(priv?.status, 'warn');
    assert.match(priv?.detail ?? '', /token is not set/);
  });

  it('a good setup is ok and shows the state of away', async () => {
    const [phone, away] = await run('d4', 'notify:\n  ntfy:\n    topic: agentctl-0123456789abcdef01234567\n');
    assert.equal(phone?.status, 'ok');
    assert.equal(away?.status, 'ok');
    assert.match(away?.detail ?? '', /away: off/);
  });
});
