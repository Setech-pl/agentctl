import fs from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';
globalThis.window = new JSDOM('').window;
globalThis.document = window.document;
const { default: mermaid } = await import('mermaid');
mermaid.initialize({ startOnLoad: false });
async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))).flat();
}
const files = process.argv.slice(2);
if (!files.length) files.push(...(await fs.readdir('.')).filter(f => /^README.*\.md$/.test(f)), ...(await walk('docs')).filter(f => f.endsWith('.md')));
let count = 0;
for (const file of files) {
  const source = await fs.readFile(file, 'utf8');
  for (const match of source.matchAll(/^```mermaid[^\n]*\n([\s\S]*?)^```\s*$/gm)) {
    const line = source.slice(0, match.index).split('\n').length;
    try {
      await mermaid.parse(match[1]);
      // Mermaid accepts duplicate participant aliases; reject this ambiguous flow too.
      const aliases = [...match[1].matchAll(/^\s*(?:participant|actor)\s+(\w+)/gm)].map(m => m[1]);
      if (new Set(aliases).size !== aliases.length) throw new Error('Duplicate participant alias');
      count++;
    } catch (error) {
      console.error(`${file}:${line}: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
console.log(`Validated ${count} Mermaid blocks`);
