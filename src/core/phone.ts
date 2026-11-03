import type { Context } from './context.ts';
import type { NtfyPriority, NtfySettings, PhoneEvent } from './config.ts';
import { clip, MAX_QUESTION } from './events.ts';

/*
 * Notifications to a phone through ntfy (https://ntfy.sh). On the public server the name of the topic is the only protection, so a message
 * carries the task ID, the name of a cohort and (if allowed) the first line of the verdict. Question text requires explicit opt-in.
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** What a notification to the phone is made of. Everything in it is already safe to send. */
export interface PhoneMessage {
  event: PhoneEvent;
  title: string;
  body: string;
  priority: NtfyPriority;
  tags: string[];
  click?: string;
}

export interface PhoneInput {
  text?: string | undefined;
  /** Screen metadata only, separate from the question text (which may come from a session log). */
  collapsed?: { count: number; shortcut: string | null } | undefined;
  task?: string | undefined;
  cohort?: string | undefined;
  /** The verdict line of a report; used only for `report-ready` and when `include_verdict` is on. */
  verdict?: string | undefined;
  /** Prepared text for `usage-critical` (a provider and a percentage - no task). */
  usage?: string | undefined;
  /** A last line of the body: where to answer from the phone (the Remote Control session of the task, or the manager). Never a link. */
  hint?: string | undefined;
}

/** The events a hint is added to: the ones the phone user answers (a question), reads and decides on (a report) or follows up (a cohort). */
export const HINTED_EVENTS: readonly PhoneEvent[] = ['needs-input', 'report-ready', 'cohort-done'];

export const NTFY_TAGS: Record<PhoneEvent, string> = {
  'disk-warn': 'warning',
  'disk-critical': 'warning',
  'disk-ok': 'white_check_mark',
  'needs-input': 'question',
  'needs-trust': 'lock',
  limited: 'hourglass_flowing_sand',
  blocked: 'no_entry',
  'report-ready': 'white_check_mark',
  'cohort-done': 'tada',
  'queue-failed': 'x',
  orphan: 'ghost',
  dead: 'skull',
  'usage-critical': 'warning',
};

const MAX_VERDICT_PHONE = 100;
const FILE_EXT = /\.(?:md|ts|tsx|js|mjs|json|ya?ml|png|jpe?g|log|txt|toml|sh|py|html|css|lock)$/i;

/** The verdict line without anything that looks like a path or a file name. */
export function safeVerdict(verdict: string): string {
  const words = verdict
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => {
      const core = w.replace(/^[("'`[]+|[)"'`\],;:.!?]+$/g, '');
      return core.includes('/') || core.includes('\\') || core.startsWith('~') || FILE_EXT.test(core) ? '…' : w;
    });
  return clip(words.join(' ').replace(/(?:…\s*){2,}/g, '… '), MAX_VERDICT_PHONE);
}

/** The notification for the phone; undefined when the event needs a task or a cohort that is not given. */
export function phoneMessage(event: PhoneEvent, input: PhoneInput, ntfy: Pick<NtfySettings, 'priority' | 'includeVerdict' | 'includeQuestion' | 'clickUrl'>): PhoneMessage | undefined {
  const { task, cohort } = input;
  let title: string;
  let body: string;
  switch (event) {
    case 'needs-input':
      if (!task) return undefined;
      title = `${task}: pytanie`;
      body = `${task}: pytanie agenta – otwórz okno`;
      if (ntfy.includeQuestion) body = input.text ? clip(input.text, MAX_QUESTION) : `${task} zadaje pytanie i czeka na odpowiedź`;
      else if (input.collapsed && Number.isSafeInteger(input.collapsed.count) && input.collapsed.count > 0) {
        // The screen is untrusted: only keyboard notation may be copied into a private notification.
        const shortcut = input.collapsed.shortcut;
        const binding = shortcut && /^(?:[⇧⌃⌥⌘↑↓←→]+|(?:(?:Ctrl|Control|Shift|Alt|Meta|Cmd|Super)[+-])*(?:Up|Down|Left|Right|Enter|Return|Tab|Esc|Escape|[A-Za-z0-9]))$/i.test(shortcut)
          ? shortcut : 'skrót przy „to answer” na ekranie';
        body = `Codex ma pytanie (${input.collapsed.count}) – Enter → okno agenta, potem ${binding}`;
      }
      break;
    case 'needs-trust':
      if (!task) return undefined;
      title = `${task}: zaufanie folderu`;
      body = `${task} czeka na zaufanie folderu (trust)`;
      break;
    case 'limited':
      if (!task) return undefined;
      title = `${task}: limit`;
      body = `${task}: agent wyczerpał limit użycia`;
      break;
    case 'blocked':
      if (!task) return undefined;
      title = `${task}: zablokowane`;
      body = `${task} zablokowane – zadanie, od którego zależy, zostało anulowane`;
      break;
    case 'report-ready': {
      if (!task) return undefined;
      title = `${task}: raport gotowy`;
      const verdict = ntfy.includeVerdict && input.verdict ? safeVerdict(input.verdict) : '';
      body = verdict ? `${task}: raport gotowy – ${verdict}` : `${task}: raport gotowy`;
      break;
    }
    case 'cohort-done':
      if (!cohort) return undefined;
      title = `kohorta ${cohort}`;
      body = `kohorta ${cohort}: wszystkie raporty gotowe`;
      break;
    case 'queue-failed':
      if (!task) return undefined;
      title = `${task}: start nieudany`;
      body = `${task}: start z kolejki nie powiódł się`;
      break;
    case 'orphan':
      if (!task) return undefined;
      title = `${task}: okno bez stanu`;
      body = `${task}: okno bez pliku stanu (orphan)`;
      break;
    case 'dead':
      if (!task) return undefined;
      title = `${task}: okno zniknęło`;
      body = `${task}: okno zniknęło bez raportu`;
      break;
    case 'disk-warn':
    case 'disk-critical':
    case 'disk-ok':
      title = event;
      body = input.text ?? event;
      break;
    case 'usage-critical':
      title = 'limit planu';
      body = input.usage ? clip(input.usage, 140) : 'limit planu prawie wyczerpany';
      break;
  }
  if (input.hint && HINTED_EVENTS.includes(event)) body = `${body}\n${input.hint}`;
  const message: PhoneMessage = { event, title: `agentctl · ${title}`, body, priority: ntfy.priority[event], tags: [NTFY_TAGS[event]] };
  if (ntfy.clickUrl) message.click = ntfy.clickUrl;
  return message;
}

/** RFC 2047 for a header value that is not plain ASCII (ntfy decodes it); fetch refuses a non-Latin-1 character in a header. */
export function headerValue(text: string): string {
  const flat = text.replace(/[\r\n]+/g, ' ');
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(flat) ? flat : `=?UTF-8?B?${Buffer.from(flat, 'utf8').toString('base64')}?=`;
}

export interface NtfyRequest {
  url: string;
  init: RequestInit & { headers: Record<string, string>; body: string };
}

/** `POST <server>/<topic>`: the text is the body, the rest are headers (Title, Priority, Tags, Click, Authorization: Bearer). */
export function buildNtfyRequest(ntfy: Pick<NtfySettings, 'server' | 'topic' | 'token'>, message: PhoneMessage): NtfyRequest {
  if (!ntfy.topic) throw new Error('notify.ntfy.topic is not set (agentctl ntfy-setup makes one)');
  const headers: Record<string, string> = {
    Title: headerValue(message.title),
    Priority: message.priority,
    Tags: message.tags.join(','),
  };
  if (message.click) headers.Click = headerValue(message.click);
  if (ntfy.token) headers.Authorization = `Bearer ${ntfy.token}`;
  return { url: `${ntfy.server.replace(/\/+$/, '')}/${encodeURIComponent(ntfy.topic)}`, init: { method: 'POST', headers, body: message.body } };
}

export interface PhoneSendResult {
  ok: boolean;
  /** HTTP status; 0 when there was no answer. */
  status: number;
  ms: number;
  error?: string;
}

export const PHONE_TIMEOUT_MS = 5000;

/** One request. Never throws: a network error is a result. */
export async function sendNtfy(fetchFn: FetchLike, ntfy: Pick<NtfySettings, 'server' | 'topic' | 'token'>, message: PhoneMessage, now: () => number = Date.now, timeoutMs: number = PHONE_TIMEOUT_MS): Promise<PhoneSendResult> {
  const started = now();
  let request: NtfyRequest;
  try {
    request = buildNtfyRequest(ntfy, message);
  } catch (e) {
    return { ok: false, status: 0, ms: 0, error: e instanceof Error ? e.message : String(e) };
  }
  try {
    const response = await fetchFn(request.url, { ...request.init, signal: AbortSignal.timeout(timeoutMs) });
    const ok = response.status >= 200 && response.status < 300;
    return { ok, status: response.status, ms: now() - started, ...(ok ? {} : { error: `HTTP ${response.status}` }) };
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    const cause = err.cause instanceof Error ? `: ${err.cause.message}` : '';
    return { ok: false, status: 0, ms: now() - started, error: `${err.name === 'TimeoutError' ? 'timeout' : err.message}${cause}` };
  }
}

export interface PhoneTestResult extends PhoneSendResult {
  /** `notify.ntfy.topic` is set. */
  configured: boolean;
  /** Where the test went: the server and the beginning of the topic (the whole topic is a secret on a public server). */
  target: string;
}

/** The topic, shortened for output. */
export const shortTopic = (topic: string): string => (topic.length > 14 ? `${topic.slice(0, 13)}…` : topic);

/** `notify-test --phone`: one test notification, whatever away says. */
export async function sendPhoneTest(ctx: Context): Promise<PhoneTestResult> {
  const ntfy = ctx.config.notify.ntfy;
  if (!ntfy?.topic) return { configured: false, ok: false, status: 0, ms: 0, target: '', error: 'notify.ntfy.topic is not set (agentctl ntfy-setup)' };
  const message: PhoneMessage = { event: 'report-ready', title: 'agentctl · test', body: 'Test powiadomienia agentctl – jeśli to widzisz, telefon działa.', priority: 'default', tags: ['bell'] };
  if (ntfy.clickUrl) message.click = ntfy.clickUrl;
  const r = await sendNtfy(ctx.fetch, ntfy, message, () => ctx.runner.now());
  return { ...r, configured: true, target: `${ntfy.server}, topic ${shortTopic(ntfy.topic)}` };
}
