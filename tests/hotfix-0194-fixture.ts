import { z } from 'zod';
import { Context } from '../src/core/context.ts';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import { DiskRunner, FakeTmux, makeConfig, useScratch } from './helpers.ts';
export const scratch = useScratch();
export function world(name: string) {
  const config = makeConfig(scratch.sub(name), 'capacity: {snapshot: false, codex_refresh: false}\nmcp: {allow: [send]}\nlimits: {claude: 5, codex: 5}\n');
  const tmux = new FakeTmux();
  const runner = new DiskRunner({ dryRun: false, startTime: Date.now() + 1000, respond: tmux.respond });
  const ctx = new Context(runner, config, () => {});
  const deps = { context: () => ctx, notify: async () => {} };
  const call = async (name: string, input: Record<string, unknown>) => {
    const tool = MCP_TOOLS.find(t => t.name === name)!;
    return tool.run(deps, z.object(tool.input).parse(input));
  };
  return { config, tmux, runner, ctx, call };
}
