import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { inspectField } from '../src/core/input-field.ts';
import type { Notifier } from '../src/core/notify.ts';
import { deliverPendingPrompt, queuePrompt, QUEUED_IN_AGENT } from '../src/core/prompt-delivery.ts';
import { commitQueueAdd, planQueueAdd, queueTick, QueueMemory, readQueue } from '../src/core/queue.ts';
import { waitForReady } from '../src/core/ready.ts';
import { RecordingRunner } from '../src/core/runner.ts';
import { splitSpecs } from '../src/core/spec.ts';
import { readTaskRecord, setHeaderFields, taskFile } from '../src/core/taskstore.ts';
import { Tmux } from '../src/core/tmux.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';

/*
 * 0.26.3 hotfix (26.11, prod 0.26.1, dev 0.27.0, remote host pc): almost every Codex queue start failed with
 * "codex did not show its input prompt within 60s" although the saved start-failure screen shows a ready Codex 0.167.
 * Root cause: the structural composer reader required the footer model row "<model> <effort> · <dir>"; Codex now draws a
 * service tier after the effort ("GPT-6.2-Sol medium Fast · <dir>"), the composer was "unreadable" and readiness never matched.
 * The fixture is the production capture (start-failure-screen.txt, path anonymised). Only the public API of 0.26.2 is used,
 * so every scenario also runs against the release before the fix.
 */
const scratch = useScratch();
const FRAME = fs.readFileSync(new URL('./fixtures/screen-codex-0167-ready-fast.txt', import.meta.url), 'utf8');
const LOADING = '  >_ OpenAI Codex (v0.167.0)\n     ~/Projects/wt/demo-task-1\n  permissions: YOLO mode\n\n  Booting MCP server: playwright (0s • esc to interrupt)\n';
const T0 = Date.UTC(2026, 10, 26, 12);

/** Variants of the same ready frame as a live capture can deliver them. */
const VARIANTS: Record<string, string> = {
  'as captured': FRAME,
  CRLF: FRAME.replace(/\n/g, '\r\n'),
  'ANSI cursor/colour codes': FRAME.replace('› Ask Codex', '\x1b[?25h\x1b[1m›\x1b[0m Ask Codex').replace('  GPT-6.2-Sol', '\x1b[2m  GPT-6.2-Sol').replace('f2 to view', 'f2 to view\x1b[0m'),
  'no-break space after the marker': FRAME.replace('› Ask Codex', '› Ask Codex'),
  'more blank padding': FRAME.replace('\n› Ask Codex', `${'\n'.repeat(40)}› Ask Codex`),
  'no warning badge, 0.172 tier "Flex"': FRAME.replace(/ {2,}⚠ 1 warning · f2 to view/, '').replace('medium Fast', 'high Flex'),
};

const codexSettings = () => makeConfig(scratch.sub('settings'), '').agents.codex;

describe('READY0263-COMPOSER: the ready Codex 0.167/0.172 frame with a service tier in the footer is a readable, empty composer', () => {
  for (const [name, screen] of Object.entries(VARIANTS)) {
    it(`READY0263-COMPOSER: ${name}: readable, no draft, waitForReady reports ready at once`, async () => {
      const field = inspectField(screen, 'codex');
      assert.equal(field.readable, true, field.reason ?? '');
      assert.deepEqual(field.area, [], 'the placeholder "Ask Codex to do anything" is not a draft');
      const settings = codexSettings();
      const runner = new RecordingRunner({ dryRun: false, respond: (cmd, a) => cmd === 'tmux' && a[0] === 'capture-pane' ? { stdout: screen } : undefined });
      const t0 = runner.now();
      const r = await waitForReady(runner, new Tmux(runner, 'agentctl'), 'w', { pattern: settings.readyPattern, emptyInput: true, structuralComposer: true, agent: 'codex', trustPattern: settings.trustPattern, dialogPattern: settings.dialogPattern!, timeoutMs: 60_000 });
      assert.equal(r.ready, true);
      assert.equal(runner.now() - t0, 0);
    });
  }
});

