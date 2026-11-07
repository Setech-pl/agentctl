import { z } from 'zod';
import type { Command } from 'commander';
import { allCommands } from '../help.ts';
import { commandPath } from '../examples.ts';
import { MCP_TOOLS } from './mcp-tools.ts';

/** Each executable command has an explicit mapping or a justified terminal/installation exception. */
export const CLI_MCP: Record<string, string[]> = {
  'mcp check': ['mcp_check'], spec: ['spec_example'], 'spec example': ['spec_example'], version: ['version'], guide: ['guide'], capacity: ['capacity'], new: ['new'],
  queue: ['queue'], 'queue show': ['queue_show'], 'queue list': ['queue_list'], 'queue rm': ['queue_rm'], 'queue up': ['queue_up'], 'queue retry': ['queue_retry'], 'queue pause': ['queue_pause'], 'queue resume': ['queue_resume'],
  unblock: ['unblock'], cohort: ['cohort_list'], 'cohort list': ['cohort_list'], 'cohort show': ['cohort_show'], 'cohort add': ['cohort_add'], 'cohort remove': ['cohort_remove'], 'cohort note': ['cohort_note'], 'cohort archive': ['cohort_archive'],
  overlap: ['overlap'], send: ['send'], status: ['status'], limits: ['limits'], 'limits show': ['limits'], 'limits set': ['set_limits'], 'limits reserve': ['reserve'], 'limits release': ['limits_release'],
  events: ['events_since'], usage: ['usage'], resume: ['resume'], mark: ['mark'], log: ['log'], stats: ['stats'], gc: ['gc_preview', 'gc'], archive: ['archive'], hide: ['hide'], unhide: ['unhide'], pull: ['get_report', 'pull_ready'], close: ['close'], cancel: ['cancel'],
  report: ['report', 'report_from'], away: ['away_status', 'away'], 'away status': ['away_status'], 'away on': ['away'], 'away off': ['away'], manager: ['manager_start', 'manager_status'], 'manager stop': ['manager_stop'], 'notify-test': ['notify_test'], adopt: ['adopt'], interrupt: ['interrupt'], move: ['move'], peek: ['peek'], doctor: ['doctor'],
};
export const CLI_MCP_EXCEPTIONS: Record<string, string> = {
  dataset: 'Local dataset command group; CLI only.',
  'dataset export': 'Owner-only local benchmark export; CLI only, no MCP tool.',
  up: 'Interactive terminal orchestration: opens watch/board and optionally manager; use the CLI.',
  watch: 'Long-running terminal watcher, started and supervised locally.',
  board: 'Interactive terminal UI.',
  attach: 'Attaches or switches a human terminal.',
  'ntfy-setup': 'Generates and saves a subscription secret; run locally.',
  event: 'Internal agent callback; accepts forwarding hooks and must not be callable by chat.',
  'usage-tap': 'Internal agent statusLine callback; may forward a local shell command.',
  mcp: 'MCP server transport itself; cannot start a nested server over a tool call.',
  'mcp serve': 'MCP server transport itself.',
  'mcp install': 'Changes MCP client configuration.',
  'mcp uninstall': 'Changes MCP client configuration.',
};
export function parityInventory(program: Command) {
  return allCommands(program).map((command) => {
    const cli = commandPath(command);
    const tools = CLI_MCP[cli] ?? [];
    return { cli, arguments: command.registeredArguments.map((a) => ({ name: a.name(), required: a.required, variadic: a.variadic })), options: command.options.map((o) => ({ flags: o.flags, description: o.description, default: o.defaultValue })), tools, exception: CLI_MCP_EXCEPTIONS[cli] ?? null };
  });
}
export function parityErrors(program: Command): string[] {
  const names = new Set(MCP_TOOLS.map((t) => t.name));
  return parityInventory(program).flatMap((row) => !row.tools.length && !row.exception ? [`${row.cli}: no MCP mapping or exception`] : row.tools.filter((name) => !names.has(name)).map((name) => `${row.cli}: missing tool ${name}`));
}
export function parityMarkdown(program: Command): string {
  const rows = parityInventory(program);
  const cell = (s: string) => s.replaceAll('|', '\\|').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return ['<!-- BEGIN GENERATED MCP PARITY -->', '', '| CLI | MCP | Exception / reason |', '|---|---|---|', ...rows.map((r) => `| \`${r.cli}\` | ${r.tools.map((t) => `\`${t}\``).join(', ') || '—'} | ${r.exception ?? ''} |`), '', 'CLI arguments and options are generated in [commands.md](commands.md). MCP arguments:', '', '| Tool | Kind | Arguments |', '|---|---|---|', ...MCP_TOOLS.map((t) => `| \`${t.name}\` | ${t.kind} | ${Object.entries(t.input).map(([k, v]) => `\`${k}${z.object({ value: v as z.ZodType }).safeParse({}).success ? '?' : ''}\``).join(', ')} |`), '', ...rows.filter((r) => r.options.length).map((r) => `- \`${r.cli}\`: ${r.options.map((o) => `\`${cell(o.flags)}\``).join(', ')}`), '', '<!-- END GENERATED MCP PARITY -->'].join('\n');
}
