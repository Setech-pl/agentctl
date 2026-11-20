import { stripVTControlCharacters } from 'node:util';
import truncate from 'cli-truncate';
import stringWidth from 'string-width';
import type { BoardCell } from '../core/board.ts';
import type { BoardSelection } from '../core/config.ts';

type ColorDepth = 1 | 4 | 8 | 24;

export function selectionColorDepth(env: NodeJS.ProcessEnv): ColorDepth {
  if (env.NO_COLOR || env.FORCE_COLOR === '0' || env.TERM === 'dumb') return 1;
  if (env.FORCE_COLOR === '3' || /^(truecolor|24bit)$/i.test(env.COLORTERM ?? '') || /-direct$/.test(env.TERM ?? '')) return 24;
  if (env.FORCE_COLOR === '2' || /256color/.test(env.TERM ?? '')) return 8;
  return 4;
}

const cube = [0, 95, 135, 175, 215, 255];
const rgb = (hex: string) => [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16));

function nearestIndex(channels: number[]): number {
  const distance = (other: number[]) => channels.reduce((sum, value, i) => sum + (value - other[i]!) ** 2, 0);
  const [r, g, b] = channels.map(value => cube.reduce((best, level, i) => Math.abs(value - level) < Math.abs(value - cube[best]!) ? i : best, 0)) as [number, number, number];
  const gray = Math.min(23, Math.max(0, Math.round((channels.reduce((sum, value) => sum + value, 0) / 3 - 8) / 10)));
  return distance([cube[r]!, cube[g]!, cube[b]!]) <= distance(Array<number>(3).fill(8 + 10 * gray))
    ? 16 + 36 * r + 6 * g + b : 232 + gray;
}

function colorCode(channel: 38 | 48, color: string | number, depth: ColorDepth): string {
  if (typeof color === 'number') return `${channel};5;${color}`;
  const channels = rgb(color);
  return depth === 24 ? `${channel};2;${channels.join(';')}` : `${channel};5;${nearestIndex(channels)}`;
}

/** Build one style for the entire row, including gaps and trailing spaces. */
export function selectionStyle(settings: BoardSelection, depth: ColorDepth, focused = true): string {
  // Explicit SGR keeps reverse video available when Ink's colors are disabled.
  if (depth === 1) return '\x1b[7m';
  const reverse = depth === 4 || settings.style === 'reverse';
  const bold = settings.bold !== false && (focused || !reverse);
  if (reverse) return bold ? '\x1b[1;7m' : '\x1b[7m';
  const bg = focused ? settings.bg ?? (depth === 24 ? '#2f4f7f' : 24) : depth === 24 ? '#333a45' : 237;
  const fg = settings.fg ?? 15;
  return `\x1b[${bold ? '1;' : ''}${colorCode(38, fg, depth)};${colorCode(48, bg, depth)}m`;
}

function fit(text: string, width: number): string {
  const plain = stripVTControlCharacters(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  const clipped = truncate(plain, width);
  return clipped + ' '.repeat(Math.max(0, width - stringWidth(clipped)));
}

export function selectionText(value: string | BoardCell[], width: number, style: string): string {
  const text = typeof value === 'string' ? value : value.map(cell => fit(cell.text, cell.width)).join(' ');
  return style + fit(text, width) + '\x1b[0m';
}
