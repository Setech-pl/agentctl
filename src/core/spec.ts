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
} from './config.ts';
import type { AgentName, Effort, GlobalConfig, Layer, Link } from './config.ts';
import { AgentctlError, Problems, TASK_ID, errorMessage, fillPlaceholders, isObject, resolvePath, windowName } from './util.ts';

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
  branch?: string;
}

export interface ResolvedSpec {
  index: number;
  task: string;
  window: string;
  agent: AgentName;
  model: string;
  effort: Effort;
  repos: ResolvedRepo[];
  links: Link[];
  env: Record<string, string>;
  reviewOf?: string;
  report: string;
  prompt: string;
}

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

const SPEC_KEYS = ['task', 'agent', 'model', 'effort', 'repos', 'links', 'env', 'review_of', 'report'];

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
  const specAgent = parseEnumValue(h.agent, AGENT_NAMES, 'agent', p);
  const specEffort = parseEnumValue(h.effort, EFFORTS, 'effort', p);
  let specModel: string | undefined;
  if (h.model !== undefined && h.model !== null) {
    if (typeof h.model === 'string' && h.model.trim() !== '') specModel = h.model.trim();
    else p.add('model must be a non-empty string (or omit it for the agent default)');
  }

  // Repos
  const rawRepos: { path: string; worktree?: string; base?: string; branch?: string }[] = [];
  if (!Array.isArray(h.repos) || h.repos.length === 0) {
    p.add('"repos" must list at least one repository: repos: [{path: ~/code/app, worktree: ~/wt/app-task}]');
  } else {
    h.repos.forEach((entry: unknown, i: number) => {
      const at = `repos[${i}]`;
      if (!isObject(entry)) return p.add(`${at} must be a mapping with a "path"`);
      checkKeys(entry, ['path', 'worktree', 'base', 'branch'], at, p);
      if (typeof entry.path !== 'string' || entry.path.trim() === '') return p.add(`${at}.path is required`);
      const repo: (typeof rawRepos)[number] = { path: entry.path };
      for (const key of ['worktree', 'base', 'branch'] as const) {
        const value = entry[key];
        if (value === undefined || value === null) continue;
        if (typeof value === 'string' && value.trim() !== '') repo[key] = value.trim();
        else p.add(`${at}.${key} must be a non-empty string`);
      }
      rawRepos.push(repo);
    });
  }
  const specLinks = parseLinks(h.links, 'links', p);
  const specEnv = parseEnv(h.env, 'env', p);
  let reviewOf: string | undefined;
  if (h.review_of !== undefined && h.review_of !== null) {
    if (typeof h.review_of === 'string' && TASK_ID.test(h.review_of)) reviewOf = h.review_of;
    else p.add(`review_of must be the task ID of the work under review (e.g. NC-12), got ${JSON.stringify(h.review_of)}`);
  }
  let specReport: string | undefined;
  if (h.report !== undefined && h.report !== null) {
    if (typeof h.report === 'string' && h.report.trim() !== '') specReport = h.report;
    else p.add('report must be a path');
  }
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

  const agent = specAgent ?? project?.defaults.agent ?? config.defaults.agent;
  if (!agent && h.agent === undefined) {
    p.add(`missing "agent" (one of ${AGENT_NAMES.join(', ')}); or set defaults.agent in .agentctl.yaml or ${config.path}`);
  }
  const model = specModel ?? project?.defaults.model ?? config.defaults.model ?? 'default';
  const effort = specEffort ?? project?.defaults.effort ?? config.defaults.effort ?? 'high';

  p.throwIfAny(`${label(raw)} is invalid:`, 'Run "agentctl spec example" to see the format.');

  const taskId = task as string;
  const vars = { task: taskId, cache: config.cache };
  const fill = (s: string): string => fillPlaceholders(s, vars);
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
    repos.push(resolved);
  }
  for (let i = 0; i < repos.length; i++) {
    const r = repos[i] as ResolvedRepo;
    if (r.worktree === r.path) p.add(`repos[${i}]: the worktree must differ from the repository itself (${r.path})`);
  }
  p.throwIfAny(`${label(raw)} is invalid:`, 'Run "agentctl spec example" to see the format.');

  // Links: later layers win for the same `from`.
  const linkByFrom = new Map<string, Link>();
  for (const link of [...config.links, ...(project?.links ?? []), ...specLinks]) {
    const from = fill(link.from);
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

  const reportTemplate = specReport ?? project?.report ?? config.report ?? '{cache}/{task}/{TASK}.md';
  const spec: ResolvedSpec = {
    index: raw.index,
    task: taskId,
    window: windowName(taskId),
    agent: agent as AgentName,
    model,
    effort,
    repos,
    links: [...linkByFrom.values()],
    env,
    report: pathOf(reportTemplate),
    prompt: raw.prompt,
  };
  if (reviewOf) spec.reviewOf = reviewOf;
  return spec;
}
