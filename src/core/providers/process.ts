const NOT_A_SESSION = new Set(['mcp', 'mcp-server', 'app-server', 'exec', 'usage-tap', 'agentctl', '--print', '-p', 'doctor', 'update', 'install', 'login', 'logout', 'proto']);
export function interactiveTokens(tokens: readonly string[]): boolean { return !tokens.slice(1).some(t => NOT_A_SESSION.has(t) || t.includes('agentctl')); }
