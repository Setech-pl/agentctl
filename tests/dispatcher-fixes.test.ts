import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { installClaudeCode, mcpEntryFrom } from '../src/core/mcp-install.ts';
import { readRateLimits } from '../src/core/readonly-rpc.ts';
import { runDoctor } from '../src/core/doctor.ts';
import { Context } from '../src/core/context.ts';
import { RecordingRunner } from '../src/core/runner.ts';
import { ensureWindow } from '../src/core/windows.ts';
import { DiskRunner, FakeTmux, makeConfig, makeContext, useScratch } from './helpers.ts';
const scratch = useScratch();

describe('dispatcher production regressions', () => {
  it('MCP entry prefers the stable symlink outside Cellar', () => {
    const root = scratch.sub('brew');
    const node = path.join(root, 'Cellar/node/26.0.0/bin/node');
    fs.mkdirSync(path.dirname(node), { recursive: true }); fs.writeFileSync(node, '');
    fs.mkdirSync(path.join(root, 'bin')); fs.symlinkSync(node, path.join(root, 'bin/node'));
    assert.equal(mcpEntryFrom([node, '/pkg/dist/bin/agentctl.js']).command, path.join(root, 'bin/node'));
  });
  it('dry-run reads an existing Claude registration but neither writes it nor claims it was registered', async () => {
    const config = makeConfig(scratch.sub('dry'));
    const reads = new RecordingRunner({ dryRun: false, respond: (_cmd, args) => args.includes('get') ? { stdout: 'agentctl:\nCommand: /node /pkg.js mcp' } : {} });
    const runner = new RecordingRunner({ readRunner: reads });
    const out: string[] = [];
    const ctx = new Context(runner, config, (l) => out.push(l));
    const r = await installClaudeCode(ctx, { command: '/node', args: ['/pkg.js', 'mcp'], env: {} }, { yes: true });
    assert.equal(r.outcome, 'dry-run');
    assert.match(out.join('\n'), /Registered now/); assert.match(out.join('\n'), /Dry run: nothing/);
    assert.doesNotMatch(out.join('\n'), /Not registered yet|Registered\./);
    assert.ok(!reads.commands.some((c) => /mcp add|mcp remove/.test(c)));
  });
  it('renamed watch and board resolve by role without creating a second window', async () => {
    const config = makeConfig(scratch.sub('roles'));
    const { ctx, runner } = makeContext(config, { respond: (_cmd, args) => {
      if (args[0] === 'list-windows') return { stdout: '@7\tSomething else\twatch\n@9\tDashboard title\tboard\n' };
      if (args[0] === 'display-message') return { stdout: '0' };
      return {};
    } });
    assert.equal(await ensureWindow(ctx, 'watch', 'agentctl watch', '/work'), 'exists');
    assert.equal(await ensureWindow(ctx, 'board', 'agentctl board', '/work'), 'exists');
    await ctx.tmux.killRole('watch');
    assert.ok(runner.commands.includes('tmux kill-window -t @7'));
    assert.ok(!runner.commands.some((c) => c.includes('new-window')));
  });
  it('doctor warns about versioned MCP Node, gives executable repair/start commands, and missing project guide', async () => {
    const root = scratch.sub('doctor'); const config = makeConfig(root);
    const project = scratch.sub('doctor-project'); fs.writeFileSync(path.join(project, '.agentctl.yaml'), 'guide: missing.md\n');
    const desktop = path.join(root, 'Library/Application Support/Claude/claude_desktop_config.json');
    fs.mkdirSync(path.dirname(desktop), { recursive: true });
    fs.writeFileSync(desktop, JSON.stringify({ mcpServers: { agentctl: { command: '/opt/homebrew/Cellar/node/26/bin/node', args: ['/missing.js', 'mcp'] } } }));
    const runner = new RecordingRunner({ dryRun: false, respond: (cmd, args) => {
      if (cmd === 'git') return { stdout: 'git version 2.51.0' };
      if (cmd === 'tmux') return args[0] === '-V' ? { stdout: 'tmux 3.6' } : { code: 1 };
      return { code: 1 };
    } });
    const checks = await runDoctor(runner, () => config, project, '26.13.0', 'darwin', root, {});
    assert.match(checks.find((c) => c.name === 'mcp node (Claude desktop)')!.detail, /agentctl mcp install --desktop --claude-code/);
    assert.match(checks.find((c) => c.name === 'watch')!.detail, /agentctl watch --tmux --restart/);
    assert.equal(checks.find((c) => c.name === 'project guide')!.status, 'warn');
  });
  it('RPC handshakes, returns provider data and stops without ever starting a turn', async () => {
    const root = scratch.sub('rpc-handshake'); const fake = path.join(root, 'fake.mjs'); const log = path.join(root, 'rpc.json');
    fs.writeFileSync(fake, `import readline from 'node:readline'; import fs from 'node:fs'; const seen=[]; readline.createInterface({input:process.stdin}).on('line', l=>{ const m=JSON.parse(l);seen.push(m.method);fs.writeFileSync(${JSON.stringify(log)},JSON.stringify(seen)); if(m.id) console.log(JSON.stringify({id:m.id,result:m.id===1?{userAgent:'fake'}:{rateLimits:{primary:{usedPercent:10}}}})); });`);
    const result = await readRateLimits(process.execPath, [fake], root, 2000);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).rateLimits.primary.usedPercent, 10);
    assert.deepEqual(JSON.parse(fs.readFileSync(log, 'utf8')), ['initialize', 'initialized', 'account/rateLimits/read']);
  });
  it('RPC missing executable and timeout are bounded and cannot leave a server', async () => {
    assert.equal((await readRateLimits('/no/such/program', [], undefined, 100)).code, 127);
    const start = Date.now();
    assert.equal((await readRateLimits(process.execPath, ['-e', 'setInterval(()=>{},1000)'], undefined, 100)).code, 1);
    assert.ok(Date.now() - start < 2000);
  });
});

describe('notification ownership durability', () => {
  it('recovers a dead lock owner but never steals a live owner', async () => {
    const { tryFileLock, withFileLock } = await import('../src/core/file-lock.ts');
    const file = path.join(scratch.sub('lock-owner'), 'send.lock');
    fs.writeFileSync(file, '99999999');
    const release = tryFileLock(file); assert.ok(release);
    assert.equal(tryFileLock(file), undefined);
    release();
    await assert.rejects(withFileLock(file, async () => { throw new Error('delivery failed'); }), /delivery failed/);
    assert.equal(fs.existsSync(file), false);
  });
  it('concurrent failed enqueues and a retry cannot overwrite or duplicate another pending notification', async () => {
    const { notifyPhone, phoneTick, queuedForPhone } = await import('../src/core/phone-send.ts');
    const config = makeConfig(scratch.sub('phone-owner'), 'notify:\n  ntfy:\n    topic: local-only\n    server: http://127.0.0.1:1\n    always: true\n');
    const fake = new FakeTmux(); const runner = new DiskRunner({ dryRun: false, respond: fake.respond });
    const ctx = new Context(runner, config, () => {});
    let phase = 0; const accepted: string[] = [];
    ctx.fetch = async (_url, init) => {
      const body = String(init?.body);
      const ok = phase > 0 && (phase > 1 || !body.includes('APP-5'));
      if (ok) accepted.push(body);
      await new Promise((resolve) => setImmediate(resolve));
      return { status: ok ? 200 : 503 } as Response;
    };
    const send = (task: string) => notifyPhone(ctx, { kind: 'report-ready', task, text: 'ready' });
    await Promise.all(['APP-1', 'APP-2', 'APP-3', 'APP-4'].map(send));
    assert.equal(queuedForPhone(config), 4);
    phase = 1; await runner.sleep(30001);
    await Promise.all([phoneTick(ctx), send('APP-5')]);
    assert.equal(queuedForPhone(config), 1);
    phase = 2; await runner.sleep(30001); await phoneTick(ctx);
    assert.equal(queuedForPhone(config), 0);
    assert.equal(accepted.length, 5); assert.equal(new Set(accepted).size, 5);
  });
});
