import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentName, GlobalConfig } from './config.ts';
import { emptyStats, feedText, localDay } from './usage-parse.ts';
import type { PlanSnapshot, SessionStats } from './usage-parse.ts';
import { isObject } from './util.ts';

/*
 * Where the agents' logs are, and a cache of what was read from them. A session log only grows, so a file is read on from the byte
 * where the last read stopped: `watch`, the board and the tmux status line can all ask every few seconds without parsing megabytes again.
 */

/** Claude's config directory and Codex's home: the config, else the environment, else the default. */
export function agentHomes(config: Pick<GlobalConfig, 'usage'>, env: Record<string, string | undefined> = process.env): Record<AgentName, string> {
  return {
    claude: config.usage.claudeDir ?? env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'),
    codex: config.usage.codexDir ?? env.CODEX_HOME ?? path.join(os.homedir(), '.codex'),
  };
}

/** The directory of agentctl's own files (`config.yaml` sits in it). */
export const homeDir = (config: Pick<GlobalConfig, 'path'>): string => path.dirname(config.path);

/** How Claude names the folder of a working directory under `projects/`: every character that is not a letter or a digit becomes "-". */
export const claudeProjectName = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-');

export interface SessionMeta {
  id: string | null;
  cwd: string | null;
  firstAt: number | null;
}

interface CachedFile {
  size: number;
  offset: number;
  stats: SessionStats;
}

interface CachedPlan {
  signature: string;
  snapshot: PlanSnapshot | null;
}

interface CacheData {
  v: 2;
  meta: Record<string, SessionMeta>;
  files: Record<string, CachedFile>;
  plans: Record<string, CachedPlan>;
}

const CHUNK = 16 * 1024 * 1024;
const META_BYTES = 512 * 1024;
const TAIL_BYTES = 256 * 1024;

const emptyCache = (): CacheData => ({ v: 2, meta: {}, files: {}, plans: {} });

export function cachePath(config: Pick<GlobalConfig, 'path'>): string {
  return path.join(homeDir(config), 'usage-cache.json');
}

function readRange(file: string, from: number, length: number): string {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, from);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** The reader with its cache. One per command; `save()` writes the cache back when something new was read. */
export class UsageReader {
  private readonly file: string | undefined;
  private data: CacheData;
  private dirty = false;
  /** Directory listings of this run: the same folder is asked for by several tasks. */
  private readonly listings = new Map<string, string[]>();

  constructor(file: string | undefined) {
    this.file = file;
    this.data = emptyCache();
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (isObject(parsed) && parsed.v === 2 && isObject(parsed.meta) && isObject(parsed.files) && isObject(parsed.plans)) this.data = parsed as unknown as CacheData;
    } catch {
      // no cache yet, or an unreadable one: it is made again
    }
  }

  /** Names in a directory (files only when `ext` is given), cached for this run; empty when it is not there. */
  list(dir: string, ext?: string): string[] {
    const key = `${dir}|${ext ?? ''}`;
    let names = this.listings.get(key);
    if (!names) {
      try {
        names = fs.readdirSync(dir).filter((n) => ext === undefined || n.endsWith(ext)).sort();
      } catch {
        names = [];
      }
      this.listings.set(key, names);
    }
    return names;
  }

  /** Session id, working directory and start of a session log, read from its first lines once. */
  meta(file: string, provider: AgentName): SessionMeta | undefined {
    const cached = this.data.meta[file];
    if (cached) return cached;
    let text: string;
    try {
      text = readRange(file, 0, META_BYTES);
    } catch {
      return undefined;
    }
    const probe = emptyStats(provider);
    // Only the lines up to the one that names the working directory matter.
    const lines = text.split('\n');
    lines.pop(); // the last one may be cut
    for (const line of lines) {
      if (line === '') continue;
      feedText(probe, `${line}\n`);
      if (probe.cwd !== null && probe.id !== null && probe.firstAt !== null) break;
    }
    if (probe.cwd === null && probe.id === null) return undefined;
    const meta: SessionMeta = { id: probe.id, cwd: probe.cwd, firstAt: probe.firstAt };
    this.data.meta[file] = meta;
    this.dirty = true;
    return meta;
  }

  /** What a session log adds up to, reading only what was appended since the last read. Undefined when the file is not there. */
  stats(file: string, provider: AgentName): SessionStats | undefined {
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      if (this.data.files[file]) {
        delete this.data.files[file];
        this.dirty = true;
      }
      return undefined;
    }
    let entry: CachedFile | undefined = this.data.files[file];
    if (entry && (size < entry.size || entry.stats.provider !== provider)) entry = undefined; // rewritten or shorter: read again from the start
    if (!entry) entry = { size: 0, offset: 0, stats: emptyStats(provider) };
    if (size > entry.offset) {
      let offset = entry.offset;
      while (offset < size) {
        const text = readRange(file, offset, Math.min(CHUNK, size - offset));
        const used = feedText(entry.stats, text);
        if (used === 0) break; // no complete line yet
        offset += used;
      }
      entry.offset = offset;
      entry.size = size;
      this.data.files[file] = entry;
      this.dirty = true;
    } else if (!this.data.files[file]) {
      this.data.files[file] = entry;
      this.dirty = true;
    }
    return entry.stats;
  }

  /** The newest plan state in the tail of the most recently written Codex session logs; undefined when none says anything. */
  codexPlan(codexHome: string, now: number): PlanSnapshot | undefined {
    const files = this.recentCodexFiles(codexHome, now, 12);
    const signature = files.map((f) => `${f.file}:${f.size}:${Math.floor(f.mtimeMs)}`).join('|');
    const cached = this.data.plans[codexHome];
    if (cached && cached.signature === signature) return cached.snapshot ?? undefined;
    let best: PlanSnapshot | null = null;
    for (const f of files) {
      const probe = emptyStats('codex');
      try {
        const from = Math.max(0, f.size - TAIL_BYTES);
        const text = readRange(f.file, from, Math.min(TAIL_BYTES, f.size));
        feedText(probe, from > 0 ? text.slice(text.indexOf('\n') + 1) : text);
      } catch {
        continue;
      }
      if (probe.plan && (best === null || probe.plan.at > best.at)) best = probe.plan;
    }
    this.data.plans[codexHome] = { signature, snapshot: best };
    this.dirty = true;
    return best ?? undefined;
  }

  private recentCodexFiles(codexHome: string, now: number, count: number): { file: string; size: number; mtimeMs: number }[] {
    const found: { file: string; size: number; mtimeMs: number }[] = [];
    // The last three days are enough: a plan reading older than that says nothing about the window now.
    for (let back = 0; back < 3; back++) {
      const d = localDay(now - back * 86_400_000).split('-');
      const dir = path.join(codexHome, 'sessions', ...d);
      for (const name of this.list(dir, '.jsonl')) {
        if (!name.startsWith('rollout-')) continue;
        const file = path.join(dir, name);
        try {
          const st = fs.statSync(file);
          found.push({ file, size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          // gone meanwhile
        }
      }
    }
    return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, count);
  }

  /** Session logs of Codex written on or after the day of `sinceMs`. */
  codexSessions(codexHome: string, sinceMs: number, now: number): string[] {
    const out: string[] = [];
    const days = Math.max(1, Math.min(120, Math.ceil((now - sinceMs) / 86_400_000) + 1));
    for (let back = 0; back < days; back++) {
      const d = localDay(now - back * 86_400_000).split('-');
      const dir = path.join(codexHome, 'sessions', ...d);
      for (const name of this.list(dir, '.jsonl')) if (name.startsWith('rollout-')) out.push(path.join(dir, name));
    }
    return out;
  }

  /** Transcripts of Claude whose folder under `projects/` belongs to the working directory `cwd` or to a folder below it. */
  claudeSessions(claudeHome: string, cwd: string): string[] {
    const projects = path.join(claudeHome, 'projects');
    const wanted = claudeProjectName(cwd);
    const out: string[] = [];
    for (const name of this.list(projects)) {
      if (name !== wanted && !name.startsWith(`${wanted}-`)) continue;
      const dir = path.join(projects, name);
      for (const f of this.list(dir, '.jsonl')) out.push(path.join(dir, f));
    }
    return out;
  }

  /** The logs of the subagents of a Claude session: `<transcript without .jsonl>/subagents/agent-*.jsonl`. */
  claudeSubagents(transcript: string): string[] {
    const dir = path.join(transcript.replace(/\.jsonl$/, ''), 'subagents');
    return this.list(dir, '.jsonl').map((f) => path.join(dir, f));
  }

  save(): void {
    if (!this.file || !this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch {
      // the cache is an optimisation: a folder that cannot be written only means the next read starts again
    }
  }
}
