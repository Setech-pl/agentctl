import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { withHarness, installPromptAgent } from './live-harness.ts';

/** Additional three-provider cases shared by scenarios and dispatcher; every subprocess inherits harness env. */
export async function providerDispatchCases(cache: string, name: string): Promise<string[]> {
  const passed: string[] = [];
  const check = (label: string, ok: unknown, detail = '') => { assert.ok(ok, `${label}: ${detail}`); passed.push(label); console.log(`PASS ${label}`); };
  await withHarness({ name, cacheRoot: cache, config: 'providers: [claude, codex, kimi]\ncapacity: {snapshot: false, codex_refresh: false}\nreview: {prefer: [kimi, codex, claude]}\n' }, async h => {
    const log = path.join(h.root, 'kimi.jsonl'); installPromptAgent(h, 'kimi', 'idle', log);
    const repo = path.join(h.root, 'repo'); fs.mkdirSync(repo);
    for (const args of [['init', '-q', repo], ['-C', repo, 'commit', '--allow-empty', '-qm', 'init']]) assert.equal(spawnSync('git', args, { env: h.env }).status, 0);
    const spec = `---\ntask: SOURCE\nagent: claude\nmodel: claude-sonnet-5-5\neffort: high\nrepos: [{path: ${repo}, worktree: ${repo}-source, branch: source}]\n---\nContinue this synthetic task.\n`;
    const started = h.agentctl(['new', '-', '--no-switch'], { input: spec }); assert.equal(started.code, 0, started.stderr);
    const module = path.join(h.root, 'review.mjs'), src = path.resolve(import.meta.dirname, '../src/core');
    fs.writeFileSync(module, `import {loadGlobalConfig} from ${JSON.stringify(`${src}/config.ts`)}; import {Context} from ${JSON.stringify(`${src}/context.ts`)}; import {RealRunner} from ${JSON.stringify(`${src}/runner.ts`)}; import {readTaskRecord} from ${JSON.stringify(`${src}/taskstore.ts`)}; import {reviewOrder} from ${JSON.stringify(`${src}/review.ts`)}; const config=loadGlobalConfig(); console.log(JSON.stringify(await reviewOrder(new Context(new RealRunner(),config,()=>{}),readTaskRecord(config,'source'),{})));`);
    const reviewed = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', module], { env: h.env, encoding: 'utf8' });
    check('three-provider automatic review prefers Kimi', reviewed.status === 0 && JSON.parse(reviewed.stdout).order.agent === 'kimi', reviewed.stderr);
    const refused = h.agentctl(['move', 'SOURCE', '-y']);
    check('three-provider move requires a target and shows free slots/usage', refused.code !== 0 && /--agent codex\|kimi.*free slots.*usage/.test(refused.stderr), refused.stderr);
    const moved = h.agentctl(['move', 'SOURCE', '--agent', 'kimi', '-y']);
    check('explicit Claude to Kimi move preserves worktree', moved.code === 0 && moved.stdout.includes('SOURCE-2') && fs.readFileSync(log, 'utf8').includes(`${repo}-source`), moved.stderr);
    const queued = h.agentctl(['queue', '-', '-y'], { input: spec.replaceAll('SOURCE', 'QUEUED').replaceAll('source', 'queued').replace('agent: claude', 'agent: kimi').replace('model: claude-sonnet-5-5', 'model: k3') });
    check('Kimi can wait in the queue', queued.code === 0 && h.agentctl(['queue', 'list', '--json']).stdout.includes('kimi'), queued.stderr);
  });
  return passed;
}

export async function providerMcpCases(cache: string): Promise<string[]> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const results: Record<string, unknown> = {};
  for (const [label, enabled] of [['off', false], ['on', true]] as const) {
    await withHarness({ name: enabled ? 'mon1' : 'moff', cacheRoot: cache, config: `capacity: {codex_refresh: false}\n${enabled ? 'providers: [claude, codex, kimi]\n' : ''}` }, async h => {
      const client = new Client({ name: 'provider-economy', version: '1' });
      try {
        h.check();
        await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--experimental-strip-types', '--no-warnings', path.resolve(import.meta.dirname, '../bin/agentctl.ts'), 'mcp'], env: h.env as Record<string, string>, stderr: 'pipe' }));
        const list = await client.listTools();
        const measure: Record<string, unknown> = { tools: list.tools.length, tools_list: Buffer.byteLength(JSON.stringify(list)) };
        const agent = list.tools.find(t => t.name === 'new')!.inputSchema.properties!.agent as { enum: string[] };
        assert.equal(agent.enum.includes('kimi'), enabled);
        assert.equal('kimi' in list.tools.find(t => t.name === 'set_limits')!.inputSchema.properties!, enabled);
        for (const name of ['capacity', 'limits', 'status']) {
          const response = await client.callTool({ name, arguments: {} }); assert.ok(!response.isError, JSON.stringify(response));
          measure[name] = { bytes: Buffer.byteLength(JSON.stringify(response)), response };
        }
        results[label] = measure;
      } finally { await client.close(); }
    });
  }
  fs.writeFileSync(path.join(cache, 'mcp-final-live.json'), JSON.stringify(results, null, 2));
  return ['MCP off/on provider enums', 'MCP off/on provider count fields', 'MCP off/on list and response sizes'];
}
