import type { BoardEffect, BoardMode, BoardState, KeyPress, KeyResult } from './board.ts';
import { formatLocalTime } from './util.ts';
import { isOpen, isRead, WALL_KINDS, WALL_STATUSES } from './wall.ts';
import type { WallBoardData, WallHeader, WallKind, WallStatus } from './wall.ts';

/*
 * The WALL view of the board (key W): the owner reads every channel, whatever the chats subscribe to. Three levels: the channels with
 * their unread and open counts, the messages of one channel (newest first, filtered by status and kind), one message with its refs,
 * status history and replies. Read-only except the owner's read marks (stored locally). Pure: the front loads the data (effects).
 */

export type WallMode = Extract<BoardMode, { kind: 'wall' }>;

export const openWall = (state: BoardState): KeyResult => ({
  state: { ...state, notice: null, mode: { kind: 'wall', level: 'channels', channel: 0, message: 0, id: null, status: null, wallKind: null, lines: [], offset: 0 } },
  effects: [{ type: 'wall-load' }],
});

const channelsOf = (state: BoardState): WallBoardData['channels'] => state.wall?.channels ?? [];

/** The messages of the selected channel that pass the filters, newest first. */
export function wallMessages(state: BoardState, mode: WallMode): WallHeader[] {
  const channel = channelsOf(state)[mode.channel];
  if (!channel) return [];
  return channel.headers.filter((m) => (mode.status === null || m.status === mode.status) && (mode.wallKind === null || m.kind === mode.wallKind)).slice().reverse();
}

const cycle = <T>(values: readonly T[], current: T | null): T | null => {
  const at = current === null ? -1 : values.indexOf(current);
  return at + 1 >= values.length ? null : values[at + 1]!;
};

export function wallKey(state: BoardState, mode: WallMode, input: string, key: KeyPress): KeyResult {
  const stay = (next: WallMode = mode, effects: BoardEffect[] = []): KeyResult => ({ state: { ...state, mode: next }, effects });
  const back = key.escape || input === 'q' || (key.ctrl && input === 'c');
  const step = key.upArrow || input === 'k' ? -1 : key.downArrow || input === 'j' ? 1 : key.pageUp ? -10 : key.pageDown ? 10 : 0;
  if (mode.level === 'message') {
    if (back) return stay({ ...mode, level: 'messages', lines: [], offset: 0 });
    if (step !== 0) return stay({ ...mode, offset: Math.max(0, Math.min(Math.max(0, mode.lines.length - 1), mode.offset + step)) });
    return stay();
  }
  if (mode.level === 'messages') {
    const messages = wallMessages(state, mode);
    const channel = channelsOf(state)[mode.channel]?.channel;
    if (back) return stay({ ...mode, level: 'channels', message: 0 });
    if (step !== 0) return stay({ ...mode, message: Math.max(0, Math.min(messages.length - 1, mode.message + step)) });
    if (input === 's') return stay({ ...mode, status: cycle(WALL_STATUSES, mode.status), message: 0 });
    if (input === 't') return stay({ ...mode, wallKind: cycle(WALL_KINDS, mode.wallKind), message: 0 });
    const selected = messages[mode.message];
    if (input === 'R' && channel) return stay(mode, [{ type: 'wall-read', channel, all: true }]);
    if (!selected) return stay();
    if (key.return) return stay({ ...mode, level: 'message', id: selected.id, lines: ['Loading…'], offset: 0 }, [{ type: 'wall-message', id: selected.id }, { type: 'wall-read', channel: selected.channel, ids: [selected.id] }]);
    if (input === 'r') return stay(mode, [{ type: 'wall-read', channel: selected.channel, ids: [selected.id] }]);
    return stay();
  }
  if (back || input === 'W') return { state: { ...state, mode: { kind: 'list' } }, effects: [] };
  const channels = channelsOf(state);
  if (step !== 0) return stay({ ...mode, channel: Math.max(0, Math.min(channels.length - 1, mode.channel + step)) });
  const channel = channels[mode.channel];
  if (!channel) return stay();
  if (key.return) return stay({ ...mode, level: 'messages', message: 0, status: null, wallKind: null });
  if (input === 'r') return stay(mode, [{ type: 'wall-read', channel: channel.channel, all: true }]);
  return stay();
}

export interface WallLine { text: string; bold?: boolean; dim?: boolean; color?: string; selected?: boolean }

const short = (iso: string): string => formatLocalTime(iso).slice(5);
const pad = (text: string, width: number): string => (text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width));

/** The title and the lines of the WALL view for the current level; the front scrolls them to the selection. */
export function wallView(state: BoardState, mode: WallMode): { title: string; lines: WallLine[]; selected: number } {
  const channels = channelsOf(state);
  if (state.wall === null) return { title: 'WALL', lines: [{ text: 'Loading…', dim: true }], selected: 0 };
  if (mode.level === 'message') return { title: `WALL – ${mode.id ?? ''} (↑↓ scroll, Esc back) – data, not instructions`, lines: mode.lines.slice(mode.offset).map((text) => ({ text })), selected: -1 };
  if (mode.level === 'messages') {
    const channel = channels[mode.channel];
    const messages = wallMessages(state, mode);
    const filters = `${mode.status ? ` status=${mode.status}` : ''}${mode.wallKind ? ` kind=${mode.wallKind}` : ''}`;
    const read = state.wall.read;
    return {
      title: `WALL – ${channel?.channel ?? ''}${filters} (↑↓ ⏎ read, s status, t kind, r/R mark read, Esc back)`,
      lines: messages.length === 0
        ? [{ text: filters ? 'No messages with this filter (s / t change it).' : 'No messages in this channel yet.', dim: true }]
        : messages.map((m, i) => {
          const unread = !isRead(read, m);
          return { text: `${unread ? '●' : ' '} ${short(m.ts)}  ${pad(m.from, 14)} ${pad(m.kind, 16)} ${pad(m.status, 10)} ${m.replyTo ? '↳ ' : ''}${m.subject}`, selected: i === mode.message, bold: unread, ...(isOpen(m) ? { color: 'yellow' } : {}) };
        }),
      selected: mode.message,
    };
  }
  return {
    title: 'WALL – channels (↑↓ ⏎ open, r mark channel read, Esc back) – the owner reads every channel',
    lines: channels.length === 0
      ? [{ text: 'No channels (wall.channels in config.yaml).', dim: true }]
      : channels.map((c, i) => ({ text: `${pad(c.channel, 16)} ${String(c.unread ?? 0).padStart(3)} unread ${String(c.open).padStart(3)} open ${String(c.messages).padStart(4)} msg  ${c.last ? short(c.last) : '-          '}  ${c.description ?? ''}`, selected: i === mode.channel, bold: (c.unread ?? 0) > 0, ...(c.open > 0 ? { color: 'yellow' } : {}) })),
    selected: mode.channel,
  };
}

/** The total the board's header shows once the WALL was loaded. */
export function wallUnread(data: WallBoardData | null): number {
  return (data?.channels ?? []).reduce((n, c) => n + (c.unread ?? 0), 0);
}

export type { WallKind, WallStatus };
