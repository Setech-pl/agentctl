#!/usr/bin/env -S node --experimental-strip-types --no-warnings
import { main } from '../src/cli.ts';

process.exitCode = await main(process.argv.slice(2));
