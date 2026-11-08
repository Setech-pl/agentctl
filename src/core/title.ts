import type { Context } from './context.ts';
import { instanceName } from './instance.ts';

export const boardTitle = (version: string, instance = 'agentctl', role = 'board'): string => `${instance} ${version} · ${role}`;
export const tmuxTitleString = (version: string, instance = 'agentctl'): string => `${instance} ${version} · #W`;
/** Save both icon/window titles, then set the window title (OSC 2). */
export const titleStart = (version: string, instance = 'agentctl', role = 'board'): string => `\u001b[22;0t\u001b]2;${boardTitle(version, instance, role)}\u0007`;
export const titleEnd = (): string => '\u001b[23;0t';

/** Restore tmux's previous effective title options before popping the terminal title stack. */
export async function beginTitle(ctx: Context, out: { write(text: string): unknown }, version: string, role: string, insideTmux: boolean): Promise<() => Promise<void>> {
  const instance = instanceName(ctx.config);
  const previous = new Map<string, string | undefined>();
  out.write(titleStart(version, instance, role));
  if (insideTmux) {
    for (const [option, value] of [['set-titles', 'on'], ['set-titles-string', tmuxTitleString(version, instance)]]) {
      const old = await ctx.runner.exec('tmux', ['show-options', '-qv', '-t', `=${ctx.config.session}:`, option!], { readOnly: true }).catch(() => undefined);
      previous.set(option!, old?.code === 0 && old.stdout.length > 0 ? old.stdout.replace(/\r?\n$/, '') : undefined);
      await ctx.tmux.setSessionOption(option!, value!).catch(() => undefined);
    }
  }
  let restored = false;
  return async () => {
    if (restored) return; restored = true;
    for (const [option, value] of [...previous].reverse()) {
      if (value !== undefined) await ctx.tmux.setSessionOption(option, value).catch(() => undefined);
      else await ctx.runner.exec('tmux', ['set-option', '-u', '-t', `=${ctx.config.session}:`, option]).catch(() => undefined);
    }
    out.write(titleEnd());
  };
}
