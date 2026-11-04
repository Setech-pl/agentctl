import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { defaultCacheRoot, withHarness } from './live-harness.ts';
import { loadGlobalConfig } from '../src/core/config.ts';
import { renderTaskMd } from '../src/core/taskstore.ts';
import type { TaskRecord } from '../src/core/taskstore.ts';
import { shellQuote } from '../src/core/util.ts';

const root = defaultCacheRoot('agentctl-economy');
const checks: string[] = [];
const check = (name: string, ok: unknown) => { assert.ok(ok, name); checks.push(name); console.log(`PASS ${name}`); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
await withHarness({ name: 'board-models', cacheRoot: root, config: 'board: {model_versions: {opus: "5.5"}}\ncapacity: {codex_refresh: false}\n' }, async h => {
  const config = loadGlobalConfig(h.agentctlHome);
  const pane = path.join(h.root, 'pane.mjs');
  fs.writeFileSync(pane, "console.log('Working (esc to interrupt)'); setInterval(()=>{},1000);");
  const node = shellQuote(process.execPath);
  for (const [i, task, agent, model, effort] of [
    ['0', 'NEON-BACKEND-TASK-12', 'codex', 'gpt-6.1-sol', 'xhigh'],
    ['1', 'NEON-CITY-REVIEW-12', 'claude', 'opus', 'high'],
  ]) {
    const window = task!.toLowerCase();
    const command = `${node} ${shellQuote(pane)}`;
    const args = i === '0' ? ['new-session', '-d', '-s', h.session, '-n', window, '-x', '160', '-y', '30', command] : ['new-window', '-d', '-t', `=${h.session}:`, '-n', window, command];
    assert.equal(h.tmux(args).code, 0);
    const record: TaskRecord = { task: task!, window, session: h.session, agent: agent as 'claude' | 'codex', model: model!, effort: effort!, repos: [], links: [], env: {}, report: path.join(h.root, task! + '.md'), started: new Date(Date.now() - 60000).toISOString(), requested: { agent: agent as 'claude' | 'codex', model: model!, effort: effort! } };
    fs.mkdirSync(path.join(config.stateDir, window), { recursive: true });
    fs.writeFileSync(path.join(config.stateDir, window, 'TASK.md'), renderTaskMd(record, 'Isolated board fixture'));
  }
  const command = ['env', 'NO_COLOR=1', process.execPath, '--experimental-strip-types', '--no-warnings', path.resolve(import.meta.dirname, '../bin/agentctl.ts'), 'board'].map(shellQuote).join(' ');
  assert.equal(h.tmux(['new-window', '-d', '-t', `=${h.session}:`, '-n', 'board', command]).code, 0);
  const target = `=${h.session}:board`;
  const capture = () => h.tmux(['capture-pane', '-p', '-t', target]).stdout;
  const until = async (pattern: RegExp) => {
    const end = Date.now() + 15000;
    while (Date.now() < end) { const text = capture(); if (pattern.test(text)) return text; await sleep(150); }
    throw new Error(`board did not render ${pattern}:\n${capture()}`);
  };
  const wide = await until(/NEON-BACKEND-TASK-12\s+cx S 6\.1 XH/);
  check('wide real tmux list keeps full task and compact model/effort', wide.includes('NEON-CITY-REVIEW-12') && wide.includes('cl O 5.5 HI'));
  check('wide real tmux includes all columns and full selected model in preview', /TASK\s+AGENT\s+STATE\s+TIME\s+TOKENS\s+PROGRESS\s+REPORT/.test(wide) && /model: gpt-6.1-sol.*effort: xhigh/.test(wide));
  h.tmux(['resize-window', '-t', target, '-x', '80', '-y', '30']);
  const narrow = await until(/cx S 6\.1 XH/);
  check('narrow list remains usable without preview', !narrow.includes('model: gpt-6.1-sol'));
  h.tmux(['send-keys', '-t', target, '?']);
  const help = await until(/model: gpt-6\.1-sol.*effort: xhigh/);
  check('help retains full selected names and effort legend under NO_COLOR', /MN minimal/.test(help) && /XH xhigh/.test(help));
  h.tmux(['send-keys', '-t', target, 'Escape', 'q']);
  fs.writeFileSync(path.join(root, 'board-live-render.json'), JSON.stringify({ terminal: 160, listWidth: 92, wide, narrow, help }, null, 2));
});
fs.writeFileSync(path.join(root, 'live-board-results.json'), JSON.stringify({ passed: checks.length, failed: 0, checks }, null, 2));
