import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { parseModelMatrix } from '../src/core/matrix.ts';

// Regenerate src/core/model-matrix.ts from data/model-matrix.yaml (npm run gen:matrix). The generated constant is
// what ships; tests/model-matrix.test.ts fails when the YAML and the constant disagree.
const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'data', 'model-matrix.yaml');
const data = YAML.parse(fs.readFileSync(source, 'utf8')) as unknown;
parseModelMatrix(data, source);
const file = path.join(root, 'src', 'core', 'model-matrix.ts');
fs.writeFileSync(
  file,
  `// GENERATED from data/model-matrix.yaml by \`npm run gen:matrix\` (scripts/gen-model-matrix.ts). Do not edit by hand.\n` +
    `export const GENERATED_MODEL_MATRIX = ${JSON.stringify(data, null, 2)} as const;\n`,
);
console.log(`wrote ${path.relative(root, file)}`);
