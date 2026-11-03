import fs from 'node:fs';
import path from 'node:path';
import { loadProgram, renderCommandsMarkdown } from '../src/help.ts';

const root = path.resolve(import.meta.dirname, '..');
const file = path.join(root, 'docs', 'commands.md');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, renderCommandsMarkdown(await loadProgram()).replaceAll('the Neon City example from the README', 'the project example from the README'));
console.log(`wrote ${path.relative(root, file)}`);

// README is the canonical source for the standalone diagram reference.
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const diagrams = [...readme.matchAll(/^```mermaid[^\n]*\n[\s\S]*?^```/gm)].map(m => m[0]);
fs.writeFileSync(path.join(root, 'docs', 'diagrams.md'), '# Diagrams\n\nGenerated from README.md by `npm run docs`.\n\n' + diagrams.join('\n\n') + '\n');
