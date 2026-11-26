import { AsyncLocalStorage } from 'node:async_hooks';

export const commandStage = new AsyncLocalStorage<{ deadline: number; signal?: AbortSignal }>();

/** Share one deadline across all commands of a start phase, including nested Runner clients. */
export function withCommandStage<T>(timeoutMs: number, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  const parent = commandStage.getStore();
  const signals = [parent?.signal, signal].filter(s => s !== undefined);
  return commandStage.run({
    deadline: Math.min(Date.now() + timeoutMs, parent?.deadline ?? Infinity),
    signal: signals.length ? AbortSignal.any(signals) : undefined,
  }, run);
}

export function commandStageRemaining(): number {
  const stage = commandStage.getStore();
  return stage?.signal?.aborted ? 0 : stage ? Math.max(0, stage.deadline - Date.now()) : Infinity;
}
