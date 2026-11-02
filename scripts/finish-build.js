import fs from 'node:fs';
const bin = 'dist/bin/agentctl.js';
fs.writeFileSync(bin, fs.readFileSync(bin, 'utf8').replace(/^#!.*\n/, '#!/usr/bin/env node\n'));
fs.chmodSync(bin, 0o755);
