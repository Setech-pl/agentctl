import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import YAML from 'yaml';
import { Harness, commandV, defaultCacheRoot } from '../scripts/live-harness.ts';
import { shellQuote } from '../src/core/util.ts';
import { REPO_ROOT } from './helpers.ts';

/*
 * P19 over the real thing: the MCP server as the app starts it (stdio, a real Client), a real watcher process, a real tmux server of its own, the
 * fake agent of the live harness. The first setup stays active until both clients
 * have read its progress and the original MCP connection has shut down.
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('P19 over stdio: the MCP server is never held by a setup', () => {
  it('confirm returns in seconds, every read answers during the setup, the setup survives the death of the MCP server and finishes in the watcher', async () => {
    const cache = defaultCacheRoot();
    const h = new Harness({ name: 'p19-stdio', cacheRoot: cache, config: 'capacity: {snapshot: false, codex_refresh: false}\nmcp: {allow: [new]}\nwatch: {interval: 1}\n' }, REPO_ROOT);
    // tests/isolation.ts replaced tmux on the PATH of this process with a stub; the harness links the real tools into its fake bin directory.
    // Only the real tmux goes in front: on Linux it lives in /usr/bin next to a system node (and possibly a real agent).
    const realTmux = commandV('tmux', ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':'));
    assert.ok(realTmux, 'tmux is installed');
    const tools = fs.mkdtempSync(path.join(process.env.TMPDIR ?? REPO_ROOT, 'p19-tools-'));
    fs.symlinkSync(realTmux, path.join(tools, 'tmux'));
    const isolatedPath = process.env.PATH;
    process.env.PATH = `${tools}:${isolatedPath}`;
    try { h.start(); } finally { process.env.PATH = isolatedPath; }
    const clients: Client[] = [];
    try {
      const finishSetup = path.join(h.root, 'allow-setup-to-finish');
      // Gate clean uses the legacy alias; it must still connect to a shortened socket directory.
      const cleanupSocket = path.join(h.root, 'tmx', `tmux-${process.getuid?.() ?? 0}`, 'default');
      const cleanupProbe = spawnSync('tmux', ['-S', cleanupSocket, 'display-message', '-p', '#{socket_path}'], {env: h.env, encoding: 'utf8'});
      assert.equal(cleanupProbe.status, 0, cleanupProbe.stderr);
      const git = (cwd: string, args: string[]) => { const r = spawnSync('git', ['-C', cwd, ...args], { env: h.env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
      const repos = ['alpha', 'beta'].map((n) => {
        const dir = path.join(h.root, n);
        fs.mkdirSync(dir);
        git(dir, ['init', '-b', 'main']);
        fs.writeFileSync(path.join(dir, 'file.txt'), 'x\n');
        const wait = n === 'alpha' ? 'while [ ! -f ' + shellQuote(finishSetup) + ' ]; do sleep 0.05; done; ' : '';
        fs.writeFileSync(path.join(dir, '.agentctl.yaml'), YAML.stringify({ setup: [wait + 'echo installed-' + n] }));
        git(dir, ['add', '.']);
        git(dir, ['commit', '-m', 'fixture']);
        return dir;
      });
      const spec = `---\n${YAML.stringify({ task: 'SLOW-1', agent: 'claude', model: 'sonnet', effort: 'high', repos: repos.map((p) => ({ path: p, worktree: `${p}-SLOW-1`, branch: 'slow-1' })) })}---\nDo the thing.\n`;
      const watcher = h.spawnAgentctl(['watch', '--tmux'], path.join(h.root, 'watch.log'));
      void watcher;
      await sleep(2500);
      const connect = async (name: string): Promise<{ client: Client; transport: StdioClientTransport }> => {
        const transport = new StdioClientTransport({ command: process.execPath, args: ['--experimental-strip-types', '--no-warnings', path.join(REPO_ROOT, 'bin', 'agentctl.ts'), 'mcp'], env: h.env as Record<string, string>, stderr: 'pipe' });
        const client = new Client({ name, version: '1' });
        await client.connect(transport);
        clients.push(client);
        return { client, transport };
      };
      const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
        const t0 = Date.now();
        const r = await client.callTool({ name, arguments: args });
        return { ms: Date.now() - t0, error: Boolean(r.isError), text: (r.content as { text: string }[]).map((c) => c.text).join('\n') };
      };
      const a = await connect('chat-a');
      const b = await connect('chat-b');
      const preview = await call(a.client, 'new', { spec });
      assert.ok(!preview.error, preview.text);
      const t0 = Date.now();
      const confirmed = await call(a.client, 'new', { spec, confirm: true });
      const confirmMs = Date.now() - t0;
      assert.ok(!confirmed.error, confirmed.text);
      assert.match(confirmed.text, /^Registered: SLOW-1/);
      assert.ok(confirmMs < 5000, `confirm took ${confirmMs} ms`);
      assert.equal(fs.existsSync(path.join(h.agentctlHome, 'queue')), true);
      const journal = path.join(h.agentctlHome, 'journal.jsonl');
      const auditRecorded = () => {
        try { return /"kind":"mcp-write","text":"new: new SLOW-1"/.test(fs.readFileSync(journal, 'utf8')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
      };

      // reads, from the same server and from another chat's, while the watcher is in the setup
      let sawSetup = false;
      let firstServer = a.client;
      let again = '';
      const slowest: number[] = [];
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline && !/START\s+SLOW-1/.test((await call(b.client, 'events_since', { client: 'p19-b' })).text)) {
        for (const [client, tool, args] of [[firstServer, 'status', {}], [b.client, 'status', {}], [firstServer, 'queue_list', {}], [b.client, 'version', {}], [b.client, 'peek', { task: 'SLOW-1' }]] as const) {
          const r = await call(client, tool, args as Record<string, unknown>);
          slowest.push(r.ms);
          if (tool === 'queue_list' && /setup w toku \(repo \d\/2/.test(r.text)) sawSetup = true;
        }
        if (sawSetup && !again && auditRecorded()) {
          // a repeated confirm during the setup, and the death of the first server in the middle of it
          again = (await call(b.client, 'new', { spec, confirm: true })).text;
          assert.match(again, /SLOW-1: already being started/);
          await a.client.close();
          firstServer = b.client;
          fs.writeFileSync(finishSetup, 'MCP client closed\n');
        }
        await sleep(300);
      }
      assert.ok(sawSetup, 'queue_list said where the setup was');
      assert.ok(auditRecorded(), 'the asynchronous order audit reached the journal');
      assert.match(again, /SLOW-1: already being started/);
      assert.ok(Math.max(...slowest) < 2000, `reads took up to ${Math.max(...slowest)} ms`);

      // the setup finished in the watcher although the server that took the order is gone
      const status = await call(b.client, 'status', {});
      assert.match(status.text, /SLOW-1/);
      const log = fs.readFileSync(path.join(h.agentctlHome, '..', 'state', 'slow-1', 'setup.log'), 'utf8');
      assert.match(log, /installed-alpha[\s\S]*installed-beta/);
      assert.equal(h.agentStarts().filter((l) => l.startsWith('claude') && !/--version|--help/.test(l)).length, 1, 'the agent was started once');
      assert.equal(fs.readdirSync(path.join(h.agentctlHome, 'queue')).filter((f) => f.endsWith('.json')).length, 0, 'the entry is gone');
    } finally {
      await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
      h.stop();
    }
  });
});
