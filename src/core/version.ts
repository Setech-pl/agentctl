import fs from 'node:fs';

/** The version in package.json (the one `agentctl version` prints); '0.0.0' when the file cannot be read. */
export function packageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL(import.meta.url.endsWith('.ts') ? '../../package.json' : '../../../package.json', import.meta.url), 'utf8')) as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}
