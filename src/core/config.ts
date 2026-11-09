import { get as providerValue } from './providers/registry.ts';
import type { ProviderValues } from './providers/registry.ts';
import { activeProviders, perProvider } from './providers/registry.ts';
import { defaultSettings } from './providers/settings.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { defaultEquivalents, parseEquivalents } from './equivalents.ts';
import type { Equivalent } from './equivalents.ts';
import { DEFAULT_WINDOW_ICONS, TASK_STATES } from './icons.ts';
import { findAutoAcceptFlag } from './safety.ts';
import type { TaskState } from './state.ts';
import { AgentctlError, Problems, errorMessage, expandHome, isObject, resolvePath } from './util.ts';

import { PROVIDER_IDS, DEFAULT_PROVIDERS } from './providers/types.ts';
import type { ProviderId } from './providers/types.ts';
export const AGENT_NAMES = PROVIDER_IDS;
export type AgentName = ProviderId;
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export interface Link {
  from: string;
  to: string;
}

export interface Defaults {
  agent?: AgentName;
  model?: string;
  effort?: Effort;
  /** `defaults.remote_control: true`: Claude tasks start with `--remote-control <TASK>` unless the spec says otherwise. */
  remoteControl?: boolean;
}

/** The part of the configuration that exists in every layer (global, project, spec). Values are unexpanded. */
export interface ReviewSettings {
  default?: 'auto' | false;
  prefer?: AgentName[];
  agent?: AgentName;
  model?: string;
  effort?: Effort;
  promptTemplate?: string;
  rerun?: boolean;
}

export interface Layer {
  review?: ReviewSettings;
  /** Project guide overlay, relative to the repository or starting with ~. */
  guide?: string;
  worktreeRoot?: string;
  links: Link[];
  env: Record<string, string>;
  report?: string;
  /** More places the report may be (paths and globs, absolute or relative to the worktree): `report: [canonical, other, ...]`. */
  reportAlt?: string[];
  /** Shell commands run in the first worktree after `git worktree add`, before the links. Unset: inherit from the layer below. */
  setup?: string[];
  defaults: Defaults;
}

export interface AgentSettings {
  env?: Record<string, string>;
  /** Extra flags appended to the agent command line. */
  flags: string[];
  acceptsBusyPrompt?: boolean;
  /** Flags that carry the effort level; `{effort}` is replaced. */
  effortArgs: string[];
  /** Regex matched against the tmux screen to decide the agent is ready for input. */
  readyPattern: string;
  /** Seconds to wait for readyPattern. */
  readyTimeout: number;
  /** Seconds `new` waits for a human to answer the folder-trust dialog. */
  trustTimeout: number;
  /** Regex: the agent shows its "trust this folder?" dialog. agentctl never answers it. */
  trustPattern: string;
  /** Regex: the agent shows another startup dialog a human must answer (Codex "Update available"). agentctl never answers it. */
  dialogPattern?: string;
  /** Regex: the agent is busy with a turn. */
  workingPattern: string;
  /** Regex: adapter output acknowledges a submitted prompt (not the composer). */
  deliveryPattern: string;
  /** tmux key name that interrupts the current turn. */
  interruptKey: string;
  /** Regexes for TUI chrome (shortcut hints, mode and warning lines, empty input prompts). `status` skips these lines when it shows the last line. */
  footerPatterns: string[];
  /** Regex: the agent asks the user a question and waits for the answer (state needs-input). */
  questionPattern: string;
  /**
   * Regex: an asynchronous question the agent is NOT waiting on while its turn runs (Codex's collapsed "? N question ·
   * … to answer" footer of request_user_input_async). Counts as needs-input only when the agent is not working.
   */
  asyncQuestionPattern?: string;
  approvalPattern?: string;
  idleRequiresInput?: boolean;
  /** Regexes (any one matches a line of the screen): the agent says its usage limit is used up or it is rate limited (state limited). */
  limitPatterns: string[];
  /**
   * Regexes (any one matches a line of the screen): the agent waits for its own background work ("1 shell, 6 monitors still running").
   * It ends its turn every few minutes meanwhile; that is state `background`, not `waiting`, and the end of turn is not announced.
   */
  backgroundPatterns: string[];
  overloadPatterns: string[];
}

export interface GlobalConfig extends Layer {
  providers: ProviderId[];
  warnings?: string[];
  /** Absolute path of the directory that holds per-task cache folders: only the reports the agents write. */
  cache: string;
  /** Where agentctl keeps its own state per task (`<stateDir>/<window>/TASK.md`, setup.log, markers), out of reach of the agents. */
  stateDir: string;
  session: string;
  ui?: { instanceName?: string };
  tmux?: { socket?: string };
  /** Seconds watch allows for asynchronous prompt acknowledgement. */
  deliveryConfirmS: number;
  /** Max simultaneous windows per provider (agent). Missing or 0 = unlimited; `off` = the provider is disabled. */
  limits: Partial<Record<AgentName, number | 'off'>> & { heavy?: number };
  /** `limits.count_external`: claude/codex terminal sessions outside agentctl's windows count against the limit (detected with ps). */
  countExternal: boolean;
  countReportReady: boolean;
  preview: { ttlS: number };
  agents: Record<AgentName, AgentSettings>;
  /** Claude<->Codex pairs: your `equivalents` first, then the built-in table. */
  equivalents: Equivalent[];
  /** When set, reports and status.json are copied here by status/pull. */
  mirrorDir?: string;
  /**
   * `agentctl watch`: poll interval, how long an idle task may wait before it is worth a notification, and the state icons
   * in front of the tmux window names (`null`: the windows keep their plain names).
   */
  watch: { idleConfirmTicks: number; interval: number; waitingAfter: number; windowIcons: Record<TaskState, string> | null; statusLine: boolean };
  /** Notifications: events from the agents themselves, what a click on a notification does, the verdict line of a report. */
  notify: NotifySettings;
  /** Away mode: when the phone gets notifications. */
  away: AwaySettings;
  /** The dispatcher session (`agentctl manager`): a Claude Code session with Remote Control and the agentctl MCP, for the phone. */
  manager: ManagerSettings;
  /** The board: what finishes up in the "Finished" section and what hides by itself. */
  board: BoardSettings;
  /** The local MCP server (`agentctl mcp`): which write tools the chat may call. Read tools are always there. */
  mcp: McpSettings;
  /** The task queue: tasks that wait for a free window of their provider and start by themselves (`agentctl queue`). */
  queue: QueueSettings;
  reportSettleS: number;
  cleanWorktreeCache: boolean;
  cohort: { doneGraceS: number };
  limited: { autoResume: boolean; resumeAbovePercent: number; message: string };
  overload: { autoRetry: boolean; retryAfter: number; maxRetries: number; giveUpAfter: number; resetAfterS: number; message: string };
  /** Collision warnings: two active tasks of one repository changing the same files. */
  collisions: CollisionSettings;
  /** `agentctl cancel`: how it stops a task that is in the middle of a turn. */
  cancel: CancelSettings;
  /** Token usage and plan limits: warning thresholds, the hold of the queue, the tmux status line, where the agents keep their logs. */
  usage: UsageSettings;
  guideLang: 'en' | 'pl';
  disk: { worktreeSharePercent: number; warnGb: number; criticalGb: number; workers: number; measurementTimeoutS: number };
  git: { timeoutS: number };
  capacity: { loadThreshold?: number; snapshot: boolean; staleMinutes: number; sampleLimit: number; thresholds: number[]; codexRefresh: boolean; claudeUsageProbe: boolean; claudeUsageProbeIntervalMinutes: number; kimiUsageProbe?: boolean; kimiUsageProbeModel?: string };
  /** Set by a long-running process (watch, MCP) when the file on disk does not load and the previous settings stay in force. */
  reloadWarning?: string;
  /** Where the config was (or would be) read from. */
  path: string;
  loaded: boolean;
}

/** Channels of a desktop notification: `auto` tries terminal-notifier (clickable) and falls back to osascript when it fails. */
export const NOTIFY_BACKENDS = ['auto', 'terminal-notifier', 'osascript'] as const;
export type NotifyBackend = (typeof NOTIFY_BACKENDS)[number];

/** Write tools of the MCP server; each one must be listed in `mcp.allow` to work. */
export const MCP_WRITE_TOOLS = ['send', 'answer', 'new', 'interrupt', 'close', 'move', 'queue', 'queue_rm', 'cancel', 'mark', 'set_limits', 'reserve', 'resume', 'away', 'queue_retry', 'queue_up', 'queue_pause', 'queue_resume', 'unblock', 'cohort_add', 'cohort_remove', 'cohort_note', 'cohort_archive', 'hide', 'unhide', 'archive', 'adopt', 'report_from', 'limits_release', 'manager_start', 'manager_stop', 'notify_test', 'gc'] as const;
export type McpWriteTool = (typeof MCP_WRITE_TOOLS)[number];
/** Permissions of `mcp.allow` that are not a tool of their own: `send_enter` lets `send` with `enter_only` press Enter for the text that a send left in an input field (it does not allow pasting). */
export const MCP_EXTRA_PERMISSIONS = ['send_enter'] as const;
export type McpPermission = McpWriteTool | (typeof MCP_EXTRA_PERMISSIONS)[number];

/** Explicit group names avoid broadening existing single-tool permissions. */
export const MCP_ALLOW_GROUPS: Record<string, readonly McpWriteTool[]> = {
  'queue:*': ['queue', 'queue_rm', 'queue_retry', 'queue_up', 'queue_pause', 'queue_resume'],
  cohort: ['cohort_add', 'cohort_remove', 'cohort_note', 'cohort_archive'],
  'manager:*': ['manager_start', 'manager_stop'],
};

export interface BoardSettings {
  modelVersions: Record<string, string>;
  /** The board names its terminal window "<instance> <version> · board" (OSC 2) and the agentctl tmux session titles the outer terminal (this session only). */
  windowTitle: boolean;
  /** How many of the most recently active cohorts the board's `k` choice lists; older quiet ones fold into "starsze…". */
  cohortsRecent: number;
  listWidth?: number | string;
  /** A task without a window whose report was pulled hides by itself (a task without a report stays in "Finished"). */
  autoHidePulledDead: boolean;
  /** `mouse on` in the agentctl tmux session (this session only): click a window name in the status bar. Selecting text then takes the fn key in Terminal.app. */
  mouse: boolean;
  /** tmux key (no prefix) that goes back to the board from any window of the agentctl session; null: no key is bound. Default F12. */
  returnKey: string | null;
  /** Color used on non-status cells of the selected board row. */
  selectedColor: string;
}

export interface QueueSettings {
  /** `false`: `watch` never starts a queued task (entries can still be added and listed). */
  enabled: boolean;
  /** Most queued tasks that `watch` has in the middle of starting (worktree, setup, waiting for the agent) at the same time. */
  parallelStarts: number;
}

export interface CancelSettings {
  /** Seconds between the interrupt key and the closing of the window of a task that is cancelled while it works (0: close at once). */
  grace: number;
}

export interface UsageSettings {
  /** Percent of a plan window (per provider) from which `watch` warns, once per window. */
  warn: ProviderValues<number>;
  /** Percent from which it warns again, louder. */
  critical: ProviderValues<number>;
  /** Percent above which the queue does not start a task of that provider by itself. A provider missing here is never held. */
  queueHold: Partial<Record<AgentName, number>>;
  /** The plan percentages in the tmux status line ("C 62% · X 18%"). */
  statusLine: boolean;
  /** `new` wires a statusLine command into Claude windows that records the plan's rate_limits (and runs the user's own statusLine after it). */
  claudeTap: boolean;
  /** Claude's config directory (holds `projects/`); null: `$CLAUDE_CONFIG_DIR`, else ~/.claude. */
  claudeDir: string | null;
  /** Codex's home (holds `sessions/`); null: `$CODEX_HOME`, else ~/.codex. */
  codexDir: string | null;
  kimiDir?: string | null;
}

export interface CollisionSettings {
  /** `false`: no collision column, no marker on the board, no notification (`agentctl overlap` still works). */
  enabled: boolean;
  /** Seconds between two collision checks by `watch` (git is asked for the changed files of every active task). */
  interval: number;
  /** One notification per new pair of colliding tasks. */
  notify: boolean;
  /** Globs of paths that never count (lock files, generated files). */
  ignore: string[];
}

export interface McpSettings {
  maxResponseKb: number;
  client?: string;
  /** Write tools the chat may call; empty (the default): the server only reads. */
  allow: McpPermission[];
  /** `close` and `cancel` may also remove the git worktree (never with --force, never the main checkout). */
  allowRmWorktree: boolean;
  /**
   * What is wrong with the `mcp` section and was ignored (an unknown tool name in `allow` from a newer or older version, an unknown key, a
   * wrong type). The server still runs; `status` and `doctor` show these. Only a config that cannot be read at all stops it.
   */
  warnings: string[];
}

export interface NotifySettings {
  /** Which channel sends notifications; default `auto`. */
  backend: NotifyBackend;
  mcpWrites?: 'all' | 'summary' | 'off';
  mcpWritesIntervalS?: number;
  /** Hooks (Claude) and `-c notify=…` (Codex) report the agents' own events to `agentctl event`. `false`: screen reading only. */
  events: boolean;
  /** A notification when a turn ends and the agent waits (not only for questions, reports and limits). */
  turnEnd: boolean;
  /** Bundle ID of the terminal app that a click on a notification brings to the front; unset: detected from the environment. */
  terminalApp?: string;
  /** Regex for the report line that goes into the "report ready" notification; unset: a "Werdykt/Verdict/Status" line, else the first line of the text. */
  verdictPattern?: string;
  /** Notifications to a phone through ntfy; unset: none. */
  ntfy?: NtfySettings;
}

/** Events that can go to the phone (`notify.ntfy.events`). */
export const PHONE_EVENTS = ['disk-warn', 'disk-critical', 'disk-ok', 'needs-input', 'needs-trust', 'overloaded', 'limited', 'blocked', 'report-ready', 'cohort-done', 'queue-failed', 'orphan', 'dead', 'usage-critical'] as const;
export type PhoneEvent = (typeof PHONE_EVENTS)[number];

/** ntfy priorities by name (1..5). */
export const NTFY_PRIORITIES = ['min', 'low', 'default', 'high', 'urgent'] as const;
export type NtfyPriority = (typeof NTFY_PRIORITIES)[number];

export const DEFAULT_NTFY_SERVER = 'https://ntfy.sh';

export const DEFAULT_NTFY_PRIORITY: Record<PhoneEvent, NtfyPriority> = {
  'disk-warn': 'default',
  'disk-critical': 'high',
  'disk-ok': 'default',
  'needs-input': 'high',
  'needs-trust': 'default',
  overloaded: 'high',
  limited: 'high',
  blocked: 'default',
  'report-ready': 'default',
  'cohort-done': 'default',
  'queue-failed': 'default',
  orphan: 'default',
  dead: 'default',
  'usage-critical': 'high',
};

export interface NtfySettings {
  /** Base URL of the ntfy server. */
  server: string;
  /** The topic; the phone subscribes to it. Unset: nothing is sent (`agentctl ntfy-setup` makes one). */
  topic?: string;
  /** Bearer token for a private server or an account. */
  token?: string;
  /** Which events are sent. */
  events: PhoneEvent[];
  priority: Record<PhoneEvent, NtfyPriority>;
  /** The first line of the verdict goes into "report ready" (never more of the report). */
  includeVerdict: boolean;
  /** Send question text to the phone; false keeps work content local. */
  includeQuestion: boolean;
  /** Link opened by a tap on the notification. */
  clickUrl?: string;
  /** Send always, not only while `agentctl away` is on. */
  always: boolean;
}

/** `away`: the phone gets the notifications only while away. */
export interface AwaySettings {
  /** Minutes without keyboard or mouse after which the Mac counts as away (macOS, HIDIdleTime); null: only `agentctl away on|off`. */
  autoIdle: number | null;
}

/** `manager`: the Claude Code session you talk to from the Claude app on the phone. */
export interface ManagerSettings {
  /** The directory the session runs in (absolute); null: the directory `agentctl manager` is run in. */
  project: string | null;
  /** The name of the session in the Claude app (`claude --remote-control <name>`) and of its Remote Control entry. */
  name: string;
  model: string;
  effort: Effort;
  /** A file with the rules for writing specs (a local copy of claude/AGENTCTL-SPEC-GUIDE), appended to the role of the manager; null: none. */
  guide: string | null;
  /** `agentctl up` starts the manager as well. */
  autostart: boolean;
}

export const DEFAULT_MANAGER_NAME = 'agentctl manager';

export const DEFAULT_AGENT_SETTINGS = Object.fromEntries(DEFAULT_PROVIDERS.map(id => [id, defaultSettings(id)])) as Record<ProviderId, AgentSettings>;

/** The keys accepted in every layer: the global config, `.agentctl.yaml` and (with a few of its own) a spec. docs/configuration.md describes each one. */
export const LAYER_KEYS = ['worktree_root', 'links', 'env', 'report', 'setup', 'defaults', 'guide', 'review'];
export const GLOBAL_KEYS = [...LAYER_KEYS, 'overload', 'limited', 'cache', 'state_dir', 'session', 'ui', 'tmux', 'limits', 'agents', 'equivalents', 'mirror_dir', 'watch', 'notify', 'board', 'mcp', 'queue', 'collisions', 'cancel', 'usage', 'away', 'manager', 'capacity', 'disk', 'git', 'cohort', 'delivery_confirm_s', 'preview', 'providers'];
export const LIMITS_KEYS = [...AGENT_NAMES, 'count_external', 'count_report_ready', 'heavy'];
export const DEFAULTS_KEYS = ['agent', 'model', 'effort', 'remote_control'];
export const LINK_KEYS = ['from', 'to'];
export const AGENT_KEYS = ['env', 'accepts_busy_prompt', 'flags', 'effort_args', 'ready_pattern', 'ready_timeout', 'trust_timeout', 'trust_pattern', 'dialog_pattern', 'working_pattern', 'delivery_pattern', 'interrupt_key', 'footer_patterns', 'question_pattern', 'async_question_pattern', 'approval_pattern', 'limit_patterns', 'background_patterns', 'overload_patterns'];
export const WATCH_KEYS = ['interval', 'waiting_after', 'window_icons', 'status_line', 'idle_confirm_ticks'];
export const NOTIFY_KEYS = ['backend', 'events', 'turn_end', 'terminal_app', 'verdict_pattern', 'ntfy', 'mcp_writes', 'mcp_writes_interval_s'];
export const NTFY_KEYS = ['server', 'topic', 'token', 'events', 'priority', 'include_verdict', 'include_question', 'click_url', 'always'];
export const AWAY_KEYS = ['auto_idle'];
export const MANAGER_KEYS = ['project', 'name', 'model', 'effort', 'guide', 'autostart'];
export const BOARD_KEYS = ['auto_hide_pulled_dead', 'mouse', 'return_key', 'selected_color', 'model_versions', 'list_width', 'window_title', 'cohorts_recent'];
export const MCP_KEYS = ['allow', 'allow_rm_worktree', 'client', 'max_response_kb'];
export const QUEUE_KEYS = ['enabled', 'parallel_starts'];
export const CANCEL_KEYS = ['grace'];
export const USAGE_KEYS = ['warn', 'critical', 'queue_hold', 'status_line', 'claude_tap', ...PROVIDER_IDS.map(id => `${id}_dir`)];
export const COLLISION_KEYS = ['enabled', 'interval', 'notify', 'ignore'];

/** Screen patterns are case-insensitive and match per line. */
export const PATTERN_FLAGS = 'im';

export function checkKeys(obj: Record<string, unknown>, allowed: string[], where: string, p: Problems): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) p.add(`${where}: unknown key "${key}" (allowed: ${allowed.join(', ')})`);
  }
}

function parseString(v: unknown, where: string, p: Problems): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || v.trim() === '') {
    p.add(`${where} must be a non-empty string`);
    return undefined;
  }
  return v;
}

/** `report`: one path, or a list whose first entry is the canonical path and the others are places to look (paths and globs). */
export function parseReportPaths(v: unknown, where: string, p: Problems): string[] {
  if (v === undefined || v === null) return [];
  if (isObject(v)) {
    checkKeys(v, ['path', 'paths', 'settle_s', 'clean_worktree_cache'], where, p);
    return parseReportPaths(v.paths ?? v.path, where, p);
  }
  const list = Array.isArray(v) ? v : [v];
  if (list.length === 0 || list.some((x) => typeof x !== 'string' || x.trim() === '')) {
    p.add(`${where} must be a path, or a list of paths and globs`);
    return [];
  }
  return list as string[];
}

export function parseStringList(v: unknown, where: string, p: Problems): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    p.add(`${where} must be a list of strings`);
    return [];
  }
  return v as string[];
}

export function parseLinks(v: unknown, where: string, p: Problems): Link[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    p.add(`${where} must be a list of {from, to} entries`);
    return [];
  }
  const links: Link[] = [];
  v.forEach((entry, i) => {
    const at = `${where}[${i}]`;
    if (!isObject(entry)) return p.add(`${at} must be a {from, to} mapping`);
    checkKeys(entry, LINK_KEYS, at, p);
    const from = parseString(entry.from, `${at}.from`, p);
    const to = parseString(entry.to, `${at}.to`, p);
    if (!from) p.add(`${at}: "from" is required`);
    if (!to) p.add(`${at}: "to" is required`);
    if (from && to) links.push({ from, to });
  });
  return links;
}

export function parseEnv(v: unknown, where: string, p: Problems): Record<string, string> {
  if (v === undefined || v === null) return {};
  if (!isObject(v)) {
    p.add(`${where} must be a mapping of NAME: value`);
    return {};
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(v)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) p.add(`${where}: "${key}" is not a valid variable name`);
    else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') env[key] = String(value);
    else p.add(`${where}.${key} must be a string, number or boolean`);
  }
  return env;
}

export function parseEnumValue<T extends string>(v: unknown, allowed: readonly T[], where: string, p: Problems): T | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
  p.add(`${where} must be one of ${allowed.join(', ')} (got ${JSON.stringify(v)})`);
  return undefined;
}

function parseDefaults(v: unknown, where: string, p: Problems): Defaults {
  if (v === undefined || v === null) return {};
  if (!isObject(v)) {
    p.add(`${where} must be a mapping`);
    return {};
  }
  checkKeys(v, DEFAULTS_KEYS, where, p);
  const defaults: Defaults = {};
  const agent = parseEnumValue(v.agent, AGENT_NAMES, `${where}.agent`, p);
  const model = parseString(v.model, `${where}.model`, p);
  const effort = parseEnumValue(v.effort, EFFORTS, `${where}.effort`, p);
  if (agent) defaults.agent = agent;
  if (model) defaults.model = model;
  if (effort) defaults.effort = effort;
  if (v.remote_control !== undefined && v.remote_control !== null) {
    if (typeof v.remote_control === 'boolean') defaults.remoteControl = v.remote_control;
    else p.add(`${where}.remote_control must be true or false`);
  }
  return defaults;
}

function parseSetup(v: unknown, where: string, p: Problems): string[] {
  const commands = parseStringList(v, where, p);
  commands.forEach((c, i) => {
    if (c.trim() === '') p.add(`${where}[${i}] is an empty command`);
  });
  return commands;
}

/** Shared review parser for global/project settings and explicit spec orders. */
export function parseReview(value: unknown, where: string, p: Problems): ReviewSettings | undefined {
  if (value === 'auto' || value === true) return { default: 'auto' };
  if (value === false) return { default: false };
  if (!isObject(value)) { p.add(`${where} must be auto, false or a mapping`); return undefined; }
  checkKeys(value, ['default', 'agent', 'model', 'effort', 'prompt_template', 'template', 'rerun', 'prefer'], where, p);
  const review: ReviewSettings = {};
  if (value.prefer !== undefined) {
    if (!Array.isArray(value.prefer) || value.prefer.some(id => !(AGENT_NAMES as readonly unknown[]).includes(id)) || new Set(value.prefer).size !== value.prefer.length) p.add(`${where}.prefer must be a list of distinct registered provider IDs`);
    else review.prefer = [...value.prefer] as AgentName[];
  }
  if (value.default !== undefined) {
    if (value.default === 'auto' || value.default === false) review.default = value.default;
    else p.add(`${where}.default must be auto or false`);
  }
  review.agent = parseEnumValue(value.agent, AGENT_NAMES, `${where}.agent`, p);
  review.effort = parseEnumValue(value.effort, EFFORTS, `${where}.effort`, p);
  if (value.model !== undefined) review.model = parseString(value.model, `${where}.model`, p);
  const template = value.prompt_template ?? value.template;
  if (template !== undefined) review.promptTemplate = parseString(template, `${where}.prompt_template`, p);
  if (value.rerun !== undefined) {
    if (typeof value.rerun === 'boolean') review.rerun = value.rerun;
    else p.add(`${where}.rerun must be boolean`);
  }
  return review;
}

function parseLayer(obj: Record<string, unknown>, where: string, p: Problems): Layer {
  const layer: Layer = {
    links: parseLinks(obj.links, `${where}.links`, p),
    env: parseEnv(obj.env, `${where}.env`, p),
    defaults: parseDefaults(obj.defaults, `${where}.defaults`, p),
  };
  if (typeof obj.guide === 'string') layer.guide = obj.guide;
  else if (obj.guide !== undefined && where !== 'config') p.add(`${where}.guide must be a path`);
  const worktreeRoot = parseString(obj.worktree_root, `${where}.worktree_root`, p);
  const reports = parseReportPaths(obj.report, `${where}.report`, p);
  const report = reports[0];
  if (worktreeRoot) layer.worktreeRoot = worktreeRoot;
  if (report) layer.report = report;
  if (reports.length > 1) layer.reportAlt = reports.slice(1);
  if (obj.setup !== undefined && obj.setup !== null) layer.setup = parseSetup(obj.setup, `${where}.setup`, p);
  if (obj.review !== undefined) layer.review = parseReview(obj.review, `${where}.review`, p);
  return layer;
}

function parseAgentSettings(name: AgentName, v: unknown, where: string, p: Problems): AgentSettings {
  const settings: AgentSettings = defaultSettings(name);
  if (v === undefined || v === null) return settings;
  if (!isObject(v)) {
    p.add(`${where} must be a mapping`);
    return settings;
  }
  checkKeys(v, AGENT_KEYS, where, p);
  if (v.env !== undefined) settings.env = parseEnv(v.env, `${where}.env`, p);
  if (v.accepts_busy_prompt !== undefined) {
    if (typeof v.accepts_busy_prompt === 'boolean') settings.acceptsBusyPrompt = v.accepts_busy_prompt;
    else p.add(`${where}.accepts_busy_prompt must be boolean`);
  }
  if (v.flags !== undefined) settings.flags = parseStringList(v.flags, `${where}.flags`, p);
  if (v.effort_args !== undefined) settings.effortArgs = parseStringList(v.effort_args, `${where}.effort_args`, p);
  for (const [key, list] of [['flags', settings.flags], ['effort_args', settings.effortArgs]] as const) {
    const bad = findAutoAcceptFlag(list, name);
    if (bad) p.add(`${where}.${key}: "${bad}" enables auto-accept, which agentctl never allows`);
  }
  for (const [key, field] of [['ready_pattern', 'readyPattern'], ['trust_pattern', 'trustPattern'], ['dialog_pattern', 'dialogPattern'], ['working_pattern', 'workingPattern'], ['delivery_pattern', 'deliveryPattern'], ['question_pattern', 'questionPattern'], ['async_question_pattern', 'asyncQuestionPattern'], ['approval_pattern', 'approvalPattern']] as const) {
    const pattern = parseString(v[key], `${where}.${key}`, p);
    if (!pattern) continue;
    try {
      new RegExp(pattern, PATTERN_FLAGS);
      settings[field] = pattern;
    } catch (e) {
      p.add(`${where}.${key} is not a valid regular expression: ${errorMessage(e)}`);
    }
  }
  if (v.footer_patterns !== undefined) {
    const list = parseStringList(v.footer_patterns, `${where}.footer_patterns`, p);
    for (const [i, pattern] of list.entries()) {
      try {
        new RegExp(pattern, PATTERN_FLAGS);
      } catch (e) {
        p.add(`${where}.footer_patterns[${i}] is not a valid regular expression: ${errorMessage(e)}`);
      }
    }
    settings.footerPatterns = list;
  }
  if (v.limit_patterns !== undefined) {
    const list = parseStringList(v.limit_patterns, `${where}.limit_patterns`, p);
    for (const [i, pattern] of list.entries()) {
      try {
        new RegExp(pattern, PATTERN_FLAGS);
      } catch (e) {
        p.add(`${where}.limit_patterns[${i}] is not a valid regular expression: ${errorMessage(e)}`);
      }
    }
    settings.limitPatterns = list;
  }
  if (v.overload_patterns !== undefined) {
    settings.overloadPatterns = parseStringList(v.overload_patterns, `${where}.overload_patterns`, p);
    for (const pattern of settings.overloadPatterns) try { new RegExp(pattern, PATTERN_FLAGS); } catch { p.add(`${where}.overload_patterns: invalid regex`); }
  }
  if (v.background_patterns !== undefined) {
    const list = parseStringList(v.background_patterns, `${where}.background_patterns`, p);
    for (const [i, pattern] of list.entries()) {
      try {
        new RegExp(pattern, PATTERN_FLAGS);
      } catch (e) {
        p.add(`${where}.background_patterns[${i}] is not a valid regular expression: ${errorMessage(e)}`);
      }
    }
    settings.backgroundPatterns = list;
  }
  const key = parseString(v.interrupt_key, `${where}.interrupt_key`, p);
  if (key) settings.interruptKey = key;
  if (v.ready_timeout !== undefined) {
    if (typeof v.ready_timeout === 'number' && v.ready_timeout > 0) settings.readyTimeout = v.ready_timeout;
    else p.add(`${where}.ready_timeout must be a positive number of seconds`);
  }
  if (v.trust_timeout !== undefined) {
    if (typeof v.trust_timeout === 'number' && v.trust_timeout > 0) settings.trustTimeout = v.trust_timeout;
    else p.add(`${where}.trust_timeout must be a positive number of seconds`);
  }
  return settings;
}

export const DEFAULT_WATCH = { interval: 15, waitingAfter: 120, idleConfirmTicks: 2 };

/** `true` or absent: the default icons; `false`: none; a mapping: the default icons with those states replaced. */
function parseWindowIcons(v: unknown, p: Problems): GlobalConfig['watch']['windowIcons'] {
  const icons = { ...DEFAULT_WINDOW_ICONS };
  if (v === undefined || v === null || v === true) return icons;
  if (v === false) return null;
  const where = 'config.watch.window_icons';
  if (!isObject(v)) {
    p.add(`${where} must be true, false or a mapping like {working: "⚙", report-ready: "✓"}`);
    return icons;
  }
  checkKeys(v, [...TASK_STATES, 'report-candidate'], where, p); // Accept the obsolete icon key from older configs; candidates are now a flag.
  for (const state of TASK_STATES) {
    const icon = v[state];
    if (icon === undefined) continue;
    if (typeof icon === 'string' && icon.trim() !== '' && !/[\p{Cc}]/u.test(icon)) icons[state] = icon.trim();
    else p.add(`${where}.${state} must be a short text without control characters`);
  }
  return icons;
}

function parseWatch(v: unknown, p: Problems): GlobalConfig['watch'] {
  const watch: GlobalConfig['watch'] = { ...DEFAULT_WATCH, windowIcons: { ...DEFAULT_WINDOW_ICONS }, statusLine: true };
  if (v === undefined || v === null) return watch;
  if (!isObject(v)) {
    p.add('config.watch must be a mapping like {interval: 15, waiting_after: 120}');
    return watch;
  }
  checkKeys(v, WATCH_KEYS, 'config.watch', p);
  if (v.idle_confirm_ticks !== undefined) {
    if (Number.isInteger(v.idle_confirm_ticks) && Number(v.idle_confirm_ticks) >= 1) watch.idleConfirmTicks = Number(v.idle_confirm_ticks);
    else p.add('config.watch.idle_confirm_ticks must be a positive integer');
  }
  watch.windowIcons = parseWindowIcons(v.window_icons, p);
  if (v.status_line !== undefined) {
    if (typeof v.status_line === 'boolean') watch.statusLine = v.status_line;
    else p.add('config.watch.status_line must be true or false');
  }
  for (const [key, field] of [['interval', 'interval'], ['waiting_after', 'waitingAfter']] as const) {
    if (v[key] === undefined) continue;
    if (typeof v[key] === 'number' && v[key] > 0) watch[field] = v[key];
    else p.add(`config.watch.${key} must be a positive number of seconds`);
  }
  return watch;
}

function parseNotify(v: unknown, p: Problems): NotifySettings {
  const notify: NotifySettings = { backend: 'auto', events: true, turnEnd: true, mcpWrites: 'summary', mcpWritesIntervalS: 60 };
  if (v === undefined || v === null) return notify;
  if (!isObject(v)) {
    p.add('config.notify must be a mapping like {terminal_app: com.apple.Terminal, verdict_pattern: "^Verdict:"}');
    return notify;
  }
  checkKeys(v, NOTIFY_KEYS, 'config.notify', p);
  notify.mcpWrites = parseEnumValue(v.mcp_writes, ['all', 'summary', 'off'] as const, 'config.notify.mcp_writes', p) ?? 'summary';
  if (v.mcp_writes_interval_s !== undefined) {
    if (typeof v.mcp_writes_interval_s === 'number' && Number.isFinite(v.mcp_writes_interval_s) && v.mcp_writes_interval_s > 0) notify.mcpWritesIntervalS = v.mcp_writes_interval_s;
    else p.add('config.notify.mcp_writes_interval_s must be positive seconds');
  }
  notify.backend = parseEnumValue(v.backend, NOTIFY_BACKENDS, 'config.notify.backend', p) ?? 'auto';
  for (const [key, field] of [['events', 'events'], ['turn_end', 'turnEnd']] as const) {
    if (v[key] === undefined) continue;
    if (typeof v[key] === 'boolean') notify[field] = v[key];
    else p.add(`config.notify.${key} must be true or false`);
  }
  const app = parseString(v.terminal_app, 'config.notify.terminal_app', p);
  if (app) notify.terminalApp = app;
  const pattern = parseString(v.verdict_pattern, 'config.notify.verdict_pattern', p);
  if (pattern) {
    try {
      new RegExp(pattern, PATTERN_FLAGS);
      notify.verdictPattern = pattern;
    } catch (e) {
      p.add(`config.notify.verdict_pattern is not a valid regular expression: ${errorMessage(e)}`);
    }
  }
  if (v.ntfy !== undefined && v.ntfy !== null) notify.ntfy = parseNtfy(v.ntfy, p);
  return notify;
}

function parseHttpUrl(v: unknown, where: string, p: Problems): string | undefined {
  const s = parseString(v, where, p);
  if (s === undefined) return undefined;
  try {
    const u = new URL(s);
    if (u.protocol === 'http:' || u.protocol === 'https:') return s;
  } catch {
    // reported below
  }
  p.add(`${where} must be an http:// or https:// URL`);
  return undefined;
}

function parseNtfy(v: unknown, p: Problems): NtfySettings {
  const where = 'config.notify.ntfy';
  const ntfy: NtfySettings = { server: DEFAULT_NTFY_SERVER, events: [...PHONE_EVENTS], priority: { ...DEFAULT_NTFY_PRIORITY }, includeVerdict: true, includeQuestion: false, always: false };
  if (!isObject(v)) {
    p.add(`${where} must be a mapping like {topic: agentctl-3f9c…, server: https://ntfy.sh}`);
    return ntfy;
  }
  checkKeys(v, NTFY_KEYS, where, p);
  const server = parseHttpUrl(v.server, `${where}.server`, p);
  if (server) ntfy.server = server.replace(/\/+$/, '');
  const topic = parseString(v.topic, `${where}.topic`, p);
  if (topic) {
    if (/^[A-Za-z0-9_-]{1,64}$/.test(topic)) ntfy.topic = topic;
    else p.add(`${where}.topic may have letters, digits, "_" and "-" only (at most 64)`);
  }
  const token = parseString(v.token, `${where}.token`, p);
  if (token) ntfy.token = token;
  if (v.events !== undefined && v.events !== null) {
    const list = parseStringList(v.events, `${where}.events`, p);
    const bad = list.filter((e) => !(PHONE_EVENTS as readonly string[]).includes(e));
    if (bad.length > 0) p.add(`${where}.events: unknown ${bad.join(', ')} (allowed: ${PHONE_EVENTS.join(', ')})`);
    else ntfy.events = list as PhoneEvent[];
  }
  if (v.priority !== undefined && v.priority !== null) {
    if (!isObject(v.priority)) p.add(`${where}.priority must be a mapping like {report-ready: low}`);
    else {
      checkKeys(v.priority, [...PHONE_EVENTS], `${where}.priority`, p);
      for (const event of PHONE_EVENTS) {
        const level = parseEnumValue(v.priority[event], NTFY_PRIORITIES, `${where}.priority.${event}`, p);
        if (level) ntfy.priority[event] = level;
      }
    }
  }
  for (const [key, field] of [['include_verdict', 'includeVerdict'], ['include_question', 'includeQuestion'], ['always', 'always']] as const) {
    if (v[key] === undefined) continue;
    if (typeof v[key] === 'boolean') ntfy[field] = v[key];
    else p.add(`${where}.${key} must be true or false`);
  }
  const click = parseHttpUrl(v.click_url, `${where}.click_url`, p);
  if (click) ntfy.clickUrl = click;
  return ntfy;
}

function parseAway(v: unknown, p: Problems): AwaySettings {
  const away: AwaySettings = { autoIdle: null };
  if (v === undefined || v === null) return away;
  if (!isObject(v)) {
    p.add('config.away must be a mapping like {auto_idle: 15}');
    return away;
  }
  checkKeys(v, AWAY_KEYS, 'config.away', p);
  if (v.auto_idle !== undefined && v.auto_idle !== null) {
    if (typeof v.auto_idle === 'number' && v.auto_idle > 0) away.autoIdle = v.auto_idle;
    else p.add('config.away.auto_idle must be a positive number of minutes');
  }
  return away;
}

function parseManager(v: unknown, p: Problems): ManagerSettings {
  const manager: ManagerSettings = { project: null, name: DEFAULT_MANAGER_NAME, model: 'sonnet', effort: 'medium', guide: null, autostart: false };
  if (v === undefined || v === null) return manager;
  if (!isObject(v)) {
    p.add('config.manager must be a mapping like {project: ~/src/sample-app, model: sonnet}');
    return manager;
  }
  checkKeys(v, MANAGER_KEYS, 'config.manager', p);
  const project = parseString(v.project, 'config.manager.project', p);
  if (project) manager.project = resolvePath(project);
  const name = parseString(v.name, 'config.manager.name', p);
  if (name) {
    if (/[\r\n]/.test(name) || name.length > 80) p.add('config.manager.name must be one line of at most 80 characters');
    else manager.name = name.trim();
  }
  const model = parseString(v.model, 'config.manager.model', p);
  if (model) manager.model = model;
  const effort = parseEnumValue(v.effort, EFFORTS, 'config.manager.effort', p);
  if (effort) manager.effort = effort;
  const guide = parseString(v.guide, 'config.manager.guide', p);
  if (guide) manager.guide = resolvePath(guide);
  if (v.autostart !== undefined && v.autostart !== null) {
    if (typeof v.autostart === 'boolean') manager.autostart = v.autostart;
    else p.add('config.manager.autostart must be true or false');
  }
  return manager;
}

function parseBoard(v: unknown, p: Problems): BoardSettings {
  const board: BoardSettings = { autoHidePulledDead: true, mouse: true, returnKey: 'F12', selectedColor: 'blue', modelVersions: {}, windowTitle: true, cohortsRecent: 10 };
  if (v === undefined || v === null) return board;
  if (!isObject(v)) {
    p.add('config.board must be a mapping like {auto_hide_pulled_dead: true, mouse: true, return_key: F12}');
    return board;
  }
  checkKeys(v, BOARD_KEYS, 'config.board', p);
  if (v.model_versions !== undefined) {
    if (isObject(v.model_versions) && Object.entries(v.model_versions).every(([k, n]) => /^[a-z0-9._-]+$/i.test(k) && typeof n === 'string' && /^\d+(?:\.\d+)*$/.test(n))) board.modelVersions = Object.fromEntries(Object.entries(v.model_versions).map(([k, n]) => [k.toLowerCase(), n as string]));
    else p.add('config.board.model_versions must map model aliases to quoted numeric versions, e.g. {sonnet: "5.5"}');
  }
  if (v.list_width !== undefined) {
    if ((typeof v.list_width === 'number' && Number.isInteger(v.list_width) && v.list_width >= 64) || (typeof v.list_width === 'string' && /^(?:[1-9]\d?|100)%$/.test(v.list_width))) board.listWidth = v.list_width;
    else p.add('config.board.list_width must be an integer >= 64 columns or a percentage such as "45%"');
  }
  if (v.window_title !== undefined) {
    if (typeof v.window_title === 'boolean') board.windowTitle = v.window_title;
    else p.add('config.board.window_title must be true or false');
  }
  if (v.cohorts_recent !== undefined) {
    if (typeof v.cohorts_recent === 'number' && Number.isInteger(v.cohorts_recent) && v.cohorts_recent >= 1) board.cohortsRecent = v.cohorts_recent;
    else p.add('config.board.cohorts_recent must be a positive integer');
  }
  if (v.mouse !== undefined) {
    if (typeof v.mouse === 'boolean') board.mouse = v.mouse;
    else p.add('config.board.mouse must be true or false');
  }
  if (v.return_key !== undefined) {
    if (v.return_key === false || v.return_key === null) board.returnKey = null;
    else if (typeof v.return_key === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,19}$/.test(v.return_key)) board.returnKey = v.return_key;
    else p.add('config.board.return_key must be a tmux key name without a prefix like F12, M-b or C-Space, or false for none');
  }
  if (v.auto_hide_pulled_dead !== undefined) {
    if (typeof v.auto_hide_pulled_dead === 'boolean') board.autoHidePulledDead = v.auto_hide_pulled_dead;
    else p.add('config.board.auto_hide_pulled_dead must be true or false');
  }
  if (v.selected_color !== undefined) {
    const colors = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'gray', 'grey', 'blackBright', 'redBright', 'greenBright', 'yellowBright', 'blueBright', 'magentaBright', 'cyanBright', 'whiteBright'];
    if (typeof v.selected_color === 'string' && colors.includes(v.selected_color)) board.selectedColor = v.selected_color;
    else p.add(`config.board.selected_color must be an Ink color name (${colors.join(', ')})`);
  }
  return board;
}

/**
 * The `mcp` section is read leniently: a problem in it must not take the whole server down (a config written for another version
 * of agentctl names tools this one does not know). The offending entry is ignored and said so in `warnings`.
 */
function parseMcp(v: unknown): McpSettings {
  const mcp: McpSettings = { maxResponseKb: 8, allow: [], allowRmWorktree: false, warnings: [] };
  if (v === undefined || v === null) return mcp;
  if (!isObject(v)) {
    mcp.warnings.push(`config.mcp must be a mapping like {allow: [${MCP_WRITE_TOOLS.join(', ')}]}: ignored, writing is off`);
    return mcp;
  }
  const q = new Problems();
  checkKeys(v, MCP_KEYS, 'config.mcp', q);
  if (v.client !== undefined) { if (typeof v.client === 'string' && v.client.trim()) mcp.client = v.client.trim(); else q.add('config.mcp.client must be nonempty text'); }
  if (v.max_response_kb !== undefined) {
    if (typeof v.max_response_kb === 'number' && Number.isFinite(v.max_response_kb) && v.max_response_kb >= 1 && v.max_response_kb <= 1024) mcp.maxResponseKb = v.max_response_kb;
    else q.add('config.mcp.max_response_kb must be between 1 and 1024');
  }
  const allow = parseStringList(v.allow, 'config.mcp.allow', q);
  for (const name of allow) {
    if (MCP_ALLOW_GROUPS[name]) {
      for (const tool of MCP_ALLOW_GROUPS[name]) if (!mcp.allow.includes(tool)) mcp.allow.push(tool);
    } else if (!([...MCP_WRITE_TOOLS, ...MCP_EXTRA_PERMISSIONS] as readonly string[]).includes(name)) mcp.warnings.push(`config.mcp.allow: "${name}" is not a write tool of this version, ignored (allowed: ${MCP_WRITE_TOOLS.join(', ')})`);
    else if (!mcp.allow.includes(name as McpPermission)) mcp.allow.push(name as McpPermission);
  }
  if (v.allow_rm_worktree !== undefined) {
    if (typeof v.allow_rm_worktree === 'boolean') mcp.allowRmWorktree = v.allow_rm_worktree;
    else q.add('config.mcp.allow_rm_worktree must be true or false');
  }
  mcp.warnings.push(...q.items.map((item) => `${item}: ignored`));
  return mcp;
}

function parseQueue(v: unknown, p: Problems): QueueSettings {
  const queue: QueueSettings = { enabled: true, parallelStarts: 2 };
  if (v === undefined || v === null) return queue;
  if (!isObject(v)) {
    p.add('config.queue must be a mapping like {enabled: true, parallel_starts: 2}');
    return queue;
  }
  checkKeys(v, QUEUE_KEYS, 'config.queue', p);
  if (v.enabled !== undefined) {
    if (typeof v.enabled === 'boolean') queue.enabled = v.enabled;
    else p.add('config.queue.enabled must be true or false');
  }
  if (v.parallel_starts !== undefined) {
    if (typeof v.parallel_starts === 'number' && Number.isInteger(v.parallel_starts) && v.parallel_starts > 0) queue.parallelStarts = v.parallel_starts;
    else p.add('config.queue.parallel_starts must be a positive integer');
  }
  return queue;
}

function parseCancel(v: unknown, p: Problems): CancelSettings {
  const cancel: CancelSettings = { grace: 5 };
  if (v === undefined || v === null) return cancel;
  if (!isObject(v)) {
    p.add('config.cancel must be a mapping like {grace: 5}');
    return cancel;
  }
  checkKeys(v, CANCEL_KEYS, 'config.cancel', p);
  if (v.grace !== undefined) {
    if (typeof v.grace === 'number' && v.grace >= 0 && Number.isFinite(v.grace)) cancel.grace = v.grace;
    else p.add('config.cancel.grace must be a number of seconds, 0 or more');
  }
  return cancel;
}

/** A percentage for both providers (`80`) or per provider (`{claude: 80, codex: 70}`); undefined when it is not one (the problem is added). */
function parsePercent(v: unknown, where: string, p: Problems, fallback: Partial<Record<AgentName, number>>, ids: readonly ProviderId[]): Partial<Record<AgentName, number>> {
  const ok = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0 && x <= 100;
  if (ok(v)) return perProvider(ids, () => v);
  if (isObject(v)) {
    checkKeys(v, [...AGENT_NAMES], where, p);
    const out = { ...fallback };
    for (const name of ids) {
      if (v[name] === undefined) continue;
      if (ok(v[name])) out[name] = v[name];
      else p.add(`${where}.${name} must be a percentage above 0 and up to 100`);
    }
    return out;
  }
  p.add(`${where} must be a percentage like 80, or per provider like {claude: 80, codex: 70}`);
  return fallback;
}

function parseUsage(v: unknown, p: Problems, ids: readonly ProviderId[]): UsageSettings {
  const usage: UsageSettings = { warn: perProvider(ids, () => 80), critical: perProvider(ids, () => 95), queueHold: {}, statusLine: true, claudeTap: true, claudeDir: null, codexDir: null };
  if (v === undefined || v === null) return usage;
  if (!isObject(v)) {
    p.add('config.usage must be a mapping like {warn: 80, critical: 95}');
    return usage;
  }
  checkKeys(v, USAGE_KEYS, 'config.usage', p);
  if (v.warn !== undefined) Object.assign(usage.warn, parsePercent(v.warn, 'config.usage.warn', p, usage.warn, ids));
  if (v.critical !== undefined) Object.assign(usage.critical, parsePercent(v.critical, 'config.usage.critical', p, usage.critical, ids));
  for (const name of ids) if (providerValue(usage.critical, name) < providerValue(usage.warn, name)) p.add(`config.usage: critical (${providerValue(usage.critical, name)}) for ${name} is below warn (${providerValue(usage.warn, name)})`);
  if (v.queue_hold !== undefined && v.queue_hold !== false) usage.queueHold = parsePercent(v.queue_hold, 'config.usage.queue_hold', p, {}, ids);
  for (const [key, field] of [['status_line', 'statusLine'], ['claude_tap', 'claudeTap']] as const) {
    if (v[key] === undefined) continue;
    if (typeof v[key] === 'boolean') usage[field] = v[key];
    else p.add(`config.usage.${key} must be true or false`);
  }
  for (const id of PROVIDER_IDS) {
    const key = `${id}_dir`;
    const field = `${id}Dir` as 'claudeDir' | 'codexDir' | 'kimiDir';
    const dir = parseString(v[key], `config.usage.${key}`, p);
    if (dir) usage[field] = resolvePath(dir);
  }
  return usage;
}

function parseCollisions(v: unknown, p: Problems): CollisionSettings {
  const collisions: CollisionSettings = { enabled: true, interval: 300, notify: true, ignore: [] };
  if (v === undefined || v === null) return collisions;
  if (!isObject(v)) {
    p.add('config.collisions must be a mapping like {interval: 300, ignore: ["**/package-lock.json"]}');
    return collisions;
  }
  checkKeys(v, COLLISION_KEYS, 'config.collisions', p);
  for (const key of ['enabled', 'notify'] as const) {
    if (v[key] === undefined) continue;
    if (typeof v[key] === 'boolean') collisions[key] = v[key];
    else p.add(`config.collisions.${key} must be true or false`);
  }
  if (v.interval !== undefined) {
    if (typeof v.interval === 'number' && v.interval > 0) collisions.interval = v.interval;
    else p.add('config.collisions.interval must be a positive number of seconds');
  }
  if (v.ignore !== undefined) collisions.ignore = parseStringList(v.ignore, 'config.collisions.ignore', p);
  return collisions;
}

function readYamlFile(file: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new AgentctlError(`Cannot read ${file}: ${errorMessage(e)}`);
  }
  try {
    return YAML.parse(text) ?? {};
  } catch (e) {
    throw new AgentctlError(`Cannot parse ${file}: ${errorMessage(e)}`, 'Fix the YAML syntax and try again.');
  }
}

/** Directory of the global config; AGENTCTL_HOME overrides ~/.agentctl. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENTCTL_HOME ? resolvePath(env.AGENTCTL_HOME) : path.join(os.homedir(), '.agentctl');
}

export function loadGlobalConfig(dir: string = configDir()): GlobalConfig {
  const file = path.join(dir, 'config.yaml');
  const exists = fs.existsSync(file);
  const raw = exists ? readYamlFile(file) : {};
  const p = new Problems();
  if (!isObject(raw)) throw new AgentctlError(`${file}: the top level must be a mapping`);
  checkKeys(raw, GLOBAL_KEYS, 'config', p);
  const layer = parseLayer(raw, 'config', p);
  const providers = parseProviders(raw.providers, p);

  const cache = parseString(raw.cache, 'config.cache', p) ?? '~/Projects/cache';
  const stateDir = parseString(raw.state_dir, 'config.state_dir', p) ?? path.join(dir, 'tasks');
  const session = parseString(raw.session, 'config.session', p) ?? 'agentctl';
  if (!/^[A-Za-z0-9_-]+$/.test(session)) p.add('config.session may only contain letters, digits, "_" and "-"');

  let ui: GlobalConfig['ui'];
  if (raw.ui !== undefined) {
    if (!isObject(raw.ui)) p.add('config.ui must be a mapping');
    else {
      checkKeys(raw.ui, ['instance_name'], 'config.ui', p);
      const instanceName = parseString(raw.ui.instance_name, 'config.ui.instance_name', p);
      if (instanceName !== undefined && !/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u.test(instanceName)) p.add('config.ui.instance_name must be 1–64 letters, digits, spaces, dots, underscores or hyphens');
      ui = instanceName === undefined ? {} : { instanceName };
    }
  }

  let tmux: GlobalConfig['tmux'];
  if (raw.tmux !== undefined) {
    if (!isObject(raw.tmux)) p.add('config.tmux must be a mapping');
    else {
      checkKeys(raw.tmux, ['socket'], 'config.tmux', p);
      const socket = parseString(raw.tmux.socket, 'config.tmux.socket', p);
      if (socket !== undefined && !/^[A-Za-z0-9_-]+$/.test(socket)) p.add('config.tmux.socket may only contain letters, digits, "_" and "-"');
      tmux = socket === undefined ? {} : { socket };
    }
  }

  const limits: GlobalConfig['limits'] = {};
  let countExternal = false;
  let countReportReady = false;
  const preview = { ttlS: 600 };
  if (raw.preview !== undefined) {
    if (!isObject(raw.preview)) p.add("config.preview must be a mapping");
    else {
      checkKeys(raw.preview, ["ttl_s"], "config.preview", p);
      if (raw.preview.ttl_s !== undefined) {
        if (typeof raw.preview.ttl_s === "number" && Number.isFinite(raw.preview.ttl_s) && raw.preview.ttl_s > 0) preview.ttlS = raw.preview.ttl_s;
        else p.add("config.preview.ttl_s must be a positive number");
      }
    }
  }
  if (raw.limits !== undefined && raw.limits !== null) {
    if (!isObject(raw.limits)) p.add('config.limits must be a mapping like {claude: 3, codex: 3}');
    else {
      checkKeys(raw.limits, [...LIMITS_KEYS], 'config.limits', p);
      if (raw.limits.count_external !== undefined) {
        if (typeof raw.limits.count_external === 'boolean') countExternal = raw.limits.count_external;
        else p.add('config.limits.count_external must be true or false');
      }
      if (raw.limits.count_report_ready !== undefined) {
        if (typeof raw.limits.count_report_ready === "boolean") countReportReady = raw.limits.count_report_ready;
        else p.add("config.limits.count_report_ready must be true or false");
      }
      for (const name of [...activeProviders({ providers }), 'heavy'] as const) {
        const value = raw.limits[name];
        if (value === undefined) continue;
        if (name !== 'heavy' && value === 'off') { limits[name] = 'off'; continue; }
        // 0 is the historic spelling of "no limit": accepted, and nothing is stored.
        if (typeof value === 'number' && Number.isInteger(value) && value >= 0) { if (value > 0) limits[name] = value; }
        else p.add(`config.limits.${name} must be a positive integer, 0 (no limit)${name === 'heavy' ? '' : ' or off (the provider is disabled)'}`);
      }
    }
  }

  const agents = {} as Record<AgentName, AgentSettings>;
  const rawAgents = raw.agents;
  if (rawAgents !== undefined && rawAgents !== null && !isObject(rawAgents)) p.add('config.agents must be a mapping');
  const agentMap = isObject(rawAgents) ? rawAgents : {};
  checkKeys(agentMap, [...AGENT_NAMES], 'config.agents', p);
  for (const name of activeProviders({ providers })) agents[name] = parseAgentSettings(name, agentMap[name], `config.agents.${name}`, p);

  const equivalents = [...parseEquivalents(raw.equivalents, 'config.equivalents', p, providers), ...defaultEquivalents(providers)];
  const mirror = parseString(raw.mirror_dir, 'config.mirror_dir', p);
  const watch = parseWatch(raw.watch, p);
  const notify = parseNotify(raw.notify, p);
  const away = parseAway(raw.away, p);
  const manager = parseManager(raw.manager, p);
  const board = parseBoard(raw.board, p);
  const mcp = parseMcp(raw.mcp);
  const queue = parseQueue(raw.queue, p);
  const collisions = parseCollisions(raw.collisions, p);
  const cancel = parseCancel(raw.cancel, p);
  const usage = parseUsage(raw.usage, p, activeProviders({ providers }));
  let guideLang: 'en' | 'pl' = 'en';
  if (isObject(raw.guide)) {
    checkKeys(raw.guide, ['lang'], 'config.guide', p);
    if (raw.guide.lang === 'en' || raw.guide.lang === 'pl') guideLang = raw.guide.lang;
    else if (raw.guide.lang !== undefined) p.add('config.guide.lang must be en or pl');
  } else if (raw.guide !== undefined) p.add('config.guide must be a mapping like {lang: en}');
  const capacity = { snapshot: true, staleMinutes: 30, sampleLimit: 2048, thresholds: [80, 95], codexRefresh: true, claudeUsageProbe: false, claudeUsageProbeIntervalMinutes: 15 };
  if (raw.capacity !== undefined) {
    if (!isObject(raw.capacity)) p.add('config.capacity must be a mapping');
    else {
      if (raw.capacity.kimi_usage_probe !== undefined) {
        if (typeof raw.capacity.kimi_usage_probe === 'boolean') Object.assign(capacity, { kimiUsageProbe: raw.capacity.kimi_usage_probe });
        else p.add('config.capacity.kimi_usage_probe must be boolean');
      }
      if (raw.capacity.kimi_usage_probe_model !== undefined) {
        if (typeof raw.capacity.kimi_usage_probe_model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(raw.capacity.kimi_usage_probe_model)) Object.assign(capacity, { kimiUsageProbeModel: raw.capacity.kimi_usage_probe_model });
        else p.add('config.capacity.kimi_usage_probe_model must be a model alias or default');
      }
      checkKeys(raw.capacity, ['load_threshold', 'snapshot', 'stale_minutes', 'sample_limit', 'thresholds', 'codex_refresh', 'kimi_usage_probe', 'kimi_usage_probe_model', 'claude_usage_probe', 'claude_usage_probe_interval_minutes'], 'config.capacity', p);
      for (const [key, field] of [['snapshot', 'snapshot'], ['codex_refresh', 'codexRefresh'], ['claude_usage_probe', 'claudeUsageProbe']] as const) {
        if (typeof raw.capacity[key] === 'boolean') capacity[field] = raw.capacity[key];
        else if (raw.capacity[key] !== undefined) p.add(`config.capacity.${key} must be boolean`);
      }
      for (const [key, field, min, max] of [['stale_minutes', 'staleMinutes', 1, 10080], ['sample_limit', 'sampleLimit', 2, 10000], ['claude_usage_probe_interval_minutes', 'claudeUsageProbeIntervalMinutes', 15, 10080]] as const) {
        const value = raw.capacity[key];
        if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) capacity[field] = value;
        else if (value !== undefined) p.add(`config.capacity.${key} must be an integer from ${min} to ${max}`);
      }
      if (raw.capacity.load_threshold !== undefined) {
        if (typeof raw.capacity.load_threshold === 'number' && Number.isFinite(raw.capacity.load_threshold) && raw.capacity.load_threshold > 0) Object.assign(capacity, { loadThreshold: raw.capacity.load_threshold });
        else p.add('config.capacity.load_threshold must be positive');
      }
      if (raw.capacity.thresholds !== undefined) {
        if (Array.isArray(raw.capacity.thresholds) && raw.capacity.thresholds.length <= 20 && raw.capacity.thresholds.every((x) => typeof x === 'number' && x > 0 && x <= 100)) capacity.thresholds = [...new Set(raw.capacity.thresholds as number[])].sort((a, b) => a - b);
        else p.add('config.capacity.thresholds must be up to 20 percentages in (0, 100]');
      }
    }
  }

  const limited = { autoResume: true, resumeAbovePercent: 5, message: 'kontynuuj' };
  if (raw.limited !== undefined) {
    if (!isObject(raw.limited)) p.add('config.limited must be a mapping');
    else {
      checkKeys(raw.limited, ['auto_resume', 'resume_above_percent', 'message'], 'config.limited', p);
      if (typeof raw.limited.auto_resume === 'boolean') limited.autoResume = raw.limited.auto_resume;
      else if (raw.limited.auto_resume !== undefined) p.add('config.limited.auto_resume must be boolean');
      if (typeof raw.limited.resume_above_percent === 'number' && Number.isFinite(raw.limited.resume_above_percent) && raw.limited.resume_above_percent >= 0 && raw.limited.resume_above_percent < 100) limited.resumeAbovePercent = raw.limited.resume_above_percent;
      else if (raw.limited.resume_above_percent !== undefined) p.add('config.limited.resume_above_percent must be >= 0 and < 100');
      if (typeof raw.limited.message === 'string' && raw.limited.message.trim()) limited.message = raw.limited.message;
      else if (raw.limited.message !== undefined) p.add('config.limited.message must be nonempty text');
    }
  }
  const overload = { autoRetry: true, retryAfter: 300, maxRetries: 3, giveUpAfter: 1800, resetAfterS: 600, message: 'kontynuuj' };
  if (raw.overload !== undefined) {
    if (!isObject(raw.overload)) p.add('config.overload must be a mapping');
    else {
      checkKeys(raw.overload, ['auto_retry', 'retry_after', 'max_retries', 'give_up_after', 'reset_after_s', 'message'], 'config.overload', p);
      if (raw.overload.auto_retry !== undefined) {
        if (typeof raw.overload.auto_retry === 'boolean') overload.autoRetry = raw.overload.auto_retry;
        else p.add('config.overload.auto_retry must be boolean');
      }
      for (const [key, field, min] of [['retry_after', 'retryAfter', 1], ['max_retries', 'maxRetries', 0], ['give_up_after', 'giveUpAfter', 1], ['reset_after_s', 'resetAfterS', 1]] as const) {
        const value = raw.overload[key];
        if (typeof value === 'number' && Number.isInteger(value) && value >= min) overload[field] = value;
        else if (value !== undefined) p.add(`config.overload.${key} must be an integer >= ${min}`);
      }
      if (typeof raw.overload.message === 'string' && raw.overload.message.trim()) overload.message = raw.overload.message;
      else if (raw.overload.message !== undefined) p.add('config.overload.message must be nonempty text');
    }
  }
  let cleanWorktreeCache = true;
  if (isObject(raw.report) && raw.report.clean_worktree_cache !== undefined) {
    if (typeof raw.report.clean_worktree_cache === 'boolean') cleanWorktreeCache = raw.report.clean_worktree_cache;
    else p.add('config.report.clean_worktree_cache must be a boolean');
  }
  let reportSettleS = 30;
  if (isObject(raw.report) && raw.report.settle_s !== undefined) {
    if (typeof raw.report.settle_s === 'number' && Number.isFinite(raw.report.settle_s) && raw.report.settle_s >= 0) reportSettleS = raw.report.settle_s;
    else p.add('config.report.settle_s must be a nonnegative number');
  }
  const disk = { worktreeSharePercent: 20, warnGb: 50, criticalGb: 20, workers: 2, measurementTimeoutS: 600 };
  const git = { timeoutS: 600 };
  for (const [section, target, fields] of [
    ['disk', disk, { worktree_share_percent: 'worktreeSharePercent', warn_gb: 'warnGb', critical_gb: 'criticalGb', workers: 'workers', measurement_timeout_s: 'measurementTimeoutS' }],
    ['git', git, { timeout_s: 'timeoutS' }],
  ] as const) {
    const value = raw[section];
    if (value === undefined) continue;
    if (!isObject(value)) { p.add(`config.${section} must be a mapping`); continue; }
    checkKeys(value, Object.keys(fields), `config.${section}`, p);
    for (const [key, field] of Object.entries(fields)) {
      if (value[key] === undefined) continue;
      if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] <= 0) p.add(`config.${section}.${key} must be positive`);
      else (target as unknown as Record<string, number>)[field] = value[key];
    }
  }
  if (disk.worktreeSharePercent > 100) p.add('config.disk.worktree_share_percent must not exceed 100');
  if (!Number.isInteger(disk.workers) || disk.workers < 1 || disk.workers > 8) p.add('config.disk.workers must be an integer from 1 to 8');
  if (disk.criticalGb > disk.warnGb) p.add('config.disk.critical_gb must not exceed warn_gb');
  const cohort = { doneGraceS: 300 };
  if (raw.cohort !== undefined) {
    if (!isObject(raw.cohort)) p.add('config.cohort must be a mapping');
    else {
      checkKeys(raw.cohort, ['done_grace_s'], 'config.cohort', p);
      if (raw.cohort.done_grace_s !== undefined) {
        if (typeof raw.cohort.done_grace_s === 'number' && Number.isFinite(raw.cohort.done_grace_s) && raw.cohort.done_grace_s >= 0) cohort.doneGraceS = raw.cohort.done_grace_s;
        else p.add('config.cohort.done_grace_s must be a nonnegative number');
      }
    }
  }
  const deliveryConfirmS = raw.delivery_confirm_s ?? 60;
  if (typeof deliveryConfirmS !== 'number' || !Number.isFinite(deliveryConfirmS) || deliveryConfirmS <= 0) p.add('config.delivery_confirm_s must be a positive number');
  p.throwIfAny(`Invalid config ${file}:`, 'Fix the listed keys; see the README section "Configuration".');
  const warnings: string[] = [];
  const usageMap = isObject(raw.usage) ? raw.usage : {};
  for (const id of PROVIDER_IDS.filter(id => !providers.includes(id))) {
    const configuredUsage = usageMap[`${id}_dir`] !== undefined || ['warn', 'critical', 'queue_hold'].some(k => { const values = usageMap[k]; return isObject(values) && values[id] !== undefined; });
    if (agentMap[id] !== undefined || (isObject(raw.limits) && raw.limits[id] !== undefined) || configuredUsage) warnings.push(`${id} is not in providers; its agent/limit/usage settings are inactive`);
  }
  const config: GlobalConfig = { ...layer, providers, cache: resolvePath(cache), stateDir: resolvePath(stateDir), session, ...(ui ? { ui } : {}), ...(tmux ? { tmux } : {}), deliveryConfirmS: deliveryConfirmS as number, limits, countExternal, countReportReady, preview, agents, equivalents, watch, notify, away, manager, board, mcp, queue, reportSettleS, cleanWorktreeCache, cohort, overload, limited, collisions, cancel, usage, guideLang, capacity, disk, git, path: file, loaded: exists };
  if (mirror) config.mirrorDir = resolvePath(mirror);
  if (warnings.length) config.warnings = warnings;
  return config;
}

export const PROJECT_CONFIG_NAME = '.agentctl.yaml';

/** Project layer from `<repo>/.agentctl.yaml`; undefined when the repo has none. */
export function loadProjectConfig(repoPath: string): (Layer & { path: string }) | undefined {
  const file = path.join(expandHome(repoPath), PROJECT_CONFIG_NAME);
  if (!fs.existsSync(file)) return undefined;
  const raw = readYamlFile(file);
  if (!isObject(raw)) throw new AgentctlError(`${file}: the top level must be a mapping`);
  const p = new Problems();
  checkKeys(raw, LAYER_KEYS, PROJECT_CONFIG_NAME, p);
  const layer = parseLayer(raw, PROJECT_CONFIG_NAME, p);
  p.throwIfAny(`Invalid project config ${file}:`, 'Fix the listed keys; see the README section "Configuration".');
  return { ...layer, path: file };
}

/** Both original providers remain mandatory; order controls the alternatives. */
function parseProviders(value: unknown, p: Problems): ProviderId[] {
  if (value === undefined) return [...DEFAULT_PROVIDERS];
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !(PROVIDER_IDS as readonly string[]).includes(id))) {
    p.add(`config.providers must be a list of known providers: ${PROVIDER_IDS.join(', ')}`);
    return [...PROVIDER_IDS];
  }
  if (new Set(value).size !== value.length) p.add('config.providers must not contain duplicates');
  for (const required of DEFAULT_PROVIDERS) if (!value.includes(required)) p.add(`config.providers must include ${required}`);
  return value as ProviderId[];
}
