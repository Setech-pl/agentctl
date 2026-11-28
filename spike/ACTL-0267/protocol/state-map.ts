// ACTL-0267 spike: protocol messages → agentctl states, for Codex App Server (codex-cli 0.167.0 schema, generated locally with
// `codex app-server generate-json-schema`) and ACP (protocolVersion 1: claude-agent-acp 0.113.0, codex-acp 2.12.1, kimi acp 2.5.2).
// Pure reducer: frames in, state out. `answer` maps a numbered choice to the protocol response.

export type DriverState = 'starting' | 'ready' | 'working' | 'needs-input' | 'needs-approval' | 'turn-done' | 'interrupted' | 'limited' | 'overloaded' | 'needs-attention' | 'dead';
export interface Pending { requestId: string | number; method: string; kind: 'approval' | 'question'; text: string; choices: { label: string; reply: unknown }[] }
export interface Usage { input: number; output: number; cacheRead: number; reasoning: number; total: number; contextWindow?: number }
export interface Snapshot { state: DriverState; threadId?: string; turnId?: string; turns: number; pending: Pending[]; lastMessage: string; turnUsage?: Usage; totalUsage?: Usage; error?: string }
type Msg = Record<string, unknown>;
const obj = (v: unknown): Msg => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Msg) : {});
const num = (v: unknown) => (typeof v === 'number' ? v : 0);

export const initial = (): Snapshot => ({ state: 'starting', turns: 0, pending: [], lastMessage: '' });

// ---------- Codex App Server ----------
const LIMIT_ERRORS = new Set(['usageLimitExceeded', 'rateLimitExceeded', 'sessionBudgetExceeded']);
const OVERLOAD_ERRORS = new Set(['serverOverloaded', 'policyCapacityUnavailable', 'flexUnavailable']);
const usage = (v: unknown, cw?: unknown): Usage => { const u = obj(v); return { input: num(u.inputTokens), output: num(u.outputTokens), cacheRead: num(u.cachedInputTokens), reasoning: num(u.reasoningOutputTokens), total: num(u.totalTokens), contextWindow: typeof cw === 'number' ? cw : undefined }; };
const APPROVAL_CHOICES = [{ label: 'Yes', reply: { decision: 'accept' } }, { label: 'Yes, for this session', reply: { decision: 'acceptForSession' } }, { label: 'No, continue', reply: { decision: 'decline' } }, { label: 'No, stop the turn', reply: { decision: 'cancel' } }];

export function codexFrame(s: Snapshot, m: Msg): Snapshot {
  const p = obj(m.params);
  const method = typeof m.method === 'string' ? m.method : undefined;
  if (method && m.id !== undefined) { // server → client request
    if (/requestApproval$|^applyPatchApproval$|^execCommandApproval$/.test(method)) {
      const text = String(p.command ?? p.reason ?? (method.includes('fileChange') ? 'apply file changes' : method));
      return { ...s, state: 'needs-approval', pending: [...s.pending, { requestId: m.id as string | number, method, kind: 'approval', text, choices: APPROVAL_CHOICES }] };
    }
    if (method === 'item/tool/requestUserInput' || method === 'mcpServer/elicitation/request') {
      const q = obj((p.questions as unknown[] | undefined)?.[0]);
      const opts = Array.isArray(q.options) ? (q.options as unknown[]).map(o => String(obj(o).label)) : [];
      const id = String(q.id ?? 'q');
      return { ...s, state: 'needs-input', pending: [...s.pending, { requestId: m.id as string | number, method, kind: 'question', text: String(q.question ?? p.message ?? ''), choices: opts.map(label => ({ label, reply: { answers: { [id]: { answers: [label] } } } })) }] };
    }
    return s;
  }
  switch (method) {
    case 'thread/started': return { ...s, state: 'ready', threadId: String(obj(p.thread).id) };
    case 'turn/started': return { ...s, state: 'working', turnId: String(obj(p.turn).id), turnUsage: undefined, error: undefined };
    case 'thread/status/changed': {
      const st = obj(p.status); const flags = Array.isArray(st.activeFlags) ? st.activeFlags : [];
      if (st.type === 'active') return { ...s, state: flags.includes('waitingOnApproval') ? 'needs-approval' : flags.includes('waitingOnUserInput') ? 'needs-input' : 'working' };
      if (st.type === 'systemError') return { ...s, state: 'needs-attention', error: 'systemError' };
      if (st.type === 'notLoaded') return { ...s, state: 'dead' };
      return s; // idle: turn/completed decides between ready and turn-done
    }
    case 'serverRequest/resolved': { const pending = s.pending.filter(x => x.requestId !== p.requestId); return { ...s, pending, state: pending.length ? s.state : s.state === 'needs-approval' || s.state === 'needs-input' ? 'working' : s.state }; }
    case 'item/completed': { const it = obj(p.item); return it.type === 'agentMessage' ? { ...s, lastMessage: String(it.text ?? '') } : s; }
    case 'thread/tokenUsage/updated': { const t = obj(p.tokenUsage); return { ...s, turnUsage: usage(t.last, t.modelContextWindow), totalUsage: usage(t.total, t.modelContextWindow) }; }
    case 'error': {
      const e = obj(p.error); const info = e.codexErrorInfo; const code = typeof info === 'string' ? info : Object.keys(obj(info))[0] ?? 'other';
      if (p.willRetry === true) return { ...s, error: `retrying: ${code}` };
      return { ...s, error: `${code}: ${String(e.message ?? '')}`, state: LIMIT_ERRORS.has(code) ? 'limited' : OVERLOAD_ERRORS.has(code) ? 'overloaded' : s.state };
    }
    case 'turn/completed': {
      const turn = obj(p.turn); const status = String(turn.status);
      const base = { ...s, turns: s.turns + 1, pending: [] };
      if (status === 'completed') return { ...base, state: 'turn-done' };
      if (status === 'interrupted') return { ...base, state: 'interrupted' };
      const e = obj(turn.error); const info = e.codexErrorInfo; const code = typeof info === 'string' ? info : Object.keys(obj(info))[0] ?? 'other';
      return { ...base, state: LIMIT_ERRORS.has(code) ? 'limited' : OVERLOAD_ERRORS.has(code) ? 'overloaded' : 'needs-attention', error: `${code}: ${String(e.message ?? '')}` };
    }
    case 'thread/closed': return { ...s, state: 'dead' };
    default: return s;
  }
}

// ---------- ACP (agent ↔ client) ----------
export function acpFrame(s: Snapshot, m: Msg, promptIds: Set<string | number> = new Set()): Snapshot {
  const p = obj(m.params);
  if (m.method === 'session/request_permission' && m.id !== undefined) {
    const tc = obj(p.toolCall);
    const choices = (Array.isArray(p.options) ? p.options : []).map(o => ({ label: `${String(obj(o).name)} (${String(obj(o).kind)})`, reply: { outcome: { outcome: 'selected', optionId: String(obj(o).optionId) } } }));
    return { ...s, state: 'needs-approval', pending: [...s.pending, { requestId: m.id as string | number, method: 'session/request_permission', kind: 'approval', text: String(tc.title ?? tc.toolCallId ?? ''), choices }] };
  }
  if (m.method === 'session/update') {
    const u = obj(p.update); const kind = u.sessionUpdate;
    if (kind === 'agent_message_chunk') return { ...s, state: s.state === 'ready' ? 'working' : s.state, lastMessage: s.lastMessage + String(obj(u.content).text ?? '') };
    if (kind === 'tool_call' || kind === 'agent_thought_chunk' || kind === 'plan') return { ...s, state: s.pending.length ? s.state : 'working' };
    if (kind === 'usage_update') return { ...s, totalUsage: { input: 0, output: 0, cacheRead: 0, reasoning: 0, total: num(u.used), contextWindow: num(u.size) || undefined } };
    return s;
  }
  if (m.id !== undefined && 'result' in m && promptIds.has(m.id as string | number)) { // response to our session/prompt
    const stop = String(obj(m.result).stopReason);
    const base = { ...s, turns: s.turns + 1, pending: [] };
    if (stop === 'end_turn') return { ...base, state: 'turn-done' };
    if (stop === 'cancelled') return { ...base, state: 'interrupted' };
    return { ...base, state: 'needs-attention', error: `stopReason ${stop}` }; // max_tokens, max_turn_requests, refusal
  }
  if (m.id !== undefined && 'error' in m && promptIds.has(m.id as string | number)) {
    const text = String(obj(m.error).message ?? '');
    return { ...s, state: /limit|quota/i.test(text) ? 'limited' : /overload|529/.test(text) ? 'overloaded' : 'needs-attention', error: text };
  }
  if (m.id !== undefined && 'result' in m && typeof obj(m.result).sessionId === 'string') return { ...s, state: 'ready', threadId: String(obj(m.result).sessionId) };
  return s;
}

/** agentctl `answer <task> <n>`: the JSON-RPC response for choice n (1-based) of the oldest pending request. */
export function answer(s: Snapshot, n: number): { response: Msg; next: Snapshot } {
  const [first, ...rest] = s.pending;
  if (!first) throw new Error('nothing to answer');
  const choice = first.choices[n - 1];
  if (!choice) throw new Error(`choice ${n} out of 1..${first.choices.length}`);
  return { response: { jsonrpc: '2.0', id: first.requestId, result: choice.reply }, next: { ...s, pending: rest, state: rest.length ? s.state : 'working' } };
}

/** Control requests agentctl sends; the probe refuses the prompt-bearing ones in this spike. */
export const controls = {
  codex: { start: 'thread/start', resume: (threadId: string) => ({ method: 'thread/resume', params: { threadId } }), interrupt: (threadId: string, turnId: string) => ({ method: 'turn/interrupt', params: { threadId, turnId } }), send: 'turn/start', steer: 'turn/steer' },
  acp: { start: 'session/new', resume: (sessionId: string, cwd: string) => ({ method: 'session/resume', params: { sessionId, cwd, mcpServers: [] } }), interrupt: (sessionId: string) => ({ method: 'session/cancel', params: { sessionId } }), send: 'session/prompt' },
} as const;
