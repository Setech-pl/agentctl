// Preloaded (node --import) into the board process of scripts/demo-board.ts only: the screenshot must not depend on the time of the run or
// on the disk of the machine. The clock stands still at FIXED and the free space is a made-up number; nothing else is touched.
import fs from 'node:fs';

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
