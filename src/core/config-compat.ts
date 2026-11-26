import fs from 'node:fs';
import YAML from 'yaml';
import type { Context } from './context.ts';
import { writeConfigText } from './config-edit.ts';
import { withFileLock } from './file-lock.ts';
import { limitEditLock, reservationsFile } from './limits.ts';
import { AgentctlError, isObject } from './util.ts';

function configDocument(file: string) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) throw new AgentctlError(`cannot read config: ${doc.errors[0]!.message}`);
  return doc;
}

/**
 * Called within the limits-edit lock. The pre-0.27 writer validates config.yaml under that same
 * lock before every write, so an explicit change_policy fences stale writers out at commit time.
 */
export async function fenceLegacyLimits(ctx: Context): Promise<boolean> {
  if (ctx.runner.dryRun || !ctx.config.loaded || !ctx.config.mcp.allow.includes('set_limits')) return false;
  const doc = configDocument(ctx.config.path);
  if (doc.hasIn(['limits', 'change_policy'])) return false;
  if (doc.get('limits') === null) doc.delete('limits');
  doc.setIn(['limits', 'change_policy'], ctx.config.limitSettings.changePolicy);
  await writeConfigText(ctx, ctx.config.path, doc.toString({lineWidth: 0}));
  ctx.info('MCP < 0.27 cannot set limits. Quit (⌘Q) and reopen the chat app to use owner approval.');
  return true;
}

export async function downgradeCheck(ctx: Context, target: string): Promise<{incompatible: string[]; pruned: string[]; reservations: string[]}> {
  const version = /^v?0\.26\.(x|0|1)$/.exec(target);
  if (!version) throw new AgentctlError('Use --to 0.26.x, 0.26.0 or 0.26.1.');
  const file = ctx.config.path;
  return withFileLock(limitEditLock(file), async () => {
    const doc = configDocument(file), now = ctx.runner.now();
    const raw: unknown = doc.toJS();
    const overrides = isObject(raw) && isObject(raw.limits) ? raw.limits.timed_overrides : undefined;
    const pruned: string[] = [];
    if (isObject(overrides)) {
      for (const [agent, value] of Object.entries(overrides)) {
        if (isObject(value) && typeof value.until === 'string' && Date.parse(value.until) <= now) {
          doc.deleteIn(['limits', 'timed_overrides', agent]);
          pruned.push(`limits.timed_overrides.${agent}`);
        }
      }
      if (Object.keys(overrides).length === pruned.length) doc.deleteIn(['limits', 'timed_overrides']);
    }
    const keys = ['launch', 'limits.change_policy', 'limits.profiles', 'limits.schedule', 'limits.active_profile',
      'limits.timed_overrides', 'queue.hold_on_load', 'disk.min_free_state_gb'];
    if (version[1] !== '1') keys.push('start_lock_stale_s', 'setup.timeout_s', 'gc.delete_mode');
    const incompatible = keys.filter(key => doc.hasIn(key.split('.')));
    const quotas = isObject(raw) ? raw.quotas : undefined;
    if (isObject(quotas)) {
      if (typeof quotas.floor === 'number') incompatible.push('quotas.floor (numeric)');
      if (isObject(quotas.chats)) for (const [chat, value] of Object.entries(quotas.chats)) {
        if (isObject(value) && Object.hasOwn(value, 'share')) incompatible.push(`quotas.chats.${chat}.share`);
      }
    }
    let reservations: string[] = [];
    try {
      const values: unknown = JSON.parse(fs.readFileSync(reservationsFile(ctx.config), 'utf8'));
      if (isObject(values)) reservations = Object.entries(values).flatMap(([agent, value]) =>
        isObject(value) && typeof value.until === 'string' ? [`reservations.json.${agent}.until`] : []);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (pruned.length) await writeConfigText(ctx, file, doc.toString({lineWidth: 0}));
    return {incompatible, pruned, reservations};
  }, 5000);
}
