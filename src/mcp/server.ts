import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { MCP_TOOLS } from '../core/mcp-tools.ts';
import type { McpDeps } from '../core/mcp-tools.ts';

/*
 * The MCP front of agentctl: registers the tools of src/core/mcp-tools.ts with the official SDK and serves them over stdio.
 * Nothing here decides anything; stdout carries only protocol messages (anything else printed there would corrupt the stream).
 */

/** What the chat is told about the server as a whole, next to the descriptions of the tools. */
export const SERVER_INSTRUCTIONS =
  'agentctl dispatches coding agents (Claude Code, Codex) into tmux windows. Start with status to see the tasks; call pull_ready at the start of discussing finished work; ' +
  'peek shows a running window, get_report and task_spec show one task. The tools send, new, interrupt, close and move change things and only work if the user allowed them; ' +
  'say what you are about to do and ask before you use one.';

export function buildMcpServer(deps: McpDeps, version: string): McpServer {
  const server = new McpServer({ name: 'agentctl', version }, { instructions: SERVER_INSTRUCTIONS });
  for (const tool of MCP_TOOLS) {
    server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.input, annotations: tool.annotations }, async (args: Record<string, unknown>) => {
      const result = await tool.run(deps, args as never);
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
