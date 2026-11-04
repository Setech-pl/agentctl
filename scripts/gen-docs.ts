import { parityMarkdown, parityErrors } from '../src/core/mcp-parity.ts';
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
fs.writeFileSync(path.join(root, 'docs', 'diagrams.md'), '# Diagrams\n\nGenerated from README.md by `npm run docs`.\n\n' + diagrams.map((diagram, i) => ['## Automatic flow', '## Dispatcher', '## Flow', '## Architecture', '## Task states'][i] + '\n\n' + diagram).join('\n\n') + '\n');

const program = await loadProgram();
const errors = parityErrors(program);
if (errors.length) throw new Error(errors.join('\n'));
const mcpFile = path.join(root, 'docs/mcp.md');
const before = fs.readFileSync(mcpFile, 'utf8');
const generated = parityMarkdown(program);
fs.writeFileSync(mcpFile, before.includes('<!-- BEGIN GENERATED MCP PARITY -->') ? before.replace(/<!-- BEGIN GENERATED MCP PARITY -->[\s\S]*?<!-- END GENERATED MCP PARITY -->/, generated) : `${before}\n${generated}\n`);

// The versioned report schema is generated from the same validator as every consumer.
const { outputsSchema } = await import('../src/core/outputs.ts');
const { z } = await import('zod');
fs.writeFileSync(path.join(root, 'docs/examples/outputs-v1.schema.json'), `${JSON.stringify(z.toJSONSchema(outputsSchema), null, 2)}\n`);
