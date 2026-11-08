#!/usr/bin/env node
// Synthetic passive-wire producer. Never invokes Kimi or reads a provider home.
import fs from 'node:fs';
const [file, cwd, at, mode] = process.argv.slice(2);
const line = value => JSON.stringify(value) + '\n';
if (mode === 'start') {
  fs.writeFileSync(file, line({ type: 'metadata', protocol_version: '1.5', cwd, session_id: 'S', time: Number(at) }) + line({ type: 'interaction.request', time: Number(at) }));
} else if (mode === 'large') {
  fs.appendFileSync(file, line({ type: 'llm.request', model: 'k3', prompt: 'ą'.repeat(300_000), time: Number(at) }));
} else if (mode === 'end') {
  fs.appendFileSync(file, line({ type: 'turn.ended', time: Number(at) }));
} else throw new Error('unknown fixture mode');
