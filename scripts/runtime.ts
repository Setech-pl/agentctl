import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const runtimesDir = () => process.env.AGENTCTL_RUNTIMES_DIR ?? path.join(os.userInfo().homedir, 'Projects/cache-dev/runtimes');
/** The pinned Node 22 build for a platform: the nodejs.org archive name without its extension. */
export const node22Dist = (platform: string = process.platform, arch: string = process.arch): string => `node-v22.14.0-${platform}-${arch}`;
const NODE22_TARGETS = new Set(['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64']);
export const node22Path = (dir = runtimesDir(), platform: string = process.platform, arch: string = process.arch) => path.join(dir, `${node22Dist(platform, arch)}/bin/node`);
export function checkRuntime(node: string, expected: string, version = (file: string) => execFileSync(file, ['--version'], { encoding: 'utf8' }).trim()): string {
  const actual = version(node);
  if (expected.endsWith('.')) {
    if (!actual.startsWith(`v${expected}`)) throw new Error(`${node}: expected Node ${expected}x, got ${actual}`);
  } else if (actual !== `v${expected}`) throw new Error(`${node}: expected Node ${expected}, got ${actual}`);
  return actual;
}
export function verifyArchive(data: Uint8Array, sums: string, name: string): void {
  const expected = sums.split('\n').map(l => l.trim().split(/\s+/)).find(parts => parts[1] === name)?.[0];
  if (!expected || createHash('sha256').update(data).digest('hex') !== expected) throw new Error(`SHA256 mismatch: ${name}`);
}
export interface RuntimeIO {
  dir?: string;
  platform?: string;
  arch?: string;
  version?: (file: string) => string;
  download?: (file: string) => Promise<Buffer>;
  extract?: (archive: string, dir: string) => void;
}
export async function ensureNode22(work: string, io: RuntimeIO = {}): Promise<string> {
  const dir = io.dir ?? runtimesDir();
  const platform = io.platform ?? process.platform, arch = io.arch ?? process.arch;
  const node = node22Path(dir, platform, arch);
  if (fs.existsSync(node)) { checkRuntime(node, '22.14.0', io.version); return node; }
  if (!NODE22_TARGETS.has(`${platform}-${arch}`)) throw new Error(`Node 22 runtime requires one of ${[...NODE22_TARGETS].join(', ')} (this is ${platform}-${arch})`);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${node22Dist(platform, arch)}.tar.gz`;
  const download = io.download ?? (async (file: string) => {
    const response = await fetch(`https://nodejs.org/dist/v22.14.0/${file}`);
    if (!response.ok) throw new Error(`Node download ${file}: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  });
  const data = await download(name);
  verifyArchive(data, (await download('SHASUMS256.txt')).toString(), name);
  const archive = path.join(work, name);
  fs.writeFileSync(archive, data);
  try {
    if (io.extract) io.extract(archive, dir);
    else execFileSync('tar', ['-xzf', archive, '-C', dir]);
  } finally { fs.rmSync(archive, { force: true }); }
  checkRuntime(node, '22.14.0', io.version);
  return node;
}
export function homebrewNode26(): string {
  const prefix = execFileSync('brew', ['--prefix', 'node'], { encoding: 'utf8' }).trim();
  const node = fs.realpathSync(path.join(prefix, 'bin/node'));
  checkRuntime(node, '26.');
  return node;
}
/** Node 26 for the gate: Homebrew's on macOS; elsewhere (Linux has no Homebrew node) the Node 26 that runs the gate. */
export function node26Runtime(platform: string = process.platform, execPath: string = process.execPath, version?: (file: string) => string): string {
  if (platform === 'darwin') return homebrewNode26();
  const node = fs.realpathSync(execPath);
  checkRuntime(node, '26.', version);
  return node;
}
export const node26Label = (platform: string = process.platform): string => platform === 'darwin' ? 'Homebrew Node 26' : 'Node 26 running the gate';

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.dirname, 'runtime.ts')) {
  ensureNode22(process.argv[2]!).catch(error => { console.error(error); process.exitCode = 1; });
}
