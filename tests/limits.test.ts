import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadGlobalConfig } from '../src/core/config.ts';
import { applySetLimits, collectLimits, detectExternal, parseAssignments, parseCounts, parsePs, planSetLimits, readReservations, releasePlaces, renderLimits, reservePlaces, sessionAgent } from '../src/core/limits.ts';
import { liveWindows } from '../src/core/plan.ts';
import { describeQueue, readQueue } from '../src/core/queue.ts';
import { readJournal } from '../src/core/journal.ts';
import { DiskRunner, FakeTmux, makeConfig, makeContext, runCli, seedTask, useScratch } from './helpers.ts';
import { Context } from '../src/core/context.ts';
import { RecordingRunner } from '../src/core/runner.ts';
import type { QueueEntry } from '../src/core/queue.ts';

const scratch = useScratch();

const COMMENTED = `# my agentctl config
cache: CACHE   # reports
limits:
  # parity for today
  claude: 3  # three
  codex: 5
session: agentctl
watch:
  interval: 20
`;

function commented(name: string): ReturnType<typeof makeConfig> {
  const root = scratch.sub(name);
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.yaml'), COMMENTED.replace('CACHE', path.join(root, 'cache')) + `state_dir: ${path.join(root, 'state')}\n`);
  return loadGlobalConfig(home);
}

describe('limits: editing config.yaml', () => {
  it('changes the numbers and keeps comments and the order of the keys; a .bak copy stays', async () => {
    const config = commented('edit');
    const before = fs.readFileSync(config.path, 'utf8');
    const { ctx } = makeContext(config);
    const plan = planSetLimits(config, parseAssignments(['claude=2', 'codex=6']));
    assert.deepEqual(plan.changes.map((c) => [c.agent, c.from, c.to]), [['claude', 3, 2], ['codex', 5, 6]]);
    assert.equal(fs.readFileSync(config.path, 'utf8'), before, 'planning writes nothing');
    const disk = new DiskRunner({ dryRun: false });
    await applySetLimits(new Context(disk, config, () => {}), plan);
    const after = fs.readFileSync(config.path, 'utf8');
    // the library writes one space before an inline comment; everything else is as it was
    const tidy = (t: string): string => t.replace(/ +#/g, ' #');
    assert.equal(tidy(after), tidy(before.replace('claude: 3', 'claude: 2').replace('codex: 5', 'codex: 6')));
    assert.match(after, /# my agentctl config/);
    assert.match(after, /# parity for today/);
    assert.match(after, /# three/);
    assert.equal(fs.readFileSync(`${config.path}.bak`, 'utf8'), before);
    assert.equal(loadGlobalConfig(path.dirname(config.path)).limits.claude, 2);
    assert.match(readJournal(config).map((e) => e.text).join('\n'), /claude 3 → 2/);
    void ctx;
  });

  it('adds a limits section to a config without one, and off removes a limit', async () => {
    const config = makeConfig(scratch.sub('add'), '# nothing yet\n');
    const disk = new Context(new DiskRunner({ dryRun: false }), config, () => {});
    await applySetLimits(disk, planSetLimits(config, parseAssignments(['claude=4'])));
    const reloaded = loadGlobalConfig(path.dirname(config.path));
    assert.equal(reloaded.limits.claude, 4);
    assert.match(fs.readFileSync(config.path, 'utf8'), /# nothing yet/);
    await applySetLimits(new Context(new DiskRunner({ dryRun: false }), reloaded, () => {}), planSetLimits(reloaded, parseAssignments(['claude=off'])));
    assert.equal(loadGlobalConfig(path.dirname(config.path)).limits.claude, undefined);
  });

  it('refuses a bad argument and a config with broken YAML', () => {
    assert.throws(() => parseAssignments(['claude=0']), /1 or more/);
    assert.throws(() => parseAssignments(['gemini=2']), /not claude=N or codex=N/);
    assert.throws(() => parseAssignments([]), /give the new limits/);
    const config = makeConfig(scratch.sub('broken'));
    const bad = { ...config, path: path.join(scratch.sub('broken2'), 'config.yaml') };
    fs.writeFileSync(bad.path, 'limits: [unclosed\n');
    assert.throws(() => planSetLimits(bad, { claude: 2 }), /cannot edit/);
  });

  it('the CLI: limits set asks y/N (-y skips it), --dry-run writes nothing', async () => {
    const config = commented('cli');
    const before = fs.readFileSync(config.path, 'utf8');
    const dry = await runCli(config, new RecordingRunner(), ['limits', 'set', 'claude=1', '--dry-run']);
    assert.equal(dry.code, 0);
    assert.equal(fs.readFileSync(config.path, 'utf8'), before);
    const noTty = await runCli(config, new DiskRunner({ dryRun: false }), ['limits', 'set', 'claude=1']);
    assert.equal(noTty.code, 1);
    assert.match(noTty.stderr, /no terminal to ask on/);
    const no = await runCli(config, new DiskRunner({ dryRun: false }), ['limits', 'set', 'claude=1'], { confirm: async () => false });
    assert.match(no.stdout, /Aborted/);
    assert.equal(fs.readFileSync(config.path, 'utf8'), before);
    const yes = await runCli(config, new DiskRunner({ dryRun: false }), ['limits', 'set', 'claude=1', 'codex=off', '-y']);
    assert.equal(yes.code, 0, yes.stderr);
    const now = loadGlobalConfig(path.dirname(config.path));
    assert.deepEqual(now.limits, { claude: 1 });
  });
});

describe('limits: reservations', () => {
  it('reserve adds up, release gives back (a number, or everything)', async () => {
    const config = makeConfig(scratch.sub('reserve'), 'limits:\n  claude: 3\n');
    const ctx = new Context(new DiskRunner({ dryRun: false }), config, () => {});
    await reservePlaces(ctx, parseCounts(['claude'], 1), 'by hand');
    await reservePlaces(ctx, parseCounts(['claude=1'], 1));
    assert.deepEqual(readReservations(config).claude?.count, 2);
    assert.equal(readReservations(config).claude?.note, 'by hand');
    await releasePlaces(ctx, parseCounts(['claude=1'], undefined));
    assert.equal(readReservations(config).claude?.count, 1);
    await releasePlaces(ctx, parseCounts(['claude'], undefined));
    assert.deepEqual(readReservations(config), {});
    await assert.rejects(releasePlaces(ctx, parseCounts(['codex'], undefined)), /nothing is reserved for codex/);
  });

  it('a reserved place counts against the limit: the queue waits, `limits` shows it, release frees it', async () => {
    const config = makeConfig(scratch.sub('count'), 'limits:\n  claude: 2\n');
    const tmux = new FakeTmux();
    seedTask(config, 'NC-1');
    tmux.add('nc-1', '❯ ');
    const runner = new DiskRunner({ dryRun: false, respond: tmux.respond });
    const ctx = new Context(runner, config, () => {});
    await reservePlaces(ctx, parseCounts(['claude=1'], 1), 'my terminal');
    const live = await liveWindows(ctx);
    assert.deepEqual(live.map((w) => w.kind ?? 'window'), ['window', 'reserved']);
    const report = collectLimits(config, live);
    const claude = report.providers[0];
    assert.deepEqual([claude?.limit, claude?.used, claude?.free, claude?.windows, claude?.reserved], [2, 2, 0, ['nc-1'], 1]);
    assert.match(renderLimits(report).join('\n'), /reserved: 1 \(my terminal\)/);
    const entry: QueueEntry = { seq: 1, task: 'NC-2', order: 1, priority: 'normal', status: 'queued', queuedAt: '', agent: 'claude', model: 'opus', effort: 'high', after: [], spec: '' };
    const held = describeQueue(config, [entry], live, [], runner.now())[0];
    assert.equal(held?.condition.kind, 'slot');
    await releasePlaces(ctx, parseCounts(['claude'], undefined));
    const freed = describeQueue(config, [entry], await liveWindows(ctx), [], runner.now())[0];
    assert.equal(freed?.condition.kind, 'ready');
    void readQueue;
  });

  it('the CLI: reserve, show --json, release', async () => {
    const config = makeConfig(scratch.sub('cli-reserve'), 'limits:\n  claude: 3\n');
    const tmux = new FakeTmux();
    const runner = new DiskRunner({ dryRun: false, respond: tmux.respond });
    const r = await runCli(config, runner, ['limits', 'reserve', 'claude=1', '--note', 'ręczny']);
    assert.match(r.stdout, /claude 1 \(ręczny\)/);
    const json = JSON.parse((await runCli(config, runner, ['limits', '--json'])).stdout);
    assert.equal(json.providers[0].reserved, 1);
    assert.equal(json.providers[0].free, 2);
    assert.match((await runCli(config, runner, ['limits', 'release', 'claude'])).stdout, /Nothing is reserved now/);
  });
});

describe('limits: sessions outside agentctl', () => {
  const PS = [
    '  100     1 /sbin/launchd',
    '  200   100 tmux: server',
    '  300   200 -bash',
    '  301   300 claude --model opus --effort high',          // inside a window of agentctl
    '  400   100 -zsh',
    '  401   400 claude',                                      // by hand
    '  402   401 claude',                                      // its child: not a second session
    '  500   100 codex resume --last',                        // by hand
    '  501   100 claude mcp serve',                           // MCP server
    '  502   100 claude -p summarize this',                   // headless
    '  503   100 node /usr/local/bin/agentctl usage-tap --task NC-1',
    '  504   100 /opt/homebrew/bin/codex app-server',
    '  505   100 codex exec do it',
  ].join('\n');

  it('sessionAgent separates terminal sessions from MCP servers, headless runs and agentctl itself', () => {
    assert.equal(sessionAgent('claude --model opus'), 'claude');
    assert.equal(sessionAgent('/opt/homebrew/bin/codex'), 'codex');
    assert.equal(sessionAgent('node /x/node_modules/@anthropic-ai/claude-code/cli.js'), 'claude');
    for (const c of ['claude mcp serve', 'claude -p x', 'codex exec x', 'codex app-server', 'node agentctl.mjs claude', 'vim claude']) assert.equal(sessionAgent(c), undefined, c);
    assert.deepEqual(parsePs(PS).slice(0, 2).map((p) => p.pid), [100, 200]);
  });

  it('detectExternal finds the sessions outside the windows of agentctl, with their directories', async () => {
    const config = makeConfig(scratch.sub('ext'), 'limits:\n  claude: 2\n  count_external: true\n');
    const asked: string[] = [];
    const runner = new DiskRunner({
      dryRun: false,
      respond: (cmd, args) => {
        asked.push(`${cmd} ${args[0]}`);
        if (cmd === 'ps') return { stdout: PS };
        if (cmd === 'tmux' && args[0] === 'list-panes') return { stdout: '300\n' };
        if (cmd === 'lsof') return { stdout: 'p401\nn/Users/x/proj\np500\nn/Users/x/other\n' };
        return undefined;
      },
    });
    const ctx = new Context(runner, config, () => {});
    const found = await detectExternal(ctx);
    assert.deepEqual(found.map((f) => [f.agent, f.pid, f.cwd]), [['claude', 401, '/Users/x/proj'], ['codex', 500, '/Users/x/other']]);
    const report = collectLimits(config, await liveWindows(ctx));
    assert.deepEqual(report.providers.map((p) => [p.agent, p.external.length, p.used, p.free]), [['claude', 1, 1, 1], ['codex', 1, 1, null]]);
    assert.match(renderLimits(report).join('\n'), /external: pid 401 in \/Users\/x\/proj/);
  });

  it('with count_external off (the default) ps is never asked', async () => {
    const config = makeConfig(scratch.sub('ext-off'));
    const asked: string[] = [];
    const runner = new DiskRunner({ dryRun: false, respond: (cmd) => { asked.push(cmd); return undefined; } });
    await liveWindows(new Context(runner, config, () => {}));
    assert.ok(!asked.includes('ps'));
  });

  it('count_external: a wrong type is a config error', () => {
    assert.throws(() => makeConfig(scratch.sub('ext-bad'), 'limits:\n  count_external: maybe\n'), /count_external must be true or false/);
  });
});
