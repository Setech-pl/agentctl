import fs from 'node:fs';
import { agentHomes, UsageReader } from '../usage-sources.ts';
import { readTaskSessions } from '../usage.ts';
import { clip, firstLine, MAX_QUESTION } from '../events.ts';
import type { GlobalConfig } from '../config.ts';
import type { TaskRecord } from '../taskstore.ts';

/** Only a session explicitly attributed by an agent event may supply question text. Never infer ownership from a filename alone. */
export function sessionQuestion(config: GlobalConfig, record: TaskRecord): string | undefined {
  if (record.agent !== 'codex') return undefined;
  const ids = new Set(readTaskSessions(config, record.window).codex.map(s => s.id));
  if (!ids.size) return undefined;
  const reader = new UsageReader(undefined);
  const home = record.env.CODEX_HOME ?? agentHomes(config).codex;
  for (const file of reader.codexSessions(home, Date.parse(record.started), Date.now()).reverse()) {
    if (![...ids].some(id => file.endsWith(`${id}.jsonl`))) continue;
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, 'r');
      const size = fs.fstatSync(fd).size;
      const head = Buffer.alloc(Math.min(size, 16384));
      fs.readSync(fd, head, 0, head.length, 0);
      const meta = JSON.parse(head.toString().split('\n')[0] ?? '{}');
      if (meta.type !== 'session_meta' || !ids.has(meta.payload?.id)) continue;
      const from = Math.max(0, size - 262144);
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      const pending = new Map<string, string>();
      for (const line of buf.toString().split('\n').slice(from ? 1 : 0)) {
        try {
          const item = JSON.parse(line).payload;
          if (item?.type === 'function_call_output') pending.delete(item.call_id);
          if (item?.type === 'function_call' && /^(?:request_user_input|request_user_input_async)$/.test(item.name)) {
            const args = JSON.parse(item.arguments);
            const text = args.questions?.[0]?.question ?? args.questions?.[0]?.title;
            if (typeof text === 'string') pending.set(item.call_id, clip(firstLine(text), MAX_QUESTION));
          }
        } catch { /* incomplete or unrelated log entry */ }
      }
      const question = [...pending.values()].at(-1);
      if (question) return question;
    } catch { /* logs are optional and may rotate */ }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  return undefined;
}
