import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { buildAgentArgv, buildResumeArgv } from '../src/core/agents.ts';
import { DEFAULT_AGENT_SETTINGS, EFFORTS } from '../src/core/config.ts';
import type { AgentName } from '../src/core/config.ts';
import { planEventWiring } from '../src/core/events.ts';
import { defaultEquivalents, translate } from '../src/core/equivalents.ts';
import { findAutoAcceptFlag } from '../src/core/safety.ts';
import { modelLabel, providerLabel } from '../src/core/model-label.ts';
import { openReader, readPlans } from '../src/core/usage.ts';
import { planStatusLine } from '../src/core/usage-report.ts';
import { pendingAlerts, providerHint, alertText } from '../src/core/usage-limits.ts';
import { limitText } from '../src/core/event-command.ts';
import { parseCounts } from '../src/core/limits.ts';
import { resolveSpec } from '../src/core/spec.ts';
import { reviewOrder } from '../src/core/review.ts';
import { planMove } from '../src/core/move.ts';
import { FakeTmux, makeContext, useScratch } from './helpers.ts';
import { makeWorld, setClaudePlan, setCodexPlan } from './usage-world.ts';

const scratch = useScratch();
const ids: AgentName[] = ['claude', 'codex'];
const now = Date.parse('2026-11-01T12:00:00Z');
const failure = (fn: () => unknown) => { try { return fn(); } catch (e) { const x = e as Error & { hint?: string }; return { message: x.message, hint: x.hint }; } };

/** Captured from 934a80d before any production changes. No agent processes are used. */
async function capture(): Promise<Record<string, unknown>> {
  const w = makeWorld(scratch, 'golden');
  const argv = [];
  for (const agent of ids) for (const model of ['default', agent === 'claude' ? 'opus' : 'gpt-6-astra']) for (const effort of EFFORTS) for (const remoteControl of [false, true]) for (const extra of [[], ['--fixture', 'value with spaces']]) {
    const order = { agent, model, effort, remoteControl, task: 'GOLD-1' };
    const settings = { ...DEFAULT_AGENT_SETTINGS[agent], flags: ['--fixture-flag'] };
    argv.push({ order, extra, start: buildAgentArgv(order, settings, extra), resume: buildResumeArgv(order, settings, extra), session: buildResumeArgv(order, settings, extra, 'session-1') });
  }
  const wiring = ids.flatMap(agent => [false, true].map(forward => planEventWiring({ agent, task: 'GOLD-1', window: 'gold-1', config: w.config, self: ['node', '/fixture/agentctl.ts'], env: { CODEX_HOME: '/fixture/codex', CLAUDE_CONFIG_DIR: '/fixture/claude' }, readConfig: () => forward ? 'notify = ["user-hook", "with spaces"]' : undefined })));
  const table = defaultEquivalents();
  const translations = table.flatMap(row => ids.map(agent => translate({ agent, ...row[agent]! }, agent === 'claude' ? 'codex' : 'claude', table)));
  translations.push(...ids.flatMap(agent => ['fable', 'unmapped'].map(model => translate({ agent, model, effort: 'high' }, agent === 'claude' ? 'codex' : 'claude', table))));
  const flags = [[], ['--dangerously-skip-permissions'], ['--allow-dangerously-skip-permissions'], ['--dangerously-bypass-approvals-and-sandbox'], ['--yolo'], ['--yolo=1'], ['--full-auto'], ['--approve-for-me'], ['--permission-mode', 'bypassPermissions'], ['--permission-mode=acceptEdits'], ['--permission-mode', 'auto'], ['--permission-mode=dontAsk'], ['--permission-mode', 'default'], ['-a', 'never'], ['--ask-for-approval=never'], ['-c', 'approval_policy="never"'], ['--config=approval_policy=never'], ['-a', 'on-request'], ['--plan'], ['-y'], ['--prompt', 'x']];
  const labels = ['default', '', 'unknown', 'opus', 'claude-sonnet-5-5-20261001', 'gpt-6.1-sol', 'haiku', 'gpt-6-astra', 'other-model'].flatMap(model => [undefined, ...EFFORTS].map(effort => ({ model, effort, label: modelLabel(model, effort, model === 'opus' ? 'claude-opus-5-5' : undefined, { haiku: '5.1' }) })));
  const wt = w.worktree('task');
  w.claudeSession(wt, 'session-claude', '2026-11-01T10:00:00Z', { sub: true });
  const codexFile = w.codexSession(wt, 'session-codex', '2026-11-01T11:00:00Z');
  setClaudePlan(w.config.path, now, { session: 83, week: 62 });
  setCodexPlan(codexFile, now, { session: 12, week: 18 });
  const plans = readPlans(w.config, openReader(w.config), now);
  const alerts = pendingAlerts(w.config, plans, {});
  const texts = { statusLine: planStatusLine(plans), hints: ids.map(id => providerHint(w.config, plans, id)), alerts: alerts.map(a => alertText(w.config, plans, a, now)), limits: ids.flatMap(agent => [false, true].map(pin => limitText({ task: 'GOLD-1', agent, pin }))) };
  const counts = [[], ['gemini=1'], ['claude=0'], ['claude=2', 'codex=3'], ['claude', 'codex']].map(args => failure(() => parseCounts(args, undefined)));
  const specs = [{ agent: 'gemini' }, { agent: 'codex', remote_control: true }, { agent: 'claude', remote_control: 'bad' }].map(header => failure(() => resolveSpec({ index: 1, header: { task: 'BAD-1', model: 'opus', effort: 'high', repos: [{ path: wt, worktree: wt }], ...header }, prompt: 'Do it.' }, { config: w.config })));
  const tmux = new FakeTmux(w.config.session);
  const { ctx } = makeContext(w.config, { respond: tmux.respond, startTime: now });
  const orders = [];
  for (const agent of ids) {
    const author = w.task(`GOLD-${agent}`, wt, { agent, turnEndedAt: '2026-11-01T12:00:00.000Z', model: agent === 'claude' ? 'claude-opus-5-5' : 'gpt-6.1-sol', effort: agent === 'claude' ? 'high' : 'medium' });
    orders.push({ review: await reviewOrder(ctx, author, {}), move: await planMove(ctx, author.task) });
  }
  const data = { argv, wiring, settings: JSON.stringify(DEFAULT_AGENT_SETTINGS), flags: flags.map(args => ({ args, result: findAutoAcceptFlag(args) ?? null })), translations, labels, providers: ['claude', 'codex', 'gemini'].map(providerLabel), plans, texts, counts, specs, orders };
  return JSON.parse(JSON.stringify(data).replaceAll(w.root, '<ROOT>').replaceAll(w.claudeHome, '<CLAUDE>').replaceAll(w.codexHome, '<CODEX>')) as Record<string, unknown>;
}

// Literal baseline captured on 0.17.4; never regenerate during the provider refactor.
const GOLDEN = {
  "argv": [
    {
      "order": {
        "agent": "claude",
        "model": "default",
        "effort": "low",
        "remoteControl": false,
        "task": "GOLD-1"
      },
      "extra": [],
      "start": [
        "claude",
        "--effort",
        "low",
        "--fixture-flag"
      ],
      "resume": [
        "claude",
        "--effort",
        "low",
        "--fixture-flag",
        "--continue"
      ],
      "session": [
        "claude",
        "--effort",
        "low",
        "--fixture-flag",
        "--resume",
        "session-1"
      ]
    },
    {
      "order": {
        "agent": "claude",
        "model": "default",
        "effort": "low",
        "remoteControl": false,
        "task": "GOLD-1"
      },
      "extra": [
        "--fixture",
        "value with spaces"
      ],
      "start": [
        "claude",
        "--effort",
        "low",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "resume": [
        "claude",
        "--effort",
        "low",
        "--fixture-flag",
        "--fixture",
        "value with spaces",
        "--continue"
      ],
      "session": [
        "claude",
        "--effort",
        "low",
        "--fixture-flag",
        "--fixture",
        "value with spaces",
        "--resume",
        "session-1"
      ]
    },
    {
      "order": {
        "agent": "claude",
        "model": "default",
        "effort": "low",
        "remoteControl": true,
        "task": "GOLD-1"
      },
      "extra": [],
      "start": [
        "claude",
        "--effort",
        "low",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1"
      ],
      "resume": [
        "claude",
        "--effort",
        "low",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--continue"
      ],
      "session": [
        "claude",
        "--effort",
        "low",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--resume",
        "session-1"
      ]
    },
    {
      "order": {
        "agent": "claude",
        "model": "default",
        "effort": "low",
        "remoteControl": true,
        "task": "GOLD-1"
      },
      "extra": [
        "--fixture",
        "value with spaces"
      ],
      "start": [
        "claude",
        "--effort",
        "low",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--fixture",
        "value with spaces"
      ],
      "resume": [
        "claude",
        "--effort",
        "low",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--fixture",
        "value with spaces",
        "--continue"
      ],
      "session": [
        "claude",
        "--effort",
        "low",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--fixture",
        "value with spaces",
        "--resume",
        "session-1"
      ]
    },
    {
      "order": {
        "agent": "claude",
        "model": "default",
        "effort": "medium",
        "remoteControl": false,
        "task": "GOLD-1"
      },
      "extra": [],
      "start": [
        "claude",
        "--effort",
        "medium",
        "--fixture-flag"
      ],
      "resume": [
        "claude",
        "--effort",
        "medium",
        "--fixture-flag",
        "--continue"
      ],
      "session": [
        "claude",
        "--effort",
        "medium",
        "--fixture-flag",
        "--resume",
        "session-1"
      ]
    },
    {
      "order": {
        "agent": "claude",
        "model": "default",
        "effort": "medium",
        "remoteControl": false,
        "task": "GOLD-1"
      },
      "extra": [
        "--fixture",
        "value with spaces"
      ],
      "start": [
        "claude",
        "--effort",
        "medium",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "resume": [
        "claude",
        "--effort",
        "medium",
        "--fixture-flag",
        "--fixture",
        "value with spaces",
        "--continue"
      ],
      "session": [
        "claude",
        "--effort",
        "medium",
        "--fixture-flag",
        "--fixture",
        "value with spaces",
        "--resume",
        "session-1"
      ]
    },
    {
      "order": {
        "agent": "claude",
        "model": "default",
        "effort": "medium",
        "remoteControl": true,
        "task": "GOLD-1"
      },
      "extra": [],
      "start": [
        "claude",
        "--effort",
        "medium",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1"
      ],
      "resume": [
        "claude",
        "--effort",
        "medium",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--continue"
      ],
      "session": [
        "claude",
        "--effort",
        "medium",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--resume",
        "session-1"
      ]
    },
    {
      "order": {
        "agent": "claude",
        "model": "default",
        "effort": "medium",
        "remoteControl": true,
        "task": "GOLD-1"
      },
      "extra": [
        "--fixture",
        "value with spaces"
      ],
      "start": [
        "claude",
        "--effort",
        "medium",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--fixture",
        "value with spaces"
      ],
      "resume": [
        "claude",
        "--effort",
        "medium",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--fixture",
        "value with spaces",
        "--continue"
      ],
      "session": [
        "claude",
        "--effort",
        "medium",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--fixture",
        "value with spaces",
        "--resume",
        "session-1"
      ]
    },
    {
      "order": {
        "agent": "claude",
        "model": "default",
        "effort": "high",
        "remoteControl": false,
        "task": "GOLD-1"
      },
      "extra": [],
      "start": [
        "claude",
        "--effort",
        "high",
        "--fixture-flag"
      ],
      "resume": [
        "claude",
        "--effort",
        "high",
        "--fixture-flag",
        "--continue"
      ],
      "session": [
        "claude",
        "--effort",
        "high",
        "--fixture-flag",
        "--resume",
        "session-1"
      ]
    },
    {
      "order": {
        "agent": "claude",
        "model": "default",
        "effort": "high",
        "remoteControl": false,
        "task": "GOLD-1"
      },
      "extra": [
        "--fixture",
        "value with spaces"
      ],
      "start": [
        "claude",
        "--effort",
        "high",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "resume": [
        "claude",
        "--effort",
        "high",
        "--fixture-flag",
        "--fixture",
        "value with spaces",
        "--continue"
      ],
      "session": [
        "claude",
        "--effort",
        "high",
        "--fixture-flag",
        "--fixture",
        "value with spaces",
        "--resume",
        "session-1"
      ]
    },
    {
      "order": {
        "agent": "claude",
        "model": "default",
        "effort": "high",
        "remoteControl": true,
        "task": "GOLD-1"
      },
      "extra": [],
      "start": [
        "claude",
        "--effort",
        "high",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1"
      ],
      "resume": [
        "claude",
        "--effort",
        "high",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--continue"
      ],
      "session": [
        "claude",
        "--effort",
        "high",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--resume",
        "session-1"
      ]
    },
    {
      "order": {
        "agent": "claude",
        "model": "default",
        "effort": "high",
        "remoteControl": true,
        "task": "GOLD-1"
      },
      "extra": [
        "--fixture",
        "value with spaces"
      ],
      "start": [
        "claude",
        "--effort",
        "high",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--fixture",
        "value with spaces"
      ],
      "resume": [
        "claude",
        "--effort",
        "high",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--fixture",
        "value with spaces",
        "--continue"
      ],
      "session": [
        "claude",
        "--effort",
        "high",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--fixture",
        "value with spaces",
        "--resume",
        "session-1"
      ]
    },
    {
      "order": {
        "agent": "claude",
        "model": "default",
        "effort": "xhigh",
        "remoteControl": false,
        "task": "GOLD-1"
      },
      "extra": [],
      "start": [
        "claude",
        "--effort",
        "xhigh",
        "--fixture-flag"
      ],
      "resume": [
        "claude",
        "--effort",
        "xhigh",
        "--fixture-flag",
        "--continue"
      ],
      "session": [
        "claude",
        "--effort",
        "xhigh",
        "--fixture-flag",
        "--resume",
        "session-1"
      ]
    },
    {
      "order": {
        "agent": "claude",
        "model": "default",
        "effort": "xhigh",
        "remoteControl": false,
        "task": "GOLD-1"
      },
      "extra": [
        "--fixture",
        "value with spaces"
      ],
      "start": [
        "claude",
        "--effort",
        "xhigh",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "resume": [
        "claude",
        "--effort",
        "xhigh",
        "--fixture-flag",
        "--fixture",
        "value with spaces",
        "--continue"
      ],
      "session": [
        "claude",
        "--effort",
        "xhigh",
        "--fixture-flag",
        "--fixture",
        "value with spaces",
        "--resume",
        "session-1"
      ]
    },
    {
      "order": {
        "agent": "claude",
        "model": "default",
        "effort": "xhigh",
        "remoteControl": true,
        "task": "GOLD-1"
      },
      "extra": [],
      "start": [
        "claude",
        "--effort",
        "xhigh",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1"
      ],
      "resume": [
        "claude",
        "--effort",
        "xhigh",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--continue"
      ],
      "session": [
        "claude",
        "--effort",
        "xhigh",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--resume",
        "session-1"
      ]
    },
    {
      "order": {
        "agent": "claude",
        "model": "default",
        "effort": "xhigh",
        "remoteControl": true,
        "task": "GOLD-1"
      },
      "extra": [
        "--fixture",
        "value with spaces"
      ],
      "start": [
        "claude",
        "--effort",
        "xhigh",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--fixture",
        "value with spaces"
      ],
      "resume": [
        "claude",
        "--effort",
        "xhigh",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--fixture",
        "value with spaces",
        "--continue"
      ],
      "session": [
        "claude",
        "--effort",
        "xhigh",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--fixture",
        "value with spaces",
        "--resume",
        "session-1"
      ]
    },
    {
      "order": {
        "agent": "claude",
        "model": "default",
        "effort": "max",
        "remoteControl": false,
        "task": "GOLD-1"
      },
      "extra": [],
      "start": [
        "claude",
        "--effort",
        "max",
        "--fixture-flag"
      ],
      "resume": [
        "claude",
        "--effort",
        "max",
        "--fixture-flag",
        "--continue"
      ],
      "session": [
        "claude",
        "--effort",
        "max",
        "--fixture-flag",
        "--resume",
        "session-1"
      ]
    },
    {
      "order": {
        "agent": "claude",
        "model": "default",
        "effort": "max",
        "remoteControl": false,
        "task": "GOLD-1"
      },
      "extra": [
        "--fixture",
        "value with spaces"
      ],
      "start": [
        "claude",
        "--effort",
        "max",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "resume": [
        "claude",
        "--effort",
        "max",
        "--fixture-flag",
        "--fixture",
        "value with spaces",
        "--continue"
      ],
      "session": [
        "claude",
        "--effort",
        "max",
        "--fixture-flag",
        "--fixture",
        "value with spaces",
        "--resume",
        "session-1"
      ]
    },
    {
      "order": {
        "agent": "claude",
        "model": "default",
        "effort": "max",
        "remoteControl": true,
        "task": "GOLD-1"
      },
      "extra": [],
      "start": [
        "claude",
        "--effort",
        "max",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1"
      ],
      "resume": [
        "claude",
        "--effort",
        "max",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--continue"
      ],
      "session": [
        "claude",
        "--effort",
        "max",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--resume",
        "session-1"
      ]
    },
    {
      "order": {
        "agent": "claude",
        "model": "default",
        "effort": "max",
        "remoteControl": true,
        "task": "GOLD-1"
      },
      "extra": [
        "--fixture",
        "value with spaces"
      ],
      "start": [
        "claude",
        "--effort",
        "max",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--fixture",
        "value with spaces"
      ],
      "resume": [
        "claude",
        "--effort",
        "max",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--fixture",
        "value with spaces",
        "--continue"
      ],
      "session": [
        "claude",
        "--effort",
        "max",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--fixture",
        "value with spaces",
        "--resume",
        "session-1"
      ]
    },
    {
      "order": {
        "agent": "claude",
        "model": "opus",
        "effort": "low",
        "remoteControl": false,
        "task": "GOLD-1"
      },
      "extra": [],
      "start": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "low",
        "--fixture-flag"
      ],
      "resume": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "low",
        "--fixture-flag",
        "--continue"
      ],
      "session": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "low",
        "--fixture-flag",
        "--resume",
        "session-1"
      ]
    },
    {
      "order": {
        "agent": "claude",
        "model": "opus",
        "effort": "low",
        "remoteControl": false,
        "task": "GOLD-1"
      },
      "extra": [
        "--fixture",
        "value with spaces"
      ],
      "start": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "low",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "resume": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "low",
        "--fixture-flag",
        "--fixture",
        "value with spaces",
        "--continue"
      ],
      "session": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "low",
        "--fixture-flag",
        "--fixture",
        "value with spaces",
        "--resume",
        "session-1"
      ]
    },
    {
      "order": {
        "agent": "claude",
        "model": "opus",
        "effort": "low",
        "remoteControl": true,
        "task": "GOLD-1"
      },
      "extra": [],
      "start": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "low",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1"
      ],
      "resume": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "low",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--continue"
      ],
      "session": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "low",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--resume",
        "session-1"
      ]
    },
    {
      "order": {
        "agent": "claude",
        "model": "opus",
        "effort": "low",
        "remoteControl": true,
        "task": "GOLD-1"
      },
      "extra": [
        "--fixture",
        "value with spaces"
      ],
      "start": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "low",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--fixture",
        "value with spaces"
      ],
      "resume": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "low",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--fixture",
        "value with spaces",
        "--continue"
      ],
      "session": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "low",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--fixture",
        "value with spaces",
        "--resume",
        "session-1"
      ]
    },
    {
      "order": {
        "agent": "claude",
        "model": "opus",
        "effort": "medium",
        "remoteControl": false,
        "task": "GOLD-1"
      },
      "extra": [],
      "start": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "medium",
        "--fixture-flag"
      ],
      "resume": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "medium",
        "--fixture-flag",
        "--continue"
      ],
      "session": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "medium",
        "--fixture-flag",
        "--resume",
        "session-1"
      ]
    },
    {
      "order": {
        "agent": "claude",
        "model": "opus",
        "effort": "medium",
        "remoteControl": false,
        "task": "GOLD-1"
      },
      "extra": [
        "--fixture",
        "value with spaces"
      ],
      "start": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "medium",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "resume": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "medium",
        "--fixture-flag",
        "--fixture",
        "value with spaces",
        "--continue"
      ],
      "session": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "medium",
        "--fixture-flag",
        "--fixture",
        "value with spaces",
        "--resume",
        "session-1"
      ]
    },
    {
      "order": {
        "agent": "claude",
        "model": "opus",
        "effort": "medium",
        "remoteControl": true,
        "task": "GOLD-1"
      },
      "extra": [],
      "start": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "medium",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1"
      ],
      "resume": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "medium",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--continue"
      ],
      "session": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "medium",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--resume",
        "session-1"
      ]
    },
    {
      "order": {
        "agent": "claude",
        "model": "opus",
        "effort": "medium",
        "remoteControl": true,
        "task": "GOLD-1"
      },
      "extra": [
        "--fixture",
        "value with spaces"
      ],
      "start": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "medium",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--fixture",
        "value with spaces"
      ],
      "resume": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "medium",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--fixture",
        "value with spaces",
        "--continue"
      ],
      "session": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "medium",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--fixture",
        "value with spaces",
        "--resume",
        "session-1"
      ]
    },
    {
      "order": {
        "agent": "claude",
        "model": "opus",
        "effort": "high",
        "remoteControl": false,
        "task": "GOLD-1"
      },
      "extra": [],
      "start": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "high",
        "--fixture-flag"
      ],
      "resume": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "high",
        "--fixture-flag",
        "--continue"
      ],
      "session": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "high",
        "--fixture-flag",
        "--resume",
        "session-1"
      ]
    },
    {
      "order": {
        "agent": "claude",
        "model": "opus",
        "effort": "high",
        "remoteControl": false,
        "task": "GOLD-1"
      },
      "extra": [
        "--fixture",
        "value with spaces"
      ],
      "start": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "high",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "resume": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "high",
        "--fixture-flag",
        "--fixture",
        "value with spaces",
        "--continue"
      ],
      "session": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "high",
        "--fixture-flag",
        "--fixture",
        "value with spaces",
        "--resume",
        "session-1"
      ]
    },
    {
      "order": {
        "agent": "claude",
        "model": "opus",
        "effort": "high",
        "remoteControl": true,
        "task": "GOLD-1"
      },
      "extra": [],
      "start": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "high",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1"
      ],
      "resume": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "high",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--continue"
      ],
      "session": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "high",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--resume",
        "session-1"
      ]
    },
    {
      "order": {
        "agent": "claude",
        "model": "opus",
        "effort": "high",
        "remoteControl": true,
        "task": "GOLD-1"
      },
      "extra": [
        "--fixture",
        "value with spaces"
      ],
      "start": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "high",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--fixture",
        "value with spaces"
      ],
      "resume": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "high",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--fixture",
        "value with spaces",
        "--continue"
      ],
      "session": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "high",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--fixture",
        "value with spaces",
        "--resume",
        "session-1"
      ]
    },
    {
      "order": {
        "agent": "claude",
        "model": "opus",
        "effort": "xhigh",
        "remoteControl": false,
        "task": "GOLD-1"
      },
      "extra": [],
      "start": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "xhigh",
        "--fixture-flag"
      ],
      "resume": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "xhigh",
        "--fixture-flag",
        "--continue"
      ],
      "session": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "xhigh",
        "--fixture-flag",
        "--resume",
        "session-1"
      ]
    },
    {
      "order": {
        "agent": "claude",
        "model": "opus",
        "effort": "xhigh",
        "remoteControl": false,
        "task": "GOLD-1"
      },
      "extra": [
        "--fixture",
        "value with spaces"
      ],
      "start": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "xhigh",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "resume": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "xhigh",
        "--fixture-flag",
        "--fixture",
        "value with spaces",
        "--continue"
      ],
      "session": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "xhigh",
        "--fixture-flag",
        "--fixture",
        "value with spaces",
        "--resume",
        "session-1"
      ]
    },
    {
      "order": {
        "agent": "claude",
        "model": "opus",
        "effort": "xhigh",
        "remoteControl": true,
        "task": "GOLD-1"
      },
      "extra": [],
      "start": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "xhigh",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1"
      ],
      "resume": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "xhigh",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--continue"
      ],
      "session": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "xhigh",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--resume",
        "session-1"
      ]
    },
    {
      "order": {
        "agent": "claude",
        "model": "opus",
        "effort": "xhigh",
        "remoteControl": true,
        "task": "GOLD-1"
      },
      "extra": [
        "--fixture",
        "value with spaces"
      ],
      "start": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "xhigh",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--fixture",
        "value with spaces"
      ],
      "resume": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "xhigh",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--fixture",
        "value with spaces",
        "--continue"
      ],
      "session": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "xhigh",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--fixture",
        "value with spaces",
        "--resume",
        "session-1"
      ]
    },
    {
      "order": {
        "agent": "claude",
        "model": "opus",
        "effort": "max",
        "remoteControl": false,
        "task": "GOLD-1"
      },
      "extra": [],
      "start": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "max",
        "--fixture-flag"
      ],
      "resume": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "max",
        "--fixture-flag",
        "--continue"
      ],
      "session": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "max",
        "--fixture-flag",
        "--resume",
        "session-1"
      ]
    },
    {
      "order": {
        "agent": "claude",
        "model": "opus",
        "effort": "max",
        "remoteControl": false,
        "task": "GOLD-1"
      },
      "extra": [
        "--fixture",
        "value with spaces"
      ],
      "start": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "max",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "resume": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "max",
        "--fixture-flag",
        "--fixture",
        "value with spaces",
        "--continue"
      ],
      "session": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "max",
        "--fixture-flag",
        "--fixture",
        "value with spaces",
        "--resume",
        "session-1"
      ]
    },
    {
      "order": {
        "agent": "claude",
        "model": "opus",
        "effort": "max",
        "remoteControl": true,
        "task": "GOLD-1"
      },
      "extra": [],
      "start": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "max",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1"
      ],
      "resume": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "max",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--continue"
      ],
      "session": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "max",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--resume",
        "session-1"
      ]
    },
    {
      "order": {
        "agent": "claude",
        "model": "opus",
        "effort": "max",
        "remoteControl": true,
        "task": "GOLD-1"
      },
      "extra": [
        "--fixture",
        "value with spaces"
      ],
      "start": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "max",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--fixture",
        "value with spaces"
      ],
      "resume": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "max",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--fixture",
        "value with spaces",
        "--continue"
      ],
      "session": [
        "claude",
        "--model",
        "opus",
        "--effort",
        "max",
        "--fixture-flag",
        "--remote-control",
        "GOLD-1",
        "--fixture",
        "value with spaces",
        "--resume",
        "session-1"
      ]
    },
    {
      "order": {
        "agent": "codex",
        "model": "default",
        "effort": "low",
        "remoteControl": false,
        "task": "GOLD-1"
      },
      "extra": [],
      "start": [
        "codex",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=low",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ],
      "resume": [
        "codex",
        "resume",
        "--last",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=low",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ],
      "session": [
        "codex",
        "resume",
        "session-1",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=low",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ]
    },
    {
      "order": {
        "agent": "codex",
        "model": "default",
        "effort": "low",
        "remoteControl": false,
        "task": "GOLD-1"
      },
      "extra": [
        "--fixture",
        "value with spaces"
      ],
      "start": [
        "codex",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=low",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "resume": [
        "codex",
        "resume",
        "--last",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=low",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "session": [
        "codex",
        "resume",
        "session-1",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=low",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ]
    },
    {
      "order": {
        "agent": "codex",
        "model": "default",
        "effort": "low",
        "remoteControl": true,
        "task": "GOLD-1"
      },
      "extra": [],
      "start": [
        "codex",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=low",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ],
      "resume": [
        "codex",
        "resume",
        "--last",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=low",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ],
      "session": [
        "codex",
        "resume",
        "session-1",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=low",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ]
    },
    {
      "order": {
        "agent": "codex",
        "model": "default",
        "effort": "low",
        "remoteControl": true,
        "task": "GOLD-1"
      },
      "extra": [
        "--fixture",
        "value with spaces"
      ],
      "start": [
        "codex",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=low",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "resume": [
        "codex",
        "resume",
        "--last",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=low",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "session": [
        "codex",
        "resume",
        "session-1",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=low",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ]
    },
    {
      "order": {
        "agent": "codex",
        "model": "default",
        "effort": "medium",
        "remoteControl": false,
        "task": "GOLD-1"
      },
      "extra": [],
      "start": [
        "codex",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=medium",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ],
      "resume": [
        "codex",
        "resume",
        "--last",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=medium",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ],
      "session": [
        "codex",
        "resume",
        "session-1",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=medium",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ]
    },
    {
      "order": {
        "agent": "codex",
        "model": "default",
        "effort": "medium",
        "remoteControl": false,
        "task": "GOLD-1"
      },
      "extra": [
        "--fixture",
        "value with spaces"
      ],
      "start": [
        "codex",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=medium",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "resume": [
        "codex",
        "resume",
        "--last",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=medium",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "session": [
        "codex",
        "resume",
        "session-1",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=medium",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ]
    },
    {
      "order": {
        "agent": "codex",
        "model": "default",
        "effort": "medium",
        "remoteControl": true,
        "task": "GOLD-1"
      },
      "extra": [],
      "start": [
        "codex",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=medium",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ],
      "resume": [
        "codex",
        "resume",
        "--last",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=medium",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ],
      "session": [
        "codex",
        "resume",
        "session-1",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=medium",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ]
    },
    {
      "order": {
        "agent": "codex",
        "model": "default",
        "effort": "medium",
        "remoteControl": true,
        "task": "GOLD-1"
      },
      "extra": [
        "--fixture",
        "value with spaces"
      ],
      "start": [
        "codex",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=medium",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "resume": [
        "codex",
        "resume",
        "--last",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=medium",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "session": [
        "codex",
        "resume",
        "session-1",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=medium",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ]
    },
    {
      "order": {
        "agent": "codex",
        "model": "default",
        "effort": "high",
        "remoteControl": false,
        "task": "GOLD-1"
      },
      "extra": [],
      "start": [
        "codex",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=high",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ],
      "resume": [
        "codex",
        "resume",
        "--last",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=high",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ],
      "session": [
        "codex",
        "resume",
        "session-1",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=high",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ]
    },
    {
      "order": {
        "agent": "codex",
        "model": "default",
        "effort": "high",
        "remoteControl": false,
        "task": "GOLD-1"
      },
      "extra": [
        "--fixture",
        "value with spaces"
      ],
      "start": [
        "codex",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=high",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "resume": [
        "codex",
        "resume",
        "--last",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=high",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "session": [
        "codex",
        "resume",
        "session-1",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=high",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ]
    },
    {
      "order": {
        "agent": "codex",
        "model": "default",
        "effort": "high",
        "remoteControl": true,
        "task": "GOLD-1"
      },
      "extra": [],
      "start": [
        "codex",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=high",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ],
      "resume": [
        "codex",
        "resume",
        "--last",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=high",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ],
      "session": [
        "codex",
        "resume",
        "session-1",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=high",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ]
    },
    {
      "order": {
        "agent": "codex",
        "model": "default",
        "effort": "high",
        "remoteControl": true,
        "task": "GOLD-1"
      },
      "extra": [
        "--fixture",
        "value with spaces"
      ],
      "start": [
        "codex",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=high",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "resume": [
        "codex",
        "resume",
        "--last",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=high",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "session": [
        "codex",
        "resume",
        "session-1",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=high",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ]
    },
    {
      "order": {
        "agent": "codex",
        "model": "default",
        "effort": "xhigh",
        "remoteControl": false,
        "task": "GOLD-1"
      },
      "extra": [],
      "start": [
        "codex",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=xhigh",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ],
      "resume": [
        "codex",
        "resume",
        "--last",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=xhigh",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ],
      "session": [
        "codex",
        "resume",
        "session-1",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=xhigh",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ]
    },
    {
      "order": {
        "agent": "codex",
        "model": "default",
        "effort": "xhigh",
        "remoteControl": false,
        "task": "GOLD-1"
      },
      "extra": [
        "--fixture",
        "value with spaces"
      ],
      "start": [
        "codex",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=xhigh",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "resume": [
        "codex",
        "resume",
        "--last",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=xhigh",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "session": [
        "codex",
        "resume",
        "session-1",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=xhigh",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ]
    },
    {
      "order": {
        "agent": "codex",
        "model": "default",
        "effort": "xhigh",
        "remoteControl": true,
        "task": "GOLD-1"
      },
      "extra": [],
      "start": [
        "codex",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=xhigh",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ],
      "resume": [
        "codex",
        "resume",
        "--last",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=xhigh",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ],
      "session": [
        "codex",
        "resume",
        "session-1",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=xhigh",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ]
    },
    {
      "order": {
        "agent": "codex",
        "model": "default",
        "effort": "xhigh",
        "remoteControl": true,
        "task": "GOLD-1"
      },
      "extra": [
        "--fixture",
        "value with spaces"
      ],
      "start": [
        "codex",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=xhigh",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "resume": [
        "codex",
        "resume",
        "--last",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=xhigh",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "session": [
        "codex",
        "resume",
        "session-1",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=xhigh",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ]
    },
    {
      "order": {
        "agent": "codex",
        "model": "default",
        "effort": "max",
        "remoteControl": false,
        "task": "GOLD-1"
      },
      "extra": [],
      "start": [
        "codex",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=max",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ],
      "resume": [
        "codex",
        "resume",
        "--last",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=max",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ],
      "session": [
        "codex",
        "resume",
        "session-1",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=max",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ]
    },
    {
      "order": {
        "agent": "codex",
        "model": "default",
        "effort": "max",
        "remoteControl": false,
        "task": "GOLD-1"
      },
      "extra": [
        "--fixture",
        "value with spaces"
      ],
      "start": [
        "codex",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=max",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "resume": [
        "codex",
        "resume",
        "--last",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=max",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "session": [
        "codex",
        "resume",
        "session-1",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=max",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ]
    },
    {
      "order": {
        "agent": "codex",
        "model": "default",
        "effort": "max",
        "remoteControl": true,
        "task": "GOLD-1"
      },
      "extra": [],
      "start": [
        "codex",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=max",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ],
      "resume": [
        "codex",
        "resume",
        "--last",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=max",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ],
      "session": [
        "codex",
        "resume",
        "session-1",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=max",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ]
    },
    {
      "order": {
        "agent": "codex",
        "model": "default",
        "effort": "max",
        "remoteControl": true,
        "task": "GOLD-1"
      },
      "extra": [
        "--fixture",
        "value with spaces"
      ],
      "start": [
        "codex",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=max",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "resume": [
        "codex",
        "resume",
        "--last",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=max",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "session": [
        "codex",
        "resume",
        "session-1",
        "--sandbox",
        "danger-full-access",
        "-c",
        "model_reasoning_effort=max",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ]
    },
    {
      "order": {
        "agent": "codex",
        "model": "gpt-6-astra",
        "effort": "low",
        "remoteControl": false,
        "task": "GOLD-1"
      },
      "extra": [],
      "start": [
        "codex",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=low",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ],
      "resume": [
        "codex",
        "resume",
        "--last",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=low",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ],
      "session": [
        "codex",
        "resume",
        "session-1",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=low",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ]
    },
    {
      "order": {
        "agent": "codex",
        "model": "gpt-6-astra",
        "effort": "low",
        "remoteControl": false,
        "task": "GOLD-1"
      },
      "extra": [
        "--fixture",
        "value with spaces"
      ],
      "start": [
        "codex",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=low",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "resume": [
        "codex",
        "resume",
        "--last",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=low",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "session": [
        "codex",
        "resume",
        "session-1",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=low",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ]
    },
    {
      "order": {
        "agent": "codex",
        "model": "gpt-6-astra",
        "effort": "low",
        "remoteControl": true,
        "task": "GOLD-1"
      },
      "extra": [],
      "start": [
        "codex",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=low",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ],
      "resume": [
        "codex",
        "resume",
        "--last",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=low",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ],
      "session": [
        "codex",
        "resume",
        "session-1",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=low",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ]
    },
    {
      "order": {
        "agent": "codex",
        "model": "gpt-6-astra",
        "effort": "low",
        "remoteControl": true,
        "task": "GOLD-1"
      },
      "extra": [
        "--fixture",
        "value with spaces"
      ],
      "start": [
        "codex",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=low",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "resume": [
        "codex",
        "resume",
        "--last",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=low",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "session": [
        "codex",
        "resume",
        "session-1",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=low",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ]
    },
    {
      "order": {
        "agent": "codex",
        "model": "gpt-6-astra",
        "effort": "medium",
        "remoteControl": false,
        "task": "GOLD-1"
      },
      "extra": [],
      "start": [
        "codex",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=medium",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ],
      "resume": [
        "codex",
        "resume",
        "--last",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=medium",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ],
      "session": [
        "codex",
        "resume",
        "session-1",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=medium",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ]
    },
    {
      "order": {
        "agent": "codex",
        "model": "gpt-6-astra",
        "effort": "medium",
        "remoteControl": false,
        "task": "GOLD-1"
      },
      "extra": [
        "--fixture",
        "value with spaces"
      ],
      "start": [
        "codex",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=medium",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "resume": [
        "codex",
        "resume",
        "--last",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=medium",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "session": [
        "codex",
        "resume",
        "session-1",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=medium",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ]
    },
    {
      "order": {
        "agent": "codex",
        "model": "gpt-6-astra",
        "effort": "medium",
        "remoteControl": true,
        "task": "GOLD-1"
      },
      "extra": [],
      "start": [
        "codex",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=medium",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ],
      "resume": [
        "codex",
        "resume",
        "--last",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=medium",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ],
      "session": [
        "codex",
        "resume",
        "session-1",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=medium",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ]
    },
    {
      "order": {
        "agent": "codex",
        "model": "gpt-6-astra",
        "effort": "medium",
        "remoteControl": true,
        "task": "GOLD-1"
      },
      "extra": [
        "--fixture",
        "value with spaces"
      ],
      "start": [
        "codex",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=medium",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "resume": [
        "codex",
        "resume",
        "--last",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=medium",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "session": [
        "codex",
        "resume",
        "session-1",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=medium",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ]
    },
    {
      "order": {
        "agent": "codex",
        "model": "gpt-6-astra",
        "effort": "high",
        "remoteControl": false,
        "task": "GOLD-1"
      },
      "extra": [],
      "start": [
        "codex",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=high",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ],
      "resume": [
        "codex",
        "resume",
        "--last",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=high",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ],
      "session": [
        "codex",
        "resume",
        "session-1",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=high",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ]
    },
    {
      "order": {
        "agent": "codex",
        "model": "gpt-6-astra",
        "effort": "high",
        "remoteControl": false,
        "task": "GOLD-1"
      },
      "extra": [
        "--fixture",
        "value with spaces"
      ],
      "start": [
        "codex",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=high",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "resume": [
        "codex",
        "resume",
        "--last",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=high",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "session": [
        "codex",
        "resume",
        "session-1",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=high",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ]
    },
    {
      "order": {
        "agent": "codex",
        "model": "gpt-6-astra",
        "effort": "high",
        "remoteControl": true,
        "task": "GOLD-1"
      },
      "extra": [],
      "start": [
        "codex",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=high",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ],
      "resume": [
        "codex",
        "resume",
        "--last",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=high",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ],
      "session": [
        "codex",
        "resume",
        "session-1",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=high",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ]
    },
    {
      "order": {
        "agent": "codex",
        "model": "gpt-6-astra",
        "effort": "high",
        "remoteControl": true,
        "task": "GOLD-1"
      },
      "extra": [
        "--fixture",
        "value with spaces"
      ],
      "start": [
        "codex",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=high",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "resume": [
        "codex",
        "resume",
        "--last",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=high",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "session": [
        "codex",
        "resume",
        "session-1",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=high",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ]
    },
    {
      "order": {
        "agent": "codex",
        "model": "gpt-6-astra",
        "effort": "xhigh",
        "remoteControl": false,
        "task": "GOLD-1"
      },
      "extra": [],
      "start": [
        "codex",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=xhigh",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ],
      "resume": [
        "codex",
        "resume",
        "--last",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=xhigh",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ],
      "session": [
        "codex",
        "resume",
        "session-1",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=xhigh",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ]
    },
    {
      "order": {
        "agent": "codex",
        "model": "gpt-6-astra",
        "effort": "xhigh",
        "remoteControl": false,
        "task": "GOLD-1"
      },
      "extra": [
        "--fixture",
        "value with spaces"
      ],
      "start": [
        "codex",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=xhigh",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "resume": [
        "codex",
        "resume",
        "--last",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=xhigh",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "session": [
        "codex",
        "resume",
        "session-1",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=xhigh",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ]
    },
    {
      "order": {
        "agent": "codex",
        "model": "gpt-6-astra",
        "effort": "xhigh",
        "remoteControl": true,
        "task": "GOLD-1"
      },
      "extra": [],
      "start": [
        "codex",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=xhigh",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ],
      "resume": [
        "codex",
        "resume",
        "--last",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=xhigh",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ],
      "session": [
        "codex",
        "resume",
        "session-1",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=xhigh",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ]
    },
    {
      "order": {
        "agent": "codex",
        "model": "gpt-6-astra",
        "effort": "xhigh",
        "remoteControl": true,
        "task": "GOLD-1"
      },
      "extra": [
        "--fixture",
        "value with spaces"
      ],
      "start": [
        "codex",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=xhigh",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "resume": [
        "codex",
        "resume",
        "--last",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=xhigh",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "session": [
        "codex",
        "resume",
        "session-1",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=xhigh",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ]
    },
    {
      "order": {
        "agent": "codex",
        "model": "gpt-6-astra",
        "effort": "max",
        "remoteControl": false,
        "task": "GOLD-1"
      },
      "extra": [],
      "start": [
        "codex",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=max",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ],
      "resume": [
        "codex",
        "resume",
        "--last",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=max",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ],
      "session": [
        "codex",
        "resume",
        "session-1",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=max",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ]
    },
    {
      "order": {
        "agent": "codex",
        "model": "gpt-6-astra",
        "effort": "max",
        "remoteControl": false,
        "task": "GOLD-1"
      },
      "extra": [
        "--fixture",
        "value with spaces"
      ],
      "start": [
        "codex",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=max",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "resume": [
        "codex",
        "resume",
        "--last",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=max",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "session": [
        "codex",
        "resume",
        "session-1",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=max",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ]
    },
    {
      "order": {
        "agent": "codex",
        "model": "gpt-6-astra",
        "effort": "max",
        "remoteControl": true,
        "task": "GOLD-1"
      },
      "extra": [],
      "start": [
        "codex",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=max",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ],
      "resume": [
        "codex",
        "resume",
        "--last",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=max",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ],
      "session": [
        "codex",
        "resume",
        "session-1",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=max",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag"
      ]
    },
    {
      "order": {
        "agent": "codex",
        "model": "gpt-6-astra",
        "effort": "max",
        "remoteControl": true,
        "task": "GOLD-1"
      },
      "extra": [
        "--fixture",
        "value with spaces"
      ],
      "start": [
        "codex",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=max",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "resume": [
        "codex",
        "resume",
        "--last",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=max",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ],
      "session": [
        "codex",
        "resume",
        "session-1",
        "--sandbox",
        "danger-full-access",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=max",
        "-c",
        "check_for_update_on_startup=false",
        "--fixture-flag",
        "--fixture",
        "value with spaces"
      ]
    }
  ],
  "wiring": [
    {
      "args": [
        "--settings",
        "<ROOT>/state/gold-1/claude-settings.json"
      ],
      "files": [
        {
          "path": "<ROOT>/state/gold-1/claude-settings.json",
          "content": "{\n  \"hooks\": {\n    \"Notification\": [\n      {\n        \"hooks\": [\n          {\n            \"type\": \"command\",\n            \"command\": \"node /fixture/agentctl.ts event --task GOLD-1 --agent claude --kind notification\",\n            \"timeout\": 15\n          }\n        ]\n      }\n    ],\n    \"Stop\": [\n      {\n        \"hooks\": [\n          {\n            \"type\": \"command\",\n            \"command\": \"node /fixture/agentctl.ts event --task GOLD-1 --agent claude --kind stop\",\n            \"timeout\": 15\n          }\n        ]\n      }\n    ],\n    \"StopFailure\": [\n      {\n        \"hooks\": [\n          {\n            \"type\": \"command\",\n            \"command\": \"node /fixture/agentctl.ts event --task GOLD-1 --agent claude --kind stop-failure\",\n            \"timeout\": 15\n          }\n        ]\n      }\n    ],\n    \"UserPromptSubmit\": [\n      {\n        \"hooks\": [\n          {\n            \"type\": \"command\",\n            \"command\": \"node /fixture/agentctl.ts event --task GOLD-1 --agent claude --kind user-prompt-submit\",\n            \"timeout\": 15\n          }\n        ]\n      }\n    ],\n    \"SessionStart\": [\n      {\n        \"hooks\": [\n          {\n            \"type\": \"command\",\n            \"command\": \"node /fixture/agentctl.ts event --task GOLD-1 --agent claude --kind session-start\",\n            \"timeout\": 15\n          }\n        ]\n      }\n    ]\n  },\n  \"statusLine\": {\n    \"type\": \"command\",\n    \"command\": \"node /fixture/agentctl.ts usage-tap --task GOLD-1\"\n  },\n  \"promptSuggestionEnabled\": false\n}\n"
        }
      ],
      "note": "events: Claude hooks SessionStart, UserPromptSubmit, Notification, Stop and StopFailure, statusLine (usage-tap) in <ROOT>/state/gold-1/claude-settings.json"
    },
    {
      "args": [
        "--settings",
        "<ROOT>/state/gold-1/claude-settings.json"
      ],
      "files": [
        {
          "path": "<ROOT>/state/gold-1/claude-settings.json",
          "content": "{\n  \"hooks\": {\n    \"Notification\": [\n      {\n        \"hooks\": [\n          {\n            \"type\": \"command\",\n            \"command\": \"node /fixture/agentctl.ts event --task GOLD-1 --agent claude --kind notification\",\n            \"timeout\": 15\n          }\n        ]\n      }\n    ],\n    \"Stop\": [\n      {\n        \"hooks\": [\n          {\n            \"type\": \"command\",\n            \"command\": \"node /fixture/agentctl.ts event --task GOLD-1 --agent claude --kind stop\",\n            \"timeout\": 15\n          }\n        ]\n      }\n    ],\n    \"StopFailure\": [\n      {\n        \"hooks\": [\n          {\n            \"type\": \"command\",\n            \"command\": \"node /fixture/agentctl.ts event --task GOLD-1 --agent claude --kind stop-failure\",\n            \"timeout\": 15\n          }\n        ]\n      }\n    ],\n    \"UserPromptSubmit\": [\n      {\n        \"hooks\": [\n          {\n            \"type\": \"command\",\n            \"command\": \"node /fixture/agentctl.ts event --task GOLD-1 --agent claude --kind user-prompt-submit\",\n            \"timeout\": 15\n          }\n        ]\n      }\n    ],\n    \"SessionStart\": [\n      {\n        \"hooks\": [\n          {\n            \"type\": \"command\",\n            \"command\": \"node /fixture/agentctl.ts event --task GOLD-1 --agent claude --kind session-start\",\n            \"timeout\": 15\n          }\n        ]\n      }\n    ]\n  },\n  \"statusLine\": {\n    \"type\": \"command\",\n    \"command\": \"node /fixture/agentctl.ts usage-tap --task GOLD-1\"\n  },\n  \"promptSuggestionEnabled\": false\n}\n"
        }
      ],
      "note": "events: Claude hooks SessionStart, UserPromptSubmit, Notification, Stop and StopFailure, statusLine (usage-tap) in <ROOT>/state/gold-1/claude-settings.json"
    },
    {
      "args": [
        "-c",
        "notify=[\"sh\", \"<ROOT>/state/gold-1/codex-notify.sh\"]"
      ],
      "files": [
        {
          "path": "<ROOT>/state/gold-1/codex-notify.sh",
          "content": "#!/bin/sh\n\nexec node /fixture/agentctl.ts event --task GOLD-1 --agent codex \"$@\"\n"
        }
      ],
      "note": "events: Codex notify -> agentctl event"
    },
    {
      "args": [
        "-c",
        "notify=[\"sh\", \"<ROOT>/state/gold-1/codex-notify.sh\"]"
      ],
      "files": [
        {
          "path": "<ROOT>/state/gold-1/codex-notify.sh",
          "content": "#!/bin/sh\n\nexec node /fixture/agentctl.ts event --task GOLD-1 --agent codex --forward-file <ROOT>/state/gold-1/codex-forward.json \"$@\"\n"
        },
        {
          "path": "<ROOT>/state/gold-1/codex-forward.json",
          "content": "[\"user-hook\",\"with spaces\"]\n"
        }
      ],
      "note": "events: Codex notify -> agentctl event (then your own notify)"
    }
  ],
  "settings": "{\"claude\":{\"acceptsBusyPrompt\":true,\"flags\":[],\"effortArgs\":[\"--effort\",\"{effort}\"],\"readyPattern\":\"^\\\\s*❯\\\\s(?!\\\\d+\\\\.)\",\"readyTimeout\":60,\"trustTimeout\":600,\"trustPattern\":\"Quick safety check|Yes, I trust this folder\",\"workingPattern\":\"esc to interrupt|^\\\\s*(?:⏺\\\\s+)?Running(?:\\\\s|…|\\\\.\\\\.\\\\.)|^\\\\s*[✶✻✽✢·*]\\\\s+[^\\\\n]+(?:…|\\\\.\\\\.\\\\.)\\\\s*\\\\([^\\\\n]*(?:\\\\d+(?:\\\\.\\\\d+)?s\\\\s*·|thinking|tokens)[^\\\\n]*\\\\)\",\"deliveryPattern\":\"^\\\\s*⏺|● got:\",\"interruptKey\":\"Escape\",\"footerPatterns\":[\"\\\\? for shortcuts\",\"^\\\\s*(⏵⏵|⏸)\",\"shift\\\\+tab to cycle\",\"^\\\\s*[❯>]\\\\s*(Try \\\".*\\\")?$\"],\"questionPattern\":\"Enter to select\\\\b.*Esc to cancel|Esc to cancel · Tab to amend\",\"limitPatterns\":[\"^[\\\\s⎿●•■⚠!*>-]*You.ve hit your .{0,60}limit\",\"^[\\\\s⎿●•■⚠!*>-]*Usage limit reached\",\"^[\\\\s⎿●•■⚠!*>-]*You.re out of extra usage\",\"^[\\\\s⎿●•■⚠!*>-]*(?:API Error: )?Request rejected \\\\(429\\\\)\"],\"overloadPatterns\":[\"^\\\\s*⎿\\\\s*API Error:\\\\s*529(?:\\\\s|$)\",\"^\\\\s*⎿\\\\s*(?:API Error:\\\\s*)?Overloaded(?:[.:]|$)\"],\"backgroundPatterns\":[\"^\\\\s*\\\\d+ (?:monitors?|shells?)(?:, \\\\d+ (?:monitors?|shells?))? still running\\\\b\",\"[·⏵].*\\\\b\\\\d+ (?:shells?|monitors?)\\\\b(?: still running)?\",\"[·⏵].*\\\\b\\\\d+ background\\\\b\"]},\"codex\":{\"acceptsBusyPrompt\":true,\"flags\":[],\"effortArgs\":[\"-c\",\"model_reasoning_effort={effort}\"],\"readyPattern\":\"^›\\\\s(?!\\\\d+\\\\.)|\\\\? for shortcuts\",\"readyTimeout\":60,\"trustTimeout\":600,\"trustPattern\":\"Trust this folder\\\\?|Folder settings can run code automatically\",\"dialogPattern\":\"Update available|Skip until next version\",\"workingPattern\":\"esc to interrupt\",\"deliveryPattern\":\"^\\\\s*[•■]|● got:\",\"interruptKey\":\"Escape\",\"footerPatterns\":[\"\\\\? for shortcuts\",\"⚠ \\\\d+ warnings?\",\"f2 to view\",\"^\\\\s*[\\\\w.-]+ (low|medium|high|xhigh|minimal|none) · \",\"^\\\\s*›\\\\s*(Ask Codex to do anything)?\\\\s*$\",\"Queued follow-up inputs|⇧.? (edit last queued message|to answer)\"],\"questionPattern\":\"Waiting for your answer|^\\\\s*\\\\?\\\\s+\\\\d+ questions?\\\\b|to answer\\\\s*$|Press enter to confirm or esc to cancel\",\"limitPatterns\":[\"^[\\\\s⎿●•■⚠!*>-]*You.ve hit your usage limit\",\"^[\\\\s⎿●•■⚠!*>-]*Usage limit reached\",\"^[\\\\s⎿●•■⚠!*>-]*You.re out of credits\",\"^[\\\\s⎿●•■⚠!*>-]*Your workspace is out of credits\",\"^[\\\\s⎿●•■⚠!*>-]*You hit your spend cap\"],\"overloadPatterns\":[\"^\\\\s*■\\\\s*Selected model is at capacity(?:\\\\.|$)\"],\"backgroundPatterns\":[\"\\\\b\\\\d+ background terminals?\\\\b\"]}}",
  "flags": [
    {
      "args": [],
      "result": null
    },
    {
      "args": [
        "--dangerously-skip-permissions"
      ],
      "result": "--dangerously-skip-permissions"
    },
    {
      "args": [
        "--allow-dangerously-skip-permissions"
      ],
      "result": "--allow-dangerously-skip-permissions"
    },
    {
      "args": [
        "--dangerously-bypass-approvals-and-sandbox"
      ],
      "result": "--dangerously-bypass-approvals-and-sandbox"
    },
    {
      "args": [
        "--yolo"
      ],
      "result": "--yolo"
    },
    {
      "args": [
        "--yolo=1"
      ],
      "result": "--yolo=1"
    },
    {
      "args": [
        "--full-auto"
      ],
      "result": "--full-auto"
    },
    {
      "args": [
        "--approve-for-me"
      ],
      "result": "--approve-for-me"
    },
    {
      "args": [
        "--permission-mode",
        "bypassPermissions"
      ],
      "result": "--permission-mode bypassPermissions"
    },
    {
      "args": [
        "--permission-mode=acceptEdits"
      ],
      "result": "--permission-mode acceptEdits"
    },
    {
      "args": [
        "--permission-mode",
        "auto"
      ],
      "result": "--permission-mode auto"
    },
    {
      "args": [
        "--permission-mode=dontAsk"
      ],
      "result": "--permission-mode dontAsk"
    },
    {
      "args": [
        "--permission-mode",
        "default"
      ],
      "result": null
    },
    {
      "args": [
        "-a",
        "never"
      ],
      "result": "-a never"
    },
    {
      "args": [
        "--ask-for-approval=never"
      ],
      "result": "--ask-for-approval never"
    },
    {
      "args": [
        "-c",
        "approval_policy=\"never\""
      ],
      "result": "-c approval_policy=\"never\""
    },
    {
      "args": [
        "--config=approval_policy=never"
      ],
      "result": "--config approval_policy=never"
    },
    {
      "args": [
        "-a",
        "on-request"
      ],
      "result": null
    },
    {
      "args": [
        "--plan"
      ],
      "result": null
    },
    {
      "args": [
        "-y"
      ],
      "result": null
    },
    {
      "args": [
        "--prompt",
        "x"
      ],
      "result": null
    }
  ],
  "translations": [
    {
      "ok": true,
      "order": {
        "agent": "codex",
        "model": "gpt-6-luna",
        "effort": "medium"
      }
    },
    {
      "ok": true,
      "order": {
        "agent": "claude",
        "model": "claude-haiku-5-5",
        "effort": "low"
      }
    },
    {
      "ok": true,
      "order": {
        "agent": "codex",
        "model": "gpt-6-luna",
        "effort": "medium"
      }
    },
    {
      "ok": true,
      "order": {
        "agent": "claude",
        "model": "claude-haiku-5-5",
        "effort": "low"
      }
    },
    {
      "ok": true,
      "order": {
        "agent": "codex",
        "model": "gpt-6-luna",
        "effort": "medium"
      }
    },
    {
      "ok": true,
      "order": {
        "agent": "claude",
        "model": "claude-haiku-5-5",
        "effort": "low"
      }
    },
    {
      "ok": true,
      "order": {
        "agent": "codex",
        "model": "gpt-6-luna",
        "effort": "medium"
      }
    },
    {
      "ok": true,
      "order": {
        "agent": "claude",
        "model": "claude-sonnet-5-5",
        "effort": "medium"
      }
    },
    {
      "ok": true,
      "order": {
        "agent": "codex",
        "model": "gpt-6.1-sol",
        "effort": "medium"
      }
    },
    {
      "ok": true,
      "order": {
        "agent": "claude",
        "model": "claude-sonnet-5-5",
        "effort": "medium"
      }
    },
    {
      "ok": true,
      "order": {
        "agent": "codex",
        "model": "gpt-6.1-sol",
        "effort": "high"
      }
    },
    {
      "ok": true,
      "order": {
        "agent": "claude",
        "model": "claude-opus-5-5",
        "effort": "high"
      }
    },
    {
      "ok": true,
      "order": {
        "agent": "codex",
        "model": "gpt-6.1-sol",
        "effort": "medium"
      }
    },
    {
      "ok": true,
      "order": {
        "agent": "claude",
        "model": "claude-sonnet-5-5",
        "effort": "medium"
      }
    },
    {
      "ok": true,
      "order": {
        "agent": "codex",
        "model": "gpt-6.1-sol",
        "effort": "medium"
      }
    },
    {
      "ok": true,
      "order": {
        "agent": "claude",
        "model": "claude-sonnet-5-5",
        "effort": "medium"
      }
    },
    {
      "ok": false,
      "message": "claude fable/high has no equivalent in codex: fable and effort max are not mapped between providers",
      "hint": "Run it on claude as ordered (pin: true, no --agent), or add a pair you trust to \"equivalents\" in your config."
    },
    {
      "ok": false,
      "message": "no codex equivalent for claude unmapped/high",
      "hint": "Add a line under \"equivalents:\" in your config (~/.agentctl/config.yaml):\n  - {claude: \"unmapped/high\", codex: \"<model>/<effort>\"}"
    },
    {
      "ok": false,
      "message": "codex fable/high has no equivalent in claude: fable and effort max are not mapped between providers",
      "hint": "Run it on codex as ordered (pin: true, no --agent), or add a pair you trust to \"equivalents\" in your config."
    },
    {
      "ok": false,
      "message": "no claude equivalent for codex unmapped/high",
      "hint": "Add a line under \"equivalents:\" in your config (~/.agentctl/config.yaml):\n  - {claude: \"<model>/<effort>\", codex: \"unmapped/high\"}"
    }
  ],
  "labels": [
    {
      "model": "default",
      "label": "– –"
    },
    {
      "model": "default",
      "effort": "low",
      "label": "– LO"
    },
    {
      "model": "default",
      "effort": "medium",
      "label": "– MD"
    },
    {
      "model": "default",
      "effort": "high",
      "label": "– HI"
    },
    {
      "model": "default",
      "effort": "xhigh",
      "label": "– XH"
    },
    {
      "model": "default",
      "effort": "max",
      "label": "– MX"
    },
    {
      "model": "",
      "label": "– –"
    },
    {
      "model": "",
      "effort": "low",
      "label": "– LO"
    },
    {
      "model": "",
      "effort": "medium",
      "label": "– MD"
    },
    {
      "model": "",
      "effort": "high",
      "label": "– HI"
    },
    {
      "model": "",
      "effort": "xhigh",
      "label": "– XH"
    },
    {
      "model": "",
      "effort": "max",
      "label": "– MX"
    },
    {
      "model": "unknown",
      "label": "– –"
    },
    {
      "model": "unknown",
      "effort": "low",
      "label": "– LO"
    },
    {
      "model": "unknown",
      "effort": "medium",
      "label": "– MD"
    },
    {
      "model": "unknown",
      "effort": "high",
      "label": "– HI"
    },
    {
      "model": "unknown",
      "effort": "xhigh",
      "label": "– XH"
    },
    {
      "model": "unknown",
      "effort": "max",
      "label": "– MX"
    },
    {
      "model": "opus",
      "label": "O 5.5 –"
    },
    {
      "model": "opus",
      "effort": "low",
      "label": "O 5.5 LO"
    },
    {
      "model": "opus",
      "effort": "medium",
      "label": "O 5.5 MD"
    },
    {
      "model": "opus",
      "effort": "high",
      "label": "O 5.5 HI"
    },
    {
      "model": "opus",
      "effort": "xhigh",
      "label": "O 5.5 XH"
    },
    {
      "model": "opus",
      "effort": "max",
      "label": "O 5.5 MX"
    },
    {
      "model": "claude-sonnet-5-5-20261001",
      "label": "S 5.5 –"
    },
    {
      "model": "claude-sonnet-5-5-20261001",
      "effort": "low",
      "label": "S 5.5 LO"
    },
    {
      "model": "claude-sonnet-5-5-20261001",
      "effort": "medium",
      "label": "S 5.5 MD"
    },
    {
      "model": "claude-sonnet-5-5-20261001",
      "effort": "high",
      "label": "S 5.5 HI"
    },
    {
      "model": "claude-sonnet-5-5-20261001",
      "effort": "xhigh",
      "label": "S 5.5 XH"
    },
    {
      "model": "claude-sonnet-5-5-20261001",
      "effort": "max",
      "label": "S 5.5 MX"
    },
    {
      "model": "gpt-6.1-sol",
      "label": "S 6.1 –"
    },
    {
      "model": "gpt-6.1-sol",
      "effort": "low",
      "label": "S 6.1 LO"
    },
    {
      "model": "gpt-6.1-sol",
      "effort": "medium",
      "label": "S 6.1 MD"
    },
    {
      "model": "gpt-6.1-sol",
      "effort": "high",
      "label": "S 6.1 HI"
    },
    {
      "model": "gpt-6.1-sol",
      "effort": "xhigh",
      "label": "S 6.1 XH"
    },
    {
      "model": "gpt-6.1-sol",
      "effort": "max",
      "label": "S 6.1 MX"
    },
    {
      "model": "haiku",
      "label": "H 5.1 –"
    },
    {
      "model": "haiku",
      "effort": "low",
      "label": "H 5.1 LO"
    },
    {
      "model": "haiku",
      "effort": "medium",
      "label": "H 5.1 MD"
    },
    {
      "model": "haiku",
      "effort": "high",
      "label": "H 5.1 HI"
    },
    {
      "model": "haiku",
      "effort": "xhigh",
      "label": "H 5.1 XH"
    },
    {
      "model": "haiku",
      "effort": "max",
      "label": "H 5.1 MX"
    },
    {
      "model": "gpt-6-astra",
      "label": "A 6 –"
    },
    {
      "model": "gpt-6-astra",
      "effort": "low",
      "label": "A 6 LO"
    },
    {
      "model": "gpt-6-astra",
      "effort": "medium",
      "label": "A 6 MD"
    },
    {
      "model": "gpt-6-astra",
      "effort": "high",
      "label": "A 6 HI"
    },
    {
      "model": "gpt-6-astra",
      "effort": "xhigh",
      "label": "A 6 XH"
    },
    {
      "model": "gpt-6-astra",
      "effort": "max",
      "label": "A 6 MX"
    },
    {
      "model": "other-model",
      "label": "M –"
    },
    {
      "model": "other-model",
      "effort": "low",
      "label": "M LO"
    },
    {
      "model": "other-model",
      "effort": "medium",
      "label": "M MD"
    },
    {
      "model": "other-model",
      "effort": "high",
      "label": "M HI"
    },
    {
      "model": "other-model",
      "effort": "xhigh",
      "label": "M XH"
    },
    {
      "model": "other-model",
      "effort": "max",
      "label": "M MX"
    }
  ],
  "providers": [
    "cl",
    "cx",
    "ge"
  ],
  "plans": {
    "claude": {
      "provider": "claude",
      "available": true,
      "readAt": 1793534340000,
      "planType": null,
      "windows": [
        {
          "kind": "session",
          "minutes": 300,
          "label": "5h",
          "usedPercent": 83,
          "resetsAt": 1793541600000
        },
        {
          "kind": "week",
          "minutes": 10080,
          "label": "week",
          "usedPercent": 62,
          "resetsAt": 1793800800000
        }
      ],
      "maxPercent": 83,
      "note": "",
      "stale": false,
      "source": "claude-statusline"
    },
    "codex": {
      "provider": "codex",
      "available": true,
      "readAt": 1793602830000,
      "planType": "prolite",
      "windows": [
        {
          "kind": "session",
          "minutes": 300,
          "label": "5h",
          "usedPercent": 12,
          "resetsAt": 1793538000000
        },
        {
          "kind": "week",
          "minutes": 10080,
          "label": "week",
          "usedPercent": 18,
          "resetsAt": 1793883600000
        }
      ],
      "maxPercent": 18,
      "note": "",
      "stale": false,
      "source": "codex-session-log"
    }
  },
  "texts": {
    "statusLine": "C 83% · X 18%",
    "hints": [
      "claude blisko limitu (83%), codex ma zapas (18%)",
      null
    ],
    "alerts": [
      "Claude: 83% limitu 5h (reset 14:00) – blisko limitu; codex ma zapas (18%)"
    ],
    "limits": [
      "GOLD-1: claude wyczerpał limit użycia – agentctl move GOLD-1 przeniesie zadanie na codex",
      "GOLD-1: claude wyczerpał limit użycia (zadanie przypięte – pin: true – move go nie przeniesie)",
      "GOLD-1: codex wyczerpał limit użycia – agentctl move GOLD-1 przeniesie zadanie na claude",
      "GOLD-1: codex wyczerpał limit użycia (zadanie przypięte – pin: true – move go nie przeniesie)"
    ]
  },
  "counts": [
    {
      "message": "give a provider, e.g. claude=1",
      "hint": "The providers are claude and codex."
    },
    {
      "message": "\"gemini=1\" is not claude=N or codex=N",
      "hint": "The providers are claude and codex."
    },
    {
      "message": "claude=0: the number must be 1 or more"
    },
    {
      "claude": 2,
      "codex": 3
    },
    {}
  ],
  "specs": [
    {
      "message": "Spec #1 (BAD-1) is invalid:\n  - agent must be one of claude, codex (got \"gemini\")",
      "hint": "Run \"agentctl spec example\" to see the format."
    },
    {
      "message": "Spec #1 (BAD-1) is invalid:\n  - remote_control: true works for Claude only (Codex has no Remote Control); drop the key or use agent: claude",
      "hint": "Run \"agentctl spec example\" to see the format."
    },
    {
      "message": "Spec #1 (BAD-1) is invalid:\n  - remote_control must be true or false",
      "hint": "Run \"agentctl spec example\" to see the format."
    }
  ],
  "orders": [
    {
      "review": {
        "order": {
          "agent": "codex",
          "model": "gpt-6.1-sol",
          "effort": "high"
        },
        "rule": "different provider"
      },
      "move": {
        "from": {
          "task": "GOLD-claude",
          "window": "gold-claude",
          "session": "agentctl",
          "agent": "claude",
          "model": "claude-opus-5-5",
          "effort": "high",
          "repos": [
            {
              "path": "<ROOT>/app",
              "worktree": "<ROOT>/wt/task"
            }
          ],
          "links": [],
          "env": {},
          "report": "<ROOT>/cache/gold-claude/GOLD-claude.md",
          "started": "2026-10-31T11:00:00.000Z",
          "requested": {
            "agent": "claude",
            "model": "opus",
            "effort": "high"
          },
          "turnEndedAt": "2026-11-01T12:00:00.000Z"
        },
        "to": {
          "agent": "codex",
          "model": "gpt-6.1-sol",
          "effort": "high"
        },
        "task": "GOLD-claude-2",
        "window": "gold-claude-2",
        "prompt": "Do GOLD-claude.\n\nPoprzedni agent (claude claude-opus-5-5) przerwał przez limit. Kontynuuj od bieżącego stanu worktree: przeczytaj git log i git diff względem bazy, nie powtarzaj zrobionej pracy. Raport zapisz do <ROOT>/cache/gold-claude/GOLD-claude.md."
      }
    },
    {
      "review": {
        "order": {
          "agent": "claude",
          "model": "claude-sonnet-5-5",
          "effort": "medium"
        },
        "rule": "different provider"
      },
      "move": {
        "from": {
          "task": "GOLD-codex",
          "window": "gold-codex",
          "session": "agentctl",
          "agent": "codex",
          "model": "gpt-6.1-sol",
          "effort": "medium",
          "repos": [
            {
              "path": "<ROOT>/app",
              "worktree": "<ROOT>/wt/task"
            }
          ],
          "links": [],
          "env": {},
          "report": "<ROOT>/cache/gold-codex/GOLD-codex.md",
          "started": "2026-10-31T11:00:00.000Z",
          "requested": {
            "agent": "claude",
            "model": "opus",
            "effort": "high"
          },
          "turnEndedAt": "2026-11-01T12:00:00.000Z"
        },
        "to": {
          "agent": "claude",
          "model": "claude-sonnet-5-5",
          "effort": "medium"
        },
        "task": "GOLD-codex-2",
        "window": "gold-codex-2",
        "prompt": "Do GOLD-codex.\n\nPoprzedni agent (codex gpt-6.1-sol) przerwał przez limit. Kontynuuj od bieżącego stanu worktree: przeczytaj git log i git diff względem bazy, nie powtarzaj zrobionej pracy. Raport zapisz do <ROOT>/cache/gold-codex/GOLD-codex.md."
      }
    }
  ]
}

it("preserves the complete two-provider 0.17.4 contract", async () => {
  assert.deepEqual(await capture(), GOLDEN);
});
