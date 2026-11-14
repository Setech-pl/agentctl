import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { acceptConsult, anonymise, answerProblems, consultFile, consultTick, parseConsult, planConsult, readConsult } from '../src/core/consult.ts';
import { newTasks } from '../src/core/new.ts';
import { protectReadOnly, readOnlyFindings } from '../src/core/read-only.ts';
import { groupTitle } from '../src/core/board.ts';
import { readCohort } from '../src/core/cohort.ts';
import { Context } from '../src/core/context.ts';
import { RealRunner } from '../src/core/runner.ts';
import { readQueue } from '../src/core/queue.ts';
import { resolveSpec, splitSpecs } from '../src/core/spec.ts';
import { readJournal } from '../src/core/journal.ts';
import { MCP_TOOLS, applyMcpRequest } from '../src/core/mcp-tools.ts';
import { readMcpRequests } from '../src/core/mcp-requests.ts';
import { channelMessages, readThread } from '../src/core/wall.ts';
import { fakeWatcher, makeConfig, makeContext, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();
const SHA = 'a'.repeat(40);
const panel = [{ agent: 'claude' as const, model: 'opus', effort: 'high' }, { agent: 'codex' as const, model: 'gpt-5.4', effort: 'high' }];
function fixture(name: string, extra = '') {
  const root = scratch.sub(name);
  const config = makeConfig(root, `mcp: {allow: [consult]}\ncapacity: {snapshot: false, codex_refresh: false}\nwall:\n  channels:\n    'shared:sim': {authors: [owner]}\n${extra}`);
  const { ctx, runner } = makeContext(config, { dryRun: false, respond: (cmd, args) => cmd === 'git' && args.includes('rev-parse') ? { code: 0, stdout: SHA + '\n' } : undefined });
  const spec = (overrides = {}) => JSON.stringify({ consult: 'NC-CHOICE', question: 'Which contract?', repos: [{ path: root }], panel, synthesis: panel[0], post_to: 'shared:sim', ...overrides });
  async function finish(task: string, text: string, baseline = true) {
    const entry = readQueue(config).find(e => e.task === task)!;
    const s = resolveSpec(splitSpecs(entry.spec)[0]!, { config });
    if (baseline) await protectReadOnly(ctx, s);
    const record = seedTask(config, task, { attemptId: `fake-${task}`, report: s.report, repos: s.repos, env: s.env, agent: s.agent, model: s.model, effort: s.effort, cohort: s.cohort });
    fs.mkdirSync(path.dirname(record.report), { recursive: true });
    fs.writeFileSync(record.report, `${text.replace('\n', `\n<!-- agentctl:attempt fake-${task} -->\n`)}\n<!-- agentctl:report-end -->\n`);
    return record;
  }
  return { ctx, config, runner, spec, finish, root };
}
const answer = (revised = false) => `Werdykt: PASS\nRecommendation: use versioned contract\nReasoning: As Claude by Anthropic, I prefer explicit units; OpenAI Codex gpt-5.4 agrees.\nRisks: migration\nConfidence: 4\nUnknowns: latency\n${revised ? 'Changed: yes – clearer units after feedback' : ''}`;

describe('CONSULT deterministic Delphi orchestration (no inference/network)', () => {
  it('previews cost and usage without creating a consultation; validates panel, rounds, refs and paths', async () => {
    const f = fixture('preview');
    const plan = await planConsult(f.ctx, f.spec());
    assert.equal(plan.preview.panel_tasks, 4);
    assert.equal(plan.preview.total_tasks, 5);
    assert.deepEqual(plan.preview.usage.map(p => p.agent), ['claude', 'codex']);
    assert.equal(readConsult(f.ctx, 'NC-CHOICE'), undefined);
    assert.equal(readQueue(f.config).length, 0);
    assert.throws(() => parseConsult(f.ctx, f.spec({ panel: [panel[0], panel[0]] })), /2 distinct providers/);
    assert.throws(() => parseConsult(f.ctx, f.spec({ panel: [panel[0], { ...panel[1], agent: 'kimi' }] })), /inactive/);
    f.config.limits.codex = 'off';
    assert.throws(() => parseConsult(f.ctx, f.spec()), /provider is off/);
    f.config.limits.codex = 1;
    for (const rounds of [0, 4, 1.5]) assert.throws(() => parseConsult(f.ctx, f.spec({ rounds })), /rounds/);
    await assert.rejects(() => planConsult(f.ctx, f.spec({ context: ['file:missing.md'] })), /ENOENT/);
    await assert.rejects(() => planConsult(f.ctx, f.spec({ report: '/etc/CONSULT.md' })), /report|outside|allowed/i);
  });

  it('runs two rounds and synthesis through Accepted tasks, anonymous prompts, events, owner report and one WALL post; restart/replay is idempotent', async () => {
    const f = fixture('flow');
    const state = await acceptConsult(f.ctx, f.spec());
    assert.equal(state.round, 1);
    const note = readCohort(f.config, state.spec.cohort)!.note;
    assert.match(groupTitle({ kind: 'group', key: state.spec.cohort, name: state.spec.cohort, note, rows: [], queued: 2, folded: false }), /runda 1\/2/);
    assert.equal(fs.statSync(consultFile(f.ctx, state.spec.id)).mode & 0o777, 0o600);
    assert.equal(state.seed.length, 64);
    assert.deepEqual([...state.labels].sort(), ['A', 'B']);
    const first = readQueue(f.config);
    assert.equal(first.length, 2);
    assert.ok(first.every(e => e.status === 'accepted' && !e.direct && e.priority === 'normal'));
    for (const entry of first) {
      const raw = splitSpecs(entry.spec)[0]!;
      assert.equal(raw.header.read_only, true);
      assert.equal(raw.header.pin, true);
      assert.ok(!raw.prompt.includes(state.seed));
      assert.ok(!raw.prompt.includes('Anonymised previous round'));
      await f.finish(entry.task, answer());
    }
    await consultTick(f.ctx);
    const round2 = readConsult(f.ctx, state.spec.id)!;
    assert.equal(round2.round, 2);
    assert.deepEqual(round2.labels, state.labels);
    const second = readQueue(f.config).filter(e => e.task.includes('-R2-'));
    assert.equal(second.length, 2);
    for (const [i, entry] of second.entries()) {
      const raw = splitSpecs(entry.spec)[0]!;
      assert.deepEqual(raw.header.after, first.map(e => e.task));
      assert.match(raw.prompt, new RegExp(`## ${state.labels[i]} \\(yours\\)`));
      assert.ok(!/anthropic|openai|claude|codex|gpt-5\.4|opus/i.test(raw.prompt), raw.prompt);
      assert.ok(!raw.prompt.includes('De-anonymisation'));
      assert.ok(!raw.prompt.includes(state.seed));
      await f.finish(entry.task, answer(true));
    }
    await consultTick(f.ctx);
    const synthesis = readQueue(f.config).find(e => e.task.endsWith('-SYN'))!;
    assert.ok(synthesis);
    const synPrompt = splitSpecs(synthesis.spec)[0]!.prompt;
    assert.ok(!synPrompt.includes('(yours)'));
    assert.ok(!/anthropic|openai|claude|codex|gpt-5\.4|opus/i.test(synPrompt));
    assert.equal(fs.existsSync(state.spec.report), false, 'map/report not released before synthesis');
    assert.equal(channelMessages(f.config, 'shared:sim').length, 0);
    await f.finish(synthesis.task, 'Werdykt: SPLIT\nConsensus: units explicit\nDisagreements: migration time\nRecommendation: stage it\nWhat the owner must decide: freeze date');
    await consultTick(f.ctx);
    await consultTick(f.ctx);
    const done = readConsult(f.ctx, state.spec.id)!;
    assert.equal(done.phase, 'done');
    const report = fs.readFileSync(done.spec.report, 'utf8');
    assert.match(report, /^Werdykt: SPLIT/);
    assert.match(report, /Consensus: units explicit/);
    assert.match(report, /De-anonymisation \(owner only\)/);
    assert.match(report, /claude \/ opus \/ high/);
    assert.equal((report.match(/De-anonymisation/g) ?? []).length, 1);
    assert.match(report, /<!-- agentctl:report-end -->\n$/);
    assert.equal(readQueue(f.config).length, 5);
    assert.match(readThread(f.config, { id: 'owner', kind: 'owner' }, channelMessages(f.config, 'shared:sim')[0]!.id).message.body, /migration time/);
    assert.equal(channelMessages(f.config, 'shared:sim').length, 1);
    assert.match(readThread(f.config, { id: 'owner', kind: 'owner' }, channelMessages(f.config, 'shared:sim')[0]!.id).message.body, /Werdykt: SPLIT/);
    assert.deepEqual(readJournal(f.config, -1).filter(e => e.kind === 'consult').map(e => e.text.split(': ')[1]?.split(' ')[0]), ['round-done', 'round-done', 'synthesis-ready']);
  });

  it('holds progression on incomplete reports, missing baseline or malformed answer; repairs partial Accepted registration', async () => {
    const f = fixture('repair');
    const state = await acceptConsult(f.ctx, f.spec({ rounds: 3 }));
    await consultTick(f.ctx);
    assert.equal(readQueue(f.config).length, 2);
    assert.equal(readConsult(f.ctx, state.spec.id)!.round, 1);
    const [a, b] = state.rounds[0]!.tasks;
    await f.finish(a!, answer(), false);
    await f.finish(b!, answer());
    await assert.rejects(() => consultTick(f.ctx), /missing read-only baseline/);
    await f.finish(a!, 'Werdykt: PASS\nRecommendation: only');
    await assert.rejects(() => consultTick(f.ctx), /incomplete CONSULT answer/);
    await f.finish(a!, answer());
    await consultTick(f.ctx);
    for (const t of readConsult(f.ctx, state.spec.id)!.rounds[1]!.tasks) await f.finish(t, answer(true));
    await consultTick(f.ctx);
    assert.equal(readConsult(f.ctx, state.spec.id)!.round, 3);
    assert.equal(readQueue(f.config).length, 6);
  });

  it('CONSULT-f2: suppresses inherited automatic review for detached consultation tasks', async () => {
    const f = fixture('auto-review');
    f.config.review = { default: 'auto' };
    await acceptConsult(f.ctx, f.spec());
    for (const entry of readQueue(f.config)) {
      const raw = splitSpecs(entry.spec)[0]!;
      const spec = resolveSpec(raw, { config: f.config });
      assert.equal(spec.review, undefined, 'automatic review needs a branch and must not alter consultation task counts');
      assert.equal(raw.header.review, false);
    }
  });

  it('recovers after a crash between individual Accepted queue writes', async () => {
    const f = fixture('partial-registration');
    const write = f.runner.writeFile.bind(f.runner);
    f.runner.writeFile = async (file, content) => {
      if (file.includes('/queue/') && file.includes('R1-P2') && file.endsWith('.json')) throw new Error('simulated interruption');
      return write(file, content);
    };
    await assert.rejects(() => acceptConsult(f.ctx, f.spec()), /simulated interruption/);
    assert.equal(readQueue(f.config).length, 1);
    f.runner.writeFile = write;
    await consultTick(f.ctx);
    assert.equal(readQueue(f.config).length, 2);
    await consultTick(f.ctx);
    assert.equal(readQueue(f.config).length, 2);
  });

  it('strips names, self-identification and report metadata; fixed answer schema rejects invalid confidence/revision', () => {
    const text = anonymise(`${answer()}\nModel: secret-model\nI am an AI language model by Moonshot.\n<!-- agentctl:attempt id -->\n\`\`\`agentctl-outputs\nnotes: [identity]\n\`\`\``, panel);
    assert.ok(!/claude|anthropic|openai|codex|gpt|moonshot|AI language|secret-model|outputs/i.test(text), text);
    assert.ok(text.includes('explicit units'), 'identity redaction must preserve reasoning');
    assert.deepEqual(answerProblems(answer(), false), []);
    assert.deepEqual(answerProblems(answer(true), true), []);
    assert.ok(answerProblems(answer().replace('Confidence: 4', 'Confidence: 9'), false).length);
    assert.ok(answerProblems(answer(), true).includes('Changed'));
  });

  it('MCP preview/confirm uses Accepted watcher requests, rejects absent preview and replays the same token once', async () => {
    const f = fixture('mcp');
    fakeWatcher(f.config);
    const tool = MCP_TOOLS.find(t => t.name === 'consult')!;
    const deps = { context: () => f.ctx, notify: async () => {} };
    const call = (input: object) => tool.run(deps, z.object(tool.input).parse(input));
    assert.equal((await call({ spec: f.spec(), confirm: true })).isError, true);
    const preview = await call({ spec: f.spec() });
    assert.equal(preview.isError, undefined, preview.text);
    assert.match(preview.text, /panel_tasks.*4/s);
    const token = /preview_token: ([\w-]+)/.exec(preview.text)![1];
    const accepted = await call({ confirm: true, preview_token: token });
    assert.equal(accepted.isError, undefined, accepted.text);
    assert.match(accepted.text, /accepted/i);
    assert.equal(readQueue(f.config).length, 0);
    const requests = readMcpRequests(f.config);
    assert.equal(requests.length, 1);
    await call({ confirm: true, preview_token: token });
    assert.equal(readMcpRequests(f.config).length, 1);
    await applyMcpRequest(deps, requests[0]!);
    assert.equal(readQueue(f.config).length, 2);
  });
});

describe('CONSULT read-only Git enforcement', () => {

  it('newTasks installs the guard before launch and skips inherited setup/links', async () => {
    const f = fixture('launch');
    fs.writeFileSync(path.join(f.root, '.agentctl.yaml'), 'setup: [touch forbidden]\n');
    const raw = { index: 1, header: { task: 'RO-NEW', ...panel[0], read_only: true, repos: [{ path: f.root, worktree: path.join(f.root, 'detached') }], setup: ['touch forbidden'] }, prompt: 'Read only and report.' };
    const spec = resolveSpec(raw, { config: f.config });
    assert.deepEqual(spec.setup, []);
    assert.deepEqual(spec.links, []);
    await newTasks(f.ctx, [spec], { noAgent: true });
    assert.ok(fs.existsSync(path.join(spec.repos[0]!.worktree, '.agentctl-consult-hooks', 'pre-commit')));
    assert.ok(fs.existsSync(path.join(f.config.stateDir, spec.window, 'read-only.json')));
    assert.ok(!f.runner.commands.some(c => c.includes('touch forbidden')));
    assert.ok(!f.runner.commands.some(c => /config.*core.hooksPath/.test(c)));
  });

  it('real Git refuses commit in the task environment, leaves source hook config alone, detects --no-verify bypass and modified files', async () => {
    const root = scratch.sub('real-git');
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
    git('init', '-q'); git('config', 'user.email', 'fake@example.invalid'); git('config', 'user.name', 'Fake');
    fs.writeFileSync(path.join(repo, 'data'), 'initial'); git('add', '.'); git('commit', '-qm', 'initial');
    const wt = path.join(root, 'wt'); git('worktree', 'add', '--detach', wt);
    const config = makeConfig(root);
    const ctx = new Context(new RealRunner(), config, () => {});
    const spec = resolveSpec({ index: 1, header: { task: 'RO-1', ...panel[0], repos: [{ path: repo, worktree: wt }], read_only: true }, prompt: 'Read only and report.' }, { config });
    await protectReadOnly(ctx, spec);
    const record = seedTask(config, spec.task, { repos: spec.repos, env: spec.env });
    const env = { ...process.env, ...spec.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const result = spawnSync('git', ['-C', wt, 'commit', '--allow-empty', '-m', 'forbidden'], { env, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /read-only/);
    assert.match((await readOnlyFindings(ctx, record)).join('\n'), /commit attempt refused/);
    assert.equal(spawnSync('git', ['-C', repo, 'config', '--local', '--get', 'core.hooksPath'], { encoding: 'utf8' }).status, 1);
    fs.writeFileSync(path.join(wt, 'data'), 'changed');
    assert.match((await readOnlyFindings(ctx, record)).join('\n'), /tracked files changed/);
    execFileSync('git', ['-C', wt, '-c', 'user.name=Fake', '-c', 'user.email=fake@example.invalid', 'commit', '--no-verify', '--allow-empty', '-m', 'bypass'], { env });
    assert.match((await readOnlyFindings(ctx, record)).join('\n'), /HEAD changed/);
  });
});
