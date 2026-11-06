import { validateLink, missingLinkTargets } from './links.ts';
import { validateLaunch } from './safety.ts';
import { provider, isActive, activeProviders } from './providers/registry.ts';
import { VERDICTS } from './outputs.ts';
import type { OutputVerdict } from './outputs.ts';
import path from 'node:path';
import YAML from 'yaml';
import {
  AGENT_NAMES,
  EFFORTS,
  checkKeys,
  loadProjectConfig,
  parseEnumValue,
  parseEnv,
  parseLinks,
  parseReview,
} from './config.ts';
import { parseReportPaths } from './config.ts';
import type { AgentName, Effort, GlobalConfig, Layer, Link, ReviewSettings } from './config.ts';
import type { Order } from './equivalents.ts';
import { AgentctlError, Problems, TASK_ID, cohortNameProblem, errorMessage, fillPlaceholders, isObject, resolvePath, windowName } from './util.ts';

/** A spec as written in the file: untouched YAML header plus the prompt below it. */
export interface RawSpec {
  /** 1-based position in the file. */
  index: number;
  header: Record<string, unknown>;
  prompt: string;
}

export interface ResolvedRepo {
  path: string;
  worktree: string;
  base?: string;
  baseTask?: string;
  branch?: string;
  /** Shell commands for this repository's worktree: the spec's `repos[].setup`, else the repository's own .agentctl.yaml (the first repository also takes the spec/global `setup`). */
  setup?: string[];
}

export interface AutoReviewSource {
  author: string;
  hash: string;
  /** The author's commit per repository that the review is pinned to (its own checkout is detached there). */
  heads: Record<string, string>;
  /** The start of the reviewed delta per repository, and the delta text in the prompt (to re-pin when the author commits again). */
  bases?: Record<string, string>;
  delta?: string;
}

export interface ResolvedSpec {
  /** Internal queue provenance, never accepted from spec YAML. */
  autoReview?: AutoReviewSource;
  index: number;
  task: string;
  window: string;
  agent: AgentName;
  model: string;
  effort: Effort;
  repos: ResolvedRepo[];
  links: Link[];
  /** Shell commands for the first worktree: after `git worktree add`, before the links. */
  setup: string[];
  env: Record<string, string>;
  reviewOf?: string;
  review?: ReviewSettings;
  report: string;
  /** Other places the report may be (paths and globs, placeholders filled; a relative one is relative to the worktree). */
  reportAlt?: string[];
  prompt: string;
  /** `pin: true`: never switch this task to the other provider. */
  pin: boolean;
  /** `remote_control: true` (Claude only): the agent starts with `--remote-control <TASK>`, so the task can be answered from the Claude app. Absent: off. */
  remoteControl?: boolean;
  /** Queue order: `high` starts before every `normal` task (FIFO inside each class). Only the queue looks at it. */
  weight?: 'normal' | 'heavy';
  priority: 'high' | 'normal';
  /** Tasks that must have a report before this one starts (queue). `new` refuses to start a task whose `after` is not met. */
  after: string[];
  afterVerdicts?: Record<string, OutputVerdict[]>;
  /** Globs of the files the task will change: `queue` and `new` warn when an active task already changes matching files. */
  touches: string[];
  /** The cohort the task belongs to, as written. Absent: no cohort (there is no default one). */
  cohort?: string;
  /** The order as written in the spec; agent/model/effort above are the effective values. */
  requested: Order;
  /** Why the effective order differs from the requested one. */
  switchedBy?: 'flag' | 'limit';
}

export const PRIORITIES = ['high', 'normal'] as const;

const FENCE = '---';
const isFence = (line: string | undefined): boolean => line !== undefined && line.trimEnd() === FENCE;

/**
 * Split a spec file into (header, prompt) pairs.
 *
 * A file is `---`, YAML, `---`, prompt text, and then optionally more `---` YAML `---` prompt
 * groups. A `---` inside a prompt (a markdown rule) stays in the prompt: a later fenced block is
 * only a header when it parses as a mapping containing `task` or `agent`.
 */
export function splitSpecs(text: string, source = 'spec'): RawSpec[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const specs: RawSpec[] = [];
  let current: { header: Record<string, unknown>; prompt: string[] } | undefined;

  const finish = (): void => {
    if (!current) return;
    specs.push({ index: specs.length + 1, header: current.header, prompt: current.prompt.join('\n').trim() });
  };

  const tryHeader = (at: number, mandatory: boolean): { header: Record<string, unknown>; next: number } | undefined => {
    let close = -1;
    for (let j = at + 1; j < lines.length; j++) {
      if (isFence(lines[j])) {
        close = j;
        break;
      }
    }
    if (close < 0) {
      if (mandatory) throw new AgentctlError(`${source}: the YAML header opened at line ${at + 1} is never closed`, 'Close it with a second "---" line.');
      return undefined;
    }
    let data: unknown;
    try {
      data = YAML.parse(lines.slice(at + 1, close).join('\n'));
    } catch (e) {
      if (mandatory) throw new AgentctlError(`${source}: invalid YAML in the header at line ${at + 1}: ${errorMessage(e)}`, 'Fix the YAML syntax.');
      return undefined;
    }
    if (mandatory && !isObject(data)) {
      throw new AgentctlError(`${source}: the header at line ${at + 1} must be a YAML mapping (task: ..., agent: ...)`);
    }
    if (!isObject(data)) return undefined;
    if (!mandatory && !('task' in data) && !('agent' in data)) return undefined;
    return { header: data, next: close + 1 };
  };

  let i = 0;
  while (i < lines.length && (lines[i] as string).trim() === '') i++;
  if (i >= lines.length) throw new AgentctlError(`${source} is empty`, 'A spec starts with a YAML header between "---" lines, followed by the prompt. Run "agentctl spec example".');
  if (!isFence(lines[i])) {
    throw new AgentctlError(`${source} must start with a YAML header between "---" lines`, 'Run "agentctl spec example" to see the format.');
  }

  while (i < lines.length) {
    if (isFence(lines[i])) {
      const found = tryHeader(i, current === undefined);
      if (found) {
        finish();
        current = { header: found.header, prompt: [] };
        i = found.next;
        continue;
      }
    }
    current?.prompt.push(lines[i] as string);
    i++;
  }
  finish();
  return specs;
}

export interface ResolveContext {
  config: GlobalConfig;
  /** Project layer lookup; defaults to reading `<repo>/.agentctl.yaml`. */
  loadProject?: (repoPath: string) => Layer | undefined;
}

/** Keys of a spec header, and of one entry of its `repos`; docs/configuration.md describes each one. */
/** Task IDs whose window name is one agentctl uses for itself (`watch`, `board`, `manager`). */
export const RESERVED_TASK_IDS = ['WATCH', 'BOARD', 'MANAGER'];

export const SPEC_KEYS = ['task', 'agent', 'model', 'effort', 'repos', 'links', 'setup', 'env', 'review_of', 'review', 'report', 'pin', 'remote_control', 'weight', 'priority', 'after', 'touches', 'cohort'];
export const REPO_KEYS = ['path', 'worktree', 'base', 'branch', 'setup'];

function label(raw: RawSpec): string {
  const task = raw.header.task;
  return typeof task === 'string' && task ? `Spec #${raw.index} (${task})` : `Spec #${raw.index}`;
}

function checkTask(raw: RawSpec, p: Problems): string | undefined {
  const task = raw.header.task;
  if (task === undefined || task === null || task === '') {
    p.add('missing "task" (the task ID, e.g. task: NC-12)');
    return undefined;
  }
  if (typeof task !== 'string' || !TASK_ID.test(task)) {
    p.add(
      `invalid task ID ${JSON.stringify(task)}: use UPPERCASE letters, digits, "-" or "_", starting with a letter (e.g. NC-12)`,
    );
    return undefined;
  }
  // The windows of the watcher, the board and the manager are not tasks: a task of that name would be invisible in status.
  if (RESERVED_TASK_IDS.includes(task)) {
    p.add(`"${task}" cannot be a task ID: the window "${windowName(task)}" of the agentctl session is used by agentctl itself (${RESERVED_TASK_IDS.join(', ')})`);
    return undefined;
  }
  return task;
}

/** Lighter check used by `send`: only the task ID and a non-empty prompt matter. */
export function resolveSendSpec(raw: RawSpec): { task: string; window: string; prompt: string } {
  const p = new Problems();
  const task = checkTask(raw, p);
  if (raw.prompt === '') p.add('the prompt is empty (write it below the closing "---" of the header)');
  p.throwIfAny(`${label(raw)} is invalid:`, 'Run "agentctl spec example" to see the format.');
  return { task: task as string, window: windowName(task as string), prompt: raw.prompt };
}

/** Validate a raw spec and merge global config < project config < spec. */
export function resolveSpec(raw: RawSpec, ctx: ResolveContext): ResolvedSpec {
  const { config } = ctx;
  const loadProject = ctx.loadProject ?? loadProjectConfig;
  const p = new Problems();
  const h = raw.header;
  const where = 'spec';

  checkKeys(h, SPEC_KEYS, where, p);
  const task = checkTask(raw, p);
  const specAgent = (typeof h.agent === 'string' && (AGENT_NAMES as readonly string[]).includes(h.agent) ? h.agent as AgentName : parseEnumValue(h.agent, activeProviders(config), 'agent', p));
  const specEffort = parseEnumValue(h.effort, EFFORTS, 'effort', p);
  let specModel: string | undefined;
  if (h.model !== undefined && h.model !== null) {
    if (typeof h.model === 'string' && h.model.trim() !== '') specModel = h.model.trim();
    else p.add('model must be a non-empty string (or omit it for the agent default)');
  }

  // Repos
  const rawRepos: { path: string; worktree?: string; base?: string; branch?: string; setup?: string[] }[] = [];
  if (!Array.isArray(h.repos) || h.repos.length === 0) {
    p.add('"repos" must list at least one repository: repos: [{path: ~/code/app, worktree: ~/wt/app-task}]');
  } else {
    h.repos.forEach((entry: unknown, i: number) => {
      const at = `repos[${i}]`;
      if (!isObject(entry)) return p.add(`${at} must be a mapping with a "path"`);
      checkKeys(entry, REPO_KEYS, at, p);
      if (typeof entry.path !== 'string' || entry.path.trim() === '') return p.add(`${at}.path is required`);
      const repo: (typeof rawRepos)[number] = { path: entry.path };
      for (const key of ['worktree', 'base', 'branch'] as const) {
        const value = entry[key];
        if (value === undefined || value === null) continue;
        if (typeof value === 'string' && value.trim() !== '') repo[key] = value.trim();
        else p.add(`${at}.${key} must be a non-empty string`);
      }
      if (entry.setup !== undefined && entry.setup !== null) {
        if (Array.isArray(entry.setup) && entry.setup.every((c: unknown) => typeof c === 'string' && c.trim() !== '')) repo.setup = entry.setup as string[];
        else p.add(`${at}.setup must be a list of non-empty shell commands`);
      }
      rawRepos.push(repo);
    });
  }
  const specLinks = parseLinks(h.links, 'links', p);
  const specEnv = parseEnv(h.env, 'env', p);
  let specSetup: string[] | undefined;
  if (h.setup !== undefined && h.setup !== null) {
    if (Array.isArray(h.setup) && h.setup.every((c: unknown) => typeof c === 'string' && c.trim() !== '')) specSetup = h.setup as string[];
    else p.add('setup must be a list of non-empty shell commands');
  }
  let reviewOf: string | undefined;
  if (h.review_of !== undefined && h.review_of !== null) {
    if (typeof h.review_of === 'string' && TASK_ID.test(h.review_of)) reviewOf = h.review_of;
    else p.add(`review_of must be the task ID of the work under review (e.g. NC-12), got ${JSON.stringify(h.review_of)}`);
  }
  let specReport: string[] = [];
  if (h.report !== undefined && h.report !== null) specReport = parseReportPaths(h.report, 'report', p);
  let pin = false;
  if (h.pin !== undefined && h.pin !== null) {
    if (typeof h.pin === 'boolean') pin = h.pin;
    else p.add('pin must be true or false');
  }
  let specRemote: boolean | undefined;
  if (h.remote_control !== undefined && h.remote_control !== null) {
    if (typeof h.remote_control === 'boolean') specRemote = h.remote_control;
    else p.add('remote_control must be true or false');
  }
  const after: string[] = [];
  const afterVerdicts: Record<string, OutputVerdict[]> = {};
  if (h.after !== undefined && h.after !== null) {
    const list = Array.isArray(h.after) ? h.after : [h.after];
    for (const dep of list) {
      if (typeof dep === 'string' && TASK_ID.test(dep)) {
        if (!after.includes(dep)) after.push(dep);
      } else if (isObject(dep) && typeof dep.task === 'string' && TASK_ID.test(dep.task)) {
        checkKeys(dep, ['task', 'verdict'], 'after', p);
        const values = Array.isArray(dep.verdict) ? dep.verdict : [dep.verdict];
        if (!values.length || !values.every(v => (VERDICTS as readonly unknown[]).includes(v))) p.add('after.verdict must be PASS, PARTIAL, FAIL, BLOCKED or a non-empty list of them');
        else if (after.includes(dep.task)) p.add(`duplicate after task ${dep.task}`);
        else { after.push(dep.task); afterVerdicts[dep.task] = values as OutputVerdict[]; }
      } else p.add(`after must be a task ID or a list of task IDs (e.g. NC-12), got ${JSON.stringify(dep)}`);
    }
  }
  const touches: string[] = [];
  if (h.touches !== undefined && h.touches !== null) {
    const list = Array.isArray(h.touches) ? h.touches : [h.touches];
    for (const glob of list) {
      if (typeof glob === 'string' && glob.trim() !== '') touches.push(glob.trim());
      else p.add(`touches must be a glob or a list of globs (e.g. [src/menu/**, "*.css"]), got ${JSON.stringify(glob)}`);
    }
  }
  let cohort: string | undefined;
  if (h.cohort !== undefined && h.cohort !== null) {
    const problem = cohortNameProblem(h.cohort);
    if (problem) p.add(problem);
    else cohort = (h.cohort as string).normalize('NFC');
  }
  const weight = parseEnumValue(h.weight, ['normal', 'heavy'] as const, 'weight', p) ?? 'normal';
  const priority = parseEnumValue(h.priority, PRIORITIES, 'priority', p) ?? 'normal';
  if (raw.prompt === '') p.add('the prompt is empty (write it below the closing "---" of the header)');

  // Project layer comes from the first repo.
  const firstRepo = rawRepos[0];
  let project: Layer | undefined;
  if (firstRepo) {
    try {
      project = loadProject(resolvePath(firstRepo.path));
    } catch (e) {
      if (e instanceof AgentctlError) p.add(e.message);
      else throw e;
    }
  }

  const inheritedReview = { ...config.review, ...project?.review };
  const explicitReview = h.review !== undefined ? parseReview(h.review, 'spec.review', p) : undefined;
  const reviewEnabled = h.review === false ? false : h.review !== undefined || inheritedReview.default === 'auto';
  const review = reviewEnabled ? { ...inheritedReview, ...explicitReview, default: 'auto' as const } : undefined;
  const agent = specAgent ?? project?.defaults.agent ?? config.defaults.agent;
  if (!agent && h.agent === undefined) {
    p.add(`missing "agent" (one of ${activeProviders(config).join(', ')}); or set defaults.agent in .agentctl.yaml or ${config.path}`);
  }
  const model = specModel ?? project?.defaults.model ?? config.defaults.model ?? 'default';
  const effort = specEffort ?? project?.defaults.effort ?? config.defaults.effort ?? 'high';

  // Remote Control is a Claude Code feature. In the spec it is an order (a codex task that asks for it is an error); as a default it only
  // applies to Claude tasks.
  const remoteDefault = project?.defaults.remoteControl ?? config.defaults.remoteControl ?? false;
  const remote = agent ? provider(agent).capabilities.remoteControl : false;
  if (agent && !isActive(config, agent)) p.add(`provider ${agent} is not enabled; add it to providers: [claude, codex, kimi] in ${config.path}`);
  if (specRemote === true && agent && !remote) p.add(`remote_control: true works for Claude only (${provider(agent).displayName} has no Remote Control); drop the key or use agent: claude`);
  if (agent && remote && (specRemote === true || (specRemote === undefined && remoteDefault))) {
    const flags = config.agents[agent].flags;
    const own = flags.find((f) => f === '--remote-control' || f === '--rc' || f === 'remote-control');
    if (own) p.add(`remote_control: true, but agents.claude.flags in ${config.path} already has ${own}: use one of them (the server mode "remote-control" refuses the settings of the event hooks)`);
  }

  p.throwIfAny(`${label(raw)} is invalid:`, 'Run "agentctl spec example" to see the format.');

  const taskId = task as string;
  const vars = { task: taskId, cache: config.cache };
  let fill = (s: string): string => fillPlaceholders(s, vars);
  const pathOf = (s: string): string => resolvePath(fill(s));

  const repos: ResolvedRepo[] = [];
  for (const repo of rawRepos) {
    const repoPath = resolvePath(repo.path);
    let projectOfRepo: Layer | undefined = project;
    if (repo !== firstRepo) {
      try {
        projectOfRepo = loadProject(repoPath);
      } catch (e) {
        if (e instanceof AgentctlError) p.add(e.message);
        else throw e;
      }
    }
    const root = projectOfRepo?.worktreeRoot ?? config.worktreeRoot;
    let worktree: string | undefined;
    if (repo.worktree) worktree = pathOf(repo.worktree);
    else if (root) worktree = path.join(pathOf(root), `${path.basename(repoPath)}-${windowName(taskId)}`);
    else {
      p.add(
        `repos: no worktree for ${repo.path}: set "worktree" in the spec or "worktree_root" in ${repoPath}/.agentctl.yaml or ${config.path}`,
      );
      continue;
    }
    const resolved: ResolvedRepo = { path: repoPath, worktree };
    if (repo.base) resolved.base = repo.base;
    if (repo.branch) resolved.branch = repo.branch;
    // Own setup of this repository: its spec entry, then (first repository) the spec's top-level setup, then the repository's own project config.
    const own = repo.setup ?? (repo === firstRepo ? specSetup : undefined) ?? projectOfRepo?.setup ?? (repo === firstRepo ? config.setup : undefined);
    if (own && own.length > 0) resolved.setup = own.map(c => c);
    repos.push(resolved);
  }
  for (let i = 0; i < repos.length; i++) {
    const r = repos[i] as ResolvedRepo;
    if (r.worktree === r.path) p.add(`repos[${i}]: the worktree must differ from the repository itself (${r.path})`);
  }
  p.throwIfAny(`${label(raw)} is invalid:`, 'Run "agentctl spec example" to see the format.');

  const basicFill = fill;
  fill = (text: string): string => basicFill(text.replace(/\{worktree:([^{}|]+)(?:\|([^{}]+))?\}/g, (_match, name: string, fallback: string | undefined) => {
    const matches = repos.filter(r => path.basename(r.path) === name);
    if (matches.length > 1) throw new AgentctlError(`${taskId}: ambiguous worktree repository "${name}"`);
    if (matches[0]) return matches[0].worktree;
    if (fallback) return resolvePath(basicFill(fallback));
    throw new AgentctlError(`${taskId}: no repository "${name}" for {worktree:${name}}; add it to repos or provide {worktree:${name}|~/fallback}`);
  }));
  for (const r of repos) if (r.setup) r.setup = r.setup.map(fill);
  // Links: later layers win for the same `from`.
  const linkByFrom = new Map<string, Link>();
  for (const link of [...config.links, ...(project?.links ?? []), ...specLinks]) {
    const expanded = fill(link.from);
    const from = path.isAbsolute(expanded) ? path.relative(repos[0]!.worktree, expanded) : expanded;
    if (path.isAbsolute(expanded) && !from.startsWith('../')) validateLink(from, pathOf(link.to), repos[0]!.worktree);
    if (!from || from === '.' || from.startsWith('../')) throw new AgentctlError(`${taskId}: link from must stay inside the primary worktree: ${expanded}`, missingLinkTargets([{ from: expanded, to: pathOf(link.to) }]).join('; ') || undefined);
    validateLink(from, pathOf(link.to), repos[0]!.worktree);
    linkByFrom.set(from, { from, to: pathOf(link.to) });
  }

  // Env: spec > project > global.
  const env: Record<string, string> = {};
  for (const layerEnv of [config.env, project?.env ?? {}, specEnv]) {
    for (const [key, value] of Object.entries(layerEnv)) {
      const filled = fill(value);
      env[key] = filled === '~' || filled.startsWith('~/') ? resolvePath(filled) : filled;
    }
  }

  const reportLayer = specReport.length > 0 ? { first: specReport[0], alt: specReport.slice(1) } : project?.report ? { first: project.report, alt: project.reportAlt ?? [] } : config.report ? { first: config.report, alt: config.reportAlt ?? [] } : undefined;
  const reportTemplate = reportLayer?.first ?? '{cache}/{task}/{TASK}.md';
  const reportAlt = (reportLayer?.alt ?? []).map((a) => {
    const filled = fill(a);
    return filled === '~' || filled.startsWith('~/') ? resolvePath(filled) : filled;
  });
  const spec: ResolvedSpec = {
    index: raw.index,
    task: taskId,
    window: windowName(taskId),
    agent: agent as AgentName,
    model,
    effort,
    repos,
    links: [...linkByFrom.values()],
    setup: repos[0]?.setup ?? [],
    env,
    report: pathOf(reportTemplate),
    prompt: raw.prompt,
    pin,
    priority,
    weight,
    after,
    ...(Object.keys(afterVerdicts).length ? { afterVerdicts } : {}),
    touches,
    requested: { agent: agent as AgentName, model, effort },
  };
  if (reviewOf) spec.reviewOf = reviewOf;
  if (review) spec.review = review;
  if (agent && remote && (specRemote ?? remoteDefault)) spec.remoteControl = true;
  if (cohort) spec.cohort = cohort;
  if (reportAlt.length > 0) spec.reportAlt = reportAlt;
  validateLaunch(config, spec, spec.env);
  return spec;
}
