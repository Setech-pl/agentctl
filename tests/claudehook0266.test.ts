import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { planEventWiring } from '../src/core/events.ts';
import { deliverPendingPrompt, queuePrompt } from '../src/core/prompt-delivery.ts';
import { buildClaudeSettings } from '../src/core/providers/claude-events.ts';
import { readTaskRecord, type TaskRecord } from '../src/core/taskstore.ts';
import { remoteMirrorScript } from '../src/core/host-mirror.ts';
import { execFileSync } from 'node:child_process';
import { claudeProjectName } from '../src/core/usage-sources.ts';
import { DiskRunner, makeConfig, seedTask, useScratch } from './helpers.ts';

/*
 * Owner field report 26.11 (HEMS-2-PC-GT2-1): Claude Code 2.1.332 printed "SessionStart:startup hook failed – Failed to run: prompt-type hooks
 * are not supported for SessionStart events" and the queued first prompt stayed pending in an idle window. Fixtures for 2.1.323 and 2.1.332.
 */

const scratch = useScratch();
const HOOK_FAILED = '  ⎿  SessionStart:startup hook failed: Failed to run: prompt-type hooks are not supported for SessionStart events (no conversation context is available). Use a command-type hook instead.';
const screen = (version: string, field = '') => [
  `╭─── Claude Code v${version} ────────────────────────╮`,
  '│                 Welcome back!                   │',
  '╰─────────────────────────────────────────────────╯',
  ...(version === '2.1.332' ? ['', HOOK_FAILED] : []),
  '',
  '────────────────────────────────────────────────────',
  `❯ ${field.split('\n')[0] ?? ''}`,
  '────────────────────────────────────────────────────',
  '  ? for shortcuts',
].join('\n');

/** What each Claude Code version accepts in a settings file (2.1.332: SessionStart hooks must be command-type; older ones run them). */
function acceptedBy(version: string, settings: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const hooks = settings.hooks as Record<string, { hooks: { type: string }[] }[]>;
  for (const [event, groups] of Object.entries(hooks)) for (const group of groups) for (const hook of group.hooks) {
    if (!['command', 'prompt', 'agent', 'http'].includes(hook.type)) problems.push(`${event}: unknown type ${hook.type}`);
    if (version === '2.1.332' && event === 'SessionStart' && hook.type !== 'command') problems.push(`${event}: ${hook.type}-type hooks are not supported`);
  }
  return problems;
}

it('CLAUDEHOOK0266-SETTINGS: generated Claude settings hold only command hooks (SessionStart included) that 2.1.323 and 2.1.332 accept; foreign prompt-type SessionStart hooks are named at start', async () => {
  const { unsupportedSessionStartHooks } = await import('../src/core/providers/claude-events.ts') as { unsupportedSessionStartHooks: (files: string[]) => string[] };
  const settings = buildClaudeSettings('NC-1', ['agentctl'], undefined, 'att-1');
  const hooks = settings.hooks as Record<string, { hooks: { type: string; command: string }[] }[]>;
  assert.deepEqual(Object.keys(hooks).sort(), ['Notification', 'SessionStart', 'Stop', 'StopFailure', 'UserPromptSubmit']);
  for (const groups of Object.values(hooks)) for (const group of groups) for (const hook of group.hooks) assert.equal(hook.type, 'command');
  for (const version of ['2.1.323', '2.1.332']) assert.deepEqual(acceptedBy(version, settings), [], version);

  const root = scratch.sub('settings'), config = makeConfig(root), home = path.join(root, 'claude-home'), wt = path.join(root, 'wt');
  fs.mkdirSync(path.join(wt, '.claude'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'prompt', prompt: 'Summarise the repo' }] }], Stop: [{ hooks: [{ type: 'prompt', prompt: 'ok?' }] }] } }));
  fs.writeFileSync(path.join(wt, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'true' }] }] } }));
  assert.deepEqual(unsupportedSessionStartHooks([path.join(wt, '.claude', 'settings.json'), path.join(home, 'settings.json')]), [`${path.join(home, 'settings.json')} (prompt)`]);
  const wiring = planEventWiring({ agent: 'claude', task: 'NC-1', window: 'nc-1', config, self: ['agentctl'], env: { CLAUDE_CONFIG_DIR: home }, worktree: wt });
  assert.match(wiring.note, /WARNING: SessionStart hooks that are not command-type.*settings\.json \(prompt\)/);
  assert.doesNotMatch(wiring.note, new RegExp(`${path.join(wt, '.claude', 'settings.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(`), 'a command-type project hook is fine');
});

for (const version of ['2.1.323', '2.1.332']) it(`CLAUDEHOOK0266-DELIVERY: Claude ${version} with no hook event at all: the first prompt is pasted on screen readiness and confirmed by its transcript`, async () => {
  const root = scratch.sub(`delivery-${version}`), claude = path.join(root, 'claude'), wt = path.join(root, 'wt');
  const config = makeConfig(root, `capacity: {snapshot: false, codex_refresh: false}\nusage: {claude_dir: ${claude}, codex_dir: ${path.join(root, 'codex')}}\n`);
  let field = '';
  const keys: string[] = [];
  const runner = new DiskRunner({ dryRun: false, startTime: Date.now() - 1000, respond: (cmd, args) => {
    if (cmd !== 'tmux') return {};
    if (args[0] === 'list-windows') return { stdout: '@1\tt1\ttask' };
    if (args[0] === 'capture-pane') return { stdout: screen(version, field) };
    if (args[0] === 'paste-buffer') field = prompt;
    if (args[0] === 'send-keys' && args.at(-1) === 'Enter') { keys.push(field); field = ''; }
    return {};
  } });
  const ctx = new Context(runner, config, () => {});
  const attempt = `att-${version}`;
  const prompt = `Model: opus · effort high\n\nDo the thing.\n\nReport protocol: … <!-- agentctl:attempt ${attempt} --> …`;
  seedTask(config, 'T1', { agent: 'claude', windowId: '@1', attemptId: attempt, repos: [{ path: wt, worktree: wt, branch: 'x' }] as never });
  await queuePrompt(ctx, readTaskRecord(config, 't1')!, prompt, 'pending');
  const first = await deliverPendingPrompt(ctx, 't1');
  assert.equal(keys.length >= 1, true, 'Enter was pressed on an idle, ready window');
  assert.notEqual(first, 'needs-attention');
  // Claude writes the session transcript; no hook ever ran (no UserPromptSubmit receipt, no session named).
  const dir = path.join(claude, 'projects', claudeProjectName(wt));
  fs.mkdirSync(dir, { recursive: true });
  const started = Date.parse(readTaskRecord(config, 't1')!.deliveryStartedAt!);
  fs.writeFileSync(path.join(dir, 'other-session.jsonl'), JSON.stringify({ type: 'user', timestamp: new Date(started + 10).toISOString(), message: { role: 'user', content: 'an unrelated conversation' } }) + '\n');
  fs.writeFileSync(path.join(dir, '5b0e-session.jsonl'), JSON.stringify({ type: 'user', promptSource: 'typed', timestamp: new Date(started + 50).toISOString(), message: { role: 'user', content: prompt } }) + '\n');
  assert.equal(await deliverPendingPrompt(ctx, 't1'), 'sent');
  const record = readTaskRecord(config, 't1')!;
  assert.equal(record.promptDelivery, 'sent');
  assert.equal(record.deliverySource, 'transcript');
});

it('CLAUDEHOOK0266-DELIVERY: on an SSH host without hook receipts the mirror returns only the transcript that holds this attempt', () => {
  const root = scratch.sub('remote'), home = path.join(root, 'claude'), wt = path.join(root, 'wt'), dir = path.join(root, 'task');
  const projects = path.join(home, 'projects', claudeProjectName(wt));
  fs.mkdirSync(projects, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  const row = (text: string) => JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: text } }) + '\n';
  fs.writeFileSync(path.join(projects, 'a.jsonl'), row('unrelated'));
  fs.writeFileSync(path.join(projects, 'b.jsonl'), row('Do it. <!-- agentctl:attempt att-remote -->'));
  const record = { agent: 'claude', env: { CLAUDE_CONFIG_DIR: home }, repos: [{ path: wt, worktree: wt }], attemptId: 'att-remote', started: new Date(Date.now() - 60_000).toISOString(), remoteDir: dir, remoteReport: path.join(dir, 'R.md') } as unknown as TaskRecord;
  const out = JSON.parse(execFileSync(process.execPath, ['-e', remoteMirrorScript(record)], { encoding: 'utf8' }));
  assert.match(out.transcript ?? '', /att-remote/);
  fs.writeFileSync(path.join(projects, 'c.jsonl'), row('again <!-- agentctl:attempt att-remote -->'));
  assert.equal(JSON.parse(execFileSync(process.execPath, ['-e', remoteMirrorScript(record)], { encoding: 'utf8' })).transcript, undefined, 'two candidates: none is chosen');
});
