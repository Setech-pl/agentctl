import path from 'node:path';
export function within(cwd: string, dir: string): boolean { const a = path.resolve(cwd), b = path.resolve(dir); return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep); }
