import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { DEFAULT_AGENT_SETTINGS } from '../src/core/config.ts';
import { Context } from '../src/core/context.ts';
import { fieldIsOurs, fieldSignature, inputFieldLines, ownPasteSignature } from '../src/core/input-field.ts';
import { readJournal } from '../src/core/journal.ts';
import { hookPromptMatches, unwrapPastedContent } from '../src/core/paste-wrapper.ts';
import { deliveryNote, deliverPendingPrompt, echoLines, queuePrompt, queueSignShown } from '../src/core/prompt-delivery.ts';
import { classifyScreen, starSpinnerActive } from '../src/core/state.ts';
import { readTaskRecord } from '../src/core/taskstore.ts';
import { DiskRunner, makeConfig, seedTask, useScratch } from './helpers.ts';

/* P15-FIX2: the pieces behind R1-R10, one by one. The counterexamples themselves are in p15-fix2.test.ts. */
const scratch = useScratch();
const fx = (name: string) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const claudeFooters = DEFAULT_AGENT_SETTINGS.claude.footerPatterns, codexFooters = DEFAULT_AGENT_SETTINGS.codex.footerPatterns;

describe('input field (R1, R2)', () => {
  it('reads the placeholder of a recorded collapsed paste as the whole field', () => {
    assert.deepEqual(inputFieldLines(fx('screen-claude-busy-paste.txt'), claudeFooters), ['[Pasted text #1 +7 lines]']);
    assert.deepEqual(inputFieldLines(fx('screen-claude-busy-paste-single.txt'), claudeFooters), ['[Pasted text #2]']);
  });
  it('reads every line of a text the TUI shows whole, down to the border (Claude) or the footer (Codex)', () => {
    assert.deepEqual(inputFieldLines('x\n────\n❯ one\n  two\n  three\n────\n  paste again to expand\n', claudeFooters), ['one', 'two', 'three']);
    assert.deepEqual(inputFieldLines('• Working\n› one\n  two\n  GPT-6.1-Sol low · ~/work\n  tab to queue message\n', codexFooters), ['one', 'two']);
    assert.deepEqual(inputFieldLines(fx('screen-codex-question-pasted.txt'), codexFooters), ['MANUAL-Q2: this text was pasted into the field while a question is open.']);
  });
  it('an empty field, a suggestion and the Codex placeholder are no field', () => {
    assert.deepEqual(inputFieldLines('x\n❯\n', claudeFooters), []);
    assert.deepEqual(inputFieldLines('x\n❯ Try "fix the bug"\n', claudeFooters), []);
    assert.deepEqual(inputFieldLines(fx('screen-codex-busy-steered.txt'), codexFooters), []);
    assert.deepEqual(inputFieldLines('no prompt here\n', claudeFooters), []);
  });
  it('the signature is the placeholder as drawn, or the text of all lines without the TUI’s white space', () => {
    assert.equal(fieldSignature(['[Pasted text #2 +7 lines]']), 'collapsed:[Pasted text #2 +7 lines]');
    assert.equal(fieldSignature([]), null);
    assert.equal(fieldSignature(['one', 'two']), fieldSignature(['one two']));
    assert.equal(fieldSignature(['on', 'e two']), fieldSignature(['one', 'two']), 'a break inside a word is the TUI’s');
    assert.notEqual(fieldSignature(['one', 'two']), fieldSignature(['one', 'twp']));
    assert.notEqual(fieldSignature(['one', 'two']), fieldSignature(['one']));
    assert.notEqual(fieldSignature(['[Pasted text #2 +7 lines]']), fieldSignature(['[Pasted text #3 +7 lines]']));
    assert.notEqual(fieldSignature(['[Pasted text #2 +7 lines]']), fieldSignature(['[Pasted text #2 +7 lines]', 'more']));
  });
  it('our paste is a placeholder or all of the text; a part of it, or more than it, is not', () => {
    const text = 'FIRST LINE\nORIGINAL BODY';
    assert.ok(ownPasteSignature(['FIRST LINE', 'ORIGINAL BODY'], text));
    assert.ok(ownPasteSignature(['FIRST LINE ORIGINAL', 'BODY'], text), 'wrapped differently by the TUI');
    assert.equal(ownPasteSignature(['FIRST LINE'], text), null);
    assert.equal(ownPasteSignature(['FIRST LINE', 'ORIGINAL BODY', 'AND MORE'], text), null);
    assert.equal(ownPasteSignature([], text), null);
    assert.equal(ownPasteSignature(['[Pasted Content 1004 chars]'], text), 'collapsed:[Pasted Content 1004 chars]');
  });
  it('fieldIsOurs compares the whole field of a screen with the recorded signature', () => {
    const screen = fx('screen-claude-busy-paste.txt');
    const recorded = fieldSignature(['[Pasted text #1 +7 lines]'])!;
    assert.ok(fieldIsOurs(screen, claudeFooters, recorded));
    assert.ok(!fieldIsOurs(screen.replace('#1', '#4'), claudeFooters, recorded));
    assert.ok(!fieldIsOurs(screen.replace('lines]\n', 'lines]\n  typed after it\n'), claudeFooters, recorded));
    assert.ok(!fieldIsOurs(screen, claudeFooters, undefined));
    assert.ok(!fieldIsOurs(screen, claudeFooters, 'FIRST LINE'), 'a record of the older format proves nothing');
  });
});

describe('hook wrapper (R5)', () => {
  const wrap = (id: string, text: string) => `<pasted_content id="${id}">\n${text}\n</pasted_content id="${id}">`;
  it('takes off separate wrappers and keeps what stands between them', () => {
    assert.equal(unwrapPastedContent('plain'), 'plain');
    assert.equal(unwrapPastedContent(wrap('a', 'one')), 'one');
    assert.equal(unwrapPastedContent(`${wrap('a', 'one')}\n${wrap('b', 'two')}`), 'one\ntwo');
    assert.equal(unwrapPastedContent(`before ${wrap('a', 'one')} after`), 'before one after');
  });
  it('is ambiguous (null) for nesting, another closing id, a stray or an unclosed tag', () => {
    assert.equal(unwrapPastedContent(wrap('outer', wrap('inner', 'x'))), null);
    assert.equal(unwrapPastedContent('<pasted_content id="a">\nx\n</pasted_content id="b">'), null);
    assert.equal(unwrapPastedContent('x\n</pasted_content id="a">'), null);
    assert.equal(unwrapPastedContent('<pasted_content id="a">\nx'), null);
  });
  it('the pending prompt is never decoded: tags in it stay what they are', () => {
    assert.ok(hookPromptMatches(wrap('a', 'one'), 'one'));
    assert.ok(hookPromptMatches('one\r\n', 'one'));
    assert.ok(!hookPromptMatches('LITERAL', wrap('a', 'LITERAL')));
    assert.ok(hookPromptMatches(wrap('a', 'LITERAL'), wrap('a', 'LITERAL')), 'sent as typed, no wrapper added');
    assert.ok(!hookPromptMatches(wrap('x', wrap('a', 'LITERAL')), wrap('a', 'LITERAL')));
  });
});

describe('spinner "✳" (R8)', () => {
  const spinner = '✳ Fluttering… (2s · thinking with high effort)';
  it('counts right above the input box, with a tip or the border between', () => {
    assert.ok(starSpinnerActive(`${spinner}\n❯ \n`));
    assert.ok(starSpinnerActive(`${spinner}\n  ⎿  Tip: use /config\n────\n❯ \n────\n`));
    assert.ok(starSpinnerActive(`x\n${spinner}\n\n────\n❯ [Pasted text #2]\n────\n`));
    assert.ok(starSpinnerActive(`✳ Cooking… (1m 8s · ↓ 105 tokens)\n❯ \n`));
  });
  it('does not count in the transcript, without the shape of a spinner line, or without an input box', () => {
    assert.ok(!starSpinnerActive(`${spinner}\nReport finished.\n❯ \n`));
    assert.ok(!starSpinnerActive(`  ${spinner}\n● Done.\n────\n❯ \n────\n`));
    assert.ok(!starSpinnerActive('✳ Fluttering…\n❯ \n'));
    assert.ok(!starSpinnerActive('✳ the star is a bullet here (2s later)\n❯ \n'));
    assert.ok(!starSpinnerActive(`${spinner}\n`));
  });
  it('is part of classifyScreen for every agent setting, whatever the configured pattern says', () => {
    assert.equal(classifyScreen(`${spinner}\n❯ \n`, { ...DEFAULT_AGENT_SETTINGS.claude, workingPattern: 'never-matches' }), 'working');
  });
});

describe('queue sign (R3)', () => {
  it('is a line of its own or the dim text of the field, never a phrase inside a line', () => {
    assert.ok(queueSignShown('claude', 'x\n  ctrl+x ctrl+s to send now\n❯\n'));
    assert.ok(queueSignShown('claude', 'x\n❯\n', 'Press up to edit queued messages'));
    assert.ok(!queueSignShown('claude', '● Documentation: ctrl+x ctrl+s to send now\n❯\n'));
    assert.ok(!queueSignShown('claude', 'x\n❯\n', 'Press up to edit queued messages for the team'));
    assert.ok(!queueSignShown('codex', 'x\n  ctrl+x ctrl+s to send now\n› \n'));
  });
});

describe('echo (R4)', () => {
  it('is one block, the marker line with its indented continuation, equal to the whole text', () => {
    const text = 'one two three four five six seven eight nine ten';
    assert.equal(echoLines(`› ${text}\n• Working\n› Ask Codex to do anything\n`, '›', text), 1);
    assert.equal(echoLines(`› one two three\n  four five six\n  seven eight nine ten\n• Working\n› Ask\n`, '›', text), 1);
    assert.equal(echoLines(`› one two three four five six seven eight nine ten\n\n  more text of something else\n› Ask\n`, '›', text), 0, 'longer than the message');
    assert.equal(echoLines(`› one two three\n• Working\n› Ask\n`, '›', text), 0, 'shorter than the message');
    assert.equal(echoLines(`› ${text}\n› ${text}\n› Ask\n`, '›', text), 2);
  });
  it('the line of the input field itself is not an echo', () => {
    assert.equal(echoLines(`• Working\n› ok\n`, '›', 'ok'), 0);
  });
});

describe('the note after the last Enter (R10) and the permission send_enter', () => {
  it('promises a retry only while one is left', () => {
    const base = { task: 'T1', deliveryResult: 'not-delivered-in-field', promptDelivery: 'confirming', deliveryField: 'collapsed:[Pasted text #1]', deliveryEnters: 3 } as never;
    assert.match(deliveryNote(base)!, /watch ponowi Enter, albo: agentctl send --enter-only T1/);
    assert.doesNotMatch(deliveryNote({ ...(base as object), deliveryEnters: 6 } as never)!, /watch ponowi/);
    assert.doesNotMatch(deliveryNote({ ...(base as object), promptDelivery: 'needs-attention' } as never)!, /watch ponowi/);
    const noTrace = deliveryNote({ ...(base as object), deliveryField: undefined } as never)!;
    assert.doesNotMatch(noTrace, /watch ponowi/); assert.doesNotMatch(noTrace, /enter-only/); assert.match(noTrace, /attach/);
    assert.match(deliveryNote({ ...(base as object), deliveryEnters: 6 } as never)!, /wciśnij go w oknie \(attach\) albo: agentctl send --enter-only T1/);
  });
  it('mcp.allow accepts send_enter, and an unknown name is still reported with the old wording', () => {
    const config = makeConfig(scratch.sub('allow'), 'mcp: {allow: [send, send_enter, merge]}\n');
    assert.deepEqual(config.mcp.allow, ['send', 'send_enter']);
    assert.equal(config.mcp.warnings.length, 1); assert.match(config.mcp.warnings[0]!, /"merge" is not a write tool of this version/);
  });
});

describe('journal (R7)', () => {
  const run = async (name: string, kind: 'initial' | 'followup') => {
    const config = makeConfig(scratch.sub(name), 'capacity: {snapshot: false, codex_refresh: false}\n');
    let ok = false;
    const runner = new DiskRunner({ dryRun: false, startTime: Date.now() + 1000, respond: (cmd, args) => cmd !== 'tmux' ? undefined : args[0] === 'list-windows' ? { stdout: '@1\tt1\ttask' } : args[0] === 'send-keys' ? (ok = true, {}) : args[0] === 'capture-pane' ? { stdout: ok ? 'Working (esc to interrupt)\n❯\n' : '❯ Try "x"\n' } : {} });
    const ctx = new Context(runner, config, () => {});
    seedTask(config, 'T1', { agent: 'claude', windowId: '@1' });
    await queuePrompt(ctx, readTaskRecord(config, 't1')!, 'hello', 'pending', kind === 'followup' ? { kind } : {});
    assert.equal(await deliverPendingPrompt(ctx, 't1'), 'sent');
    return { config, entries: readJournal(config).filter(e => e.kind === 'delivery'), record: readTaskRecord(config, 't1')! };
  };
  it('a follow-up that was delivered is recorded with its delivery id', async () => {
    const { entries, record } = await run('journal-followup', 'followup');
    assert.equal(record.deliveryResult, 'delivered');
    assert.equal(entries.length, 1); assert.match(entries[0]!.text, /dostarczono/); assert.ok(entries[0]!.text.includes(record.deliveryId!.slice(0, 8)));
  });
  it('the first prompt of a task is recorded only when it needs a look, not once per start', async () => {
    const { entries } = await run('journal-initial', 'initial');
    assert.equal(entries.length, 0);
  });
});
