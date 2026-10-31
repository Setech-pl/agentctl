import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_AGENT_SETTINGS, PATTERN_FLAGS } from '../src/core/config.ts';
import { newTasks } from '../src/core/new.ts';
import { waitForReady } from '../src/core/ready.ts';
import { RecordingRunner } from '../src/core/runner.ts';
import { Tmux } from '../src/core/tmux.ts';
import { resolveSpec, splitSpecs } from '../src/core/spec.ts';
import type { ResolvedSpec } from '../src/core/spec.ts';
import { classifyScreen, taskState } from '../src/core/state.ts';
import { collectStatus } from '../src/core/status.ts';
import { recordFromSpec, renderTaskMd, taskFile } from '../src/core/taskstore.ts';
import { makeConfig, makeContext, useScratch } from './helpers.ts';

const scratch = useScratch();
const { claude, codex } = DEFAULT_AGENT_SETTINGS;
const ready = (s: { readyPattern: string }, screen: string): boolean => new RegExp(s.readyPattern, PATTERN_FLAGS).test(screen);

// Screens as seen in a live tmux session (Claude Code 2.1.309, Codex 0.166.0), trimmed.
const CLAUDE_IDLE = ` ▐▛███▛█   Claude Code v2.1.309
▝▜██████▀  Opus 5.5 with low effort · Claude Ultra
 ▝▝   ▝▝   ~/Projects/cache/agentctl-1/trust-test
──────────────────────────────────────────────
❯ Try "how do I log an error?"
──────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle)`;
const CODEX_IDLE = `  >_ OpenAI Codex (v0.166.0)
     ~/Projects/cache/agentctl-1/trust-test
› Ask Codex to do anything
  GPT-6.1-Sol low · ~/Projects/cache/agentctl-1/trust-test
  ? for shortcuts                                       ⚠ 1 warning · f2 to view`;
// Claude trust dialog: captured live (2.1.309) in a fresh git worktree, which Claude treats as a new, untrusted project.
// The Codex dialog text comes from the binary strings (the live checks ran in an already trusted tree); lines are approximate.
const CLAUDE_TRUST = `────────────────────────────────────────────────────────────────────────────────
 Accessing workspace:
 /Users/me/wt/sm-1
 Quick safety check: Is this a project you created or one you trust? (Like your
 own code, a well-known open source project, or work from your team). If not,
 take a moment to review what's in this folder first.
 Claude Code'll be able to read, edit, and execute files here.
 Security guide
 ❯ No, exit
   Yes, I trust this folder
 Enter to confirm · Esc to cancel`;
const CODEX_TRUST = `Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.
Folder settings can run code automatically, even without a model request.
› 1. Yes, continue
  2. No, quit`;
const WORKING = `✻ Pondering… (12s · esc to interrupt)\n❯ `;

describe('screen patterns (against real and recorded screens)', () => {
  it('idle screens are "ready" and not trust or working', () => {
    assert.ok(ready(claude, CLAUDE_IDLE));
    assert.ok(ready(codex, CODEX_IDLE));
    assert.equal(classifyScreen(CLAUDE_IDLE, claude), 'idle');
    assert.equal(classifyScreen(CODEX_IDLE, codex), 'idle');
  });

  it('trust dialogs are recognised in both TUIs and never look "ready"', () => {
    assert.equal(classifyScreen(CLAUDE_TRUST, claude), 'needs-trust');
    assert.equal(classifyScreen(CODEX_TRUST, codex), 'needs-trust');
    // The dialog's "❯ No, exit" cursor line looks like an input prompt, so trust must be checked before ready.
    assert.equal(ready(codex, CODEX_TRUST), false, 'the "› 1." cursor line is not the input prompt');
  });

  it('a running turn is "working"; trust wins over working', () => {
    assert.equal(classifyScreen(WORKING, claude), 'working');
    assert.equal(classifyScreen(`${WORKING}\n${CLAUDE_TRUST}`, claude), 'needs-trust');
  });
});

describe('waiting for readiness on a trust dialog', () => {
  it('reports trust, not ready, even though the cursor line resembles a prompt', async () => {
    const runner = new RecordingRunner({ dryRun: false, respond: (cmd, a) => (cmd === 'tmux' && a[0] === 'capture-pane' ? { stdout: CLAUDE_TRUST } : undefined) });
    const start = runner.now();
    const result = await waitForReady(runner, new Tmux(runner, 'agentctl'), 'nc-1', { pattern: claude.readyPattern, trustPattern: claude.trustPattern, timeoutMs: 5000 });
    assert.equal(result.trust, true);
    assert.equal(result.ready, false);
    assert.equal(runner.now(), start, 'returns at once instead of waiting for a timeout');
  });
});

describe('taskState', () => {
  const base = { screen: '', settings: claude, reportReady: false };
  it('maps every combination to one of the five states', () => {
    assert.equal(taskState({ ...base, alive: false }), 'dead');
    assert.equal(taskState({ ...base, alive: false, reportReady: true }), 'report-ready');
    assert.equal(taskState({ ...base, alive: true, screen: CLAUDE_IDLE }), 'waiting');
    assert.equal(taskState({ ...base, alive: true, screen: CLAUDE_IDLE, reportReady: true }), 'report-ready');
    assert.equal(taskState({ ...base, alive: true, screen: WORKING, reportReady: true }), 'working');
    assert.equal(taskState({ ...base, alive: true, screen: CLAUDE_TRUST }), 'needs-trust');
  });
});

describe('status states from mocked capture-pane', () => {
  const root = scratch.sub('states');
  const repo = scratch.sub('states/app');
  const config = makeConfig(root);
  const start = Date.UTC(2026, 9, 31, 10, 0, 0);
  const headers = ['NC-1', 'NC-2', 'NC-3', 'NC-4', 'NC-5', 'NC-6'].map((t, i) => {
    const report = path.join(root, `${t}.md`);
    return `---\ntask: ${t}\nagent: ${i === 2 ? 'codex' : 'claude'}\nreport: ${report}\nrepos:\n  - {path: ${repo}, worktree: ${repo}-${i}}\n---\nGo\n`;
  });
  const specs: ResolvedSpec[] = splitSpecs(headers.join('')).map((raw) => resolveSpec(raw, { config, loadProject: () => undefined }));
  for (const s of specs) {
    fs.mkdirSync(path.dirname(taskFile(config, s.window)), { recursive: true });
    fs.writeFileSync(taskFile(config, s.window), renderTaskMd(recordFromSpec(s, config, start), 'Go'));
  }
  fs.writeFileSync(path.join(root, 'NC-4.md'), 'done');
  fs.utimesSync(path.join(root, 'NC-4.md'), new Date(start + 60_000), new Date(start + 60_000));
  fs.writeFileSync(path.join(root, 'NC-6.md'), 'left over from an earlier run');
  fs.utimesSync(path.join(root, 'NC-6.md'), new Date(start - 3_600_000), new Date(start - 3_600_000));

  it('reports working / waiting / needs-trust / report-ready / dead', async () => {
    const screens: Record<string, string> = { 'nc-1': WORKING, 'nc-2': CLAUDE_IDLE, 'nc-3': CODEX_TRUST, 'nc-4': CLAUDE_IDLE };
    const { ctx } = makeContext(config, {
      startTime: start + 3_600_000,
      respond: (cmd, args) => {
        if (cmd !== 'tmux') return undefined;
        if (args[0] === 'list-windows') return { stdout: 'nc-1\nnc-2\nnc-3\nnc-4\nnc-6\n' };
        if (args[0] === 'capture-pane') return { stdout: screens[(args[args.indexOf('-t') + 1] as string).split(':')[1] as string] ?? CLAUDE_IDLE };
        return undefined;
      },
    });
    const rows = await collectStatus(ctx);
    assert.deepEqual(
      rows.map((r) => [r.task, r.state]),
      [
        ['NC-1', 'working'],
        ['NC-2', 'waiting'],
        ['NC-3', 'needs-trust'],
        ['NC-4', 'report-ready'], // window alive and idle, fresh report
        ['NC-5', 'dead'], // window gone, no report
        ['NC-6', 'waiting'], // an old report from before the start does not count
      ],
    );
    assert.equal(rows[5]?.report, 'yes');
  });

  it('a closed window with a fresh report is report-ready', async () => {
    const { ctx } = makeContext(config, { respond: (cmd, args) => (cmd === 'tmux' && args[0] === 'list-windows' ? { stdout: 'other\n' } : undefined) });
    const rows = await collectStatus(ctx);
    assert.equal(rows.find((r) => r.task === 'NC-4')?.state, 'report-ready');
    assert.equal(rows.find((r) => r.task === 'NC-1')?.state, 'dead');
  });
});

describe('new --no-wait-trust: folder-trust dialog', () => {
  it('stops with the attach instructions instead of timing out, and never answers the dialog', async () => {
    const root = scratch.sub('trust');
    const repo = scratch.sub('trust/app');
    const config = makeConfig(root);
    for (const [agent, screen] of [['claude', CLAUDE_TRUST], ['codex', CODEX_TRUST]] as const) {
      const [spec] = splitSpecs(`---\ntask: NC-${agent === 'claude' ? 1 : 2}\nagent: ${agent}\nrepos:\n  - {path: ${repo}, worktree: ${repo}-${agent}}\n---\nGo\n`).map((raw) =>
        resolveSpec(raw, { config, loadProject: () => undefined }),
      );
      const { ctx, runner } = makeContext(config, {
        respond: (cmd, a) => {
          if (cmd === 'tmux' && (a[0] === 'has-session' || a[0] === 'list-windows')) return { code: 1 };
          if (cmd === 'tmux' && a[0] === 'capture-pane') return { stdout: screen };
          return undefined;
        },
      });
      const t0 = runner.now();
      await assert.rejects(newTasks(ctx, [spec!], { waitTrust: false }), (e: Error & { hint?: string }) => {
        assert.equal(e.message, `${spec!.task}: agent waits for folder trust – attach: tmux attach -t agentctl, confirm, then agentctl status`);
        assert.match(e.hint ?? '', /never answers that dialog.*agentctl send .*TASK\.md/);
        return true;
      });
      assert.equal(runner.now() - t0, 0, 'no waiting for a timeout');
      const keys = runner.commands.filter((c) => c.startsWith('tmux send-keys') || c.includes('paste-buffer'));
      assert.equal(keys.length, 2, 'only the agent start command and its Enter were typed');
      assert.ok(!runner.commands.some((c) => c.includes('paste-buffer')));
    }
  });
});
