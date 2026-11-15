import type { AgentName, GlobalConfig } from './config.ts';

export function checkHostLimit(config: GlobalConfig, task: { host?: string; agent: AgentName }, live: readonly { host?: string; agent?: AgentName; counted?: boolean }[]): string | undefined {
  if (!task.host) return undefined;
  const limit = config.hosts[task.host]?.limits?.[task.agent];
  if (limit === undefined) return undefined;
  const used = live.filter(w => w.host === task.host && w.agent === task.agent && w.counted !== false).length;
  return used >= limit ? `host ${task.host} limit reached: ${task.agent} ${used}/${limit}; wait for a slot or queue the task` : undefined;
}
