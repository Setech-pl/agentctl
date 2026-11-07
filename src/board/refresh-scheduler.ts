/** One serialized refresh operation shared by initial, periodic, watch and manual requests. */
export interface RefreshClock {
  set(callback: () => void, delay: number): unknown;
  clear(timer: unknown): void;
}
const clock: RefreshClock = {
  set: (callback, delay) => setTimeout(callback, delay),
  clear: (timer) => clearTimeout(timer as NodeJS.Timeout),
};

export class RefreshScheduler {
  private stopped = false;
  private running = false;
  private again = false;
  private timer: unknown;
  private refresh: () => Promise<void>;
  private delay: () => number;
  private onError: (error: unknown) => void;
  private clock: RefreshClock;
  constructor(refresh: () => Promise<void>, delay: () => number,
    onError: (error: unknown) => void, timerClock: RefreshClock = clock) {
    this.refresh = refresh; this.delay = delay; this.onError = onError; this.clock = timerClock;
  }

  start(): void { this.request(); }
  request(): void {
    if (this.stopped) return;
    // Every source supersedes the old deadline, including watch/manual requests.
    if (this.timer !== undefined) this.clock.clear(this.timer);
    this.timer = undefined;
    void this.tick();
  }
  private arm(): void {
    if (!this.stopped) this.timer = this.clock.set(() => {
      this.timer = undefined;
      this.request();
    }, this.delay());
  }
  private async tick(): Promise<void> {
    if (this.running) { this.again = true; return; }
    this.running = true;
    try {
      do {
        this.again = false;
        try { await this.refresh(); } catch (error) { this.onError(error); }
      } while (this.again && !this.stopped);
    } finally {
      this.running = false;
      this.arm();
    }
  }
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) this.clock.clear(this.timer);
    this.timer = undefined;
  }
}
