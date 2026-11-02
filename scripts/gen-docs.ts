import fs from 'node:fs';
import path from 'node:path';
import { loadProgram, renderCommandsMarkdown } from '../src/help.ts';

const root = path.resolve(import.meta.dirname, '..');
const file = path.join(root, 'docs', 'commands.md');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, renderCommandsMarkdown(await loadProgram()));
console.log(`wrote ${path.relative(root, file)}`);
