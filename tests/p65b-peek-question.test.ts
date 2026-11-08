import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { makeConfig, makeContext, seedTask, useScratch, FakeTmux } from './helpers.ts';
import { peekTask } from '../src/core/peek.ts';
import { sessionsFile } from '../src/core/usage.ts';
import { localDay } from '../src/core/usage-parse.ts';

/*
 * P65-b (production 0.18.2, Neon City 08.11): `peek` of a Codex task whose question is collapsed ("? 1 question · …
 * to answer") showed only the generic hint. The question text is known: the expanded view stays in the scrollback the
 * capture already holds, and the pending request_user_input of the session transcript names it. No key is ever sent.
 */
const scratch = useScratch();
const fx = (name: string) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

function setup(name: string, screen: string) {
  const config = makeConfig(scratch.sub(name));
  const record = seedTask(config, 'NC-1', { agent: 'codex' });
  const tmux = new FakeTmux();
  tmux.add('nc-1', screen);
  return { config, record, ...makeContext(config, { dryRun: false, respond: tmux.respond }) };
}

it('P65-b: peek names the question of the collapsed Codex footer from the captured expanded view', async () => {
  const { ctx } = setup('p65b-scrollback', fx('screen-codex-question-collapsed.txt'));
  const r = await peekTask(ctx, 'NC-1');
  assert.match(r.lines[0] ?? '', /Which colour: red or blue\?/, r.lines[0]);
  assert.match(r.lines[0] ?? '', /zwinięte, 1/);
});

it('P65-b: without the text on the screen the session transcript supplies it', async () => {
  const collapsedOnly = '• Working (27s • esc to interrupt)\n• Queued follow-up inputs\n  ? 1 question · 8s\n    ⇧← to answer\n› Ask Codex to do anything\n  GPT-6.1-Sol low · ~/work/sandbox\n';
  const f = setup('p65b-session', collapsedOnly);
  const home = path.join(f.config.cache, 'codex-home');
  fs.mkdirSync(path.dirname(sessionsFile(f.config, 'nc-1')), { recursive: true });
  fs.writeFileSync(sessionsFile(f.config, 'nc-1'), JSON.stringify({ codex: [{ id: 'sess-1' }] }));
  const dir = path.join(home, 'sessions', ...localDay(Date.now()).split('-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'rollout-sess-1.jsonl'), [
    { type: 'session_meta', payload: { id: 'sess-1' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'request_user_input_async', call_id: 'c1', arguments: JSON.stringify({ questions: [{ question: 'Deploy to production?' }] }) } },
  ].map((v) => JSON.stringify(v)).join('\n') + '\n');
  const record = seedTask(f.config, 'NC-1', { agent: 'codex', env: { CODEX_HOME: home } });
  void record;
  const r = await peekTask(f.ctx, 'NC-1');
  assert.match(r.lines[0] ?? '', /Deploy to production\?/, r.lines[0]);
  assert.match(r.lines[0] ?? '', /zwinięte, 1/);
});

it('P65-b: the marker alone still yields the plain collapsed hint, never a fabricated text', async () => {
  const markerOnly = '• Working (27s • esc to interrupt)\n  ? 2 questions\n  ⇧↑ to answer\n› Ask Codex to do anything\n';
  const { ctx } = setup('p65b-marker', markerOnly);
  const r = await peekTask(ctx, 'NC-1');
  assert.match(r.lines[0] ?? '', /zwinięte, 2/);
  assert.doesNotMatch(r.lines[0] ?? '', /„/);
});
