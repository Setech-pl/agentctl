#!/usr/bin/env -S node --experimental-strip-types --no-warnings
import { main } from '../src/cli.ts';

// "agentctl status | head": the reader going away is not an error.
process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') process.exit(0);
  throw e;
});

process.exitCode = await main(process.argv.slice(2));
