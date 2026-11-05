import { codexLogPlan, codexSessions } from './providers/codex-usage.ts';
import { claudeSessions, claudeSubagents } from './providers/claude-usage.ts';
import { provider as adapter, perProvider, PROVIDER_IDS } from './providers/registry.ts';
import { atomicWriteFile } from './atomic-file.ts';
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
export function agentHomes(config: Pick<GlobalConfig, 'usage'> & Partial<Pick<GlobalConfig, 'agents'>>, env: Record<string, string | undefined> = process.env): Record<AgentName, string> {
  return perProvider(PROVIDER_IDS, id => adapter(id).usage.home(config, env));
}

/** The directory of agentctl's own files (`config.yaml` sits in it). */
export const homeDir = (config: Pick<GlobalConfig, 'path'>): string => path.dirname(config.path);

/** How Claude names the folder of a working directory under `projects/`: every character that is not a letter or a digit becomes "-". */
export { claudeProjectName } from './providers/claude-usage.ts';

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

export function readRange(file: string, from: number, length: number): string {
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

  /** Compatibility wrapper; provider owns the log layout and parsing. */
  codexPlan(home: string, now: number): PlanSnapshot | undefined { return codexLogPlan(this, home, now); }

  cachedPlan(key: string, signature: string, read: () => PlanSnapshot | undefined): PlanSnapshot | undefined {
    const cached = this.data.plans[key];
    if (cached && cached.signature === signature) return cached.snapshot ?? undefined;
    const snapshot = read(); this.data.plans[key] = { signature, snapshot: snapshot ?? null }; this.dirty = true; return snapshot;
  }

  /** Session logs of Codex written on or after the day of `sinceMs`. */
  codexSessions(home: string, since: number, now: number): string[] { return codexSessions(this, home, since, now); }

  /** Transcripts of Claude whose folder under `projects/` belongs to the working directory `cwd` or to a folder below it. */
  claudeSessions(home: string, cwd: string): string[] { return claudeSessions(this, home, cwd); }

  /** The logs of the subagents of a Claude session: `<transcript without .jsonl>/subagents/agent-*.jsonl`. */
  claudeSubagents(file: string): string[] { return claudeSubagents(this, file); }

  save(): void {
    if (!this.file || !this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      atomicWriteFile(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch {
      // the cache is an optimisation: a folder that cannot be written only means the next read starts again
    }
  }
}
