import { AsyncLocalStorage } from 'node:async_hooks';
import { checkReportPath } from './report-path.ts';
import { remoteMirrorScript } from './host-mirror.ts';
import { codexMessages } from './transcript.ts';
import { sameMessage } from './paste-wrapper.ts';
import { kimiEvents } from './providers/kimi-events.ts';
import { wireObject, wireProtocol, wireTime } from './providers/kimi-usage.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { Context } from './context.ts';
import type { GlobalConfig } from './config.ts';
import { HostRunner, HostUnreachable } from './host-runner.ts';
import { knownIcons } from './icons.ts';
import type { Runner } from './runner.ts';
import { cachedRequest } from './response-budget.ts';
import { listTaskRecords, readTaskRecord, setHeaderField, taskFile } from './taskstore.ts';
import type { TaskRecord } from './taskstore.ts';
import { Tmux } from './tmux.ts';
import type { WindowInfo, Capture } from './tmux.ts';
import { firstConnectCommand } from './hosts.ts';
import { shellQuote } from './util.ts';

const liveHostRequest = new AsyncLocalStorage<'preview' | 'confirm'>();
const observing = () => liveHostRequest.getStore() === 'preview';
/** MCP previews may observe remote panes without updating task records or report mirrors. */
export function observeHostWindows<T>(read: () => Promise<T>): Promise<T> {
  return liveHostRequest.run('preview', read);
}

/** MCP confirmations that run inline must verify the actual pane and delivery. */
export function applyWithLiveHosts<T>(write: () => Promise<T>): Promise<T> {
  return liveHostRequest.run('confirm', write);
}

interface Connection { unreachable: boolean; failures: number; retryAt: number; detail: string; windows: WindowInfo[]; screens?: Record<string, Capture> }

/** Per-context clients, with durable backoff so a watcher restart cannot flood an offline host. */
export class HostRuntime {
  private connections = new Map<string, Connection>();
  readonly runner: Runner;
  readonly config: GlobalConfig;
  constructor(runner: Runner, config: GlobalConfig) { this.runner = runner; this.config = config; }
  hasTrackedHosts(): boolean { return Object.keys(this.config.hosts).length > 0 || this.connections.size > 0 || fs.existsSync(path.join(this.config.stateDir, 'hosts')); }
  async trackHost(name: string): Promise<void> { await this.persist(name); }
  private file(name: string): string { return path.join(this.config.stateDir, 'hosts', `${name}.json`); }
  connection(name: string): Connection {
    let c = this.connections.get(name);
    if (!c) {
      try { c = JSON.parse(fs.readFileSync(this.file(name), 'utf8')); } catch { /* first sample */ }
      if (!c || !Array.isArray(c.windows) || !Number.isFinite(c.retryAt)) c = { unreachable: false, failures: 0, retryAt: 0, detail: '', windows: [] };
      this.connections.set(name, c);
    }
    if (!this.config.hosts[name]) { c.unreachable = true; c.detail = 'host removed from config; restore its hosts: entry'; }
    return c;
  }
  private async persist(name: string): Promise<void> { if (!this.runner.dryRun && !observing()) await this.runner.writeFile(this.file(name), JSON.stringify(this.connection(name))); }
  forHost(name: string): HostRunner {
    const host = this.config.hosts[name];
    if (!host) throw new HostUnreachable(name, 'host removed from config; restore its hosts: entry');
    return new HostRunner(this.runner, name, host, (up, detail) => {
      const c = this.connection(name);
      if (up) { c.unreachable = false; c.failures = 0; c.retryAt = 0; c.detail = ''; }
      else {
        c.unreachable = true; c.detail = detail; c.failures++;
        c.retryAt = this.runner.now() + Math.min(300_000, 5_000 * 2 ** Math.min(c.failures - 1, 6));
        return this.persist(name);
      }
    });
  }
  tmux(name: string): Tmux {
    return new Tmux(this.forHost(name), `agentctl-${name}`, { taskRoles: true, icons: knownIcons(this.config.watch.windowIcons), idFor: window => readTaskRecord(this.config, window)?.windowId });
  }
  cachedCapture(name: string, window: string): Capture {
    return this.connection(name).screens?.[window] ?? { code: 1, stdout: '', stderr: 'No host screen sample yet; leave watch running' };
  }
  async rememberCapture(name: string, window: string, screen: Capture): Promise<void> {
    if (screen.code !== 0) return;
    (this.connection(name).screens ??= {})[window] = { ...screen, stdout: screen.stdout.slice(-256 * 1024) };
    await this.persist(name);
  }
  async windows(cachedOnly = false, current?: readonly TaskRecord[]): Promise<WindowInfo[]> {
    if (!this.hasTrackedHosts()) return [];
    const records = (current ?? listTaskRecords(this.config)).filter(r => r.host && !r.closed && !r.cancelled);
    const names = [...new Set(records.map(r => r.host!))];
    return (await Promise.all(names.map(async name => {
      const c = this.connection(name);
      if (cachedOnly || cachedRequest() && !liveHostRequest.getStore() || c.unreachable && this.runner.now() < c.retryAt) return c.windows;
      try {
        const discovered = await this.tmux(name).windows();
        c.windows = [];
        for (const record of records.filter(r => r.host === name)) {
          const matches = discovered.filter(w => w.role === record.window || w.plain === record.window);
          if (matches.length !== 1) continue; // ambiguous identity is never adopted
          const found = matches[0]!;
          c.windows.push({ ...found, plain: record.window, host: name });
          if (!observing() && found.id && found.id !== record.windowId) await setHeaderField(this.runner, taskFile(this.config, record.window), 'window_id', found.id);
        }
      }
      catch (error) {
        if (!(error instanceof HostUnreachable)) throw error;
        c.unreachable = true; c.detail = error.message;
        if (!c.retryAt) c.retryAt = this.runner.now() + 5000;
      }
      await this.persist(name);
      return c.windows;
    }))).flat();
  }
}

/** All task-window methods route by the durable record, never by tmux ID (IDs collide across servers). */
export function taskTmux(local: Tmux, hosts: HostRuntime, config: GlobalConfig): Tmux {
  const routed = new Set(['target', 'targetFor', 'newSession', 'newWindow', 'startWindow', 'paneDead', 'respawn', 'typeCommand', 'sendKey', 'pressEnter', 'pasteText', 'submitPrompt', 'capture', 'selectWindow', 'killWindow']);
  return new Proxy(local, {
    get(target, key) {
      if (key === 'windows' || key === 'listWindows') {
        const windows = target.windows.bind(target);
        return async () => { const all = [...await windows(), ...await hosts.windows()]; return key === 'windows' ? all : all.map(w => w.plain); };
      }
      if (typeof key === 'string' && routed.has(key)) {
        const localMethod = Reflect.get(target, key) as Function;
        return (...args: unknown[]) => {
          const window = String(args[0]);
          const host = readTaskRecord(config, window)?.host;
          if (host && key === 'capture' && cachedRequest() && !liveHostRequest.getStore()) return Promise.resolve(hosts.cachedCapture(host, window));
          const client = host ? hosts.tmux(host) : target;
          // A caller may pass the aggregate listing; remote capture/lookup must see only this host's windows.
          if (host && key === 'capture' && Array.isArray(args[2])) args[2] = (args[2] as WindowInfo[]).filter(w => w.host === host);
          if (host && key === 'targetFor' && Array.isArray(args[1])) args[1] = (args[1] as WindowInfo[]).filter(w => w.host === host);
          const result = (host ? client[key as keyof Tmux] as Function : localMethod).apply(client, args);
          if (host && key === 'capture' && !observing()) return Promise.resolve(result).then(async screen => {
            await hosts.rememberCapture(host, window, screen);
            const record = readTaskRecord(config, window);
            if (record) await syncRemoteFiles({ runner: hosts.runner, config, hosts } as Context, record);
            return screen;
          });
          return result;
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function remoteAttachHint(config: GlobalConfig, record: Pick<TaskRecord, 'host' | 'window'> & { windowId?: string }): string | undefined {
  const host = record.host && config.hosts[record.host];
  if (!host) return record.host ? `restore hosts.${record.host} in config` : undefined;
  const id = record.windowId ?? readTaskRecord(config, record.window)?.windowId;
  return `${firstConnectCommand(host).replace(/^ssh /, 'ssh -t ')} ${shellQuote(`tmux attach -t =agentctl-${record.host}:${id ?? record.window}`)}`;
}

/** Canonical report mirror and hook receipts. Missing files are normal; SSH loss is never a missing window. */
export async function syncRemoteFiles(ctx: Context, record: TaskRecord): Promise<boolean> {
  if (!record.host || !record.remoteReport || !record.remoteDir || ctx.runner.dryRun || cachedRequest()) return false;
  const connection = ctx.hosts.connection(record.host);
  if (connection.unreachable && ctx.runner.now() < connection.retryAt) return false;
  const remote = ctx.hosts.forHost(record.host);
  // Read one bounded JSON envelope; files use a rename on the host, so partial transfers cannot replace the mirror.
  const script = remoteMirrorScript(record);
  try {
    const r = await remote.checked('node', ['-e', script], { readOnly: true });
    const data = JSON.parse(r.stdout) as { report?: string; receipt?: string; transcript?: string; wire?: string };
    let changed = false;
    if (typeof data.report === 'string') {
      checkReportPath(ctx.config, record, record.report);
      let previous: string | undefined;
      try { previous = fs.readFileSync(record.report, 'utf8'); } catch { /* no mirror */ }
      if (previous !== data.report) { await ctx.runner.mkdir(path.dirname(record.report)); await ctx.runner.writeFile(record.report, data.report); changed = true; }
    }
    if (typeof data.receipt === 'string') {
      const receipt = JSON.parse(data.receipt);
      if (receipt.attempt === record.attemptId) {
        if (receipt.event?.outcome === 'turn-complete' && typeof receipt.event.at === 'string' && receipt.event.at !== record.turnEndedAt) await setHeaderField(ctx.runner, taskFile(ctx.config, record.window), 'turn_ended_at', receipt.event.at);
        if (receipt.event) await ctx.runner.writeFile(path.join(ctx.config.stateDir, record.window, 'event.json'), JSON.stringify(receipt.event));
        if (receipt.evidence?.deliveryId === record.deliveryId) await ctx.runner.writeFile(path.join(ctx.config.stateDir, record.window, 'delivery-evidence.json'), JSON.stringify({ ...receipt.evidence, at: new Date(ctx.runner.now()).toISOString() }));
      }
    }
    if (record.pendingPrompt && record.deliveryStartedAt && data.transcript && record.agent === 'codex') {
      const seen = codexMessages(data.transcript).some(row => row.at >= Date.parse(record.deliveryStartedAt!) && sameMessage(row.text, record.pendingPrompt!, 'codex'));
      if (seen) await ctx.runner.writeFile(path.join(ctx.config.stateDir, record.window, 'delivery-evidence.json'), JSON.stringify({ deliveryId: record.deliveryId, accepted: true, at: new Date(ctx.runner.now()).toISOString() }));
    }
    if (data.wire && record.agent === 'kimi') {
      let protocol: string | undefined;
      for (const line of data.wire.split('\n')) {
        const row = wireObject(line);
        if (!row) continue;
        protocol = wireProtocol(row) ?? protocol;
        if (protocol !== '1.5') continue;
        const ms = wireTime(row);
        if (ms === null || ms < Date.parse(record.attemptStarted ?? record.started)) continue;
        const at = new Date(ms).toISOString();
        const event = kimiEvents.parse({ payload: row });
        if (event?.outcome === 'turn-complete' && at !== record.turnEndedAt) await setHeaderField(ctx.runner, taskFile(ctx.config, record.window), 'turn_ended_at', at);
        if (event && event.outcome !== 'ignored') await ctx.runner.writeFile(path.join(ctx.config.stateDir, record.window, 'event.json'), JSON.stringify({ outcome: event.outcome === 'idle' ? 'turn-complete' : event.outcome, type: event.type, text: event.text, at }));
        if (record.deliveryStartedAt && ms >= Date.parse(record.deliveryStartedAt) && kimiEvents.acknowledgesPrompt?.({ payload: row, prompt: record.pendingPrompt })) await ctx.runner.writeFile(path.join(ctx.config.stateDir, record.window, 'delivery-evidence.json'), JSON.stringify({ deliveryId: record.deliveryId, accepted: true, at: new Date(ctx.runner.now()).toISOString() }));
      }
    }
    return changed;
  } catch (error) { if (error instanceof HostUnreachable) return false; throw error; }
}

export async function prepareRemoteDelivery(ctx: Context, record: TaskRecord): Promise<void> {
  if (!record.host || !record.remoteDir) return;
  await ctx.hosts.forHost(record.host).writeFile(path.posix.join(record.remoteDir, 'delivery.json'), JSON.stringify({ id: record.deliveryId, prompt: record.pendingPrompt, attempt: record.attemptId }));
}
