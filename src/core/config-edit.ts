import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { loadGlobalConfig } from './config.ts';
import type { GlobalConfig } from './config.ts';
import type { Context } from './context.ts';
import { AgentctlError, errorMessage } from './util.ts';

/** The text of config.yaml after `edit` changed it; comments and the order of the keys stay. Nothing is written. */
export function editConfigText(config: Pick<GlobalConfig, 'path'>, edit: (doc: YAML.Document) => void): string {
  const file = config.path;
  const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const doc = YAML.parseDocument(original);
  if (doc.errors.length > 0) throw new AgentctlError(`cannot edit ${file}: ${doc.errors[0]?.message ?? 'invalid YAML'}`, 'Fix the YAML syntax first.');
  edit(doc);
  return doc.toString({ lineWidth: 0 });
}

/** Write the edited text: a `.bak` copy first, the new text, and a check that the result loads (else the old text comes back). */
export async function writeConfigText(ctx: Context, file: string, text: string): Promise<void> {
  const { runner } = ctx;
  const existed = fs.existsSync(file);
  const original = existed ? fs.readFileSync(file, 'utf8') : '';
  if (existed) await runner.copyFile(file, `${file}.bak`);
  await runner.writeFile(file, text);
  if (!runner.dryRun) {
    try {
      loadGlobalConfig(path.dirname(file));
    } catch (e) {
      if (existed) await runner.writeFile(file, original);
      else fs.rmSync(file, { force: true });
      throw new AgentctlError(`the edited config does not load, the old text is back: ${errorMessage(e).split('\n')[0]}`);
    }
  }
}
