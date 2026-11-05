import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { DEFAULT_AGENT_SETTINGS } from '../src/core/config.ts';
import { Context } from '../src/core/context.ts';
import { areaKey, fieldArea, fieldText, pasteImage } from '../src/core/input-field.ts';
import { readJournal } from '../src/core/journal.ts';
import { hookPromptMatches, unwrapPastedContent } from '../src/core/paste-wrapper.ts';
import { deliveryClass, deliveryNote, deliveryProof, deliverPendingPrompt, echoLines, queuePrompt, queueSignShown } from '../src/core/prompt-delivery.ts';
import { classifyScreen, starSpinnerActive } from '../src/core/state.ts';
import { readTaskRecord, setHeaderFields, taskFile } from '../src/core/taskstore.ts';
import { DiskRunner, makeConfig, seedTask, useScratch } from './helpers.ts';

/* P15-FIX2: the pieces behind R1-R10, one by one. The counterexamples themselves are in p15-fix2.test.ts. */
const scratch = useScratch();
const fx = (name: string) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const claudeFooters = DEFAULT_AGENT_SETTINGS.claude.footerPatterns, codexFooters = DEFAULT_AGENT_SETTINGS.codex.footerPatterns;

describe('input field area (R1, R2; rewritten in P15-FIX3: the area is exact, nothing is squeezed)', () => {
  it('is the marker line of a recorded collapsed paste and nothing else', () => {
    assert.deepEqual(fieldArea(fx('screen-claude-busy-paste.txt'), claudeFooters), ['❯\u00a0[Pasted text #1 +7 lines]'], 'the marker is followed by a no-break space in the real capture');
    assert.deepEqual(fieldArea(fx('screen-claude-busy-paste-single.txt'), claudeFooters), ['❯\u00a0[Pasted text #2]']);
    assert.equal(fieldText(fieldArea(fx('screen-claude-busy-paste.txt'), claudeFooters)), '[Pasted text #1 +7 lines]');
  });
  it('runs from the marker down to the structural border or recorded Codex footer, empty lines inside kept (F2)', () => {
    assert.deepEqual(fieldArea('x\n────\n❯ one\n  two\n\n  three\n────\n  paste again to expand\n', claudeFooters), ['❯ one', '  two', '', '  three']);
    assert.deepEqual(fieldArea('x\n────\n❯ [Pasted text #2 +1 lines]\n\n  USER ADDED SECRET\n────\n', claudeFooters), ['❯ [Pasted text #2 +1 lines]', '', '  USER ADDED SECRET']);
    assert.deepEqual(fieldArea('• Working\n› one\n  two\n  GPT-6.1-Sol low · ~/work\n  tab to queue message\n', codexFooters), ['› one', '  two']);
    assert.deepEqual(fieldArea(fx('screen-codex-question-pasted.txt'), codexFooters), ['› MANUAL-Q2: this text was pasted into the field while a question is open.']);
    assert.deepEqual(fieldArea('────\n❯ one\n  two\n\n\n────\n', claudeFooters), ['❯ one', '  two'], 'blank padding at the bottom of the framed field');
  });
  it('a line of hyphens in the field is text, not a border', () => {
    assert.deepEqual(fieldArea('────\n❯ one\n  ---------\n  two\n────\n', claudeFooters), ['❯ one', '  ---------', '  two']);
  });
  it('is empty for an empty field, a suggestion, an idle Codex field and a screen without a marker', () => {
    assert.deepEqual(fieldArea('x\n❯\n', claudeFooters), []);
    assert.deepEqual(fieldArea('x\n❯ Try "fix the bug"\n', claudeFooters), []);
    assert.deepEqual(fieldArea(fx('screen-codex-busy-steered.txt'), codexFooters), []);
    assert.deepEqual(fieldArea('no prompt here\n', claudeFooters), []);
  });
  it('areaKey is the same for the same bytes only: a space, a blank line or another number changes it (F1, F2)', () => {
    const base = ['❯ Use key "AB CD"'];
    assert.equal(areaKey(base), areaKey(['❯ Use key "AB CD"']));
    assert.notEqual(areaKey(base), areaKey(['❯ Use key "ABCD"']));
    assert.notEqual(areaKey(base), areaKey(['❯ Use key "AB  CD"']));
    assert.notEqual(areaKey(['❯ one', '  two']), areaKey(['❯ one', '', '  two']));
    assert.notEqual(areaKey(['❯ [Pasted text #2 +1 lines]']), areaKey(['❯ [Pasted text #3 +1 lines]']));
    assert.equal(areaKey([]), '');
  });
  it('fieldText reads the area as a person does: marker and indentation off, blank lines kept', () => {
    assert.equal(fieldText(['❯ one', '  two', '', '  three']), 'one\ntwo\n\nthree');
  });
  it('pasteImage: our paste is one placeholder, or the lines of the prompt, or their start; never another line (a)', () => {
    const text = 'FIRST LINE\nORIGINAL BODY';
    assert.ok(pasteImage(['❯ FIRST LINE', '  ORIGINAL BODY'], text));
    assert.ok(pasteImage(['❯ FIRST LINE'], text), 'a TUI that shows only the start');
    assert.ok(!pasteImage(['❯ FIRST LINE', '  USER REPLACED BODY'], text), 'a changed second line');
    assert.ok(!pasteImage(['❯ FIRST LINE', '  ORIGINAL BODY', '  AND MORE'], text));
    assert.ok(!pasteImage(['❯ FIRST LINE', '', '  ORIGINAL BODY'], text), 'an extra empty line');
    assert.ok(pasteImage(['❯ [Pasted text #2 +1 lines]'], text));
    assert.ok(pasteImage(['› [Pasted Content 1004 chars]'], text));
    assert.ok(!pasteImage([], text));
  });
  it('pasteImage: a wrapped line reads back to its line, only the swallowed space may differ (F1 at a wrap)', () => {
    assert.ok(pasteImage(['❯ Use the key', '  AB CD to log in'], 'Use the key AB CD to log in'));
    assert.ok(!pasteImage(['❯ Use the key', '  ABCD to log in'], 'Use the key AB CD to log in'));
    assert.ok(!pasteImage(['❯ Use key "ABCD"'], 'Use key "AB CD"'));
  });
  it('a tab is what Claude Code stores of it: four spaces', () => {
    assert.ok(pasteImage(['❯ a    b'], 'a\tb', 'claude'));
    assert.ok(!pasteImage(['❯ a    b'], 'a\tb', 'codex'));
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

describe('queue sign needs a correlated Enter (R3; since P15-FIX3 it classifies, it never confirms)', () => {
  const recordFor = async (name: string, extra: Record<string, unknown>) => {
    const config = makeConfig(scratch.sub(name), 'capacity: {snapshot: false, codex_refresh: false}\n');
    const runner = new DiskRunner({ dryRun: false, startTime: Date.now() + 1000 });
    const ctx = new Context(runner, config, () => {});
    seedTask(config, 'T1', { agent: 'claude', windowId: '@1' });
    await queuePrompt(ctx, readTaskRecord(config, 't1')!, 'SECOND', 'pending', { kind: 'followup' });
    await setHeaderFields(runner, taskFile(config, 't1'), { prompt_delivery: 'confirming', delivery_was_busy: true, delivery_started_at: new Date(runner.now() - 1000).toISOString(), ...extra });
    return { ctx, record: readTaskRecord(config, 't1')! };
  };
  const screen = '⏺ x\n  ctrl+x ctrl+s to send now\n✻ Cooking… (3s · ↓ 1 tokens)\n❯\n';
  const ours = { delivery_field: 'image:0123456789abcdef01234567', delivery_enters: 1 };
  it('queued-in-agent (not confirmed) only with the recorded paste, an Enter of ours and a sign that was not there before it', async () => {
    const classes: Record<string, unknown> = {};
    for (const [name, extra] of [['q-ok', { ...ours, delivery_queue_sign: false }], ['q-before', { ...ours, delivery_queue_sign: true }], ['q-unknown', { ...ours }], ['q-no-enter', { ...ours, delivery_enters: 0, delivery_queue_sign: false }], ['q-no-paste', { delivery_enters: 1, delivery_queue_sign: false }]] as const) {
      const { ctx, record } = await recordFor(name, extra);
      classes[name] = deliveryClass(record, screen);
      assert.equal(deliveryProof(ctx, record, screen), null, `${name}: the screen confirms nothing`);
    }
    assert.deepEqual(classes, { 'q-ok': 'queued-in-agent', 'q-before': null, 'q-unknown': null, 'q-no-enter': null, 'q-no-paste': null });
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

describe('the note after the last Enter (R10) and the permission send_enter (P15-FIX3: no Enter is ever retried by watch)', () => {
  it('never promises a retry; names the two ways out while the record of the paste is there', () => {
    const base = { task: 'T1', deliveryResult: 'not-delivered-in-field', promptDelivery: 'confirming', deliveryField: 'image:0123456789abcdef01234567', deliveryEnters: 3 } as never;
    for (const promptDelivery of ['confirming', 'needs-attention']) {
      const note = deliveryNote({ ...(base as object), promptDelivery } as never)!;
      assert.doesNotMatch(note, /ponowi/); assert.match(note, /nie naciśnie już Enter sam/); assert.match(note, /agentctl send --enter-only T1/); assert.match(note, /attach/);
    }
    const noTrace = deliveryNote({ ...(base as object), deliveryField: undefined } as never)!;
    assert.doesNotMatch(noTrace, /enter-only/); assert.match(noTrace, /attach/);
  });
  it('the screen-only class says "queued, not confirmed" and keeps the message', () => {
    const note = deliveryNote({ task: 'T1', deliveryResult: 'queued-in-agent', promptDelivery: 'confirming' } as never)!;
    assert.match(note, /w kolejce agenta – niepotwierdzone/); assert.match(note, /TASK\.md/);
    assert.equal(deliveryNote({ task: 'T1', deliveryResult: 'queued-in-agent', promptDelivery: 'sent' } as never), undefined);
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
    const runner = new DiskRunner({ dryRun: false, startTime: Date.now() + 1000, respond: (cmd, args) => cmd !== 'tmux' ? undefined : args[0] === 'list-windows' ? { stdout: '@1\tt1\ttask' } : args[0] === 'send-keys' ? (ok = true, {}) : args[0] === 'capture-pane' ? { stdout: ok ? 'Working (esc to interrupt)\n❯\n' : '────\n❯ Try "x"\n────\n' } : {} });
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
