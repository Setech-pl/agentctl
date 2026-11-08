import assert from 'node:assert/strict';
import fs from 'node:fs';
import { it } from 'node:test';
import { DEFAULT_AGENT_SETTINGS } from '../src/core/config.ts';
import { provider } from '../src/core/providers/registry.ts';
import { extractQuestion } from '../src/core/events.ts';
import { classifyScreen } from '../src/core/state.ts';

/*
 * P65 (DEV-MARK-1, 2026-11-07 23:55): one minute after start Codex 0.167 called request_user_input_async and the
 * footer showed the collapsed "? 1 question" while the agent kept working (it finished PASS without an answer).
 * agentctl raised needs-input "Codex ma pytanie (zwinięte, 1)". The collapsed footer of an asynchronous question
 * while the agent works is not a wait; only an idle agent with the question still pending waits. A real question
 * (expanded view, or the pending request_user_input of the session) names its text.
 * The frame is the recorded screen-codex-question-collapsed.txt: Working + collapsed "? 1 question".
 */
const fx = (name: string) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const collapsedWorking = fx('screen-codex-question-collapsed.txt');
const codex = DEFAULT_AGENT_SETTINGS.codex;

it('P65 a collapsed "? N question" footer while Codex works is working, not needs-input', () => {
  assert.match(collapsedWorking, /• Working \(27s • esc to interrupt\)/);
  assert.match(collapsedWorking, /\? 1 question · 8s/);
  assert.equal(classifyScreen(collapsedWorking, codex), 'working');
});

it('P65 the same collapsed footer on an idle screen is still needs-input (the question is pending)', () => {
  const idle = collapsedWorking.replace(/^• Working \(27s • esc to interrupt\)\n/m, '');
  assert.equal(classifyScreen(idle, codex), 'needs-input');
});

it('P65 a real waiting question (expanded view) is needs-input even without a Working line', () => {
  const waiting = '› Ask me which colour.\n\n? Which colour: red or blue?\n  • red\n  • blue\n\n• Waiting for your answer\n\n› Ask Codex to do anything\n  GPT-6.1-Sol low · ~/work/sandbox\n  ? for shortcuts\n';
  assert.equal(classifyScreen(waiting, codex), 'needs-input');
});

it('P65 the text of an expanded Codex question (bullet options) is captured', () => {
  const waiting = '› Ask me which colour.\n\n? Which colour: red or blue?\n  • red\n  • blue\n\n• Waiting for your answer\n\n› Ask Codex to do anything\n  GPT-6.1-Sol low · ~/work/sandbox\n  ? for shortcuts\n';
  assert.equal(extractQuestion(waiting), 'Which colour: red or blue?');
});

it('P65 the collapsed marker alone still yields the collapsed hint, not a fabricated text', () => {
  const text = extractQuestion('Working (esc to interrupt)\n? 1 question · 8s\n  ⇧← to answer') ?? '';
  assert.match(text, /zwinięte, 1/);
});

it('P65 Claude and Kimi classification of their question dialogs is unchanged', () => {
  assert.equal(classifyScreen('❯ 1. Yes\n  2. No\n\nEnter to select · Esc to cancel', DEFAULT_AGENT_SETTINGS.claude), 'needs-input');
  assert.equal(classifyScreen(fx('screen-kimi-04-zgoda.txt'), provider('kimi').defaultSettings()), 'needs-input');
});
