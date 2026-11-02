import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const { name, version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
// A manual bootstrap may already have published the first release. Never republish it.
try {
  const published = execFileSync('npm', ['view', `${name}@${version}`, 'version', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (JSON.parse(published) !== version) throw new Error('Unexpected registry response');
  fs.appendFileSync(process.env.GITHUB_OUTPUT, 'publish=false\n');
  console.log(`${name}@${version} already exists; skipping publication (no new provenance attestation).`);
} catch (error) {
  if (!error.stderr || !/E404/.test(String(error.stderr))) throw error;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, 'publish=true\n');
}
