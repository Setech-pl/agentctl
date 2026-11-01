import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadGlobalConfig } from '../src/core/config.ts';
import { Context } from '../src/core/context.ts';
import { MCP_TOOL_NAMES } from '../src/core/mcp-tools.ts';
import type { McpDeps } from '../src/core/mcp-tools.ts';
import { runCli } from './helpers.ts';
import { buildMcpServer, SERVER_INSTRUCTIONS } from '../src/mcp/server.ts';
import { DiskRunner, FakeTmux, makeConfig, REPO_ROOT, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();

async function connected(name: string) {
  const config = makeConfig(scratch.sub(name), 'mcp: {allow: [send]}\n');
  const tmux = new FakeTmux();
  const runner = new DiskRunner({ dryRun: false, respond: tmux.respond, startTime: Date.now() });
  const sent: string[] = [];
  const deps: McpDeps = { context: (out) => new Context(runner, loadGlobalConfig(path.dirname(config.path)), out), notify: async (m) => void sent.push(m) };
  const server = buildMcpServer(deps, '9.9.9');
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { config, tmux, client, server, sent, close: () => client.close() };
}

describe('mcp: the SDK front (in memory)', () => {
  it('lists every tool with its title, annotations and a JSON schema; the server says who it is and how to use it', async () => {
    const t = await connected('m1');
    const { tools } = await t.client.listTools();
    assert.deepEqual(tools.map((x) => x.name), MCP_TOOL_NAMES);
    const peek = tools.find((x) => x.name === 'peek')!;
    assert.equal(peek.annotations?.readOnlyHint, true);
    assert.equal(peek.annotations?.title, 'Look into a task window');
    const props = (peek.inputSchema as { properties: Record<string, { maximum?: number }>; required?: string[] }).properties;
    assert.deepEqual(Object.keys(props), ['task', 'lines']);
    assert.equal(props.lines?.maximum, 200);
    assert.deepEqual((peek.inputSchema as { required?: string[] }).required, ['task']);
    assert.equal(tools.find((x) => x.name === 'close')?.annotations?.destructiveHint, true);
    assert.equal(t.client.getServerVersion()?.name, 'agentctl');
    assert.equal(t.client.getServerVersion()?.version, '9.9.9');
    assert.equal(t.client.getInstructions(), SERVER_INSTRUCTIONS);
    await t.close();
  });

  it('calls a read tool and a write tool; a refused write is a tool error the chat can read, not a crash', async () => {
    const t = await connected('m2');
    seedTask(t.config, 'NC-1');
    t.tmux.add('nc-1', 'Welcome\n❯ \n');
    const status = await t.client.callTool({ name: 'status', arguments: {} });
    assert.match((status.content as { text: string }[])[0]?.text ?? '', /^1 task: 1 waiting/);
    const refused = await t.client.callTool({ name: 'interrupt', arguments: { task: 'NC-1' } });
    assert.equal(refused.isError, true);
    assert.match((refused.content as { text: string }[])[0]?.text ?? '', /Writing is off for "interrupt"/);
    const sent = await t.client.callTool({ name: 'send', arguments: { task: 'NC-1', text: 'hello' } });
    assert.ok(!sent.isError);
    assert.deepEqual(t.sent, ['czat zlecił: send NC-1']);
    await t.close();
  });

  it('arguments that break the schema never reach a tool', async () => {
    const t = await connected('m3');
    for (const args of [{ task: 'NC-1', lines: 500 }, { lines: 5 }, { task: 'NC-1', lines: 'many' }]) {
      const outcome = await t.client.callTool({ name: 'peek', arguments: args }).then((r) => (r.isError ? 'error result' : 'ok'), () => 'rejected');
      assert.notEqual(outcome, 'ok', JSON.stringify(args));
    }
    assert.ok(!t.sent.length);
    await t.close();
  });
});

describe('mcp: over stdio, as the app starts it', () => {
  it('`agentctl mcp` answers on stdout with protocol messages only and ends when stdin does', async () => {
    const root = scratch.sub('stdio');
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'config.yaml'), `cache: ${root}/cache\nstate_dir: ${root}/state\n`);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--experimental-strip-types', '--no-warnings', path.join(REPO_ROOT, 'bin', 'agentctl.ts'), 'mcp'],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', AGENTCTL_HOME: home, TMUX_TMPDIR: root, LANG: 'en_US.UTF-8' },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-test', version: '0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((x) => x.name), MCP_TOOL_NAMES);
    const status = await client.callTool({ name: 'status', arguments: {} });
    assert.equal((status.content as { text: string }[])[0]?.text.split('\n')[0], 'No tasks');
    await client.close();
  });

  it('`agentctl mcp` with a stub server: stdout stays silent, the tools get the settings of this run', async () => {
    const config = makeConfig(scratch.sub('cli'));
    let seen: McpDeps | undefined;
    const r = await runCli(config, new DiskRunner({ dryRun: false }), ['mcp'], {
      selfArgv: () => ['/opt/node/bin/node', '/opt/agentctl/bin/agentctl.ts'],
      runMcp: async (tools, version) => {
        seen = tools;
        assert.match(version, /^\d+\.\d+\.\d+/);
      },
    });
    assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', '']);
    assert.deepEqual(seen?.self, ['/opt/node/bin/node', '/opt/agentctl/bin/agentctl.ts']);
    assert.equal(seen?.context(() => {}).config.path, config.path);
  });
});
