import type { AgentName, GlobalConfig } from './config.ts';

export interface HostSlot { host?: string; agent?: AgentName; counted?: boolean; owner?: string; kind?: 'reserved' | 'external' | 'starting'; perf?: boolean; reportReady?: boolean }

export function checkHostLimit(config: GlobalConfig, task: { host?: string; agent: AgentName; perf?: unknown }, live: readonly HostSlot[]): string | undefined {
  const name = task.host ?? 'local';
  const host = task.host ? config.hosts[task.host] : config.localHost;
  const slots = live.filter(w => (w.host ?? 'local') === name && w.agent && w.kind !== 'reserved');
  const running = slots.filter(w => !w.reportReady);
  if (running.some(w => w.perf)) return `host ${name} limit reached: exclusive perf reservation`;
  if (task.perf && running.length) return `host ${name} limit reached: perf waiting for ${running.length} running task(s)`;
  const counted = slots.filter(w => w.counted !== false);
  if (host?.maxTotal !== undefined && counted.length >= host.maxTotal) return `host ${name} limit reached: total ${counted.length}/${host.maxTotal}`;
  const limit = host?.limits?.[task.agent];
  const used = counted.filter(w => w.agent === task.agent).length;
  return limit !== undefined && used >= limit ? `host ${name} limit reached: ${task.agent} ${used}/${limit}; wait for a slot or queue the task` : undefined;
}
