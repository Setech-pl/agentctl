import fs from 'node:fs';
import path from 'node:path';
import { loadProjectConfig } from './config.ts';
import type { GlobalConfig } from './config.ts';
import { resolvePath } from './util.ts';

export type GuideLanguage = 'en' | 'pl';

/** Works both from src/core and from dist/src/core inside a global npm installation. */
export function dispatcherGuide(lang: GuideLanguage): string {
  const name = lang === 'pl' ? 'dispatcher.pl.md' : 'dispatcher.md';
  for (const base of ['../../docs', '../../../docs']) {
    const file = path.resolve(import.meta.dirname, base, name);
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  }
  throw new Error(`Packaged guide missing: docs/${name}`);
}

export function projectGuide(project: string): { text: string; warnings: string[] } {
  const repo = resolvePath(project);
  const overlay = loadProjectConfig(repo)?.guide;
  if (!overlay) return { text: '', warnings: [] };
  const file = overlay.startsWith('~') ? resolvePath(overlay) : path.resolve(repo, overlay);
  try { return { text: fs.readFileSync(file, 'utf8'), warnings: [] }; }
  catch { return { text: '', warnings: [`Project guide cannot be read: ${file}`] }; }
}

export function collectGuide(config: GlobalConfig, opts: { project?: string; lang?: GuideLanguage } = {}): { lang: GuideLanguage; text: string; warnings: string[] } {
  const lang = opts.lang ?? config.guideLang;
  const overlay = opts.project ? projectGuide(opts.project) : { text: '', warnings: [] };
  const title = lang === 'pl' ? 'Zasady projektu' : 'Project rules';
  const text = dispatcherGuide(lang) + (overlay.text ? `\n## ${title}\n\n${overlay.text.trimEnd()}\n` : '') + overlay.warnings.map((w) => `\n> warning: ${w}\n`).join('');
  return { lang, text, warnings: overlay.warnings };
}
