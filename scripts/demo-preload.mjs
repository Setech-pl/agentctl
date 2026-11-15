// Preloaded (node --import) into the board process of scripts/demo-board.ts only: the screenshot must not depend on the time of the run or
// on host readings. Clock, disk and machine capacity are synthetic inside this board process only.
import fs from 'node:fs';
import os from 'node:os';

const FIXED = Number(process.env.DEMO_FIXED_MS);
if (!Number.isFinite(FIXED)) throw new Error('DEMO_FIXED_MS is not set');
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(FIXED);
    else super(...args);
  }
  static now() {
    return FIXED;
  }
}
globalThis.Date = FrozenDate;

const GIB = 1024 ** 3;
fs.promises.statfs = async () => ({ bsize: 4096, blocks: (994 * GIB) / 4096, bavail: (412.6 * GIB) / 4096, bfree: (412.6 * GIB) / 4096 });

os.loadavg = () => [1.25, 1.10, 0.90];
os.freemem = () => 16 * GIB;
os.cpus = () => Array.from({ length: 8 }, () => ({ model: 'Demo CPU', speed: 3200, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }));
