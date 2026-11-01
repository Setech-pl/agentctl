import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { DEFAULT_EQUIVALENTS, parseEquivalents } from './equivalents.ts';
import type { Equivalent } from './equivalents.ts';
import { DEFAULT_WINDOW_ICONS, TASK_STATES } from './icons.ts';
import { findAutoAcceptFlag } from './safety.ts';
import type { TaskState } from './state.ts';
import { AgentctlError, Problems, errorMessage, expandHome, isObject, resolvePath } from './util.ts';

export const AGENT_NAMES = ['claude', 'codex'] as const;
export type AgentName = (typeof AGENT_NAMES)[number];
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
}

/** The part of the configuration that exists in every layer (global, project, spec). Values are unexpanded. */
export interface Layer {
  worktreeRoot?: string;
  links: Link[];
  env: Record<string, string>;
  report?: string;
  /** Shell commands run in the first worktree after `git worktree add`, before the links. Unset: inherit from the layer below. */
  setup?: string[];
  defaults: Defaults;
}

export interface AgentSettings {
  /** Extra flags appended to the agent command line. */
  flags: string[];
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
  /** Regex: the agent is busy with a turn. */
  workingPattern: string;
  /** tmux key name that interrupts the current turn. */
  interruptKey: string;
  /** Regexes for TUI chrome (shortcut hints, mode and warning lines, empty input prompts). `status` skips these lines when it shows the last line. */
  footerPatterns: string[];
  /** Regex: the agent asks the user a question and waits for the answer (state needs-input). */
  questionPattern: string;
}

export interface GlobalConfig extends Layer {
  /** Absolute path of the directory that holds per-task cache folders: only the reports the agents write. */
  cache: string;
  /** Where agentctl keeps its own state per task (`<stateDir>/<window>/TASK.md`, setup.log, markers), out of reach of the agents. */
  stateDir: string;
  session: string;
  /** Max simultaneous windows per provider (agent). Missing = unlimited. */
  limits: Partial<Record<AgentName, number>>;
  agents: Record<AgentName, AgentSettings>;
  /** Claude<->Codex pairs: your `equivalents` first, then the built-in table. */
  equivalents: Equivalent[];
  /** When set, reports and status.json are copied here by status/pull. */
  mirrorDir?: string;
  /**
   * `agentctl watch`: poll interval, how long an idle task may wait before it is worth a notification, and the state icons
   * in front of the tmux window names (`null`: the windows keep their plain names).
   */
  watch: { interval: number; waitingAfter: number; windowIcons: Record<TaskState, string> | null };
  /** Where the config was (or would be) read from. */
  path: string;
  loaded: boolean;
}

export const DEFAULT_AGENT_SETTINGS: Record<AgentName, AgentSettings> = {
  claude: {
    flags: [],
    effortArgs: ['--effort', '{effort}'],
    // Claude Code 2.1.309 idle screen: the input box line "❯ Try ...". The trust dialog also uses "❯", but with "1. Yes".
    readyPattern: '^\\s*❯\\s(?!\\d+\\.)',
    readyTimeout: 60,
    trustTimeout: 600,
    trustPattern: 'Quick safety check|Yes, I trust this folder',
    workingPattern: 'esc to interrupt',
    interruptKey: 'Escape',
    footerPatterns: [
      '\\? for shortcuts',
      '^\\s*(⏵⏵|⏸)',
      'shift\\+tab to cycle',
      '^\\s*[❯>]\\s*(Try ".*")?$',
    ],
    // AskUserQuestion dialog footer.
    questionPattern: 'Enter to select\\b.*Esc to cancel',
  },
  codex: {
    flags: [],
    effortArgs: ['-c', 'model_reasoning_effort={effort}'],
    // Codex 0.166.0 idle screen: "› Ask Codex to do anything" and the footer "? for shortcuts".
    readyPattern: '^›\\s(?!\\d+\\.)|\\? for shortcuts',
    readyTimeout: 60,
    trustTimeout: 600,
    trustPattern: 'Trust this folder\\?|Folder settings can run code automatically',
    workingPattern: 'esc to interrupt',
    interruptKey: 'Escape',
    // Codex 0.166.0 footer: "GPT-6.1-Sol low · <dir> · <title>" and "? for shortcuts … ⚠ 1 warning · f2 to view".
    footerPatterns: [
      '\\? for shortcuts',
      '⚠ \\d+ warnings?',
      'f2 to view',
      '^\\s*[\\w.-]+ (low|medium|high|xhigh|minimal|none) · ',
      '^\\s*›\\s*(Ask Codex to do anything)?\\s*$',
      'Queued follow-up inputs|⇧.? (edit last queued message|to answer)',
    ],
    // A pending request_user_input question: "? Which color…" with options, then "• Waiting for your answer.".
    questionPattern: 'Waiting for your answer|^\\s*\\?\\s+\\d+ questions?\\b|to answer\\s*$',
  },
};

const LAYER_KEYS = ['worktree_root', 'links', 'env', 'report', 'setup', 'defaults'];
const GLOBAL_KEYS = [...LAYER_KEYS, 'cache', 'state_dir', 'session', 'limits', 'agents', 'equivalents', 'mirror_dir', 'watch'];

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
    checkKeys(entry, ['from', 'to'], at, p);
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
  checkKeys(v, ['agent', 'model', 'effort'], where, p);
  const defaults: Defaults = {};
  const agent = parseEnumValue(v.agent, AGENT_NAMES, `${where}.agent`, p);
  const model = parseString(v.model, `${where}.model`, p);
  const effort = parseEnumValue(v.effort, EFFORTS, `${where}.effort`, p);
  if (agent) defaults.agent = agent;
  if (model) defaults.model = model;
  if (effort) defaults.effort = effort;
  return defaults;
}

function parseSetup(v: unknown, where: string, p: Problems): string[] {
  const commands = parseStringList(v, where, p);
  commands.forEach((c, i) => {
    if (c.trim() === '') p.add(`${where}[${i}] is an empty command`);
  });
  return commands;
}

function parseLayer(obj: Record<string, unknown>, where: string, p: Problems): Layer {
  const layer: Layer = {
    links: parseLinks(obj.links, `${where}.links`, p),
    env: parseEnv(obj.env, `${where}.env`, p),
    defaults: parseDefaults(obj.defaults, `${where}.defaults`, p),
  };
  const worktreeRoot = parseString(obj.worktree_root, `${where}.worktree_root`, p);
  const report = parseString(obj.report, `${where}.report`, p);
  if (worktreeRoot) layer.worktreeRoot = worktreeRoot;
  if (report) layer.report = report;
  if (obj.setup !== undefined && obj.setup !== null) layer.setup = parseSetup(obj.setup, `${where}.setup`, p);
  return layer;
}

function parseAgentSettings(name: AgentName, v: unknown, where: string, p: Problems): AgentSettings {
  const settings: AgentSettings = { ...DEFAULT_AGENT_SETTINGS[name] };
  if (v === undefined || v === null) return settings;
  if (!isObject(v)) {
    p.add(`${where} must be a mapping`);
    return settings;
  }
  checkKeys(v, ['flags', 'effort_args', 'ready_pattern', 'ready_timeout', 'trust_timeout', 'trust_pattern', 'working_pattern', 'interrupt_key', 'footer_patterns', 'question_pattern'], where, p);
  if (v.flags !== undefined) settings.flags = parseStringList(v.flags, `${where}.flags`, p);
  if (v.effort_args !== undefined) settings.effortArgs = parseStringList(v.effort_args, `${where}.effort_args`, p);
  for (const [key, list] of [['flags', settings.flags], ['effort_args', settings.effortArgs]] as const) {
    const bad = findAutoAcceptFlag(list);
    if (bad) p.add(`${where}.${key}: "${bad}" enables auto-accept, which agentctl never allows`);
  }
  for (const [key, field] of [['ready_pattern', 'readyPattern'], ['trust_pattern', 'trustPattern'], ['working_pattern', 'workingPattern'], ['question_pattern', 'questionPattern']] as const) {
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

export const DEFAULT_WATCH = { interval: 15, waitingAfter: 120 };

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
  checkKeys(v, [...TASK_STATES], where, p);
  for (const state of TASK_STATES) {
    const icon = v[state];
    if (icon === undefined) continue;
    if (typeof icon === 'string' && icon.trim() !== '' && !/[\p{Cc}]/u.test(icon)) icons[state] = icon.trim();
    else p.add(`${where}.${state} must be a short text without control characters`);
  }
  return icons;
}

function parseWatch(v: unknown, p: Problems): GlobalConfig['watch'] {
  const watch: GlobalConfig['watch'] = { ...DEFAULT_WATCH, windowIcons: { ...DEFAULT_WINDOW_ICONS } };
  if (v === undefined || v === null) return watch;
  if (!isObject(v)) {
    p.add('config.watch must be a mapping like {interval: 15, waiting_after: 120}');
    return watch;
  }
  checkKeys(v, ['interval', 'waiting_after', 'window_icons'], 'config.watch', p);
  watch.windowIcons = parseWindowIcons(v.window_icons, p);
  for (const [key, field] of [['interval', 'interval'], ['waiting_after', 'waitingAfter']] as const) {
    if (v[key] === undefined) continue;
    if (typeof v[key] === 'number' && v[key] > 0) watch[field] = v[key];
    else p.add(`config.watch.${key} must be a positive number of seconds`);
  }
  return watch;
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

  const cache = parseString(raw.cache, 'config.cache', p) ?? '~/Projects/cache';
  const stateDir = parseString(raw.state_dir, 'config.state_dir', p) ?? path.join(dir, 'tasks');
  const session = parseString(raw.session, 'config.session', p) ?? 'agentctl';
  if (!/^[A-Za-z0-9_-]+$/.test(session)) p.add('config.session may only contain letters, digits, "_" and "-"');

  const limits: GlobalConfig['limits'] = {};
  if (raw.limits !== undefined && raw.limits !== null) {
    if (!isObject(raw.limits)) p.add('config.limits must be a mapping like {claude: 3, codex: 3}');
    else {
      checkKeys(raw.limits, [...AGENT_NAMES], 'config.limits', p);
      for (const name of AGENT_NAMES) {
        const value = raw.limits[name];
        if (value === undefined) continue;
        if (typeof value === 'number' && Number.isInteger(value) && value > 0) limits[name] = value;
        else p.add(`config.limits.${name} must be a positive integer`);
      }
    }
  }

  const agents = {} as Record<AgentName, AgentSettings>;
  const rawAgents = raw.agents;
  if (rawAgents !== undefined && rawAgents !== null && !isObject(rawAgents)) p.add('config.agents must be a mapping');
  const agentMap = isObject(rawAgents) ? rawAgents : {};
  checkKeys(agentMap, [...AGENT_NAMES], 'config.agents', p);
  for (const name of AGENT_NAMES) agents[name] = parseAgentSettings(name, agentMap[name], `config.agents.${name}`, p);

  const equivalents = [...parseEquivalents(raw.equivalents, 'config.equivalents', p), ...parseEquivalents(DEFAULT_EQUIVALENTS, 'defaults', p)];
  const mirror = parseString(raw.mirror_dir, 'config.mirror_dir', p);
  const watch = parseWatch(raw.watch, p);

  p.throwIfAny(`Invalid config ${file}:`, 'Fix the listed keys; see the README section "Configuration".');
  const config: GlobalConfig = { ...layer, cache: resolvePath(cache), stateDir: resolvePath(stateDir), session, limits, agents, equivalents, watch, path: file, loaded: exists };
  if (mirror) config.mirrorDir = resolvePath(mirror);
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
