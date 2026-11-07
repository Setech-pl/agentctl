import os from 'node:os';
import path from 'node:path';
import type { GlobalConfig } from './config.ts';
import { developmentEnvironment } from './installation.ts';
import { stableScript } from './mcp-install.ts';

/** Share doctor/version's state-home and executable detection; an explicit label wins. */
export function instanceName(config: Pick<GlobalConfig, 'path' | 'ui'>, options: {
  env?: NodeJS.ProcessEnv; home?: string; script?: string; stable?: string;
} = {}): string {
  if (config.ui?.instanceName) return config.ui.instanceName;
  const env = options.env ?? process.env, home = options.home ?? os.homedir();
  if (developmentEnvironment(config.path, undefined, undefined, home) ||
    developmentEnvironment(env.AGENTCTL_HOME ? path.join(env.AGENTCTL_HOME, 'config.yaml') : undefined, undefined, undefined, home)) return 'agentctl-dev';
  return developmentEnvironment(undefined, options.script ?? process.argv[1], options.stable ?? stableScript(env, home), home) ? 'agentctl-dev' : 'agentctl';
}

/** Keep the whole instance label visible even with tmux's short default left width. */
export async function applyInstanceLabel(ctx: import('./context.ts').Context): Promise<void> {
  const name = instanceName(ctx.config);
  await ctx.tmux.setSessionOption('status-left', `${name} `);
  await ctx.tmux.setSessionOption('status-left-length', String(Math.max(20, name.length + 1)));
}
