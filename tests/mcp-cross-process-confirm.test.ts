import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { it } from 'node:test';
import { fakeWatcher, makeConfig, specText, useScratch } from './helpers.ts';
import { readQueue } from '../src/core/queue.ts';
const scratch = useScratch();
for (const name of ['queue', 'new']) it(`R2: two MCP processes confirm ${name} once under the queue accept lock`, { timeout: 30000 }, async () => {
  const root = scratch.sub(name);
  const config = makeConfig(root, `mcp: {allow: [${name}]}\ncapacity: {snapshot: false, codex_refresh: false}\n`);
  fakeWatcher(config);
  const spec = specText({ task: 'CROSS', agent: 'claude' }, scratch.sub(`${name}-repo`));
  const moduleUrl = (rel: string) => new URL(rel, import.meta.url).href;
  const source = String.raw`
    import fs from 'node:fs';
    import { loadGlobalConfig } from ${JSON.stringify(moduleUrl('../src/core/config.ts'))};
    import { Context } from ${JSON.stringify(moduleUrl('../src/core/context.ts'))};
    import { MCP_TOOLS } from ${JSON.stringify(moduleUrl('../src/core/mcp-tools.ts'))};
    import { DiskRunner, FakeTmux } from ${JSON.stringify(moduleUrl('./helpers.ts'))};
    const config = loadGlobalConfig(${JSON.stringify(path.dirname(config.path))});
    crypto.randomUUID = () => '11111111-1111-4111-8111-111111111111'; // same preview identity in both servers
    let confirm = false, blocked = false, resumeWrite;
    const open = fs.openSync;
    fs.openSync = function(file, ...args) {
      try { return open.call(fs, file, ...args); }
      catch(e) { if (confirm && String(file).endsWith('/queue-accept.lock') && e.code === 'EEXIST' && !blocked) { blocked = true; process.send({stage:'blocked'}); } throw e; }
    };
    const runner = new DiskRunner({dryRun:false, respond:new FakeTmux().respond});
    const write = runner.writeFile.bind(runner);
    runner.writeFile = async (file, content) => {
      if (confirm && /\/queue\/\d+-CROSS\.json$/.test(file)) {
        process.send({stage:'write'});
        await new Promise(r => { resumeWrite = r; });
      }
      return write(file, content);
    };
    const ctx = new Context(runner, config, () => {});
    const deps = {context: () => ctx, notify: async () => {}};
    const tool = MCP_TOOLS.find(t => t.name === ${JSON.stringify(name)});
    const preview = await tool.run(deps, {spec:${JSON.stringify(spec)}});
    if (preview.isError) throw new Error(preview.text);
    const token = /preview_token: (\S+)/.exec(preview.text)[1];
    process.on('message', async msg => {
      if (msg === 'release') { resumeWrite?.(); return; }
      if (msg !== 'go') return;
      confirm = true;
      try { process.send({stage:'done', result:await tool.run(deps, {confirm:true,preview_token:token})}); }
      catch(e) { process.send({stage:'error', error:String(e)}); }
    });
    process.send({stage:'ready'});
  `;
  const children = [0, 1].map(() => spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
  let stderr = '';
  let writes = 0, signals = 0, ready = 0;
  const results: {text: string; isError?: boolean}[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      for (const child of children) {
        child.stderr!.on('data', bytes => { stderr += bytes; });
        child.on('error', reject);
        child.on('exit', code => { if (code !== null && code !== 0) reject(new Error(stderr)); });
        child.on('message', (message: {stage: string; result?: typeof results[number]; error?: string}) => {
          if (message.stage === 'ready' && ++ready === 2) children.forEach(c => c.send('go'));
          if (message.stage === 'write' || message.stage === 'blocked') {
            if (message.stage === 'write') writes++;
            if (++signals === 2) children.forEach(c => c.send('release'));
          }
          if (message.stage === 'error') reject(new Error(message.error));
          if (message.stage === 'done') { results.push(message.result!); if (results.length === 2) resolve(); }
        });
      }
    });
    assert.ok(results.every(r => !r.isError), JSON.stringify(results));
    assert.equal(writes, 1, 'only one process may publish the queue entry');
    assert.equal(results.filter(r => /already executed: CROSS/.test(r.text)).length, 1);
    assert.equal(readQueue(config).length, 1);
  } finally {
    await Promise.all(children.map(child => new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode !== null) return resolve(); child.once('exit', () => resolve()); child.kill('SIGKILL'); })));
  }
});
