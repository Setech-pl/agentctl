import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { screenMetadata, withoutDimInput, inputIsDim } from '../src/core/tmux.ts';

const fixtureText = (name: string): string => fs.readFileSync(path.resolve(import.meta.dirname, 'fixtures', name), 'utf8');
const SUGGESTION = fixtureText('screen-claude-suggestion.txt'), SUGGESTION_ANSI = fixtureText('screen-claude-suggestion-ansi.txt');
const DRAFT = fixtureText('screen-claude-draft.txt'), DRAFT_ANSI = fixtureText('screen-claude-draft-ansi.txt');
const CODEX = fixtureText('screen-codex-placeholder.txt'), CODEX_ANSI = fixtureText('screen-codex-placeholder-ansi.txt');

describe('FIX5 E1: reading the colour of the input field (recorded on Claude Code 2.1.311 and Codex 0.166.0)', () => {
  it('recorded on a real Claude Code 2.1.311: the suggestion is dim (SGR 2), the draft is not', () => {
    const line = (ansi: string, text: string) => ansi.split('\n').find(l => l.includes(text))!;
    assert.ok(inputIsDim(line(SUGGESTION_ANSI, 'nie scalaj')), 'suggestion is dim');
    assert.ok(!inputIsDim(line(DRAFT_ANSI, 'real draft')), 'a typed draft is not');
    assert.ok(inputIsDim(line(CODEX_ANSI, 'Ask Codex')), 'the Codex placeholder is dim too');
  });
  it('the plain text alone cannot tell them apart: that is why the colour is read', () => {
    assert.match(screenMetadata(SUGGESTION).draft_input ?? '', /nie scalaj/);
  });
  it('withoutDimInput: the suggestion goes out of the screen, a draft and the rest stay', () => {
    assert.equal(screenMetadata(withoutDimInput(SUGGESTION, SUGGESTION_ANSI)).draft_input, null);
    assert.equal(screenMetadata(withoutDimInput(DRAFT, DRAFT_ANSI)).draft_input, 'my real draft');
    assert.equal(screenMetadata(withoutDimInput(CODEX, CODEX_ANSI)).draft_input, null);
    assert.ok(withoutDimInput(SUGGESTION, SUGGESTION_ANSI).includes('Baked for'));
  });
});
