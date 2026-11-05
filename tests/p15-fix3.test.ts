import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { auditPath, MCP_TOOLS } from '../src/core/mcp-tools.ts';
import { deliverPendingPrompt, deliveryProof, queuePrompt, submitDraft } from '../src/core/prompt-delivery.ts';
import { classifyScreen } from '../src/core/state.ts';
import { readTaskRecord } from '../src/core/taskstore.ts';
import { DiskRunner, makeConfig, seedTask, useScratch } from './helpers.ts';

/*
 * P15-FIX3: the findings F1-F5 and the scenario (a) of the second cross review (AGENTCTL-P15-REV2.md), as regression tests. Every test here was RED on
 * 37e20e3 and is green after the fix. Only the API that 37e20e3 already had is used (queuePrompt, deliverPendingPrompt, submitDraft, deliveryProof,
 * the MCP tool "send"), so the file runs on both commits; `enterOnly` below follows the two steps of the new `send --enter-only` when the preview
 * returns a token and is the one-step call on 37e20e3. The sources of the scripted panes are the probes of the review (REPRO2.md, rev2-extra.ts).
 */
const scratch = useScratch();
const pane = (field: string, dialog = '') => `Working (esc to interrupt)\n────────────\n❯ ${field.replace(/\n/g, '\n  ')}\n────────────\n${dialog}`;
const DIALOG = 'Enter to select · ↑/↓ to navigate · Esc to cancel\n';

interface Key { field: string; dialog: string; state: string; phase: string }
/**
 * A Claude pane that works, with `prompt` pasted and the Enter swallowed (the field keeps what the paste left). `mutate` changes the pane at the
 * capture `n` after the paste or after the first Enter: the review's way to edit the field or open a dialog between a look and the key.
 */
async function fixture(name: string, prompt: string, shown = prompt, mutateAfterFirstEnter?: (f: { setField(v: string): void; setDialog(v: string): void }) => void) {
  const config = makeConfig(scratch.sub(name), 'capacity: {snapshot: false, codex_refresh: false}\nmcp: {allow: [send, send_enter]}\n');
  let field = '', dialog = '', phase = 'paste', captures = 0, mutated = false;
  const keys: Key[] = [];
  const handle = { setField: (v: string) => { field = v; }, setDialog: (v: string) => { dialog = v; } };
  const runner = new DiskRunner({ dryRun: false, startTime: Date.now() + 1000, respond: (cmd, args) => {
    if (cmd !== 'tmux') return {};
    if (args[0] === 'list-windows') return { stdout: '@1\tt1\ttask' };
    if (args[0] === 'paste-buffer') { field = shown; return {}; }
    if (args[0] === 'capture-pane') {
      if (!args.includes('-e')) { captures++; if (mutateAfterFirstEnter && keys.length >= 1 && !mutated) { mutated = true; mutateAfterFirstEnter(handle); } }
      return { stdout: pane(field, dialog) };
    }
    if (args[0] === 'send-keys' && args.at(-1) === 'Enter') { keys.push({ field, dialog, phase, state: classifyScreen(pane(field, dialog), config.agents.claude) }); return {}; }
    return {};
  } });
  const ctx = new Context(runner, config, () => {});
  seedTask(config, 'T1', { agent: 'claude', windowId: '@1' });
  const record = () => readTaskRecord(config, 't1')!;
  await queuePrompt(ctx, record(), prompt, 'pending', { kind: 'followup' });
  await deliverPendingPrompt(ctx, 't1');
  phase = 'later';
  return { ctx, config, runner, record, keys, captures: () => captures, ...handle, sleepPastRetry: () => runner.sleep(9000) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
/** `send --enter-only`: the preview, then the confirm with its token (37e20e3: the one call that presses). */
const enterOnly = async (f: Fixture) => {
  const preview = await submitDraft(f.ctx, 't1');
  return preview.outcome === 'ready' && (preview as { token?: string }).token ? submitDraft(f.ctx, 't1', { token: (preview as { token?: string }).token } as never) : preview;
};
const later = (mode: 'watch' | 'enter-only', f: Fixture) => mode === 'watch' ? deliverPendingPrompt(f.ctx, 't1') : enterOnly(f);
const none = (keys: Key[], from: number) => assert.deepEqual(keys.slice(from).map(k => k.field), [], 'an Enter went into a field that is not what agentctl pasted');

describe('F1: a changed space is not the same text', () => {
  for (const mode of ['watch', 'enter-only'] as const) it(`F1 ${mode}: after the paste the human turns "AB CD" into "ABCD": no Enter`, async () => {
    const f = await fixture(`f1-${mode}`, 'Use key "AB CD"');
    const n = f.keys.length;
    f.setField('Use key "ABCD"'); await f.sleepPastRetry();
    await later(mode, f);
    none(f.keys, n);
  });
  it('F1 in the paste call: the field turns into "ABCD" after the first Enter: no second Enter', async () => {
    const f = await fixture('f1-call', 'Use key "AB CD"', undefined, h => h.setField('Use key "ABCD"'));
    assert.equal(f.keys.length, 1);
    assert.deepEqual(f.keys.map(k => k.field), ['Use key "AB CD"']);
  });
});

describe('F2: text after an empty line belongs to the field', () => {
  const shown = '[Pasted text #2 +1 lines]', added = '[Pasted text #2 +1 lines]\n\nUSER ADDED SECRET';
  for (const mode of ['watch', 'enter-only'] as const) it(`F2 ${mode}: a body added behind an empty line: no Enter`, async () => {
    const f = await fixture(`f2-${mode}`, 'ORIGINAL', shown);
    const n = f.keys.length;
    f.setField(added); await f.sleepPastRetry();
    await later(mode, f);
    none(f.keys, n);
  });
  it('F2 in the paste call: the body is added after the first Enter: no second Enter', async () => {
    const f = await fixture('f2-call', 'ORIGINAL', shown, h => h.setField(added));
    assert.equal(f.keys.length, 1);
    assert.deepEqual(f.keys.map(k => k.field), [shown]);
  });
});

describe('F3: a dialog on the very capture before the key', () => {
  for (const mode of ['watch', 'enter-only'] as const) it(`F3 ${mode}: the dialog is on the last capture and the field is unchanged: no Enter`, async () => {
    const f = await fixture(`f3-${mode}`, 'ORIGINAL');
    const n = f.keys.length, base = f.captures();
    await f.sleepPastRetry();
    const orig = f.runner.exec.bind(f.runner);
    // The first capture of the call (the preview, the look of watch) is clean; the capture that the key follows shows the dialog.
    f.runner.exec = (async (cmd: string, args: string[], opts?: never) => { if (cmd === 'tmux' && args[0] === 'capture-pane' && !args.includes('-e') && f.captures() >= base + 1) f.setDialog(DIALOG); return orig(cmd, args, opts); }) as typeof f.runner.exec;
    await later(mode, f);
    assert.deepEqual(f.keys.slice(n).map(k => k.state), [], 'an Enter went in while the screen showed a dialog');
  });
  it('F3 in the paste call: the dialog opens after the first Enter: no second Enter', async () => {
    const f = await fixture('f3-call', 'ORIGINAL', undefined, h => h.setDialog(DIALOG));
    assert.deepEqual(f.keys.map(k => k.state), ['working'], 'only the first Enter, before the dialog');
  });
});

describe('(a): the body is replaced before the first control capture', () => {
  it('(a) "FIRST LINE\\nUSER REPLACED BODY" instead of "FIRST LINE\\nORIGINAL BODY" in the first capture after the paste: no Enter at all', async () => {
    const f = await fixture('a-initial', 'FIRST LINE\nORIGINAL BODY', 'FIRST LINE\nUSER REPLACED BODY');
    assert.deepEqual(f.keys.map(k => k.field), [], 'the three Enters went into a changed body');
    assert.equal(f.record().deliveryResult, 'not-delivered-in-field');
  });
});

describe('F4: the echo of Codex is not an acknowledgement', () => {
  it('F4 "Use key \\"AB CD\\"" is not acknowledged by the echo "› Use key \\"ABCD\\""', async () => {
    const f = await fixture('f4', 'Use key "AB CD"');
    const record = { ...f.record(), agent: 'codex' as const };
    assert.equal(deliveryProof(f.ctx, record, '› Use key "ABCD"\n› Ask Codex to do anything\n'), null);
  });
  it('F4 even the exact echo of a busy delivery does not acknowledge it: only the hook or the transcript does', async () => {
    const f = await fixture('f4-exact', 'Use key "AB CD"');
    const record = { ...f.record(), agent: 'codex' as const, deliveryWasBusy: true };
    assert.equal(deliveryProof(f.ctx, record, '› Use key "AB CD"\n› Ask Codex to do anything\n'), null);
  });
});

describe('F5: a failed key is a failure', () => {
  it('F5 a transport error of tmux send-keys is an error of the tool with the reason, the audit says failed, nothing says "Enter wysłany: tak"', async () => {
    const f = await fixture('f5', 'ORIGINAL');
    f.config.mcp.allow = ['send_enter'];
    const orig = f.runner.exec.bind(f.runner), n = f.keys.length;
    f.runner.exec = (async (cmd: string, args: string[], opts?: never) => cmd === 'tmux' && args[0] === 'send-keys' && args.at(-1) === 'Enter' ? { code: 1, stdout: '', stderr: 'tmux send-keys failed (injected)' } : orig(cmd, args, opts)) as typeof f.runner.exec;
    const call = (args: Record<string, unknown>) => MCP_TOOLS.find(t => t.name === 'send')!.run({ context: () => f.ctx, notify: async () => {} } as never, args as never) as Promise<{ isError?: boolean; text: string; data?: { token?: string; key_sent?: boolean } }>;
    const preview = await call({ task: 'T1', enter_only: true });
    const token = preview.data?.token ?? /token: "([0-9a-f]+)"/.exec(preview.text)?.[1];
    const response = await call({ task: 'T1', enter_only: true, confirm: true, ...(token ? { token } : {}) });
    assert.equal(response.isError, true, response.text);
    assert.match(response.text, /injected/); assert.doesNotMatch(response.text, /Enter wysłany: tak/);
    assert.notEqual(response.data?.key_sent, true);
    const audit = fs.readFileSync(auditPath(f.config), 'utf8').trim().split('\n').map(l => JSON.parse(l) as { tool: string; outcome: string });
    assert.equal(audit.at(-1)!.outcome, 'failed');
    assert.equal(f.keys.length, n, 'no key went in');
  });
});
