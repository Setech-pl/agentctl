import fs from 'node:fs';
import path from 'node:path';
import type { EventSupport, RawEvent } from './types.ts';
import type { AgentEvent } from '../events.ts';
import { isObject } from '../util.ts';
import { UsageReader, readRange } from '../usage-sources.ts';
import { kimiSessions, wireObject, wirePayload, wireProtocol } from './kimi-usage.ts';
import { kimiHome } from './kimi-config.ts';
import { readTaskSessions, sessionsFile } from '../usage.ts';
import { setHeaderField, taskDir, taskFile } from '../taskstore.ts';

/** Only supported name/message wrappers count as an error; unknown shapes use the screen. */
function errorText(value: unknown, depth = 0): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (!isObject(value) || depth > 4) return undefined;
  const parts = ['name', 'message', 'error', 'cause'].map(key => errorText(value[key], depth + 1)).filter(Boolean);
  return parts.length ? parts.join(' ') : undefined;
}

/** Event names/protocol from bundle; interaction shape and session layout are synthetic hypotheses. */
export function parseKimiEvent(e: RawEvent): AgentEvent | undefined {
  if (!isObject(e.payload)) return undefined;
  const event = wirePayload(e.payload), type = String(event.type ?? ''), data = isObject(event.data) ? event.data : event;
  let outcome: AgentEvent['outcome'] = 'ignored';
  if (type === 'interaction.request') outcome = 'needs-input';
  if (type === 'interaction.resolved') outcome = 'idle';
  if (type === 'turn.ended') {
    const error = errorText(data.error);
    outcome = data.error != null ? (error ? 'error' : 'ignored') : data.reason === 'failed' ? 'error' : 'turn-complete';
    if (error && /quota|rate[_ -]?limit/i.test(error)) outcome = 'limited';
    if (error && /overloaded/i.test(error)) outcome = 'overloaded';
  }
  return { agent: 'kimi', type, outcome, text: '' };
}
export const kimiEvents: EventSupport = {
  emits: { turnEnd: true, needsInput: true, limit: true, overload: true, promptSubmit: true },
  kinds: [], payloadFrom: 'wire',
  plan: () => ({ args: [], files: [], note: 'events: Kimi passive wire protocol 1.5 (session paths/interactions are hypotheses); no hooks installed' }),
  parse: parseKimiEvent,
  session(e) { const data = isObject(e.payload) ? e.payload : {}; return typeof data.session_id === 'string' ? { id: data.session_id } : undefined; },
  acknowledgesPrompt(e) {
    if (!isObject(e.payload)) return false;
    const event = wirePayload(e.payload), data = isObject(event.data) ? event.data : event;
    return event.type === 'turn.prompt' && typeof data.prompt === 'string' && data.prompt.replace(/\r\n?/g, '\n').trim() === e.prompt?.replace(/\r\n?/g, '\n').trim();
  },
  async poll(ctx, record) {
    if (ctx.runner.dryRun) return;
    const dir = taskDir(ctx.config, record.window), cursorFile = path.join(dir, 'kimi-wire-cursor.json');
    let cursors: Record<string, { offset: number; protocol?: string }> = {};
    try { cursors = JSON.parse(fs.readFileSync(cursorFile, 'utf8')); } catch { /* first poll */ }
    const sessions = readTaskSessions(ctx.config, record.window);
    const home = ctx.config.usage.kimiDir ?? kimiHome({ ...process.env, ...record.env });
    const files = kimiSessions(new UsageReader(undefined), home, record, record.repos.map(r => r.worktree), sessions.kimi ?? []);
    let dirty = false;
    for (const { file } of files.sort((a, b) => (a.firstAt ?? 0) - (b.firstAt ?? 0))) {
      let size: number; try { size = fs.statSync(file).size; } catch { continue; }
      const cursor = cursors[file] && cursors[file]!.offset <= size ? cursors[file]! : { offset: 0 };
      const text = readRange(file, cursor.offset, Math.min(size - cursor.offset, 512 * 1024));
      const end = text.lastIndexOf('\n');
      if (end < 0) continue;
      for (const line of text.slice(0, end).split('\n')) {
        const o = wireObject(line);
        if (!o) continue;
        const protocol = wireProtocol(o);
        if (protocol !== undefined) {
          cursor.protocol = protocol;
          if (protocol !== '1.5') await ctx.runner.remove(path.join(dir, 'event.json'));
          await ctx.runner.writeFile(path.join(dir, 'kimi-wire-status.json'), JSON.stringify({ protocol, supported: protocol === '1.5', note: protocol === '1.5' ? 'session layout/interactions are hypotheses' : 'unknown protocol; screen only' }));
        }
        if (cursor.protocol !== '1.5') continue;
        const event = parseKimiEvent({ payload: o });
        const at = typeof o.timestamp === 'string' ? o.timestamp : '';
        if (!event || !Number.isFinite(Date.parse(at)) || Date.parse(at) < Date.parse(record.attemptStarted ?? record.started)) continue;
        if (event.outcome !== 'ignored') await ctx.runner.writeFile(path.join(dir, 'event.json'), JSON.stringify({ outcome: event.outcome === 'idle' ? 'turn-complete' : event.outcome, type: event.type, at, text: '' }));
        if (event.type === 'turn.ended' && event.outcome === 'ignored') await ctx.runner.remove(path.join(dir, 'event.json'));
        if (event.type === 'turn.ended') await setHeaderField(ctx.runner, taskFile(ctx.config, record.window), 'turn_ended_at', event.outcome === 'turn-complete' ? at : null);
        if (record.deliveryId && record.deliveryStartedAt && Date.parse(at) >= Date.parse(record.deliveryStartedAt) && kimiEvents.acknowledgesPrompt?.({ payload: o, prompt: record.pendingPrompt ?? '' })) await ctx.runner.writeFile(path.join(dir, 'delivery-evidence.json'), JSON.stringify({ deliveryId: record.deliveryId, at, accepted: true, type: 'turn.prompt' }));
        const ref = kimiEvents.session({ payload: o });
        if (ref && !(sessions.kimi ?? []).some(s => s.id === ref.id)) { (sessions.kimi ??= []).push(ref); await ctx.runner.writeFile(sessionsFile(ctx.config, record.window), JSON.stringify(sessions)); }
      }
      cursor.offset += Buffer.byteLength(text.slice(0, end + 1)); cursors[file] = cursor; dirty = true;
    }
    if (dirty) await ctx.runner.writeFile(cursorFile, JSON.stringify(cursors));
  },
};
