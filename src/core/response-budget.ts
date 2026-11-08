import { AsyncLocalStorage } from 'node:async_hooks';
import type { Runner } from './runner.ts';

export const RESPONSE_BUDGET_MS = 8000;
export interface BudgetClock {
  now(): number;
  schedule(expire: () => void, ms: number): () => void;
}
const clock: BudgetClock = {
  now: Date.now,
  schedule(expire, ms) { const timer = setTimeout(expire, ms); return () => clearTimeout(timer); },
};
interface Request { deadline: number; clock: BudgetClock; expired: boolean }
const requests = new AsyncLocalStorage<Request>();
export const cachedRequest = (): boolean => requests.getStore() !== undefined;
export function checkResponseBudget(): void {
  const request = requests.getStore();
  if (request && (request.expired || request.clock.now() >= request.deadline)) throw new Error('Partial result: response budget exhausted; no further work in this request.');
}
/** Expiry stops future effects as well as returning a bounded response. */
export async function withResponseBudget<T>(body: () => Promise<T>, partial: () => T, timer: BudgetClock = clock): Promise<T> {
  const request: Request = { deadline: timer.now() + RESPONSE_BUDGET_MS, clock: timer, expired: false };
  let cancel = () => {};
  const expired = new Promise<T>(resolve => { cancel = timer.schedule(() => { request.expired = true; resolve(partial()); }, RESPONSE_BUDGET_MS); });
  try { return await requests.run(request, () => Promise.race([Promise.resolve().then(body).then(result => {
      if (request.expired || timer.now() >= request.deadline) { request.expired = true; return partial(); }
      return result;
    }), expired])); }
  finally { cancel(); }
}
/** Contexts can outlive a request; consult async-local ownership on every operation. */
export function budgetRunner(runner: Runner): Runner {
  return new Proxy(runner, { get(target, key) {
    const value = Reflect.get(target, key);
    if (typeof value !== 'function') return value;
    if (key === 'now' || key === 'note') return value.bind(target);
    return async (...args: unknown[]) => {
      checkResponseBudget();
      if (key === 'exec' && requests.getStore()) {
        const request = requests.getStore()!;
        const opts = (args[2] ?? {}) as { timeoutMs?: number };
        args[2] = { ...opts, timeoutMs: Math.max(1, Math.min(opts.timeoutMs ?? RESPONSE_BUDGET_MS, request.deadline - request.clock.now())) };
      }
      const result = await value.apply(target, args);
      checkResponseBudget();
      return result;
    };
  } });
}
