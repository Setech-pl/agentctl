import { isObject } from './util.ts';
import type { Problems } from './util.ts';

/*
 * The `wall` section of config.yaml: the channels of the WALL (a message board of the owner's chats and agents), who may post in each,
 * the chats that may name themselves (`as: "chat:nc"`), what each chat sees in events_since, and where refs may point. Only data and its
 * parser live here (config.ts imports it); the board itself is wall.ts.
 */

export const WALL_KEYS = ['channels', 'chats', 'subscriptions', 'ref_roots', 'archive_after_days', 'remind_after_hours', 'stale_after_days'];
export const WALL_CHANNEL_KEYS = ['authors', 'description'];
export const WALL_CHAT_KEYS = ['channels', 'clients'];

/** A channel name: lower-case words, optionally one `group:` prefix (shared:sim). */
export const WALL_CHANNEL_NAME = /^[a-z0-9][a-z0-9-]{0,39}(?::[a-z0-9][a-z0-9-]{0,39})?$/;
/** A chat name (the part after `chat:`). */
export const WALL_CHAT_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
/** Channel the tool itself talks on: every configured chat reads and posts there; an unknown one reads only it. */
export const WALL_TOOL_CHANNEL = 'agentctl';

export interface WallChannelSettings {
  /** Who may post: `owner`, `chat:<name>`, `chat:*`, `task:<ID>`, `task:*`, or `*` (every known identity). */
  authors: string[];
  description?: string;
}

export interface WallChatSettings {
  /** Channels this chat reads and may post to (patterns like `shared:*`); `agentctl` is always readable. */
  channels: string[];
  /** MCP client names (from the client's initialize) that are this chat without an explicit `as`. */
  clients: string[];
}

export interface WallSettings {
  channels: Record<string, WallChannelSettings>;
  chats: Record<string, WallChatSettings>;
  /** Per chat name or MCP client name: the channels whose WALL events events_since returns (patterns). Absent: own channel + agentctl + shared:*. */
  subscriptions: Record<string, string[]>;
  /** Paths a ref may name (absolute after `~` expansion); nothing is read from them. */
  refRoots: string[];
  archiveAfterDays: number;
  remindAfterHours: number;
  staleAfterDays: number;
}

export function defaultWallSettings(): WallSettings {
  const everyone = ['*'];
  const local = (chat: string) => ['owner', `chat:${chat}`, 'task:*'];
  return {
    channels: {
      agentctl: { authors: everyone, description: 'agentctl itself: bug reports, version announcements, questions' },
      nc: { authors: local('nc'), description: 'Neon City' },
      hems: { authors: local('hems'), description: 'HEMS' },
      'shared:sim': { authors: everyone, description: 'contract of @neon-city/sim (building heights …)' },
      'shared:weather': { authors: everyone, description: 'weather API' },
      'shared:maps': { authors: everyone, description: 'maps, helipads' },
    },
    chats: {
      nc: { channels: ['nc', 'agentctl', 'shared:*'], clients: [] },
      hems: { channels: ['hems', 'agentctl', 'shared:*'], clients: [] },
      agentctl: { channels: ['agentctl', 'shared:*'], clients: [] },
    },
    subscriptions: {},
    refRoots: ['~/Projects/cache'],
    archiveAfterDays: 14, remindAfterHours: 24, staleAfterDays: 7,
  };
}

/** `*` matches any run of characters; everything else is literal. */
export function wallGlob(pattern: string, value: string): boolean {
  if (!pattern.includes('*')) return pattern === value;
  return new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(value);
}

/** The channels in display order: `agentctl` first, then by name. */
export const sortedChannels = (wall: WallSettings): string[] => Object.keys(wall.channels).sort((a, b) => (a === WALL_TOOL_CHANNEL ? -1 : b === WALL_TOOL_CHANNEL ? 1 : a.localeCompare(b)));

/** What a task (`task:<ID>`) reads: `agentctl` and every channel whose authors name it (task:*, task:<ID>, *). */
export const taskReadableChannels = (wall: WallSettings, task: string): string[] =>
  sortedChannels(wall).filter((c) => c === WALL_TOOL_CHANNEL || (wall.channels[c]?.authors ?? []).some((a) => a === '*' || wallGlob(a, `task:${task}`)));

/**
 * A spec's `wall:` key: the channels whose open messages the agent gets (read-only) in its start prompt. Entries are channel names,
 * patterns (`shared:*`) or `chat:<name>` (the channels of that chat in wall.chats); each must name at least one channel the task reads.
 */
export function resolveSpecWall(wall: WallSettings, task: string | undefined, v: unknown, p: Problems): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  const list = typeof v === 'string' ? [v] : v;
  if (!Array.isArray(list) || list.some((x) => typeof x !== 'string' || !x.trim())) { p.add('wall must be a list of WALL channels, like wall: [nc, agentctl, "shared:*"] (or chat:<name> for the channels of a chat)'); return undefined; }
  const readable = task ? taskReadableChannels(wall, task) : sortedChannels(wall);
  const picked = new Set<string>();
  for (const raw of list as string[]) {
    const entry = raw.trim();
    const chat = /^chat:(.+)$/.exec(entry)?.[1];
    if (chat !== undefined && !wall.chats[chat]) { p.add(`wall: "${entry}" is no chat of wall.chats (known: ${Object.keys(wall.chats).map((n) => `chat:${n}`).join(', ') || 'none'})`); continue; }
    const patterns = chat !== undefined ? wall.chats[chat]!.channels : [entry];
    const known = sortedChannels(wall).filter((c) => patterns.some((pattern) => wallGlob(pattern, c)));
    if (!known.length) { p.add(`wall: "${entry}" names no channel of wall.channels (${sortedChannels(wall).join(', ')})`); continue; }
    const hits = known.filter((c) => readable.includes(c));
    if (!hits.length) { p.add(`wall: task:${task ?? '<ID>'} does not read ${known.join(', ')} (wall.channels.<channel>.authors must name task:* or task:${task ?? '<ID>'}); it reads ${readable.join(', ')}`); continue; }
    for (const c of hits) picked.add(c);
  }
  return sortedChannels(wall).filter((c) => picked.has(c));
}

const AUTHOR_PATTERN = /^(?:\*|owner|chat:(?:\*|[a-z0-9][a-z0-9_-]{0,39})|task:(?:\*|[A-Za-z0-9][A-Za-z0-9_*-]{0,39}))$/;
const CHANNEL_PATTERN = /^[a-z0-9*][a-z0-9*-]{0,39}(?::[a-z0-9*][a-z0-9*-]{0,39})?$/;

function stringList(v: unknown, where: string, p: Problems, check: RegExp, what: string): string[] | undefined {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) { p.add(`${where} must be a list of ${what}`); return undefined; }
  const bad = (v as string[]).filter((x) => !check.test(x));
  if (bad.length) { p.add(`${where}: not ${what}: ${bad.join(', ')}`); return undefined; }
  return [...new Set(v as string[])];
}

function keys(obj: Record<string, unknown>, allowed: string[], where: string, p: Problems): void {
  for (const key of Object.keys(obj)) if (!allowed.includes(key)) p.add(`${where}: unknown key "${key}" (allowed: ${allowed.join(', ')})`);
}

/** `wall.channels` and `wall.chats`, when given, are the whole list (the `agentctl` channel is added when missing). */
export function parseWall(v: unknown, p: Problems): WallSettings {
  const wall = defaultWallSettings();
  if (v === undefined || v === null) return wall;
  if (!isObject(v)) { p.add('config.wall must be a mapping like {channels: {nc: {authors: [owner, chat:nc]}}, chats: {nc: {channels: [nc, agentctl]}}}'); return wall; }
  keys(v, WALL_KEYS, 'config.wall', p);
  for (const [key, field] of [['archive_after_days', 'archiveAfterDays'], ['remind_after_hours', 'remindAfterHours'], ['stale_after_days', 'staleAfterDays']] as const) {
    if (v[key] === undefined) continue;
    if (typeof v[key] !== 'number' || !Number.isFinite(v[key]) || v[key] <= 0) p.add(`config.wall.${key} must be a positive number`);
    else wall[field] = v[key];
  }
  if (v.channels !== undefined && v.channels !== null) {
    if (!isObject(v.channels)) p.add('config.wall.channels must map channel names to {authors: [...], description: ...}');
    else {
      const channels: Record<string, WallChannelSettings> = {};
      for (const [name, raw] of Object.entries(v.channels)) {
        const where = `config.wall.channels.${name}`;
        if (!WALL_CHANNEL_NAME.test(name)) { p.add(`${where}: a channel name is lower-case letters, digits and "-", optionally with one "group:" prefix (shared:sim)`); continue; }
        if (!isObject(raw)) { p.add(`${where} must be a mapping like {authors: [owner, chat:nc]}`); continue; }
        keys(raw, WALL_CHANNEL_KEYS, where, p);
        const authors = raw.authors === undefined ? ['owner'] : stringList(raw.authors, `${where}.authors`, p, AUTHOR_PATTERN, 'authors (owner, chat:<name>, chat:*, task:<ID>, task:*, *)');
        if (!authors) continue;
        if (raw.description !== undefined && (typeof raw.description !== 'string' || raw.description.length > 200)) p.add(`${where}.description must be text of at most 200 characters`);
        channels[name] = { authors, ...(typeof raw.description === 'string' ? { description: raw.description } : {}) };
      }
      if (!channels[WALL_TOOL_CHANNEL]) channels[WALL_TOOL_CHANNEL] = defaultWallSettings().channels[WALL_TOOL_CHANNEL]!;
      wall.channels = channels;
    }
  }
  if (v.chats !== undefined && v.chats !== null) {
    if (!isObject(v.chats)) p.add('config.wall.chats must map chat names to {channels: [...], clients: [...]}');
    else {
      const chats: Record<string, WallChatSettings> = {};
      for (const [name, raw] of Object.entries(v.chats)) {
        const where = `config.wall.chats.${name}`;
        if (!WALL_CHAT_NAME.test(name)) { p.add(`${where}: a chat name is lower-case letters, digits, "_" and "-" (used as chat:${name})`); continue; }
        if (!isObject(raw)) { p.add(`${where} must be a mapping like {channels: [nc, agentctl, "shared:*"]}`); continue; }
        keys(raw, WALL_CHAT_KEYS, where, p);
        const channels = raw.channels === undefined ? [WALL_TOOL_CHANNEL] : stringList(raw.channels, `${where}.channels`, p, CHANNEL_PATTERN, 'channel names or patterns');
        const clients = raw.clients === undefined ? [] : stringList(raw.clients, `${where}.clients`, p, /^[\x21-\x7e][\x20-\x7e]{0,199}$/, 'MCP client names');
        if (channels && clients) chats[name] = { channels, clients };
      }
      wall.chats = chats;
    }
  }
  if (v.subscriptions !== undefined && v.subscriptions !== null) {
    if (!isObject(v.subscriptions)) p.add('config.wall.subscriptions must map a chat (or MCP client) name to a list of channels');
    else for (const [name, raw] of Object.entries(v.subscriptions)) {
      const list = stringList(raw, `config.wall.subscriptions.${name}`, p, CHANNEL_PATTERN, 'channel names or patterns');
      if (list) wall.subscriptions[name] = list;
    }
  }
  if (v.ref_roots !== undefined && v.ref_roots !== null) {
    const roots = stringList(v.ref_roots, 'config.wall.ref_roots', p, /^[~/]/, 'absolute paths (or ~/…)');
    if (roots) wall.refRoots = roots;
  }
  return wall;
}
