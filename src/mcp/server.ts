import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { MCP_TOOLS, providerToolInput } from '../core/mcp-tools.ts';
import type { McpDeps } from '../core/mcp-tools.ts';
import { FIRST_LOOK_MS, readMarkers } from '../core/chat-events.ts';

/*
 * The MCP front of agentctl: registers the tools of src/core/mcp-tools.ts with the official SDK and serves them over stdio.
 * Nothing here decides anything; stdout carries only protocol messages (anything else printed there would corrupt the stream).
 */

/** What the chat is told about the server as a whole, next to the descriptions of the tools. */
export const SERVER_INSTRUCTIONS =
  'agentctl dispatches coding agents (Claude Code, Codex) into tmux windows. Call events_since at the start of every answer about the agents\' work: it tells what changed since your last call (you get no notifications). Use its current summary without a separate status call; call pull_ready in summary mode at the start of discussing finished work; ' +
  'Each MCP session consumes events independently from its initialization checkpoint; later sessions inherit the client high-water mark. Set client only to intentionally share a cursor between sessions. get_report section reads a selected section; peek shows a running window, get_report and task_spec show one task. Tasks may belong to cohorts (named groups): status, pull_ready take a cohort, cohort_list and cohort_show show them. The tools send, new, interrupt, close, move, queue, queue_rm and cancel change things and only work if the user allowed them; ' +
  'Check capacity.disk before dispatching; read queue_list failed reasons before queue_retry. At disk-warn propose gc_preview; at disk-critical use gc only within the user authorization and mcp.allow. Writes that start, interrupt, close, cancel, move, archive or remove work require a preview followed by confirm: true with identical arguments. Never merge, push or use force.';

export function buildMcpServer(deps: McpDeps, version: string): McpServer {
  const server = new McpServer({ name: 'agentctl', version }, { instructions: SERVER_INSTRUCTIONS });
  const sessionDeps = { ...deps };
  server.server.oninitialized = () => {
    sessionDeps.clientId = server.server.getClientVersion()?.name.slice(0, 200) ?? 'unknown';
    const ctx = deps.context(() => {});
    sessionDeps.eventsSession = { markers: readMarkers(ctx.config), cursors: {}, initialSince: new Date(ctx.runner.now() - FIRST_LOOK_MS).toISOString() };
  };
  for (const tool of MCP_TOOLS) {
    server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: providerToolInput(tool, deps.context(() => {}).config), annotations: tool.annotations }, async (args: Record<string, unknown>) => {
      const result = await tool.run(sessionDeps, args as never);
      return { content: [{ type: 'text' as const, text: result.text }], ...(result.isError ? { isError: true } : {}) };
    });
  }
  return server;
}

/** Serve until the client goes away (stdin ends) or the transport closes. */
export async function runMcpServer(deps: McpDeps, version: string, transport: Transport = new StdioServerTransport(), stdin: NodeJS.ReadableStream | undefined = process.stdin): Promise<void> {
  const server = buildMcpServer(deps, version);
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
  });
  await server.connect(transport);
  // The SDK transport does not notice that its input ended; the app that started us is gone then.
  stdin?.once('end', () => void server.close());
  await closed;
}
