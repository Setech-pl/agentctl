import { provider } from './providers/registry.ts';
import type { GlobalConfig } from './config.ts';
import type { TaskRecord } from './taskstore.ts';

/** Session text is supplied only by the task's provider. */
export function sessionQuestion(config: GlobalConfig, record: TaskRecord): string | undefined {
  return record.agent === 'unknown' ? undefined : provider(record.agent).screen.sessionQuestion?.(config, record);
}
