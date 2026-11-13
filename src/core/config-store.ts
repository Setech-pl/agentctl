import { atomicWriteFile } from './atomic-file.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { GlobalConfig } from './config.ts';
import { errorMessage, isObject } from './util.ts';

/*
 * The configuration of a long-running process (`watch`, the MCP server). The file is read again when its text changes; a text that does not
 * load is not applied: the previous configuration stays in force and the problem is reported (watch log, `status`, `doctor`).
 */

export interface ConfigRefresh {
  config: GlobalConfig;
  /** A new configuration came into force with this call. */
  changed: boolean;
  /** The top-level keys that differ from the previous configuration. */
  keys: string[];
  /** This call found a file that does not load (reported once per text); the previous configuration stays. */
  error?: string;
}

const IGNORED = new Set(['path', 'loaded', 'reloadWarning']);

/** Which sections differ: by key of the parsed configuration. */
export function changedKeys(a: GlobalConfig, b: GlobalConfig): string[] {
  const x = a as unknown as Record<string, unknown>;
  const y = b as unknown as Record<string, unknown>;
  return [...new Set([...Object.keys(x), ...Object.keys(y)])].filter((k) => !IGNORED.has(k) && JSON.stringify(x[k]) !== JSON.stringify(y[k]));
}

export class ConfigStore {
  private readonly load: () => GlobalConfig;
  private good: GlobalConfig | undefined;
  private goodText: string | undefined;
  private failedText: string | undefined;
  private warning: string | undefined;
  private file: string | undefined;
  private view: GlobalConfig | undefined;
  /** mtime, size and inode of the file at the last look: an unchanged stamp is not read again (QH: a hand edit changes it). */
  private seen: string | undefined;

  constructor(load: () => GlobalConfig, initial?: GlobalConfig, file?: string) {
    this.load = load;
    this.file = file ?? initial?.path;
    if (initial) {
      this.good = initial;
      this.seen = this.stamp();
      this.goodText = this.read();
    }
  }

  private stamp(): string | undefined {
    if (!this.file) return undefined;
    try {
      const st = fs.statSync(this.file, { bigint: true });
      return `${st.mtimeNs}:${st.size}:${st.ino}`;
    } catch {
      return 'missing';
    }
  }

  private read(): string | undefined {
    if (!this.file) return undefined;
    try {
      return fs.readFileSync(this.file, 'utf8');
    } catch {
      return '';
    }
  }

  /** The configuration in force, carrying the warning when the file on disk does not load. */
  get current(): GlobalConfig {
    if (!this.good) throw new Error('the configuration was not loaded yet');
    this.view ??= this.warning ? { ...this.good, reloadWarning: this.warning } : this.good;
    return this.view;
  }

  /** Look at the file. The first call (nothing loaded yet) loads it and throws when it cannot. */
  refresh(): ConfigRefresh {
    const stamp = this.stamp();
    if (this.good && stamp !== undefined && stamp === this.seen) return { config: this.current, changed: false, keys: [] };
    this.seen = stamp;
    const text = this.read();
    if (this.good && text !== undefined && text === (this.failedText ?? this.goodText)) return { config: this.current, changed: false, keys: [] };
    try {
      const next = this.load();
      const keys = this.good ? changedKeys(this.good, next) : [];
      this.file = next.path;
      this.good = next;
      this.goodText = this.read();
      this.failedText = undefined;
      this.warning = undefined;
      this.view = undefined;
      return { config: this.current, changed: keys.length > 0, keys };
    } catch (e) {
      if (!this.good) throw e;
      this.failedText = text;
      this.view = undefined;
      this.warning = `config.yaml does not load, the previous settings stay in force: ${errorMessage(e).split('\n').filter(Boolean).slice(0, 3).join(' ')}`;
      return { config: this.current, changed: false, keys: [], error: this.warning };
    }
  }
}

// ---- what the long-running processes tell the others

export interface ConfigState {
  ok: boolean;
  /** ISO time of the check. */
  at: string;
  /** Who saw it: `watch` or `mcp`. */
  by: string;
  error?: string;
}

export const configStatePath = (config: Pick<GlobalConfig, 'path'>): string => path.join(path.dirname(config.path), 'config-state.json');

export function readConfigState(file: string): ConfigState | undefined {
  try {
    const d: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (isObject(d) && typeof d.ok === 'boolean' && typeof d.at === 'string') return d as unknown as ConfigState;
  } catch {
    // none yet
  }
  return undefined;
}

/** Record the outcome of a reload so that `doctor` and the CLI can say that a process keeps the previous settings. Written only when it changes. */
export function noteConfigState(file: string, by: string, nowMs: number, error: string | undefined): void {
  const was = readConfigState(file);
  if (was && was.ok === (error === undefined) && was.error === error) return;
  if (!was && error === undefined) return;
  const state: ConfigState = { ok: error === undefined, at: new Date(nowMs).toISOString(), by, ...(error ? { error } : {}) };
  atomicWriteFile(file, `${JSON.stringify(state, null, 2)}\n`);
}
