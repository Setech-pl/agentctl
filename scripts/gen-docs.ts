import { parityMarkdown, parityErrors } from '../src/core/mcp-parity.ts';
import fs from 'node:fs';
import path from 'node:path';
import { loadProgram, renderCommandsMarkdown } from '../src/help.ts';

const root = path.resolve(import.meta.dirname, '..');
const file = path.join(root, 'docs', 'commands.md');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, renderCommandsMarkdown(await loadProgram()).replaceAll('the Neon City example from the README', 'the project example from the README'));
console.log(`wrote ${path.relative(root, file)}`);

// Current architecture sources live in docs/diagrams/*.puml.
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

await import('./docs-reference.ts');

const { EXAMPLE_SPEC } = await import('../src/core/example.ts');
fs.writeFileSync(path.join(root, 'docs/examples/spec.md'), '# Canonical CLI spec example\n\n' + String.fromCharCode(96).repeat(3) + 'yaml\n' + EXAMPLE_SPEC + String.fromCharCode(96).repeat(3) + '\n');
