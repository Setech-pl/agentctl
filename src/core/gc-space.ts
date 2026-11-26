import { setTimeout as wait } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';

/** Measure the net change in space available on each affected filesystem. */
export class GcSpace {
  private readonly volumes = new Map<number, { directory: string; before?: number }>();

  private async available(directory: string): Promise<number | undefined> {
    const timer = new AbortController();
    try {
      const stat = await Promise.race([fs.promises.statfs(directory), wait(1500, undefined, { signal: timer.signal })]);
      return stat && Number(stat.bavail) * Number(stat.bsize);
    } catch { return undefined; }
    finally { timer.abort(); }
  }

  async before(target: string): Promise<void> {
    try {
      let directory = fs.realpathSync(path.dirname(target));
      const dev = fs.lstatSync(target).dev;
      if (this.volumes.has(dev) || fs.statSync(directory).dev !== dev) return;
      for (let parent = path.dirname(directory); parent !== directory && fs.statSync(parent).dev === dev; parent = path.dirname(directory)) directory = parent;
      this.volumes.set(dev, { directory, before: await this.available(directory) });
    } catch { /* a missing sample cannot prove reclaimed space */ }
  }

  async freed(): Promise<number> {
    let freed = 0;
    for (const [dev, { directory, before }] of this.volumes) {
      try {
        if (before === undefined || fs.statSync(directory).dev !== dev) continue;
        const after = await this.available(directory);
        if (after !== undefined) freed += Math.max(0, after - before);
      } catch { /* the volume disappeared during GC */ }
    }
    return freed;
  }
}
