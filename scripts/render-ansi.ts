/*
 * A terminal screen with colours (the output of `tmux capture-pane -e -p`) as an SVG, and the SVG as a PNG.
 *
 * Why our own renderer: the input is one fixed-size screen with a handful of SGR codes (bold, dim, 16 colours), and the output has to be
 * exactly reproducible and exactly on the character grid. An "ansi to svg" package would add a dependency for a few dozen lines, and none
 * of the maintained ones lays text out cell by cell. Every word is placed at its column with an explicit text length, so the picture
 * stays aligned in whatever monospace font the viewer has (GitHub shows an SVG without web fonts). The PNG is rasterised by resvg
 * (@resvg/resvg-js, a devDependency with a prebuilt binary, no global install) with DejaVu Sans Mono from the dejavu-fonts-ttf devDependency
 * only (no system fonts), so it is the same on every machine.
 */

export interface Cell {
  ch: string;
  /** 1, or 2 for a wide character (the next cell is then `continuation`). */
  width: 1 | 2;
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  continuation?: true;
}

/** A dark theme close to GitHub's: the 16 ANSI colours by index. */
export const THEME = {
  background: '#0d1117',
  foreground: '#c9d1d9',
  chrome: '#161b22',
  border: '#30363d',
  title: '#8b949e',
  ansi: ['#484f58', '#f85149', '#3fb950', '#d29922', '#58a6ff', '#bc8cff', '#39c5cf', '#c9d1d9', '#6e7681', '#ff7b72', '#56d364', '#e3b341', '#79c0ff', '#d2a8ff', '#56d4dd', '#f0f6fc'],
};

const WIDE_SINGLES = new Set([0x231a, 0x231b, 0x23e9, 0x23ea, 0x23eb, 0x23ec, 0x23f0, 0x23f3, 0x25fd, 0x25fe, 0x2614, 0x2615, 0x267f, 0x2693, 0x26a1, 0x26aa, 0x26ab, 0x26bd, 0x26be, 0x26c4, 0x26c5, 0x26ce, 0x26d4, 0x26ea, 0x26f2, 0x26f3, 0x26f5, 0x26fa, 0x26fd, 0x2705, 0x270a, 0x270b, 0x2728, 0x274c, 0x274e, 0x2753, 0x2754, 0x2755, 0x2757, 0x2795, 0x2796, 0x2797, 0x27b0, 0x27bf, 0x2b1b, 0x2b1c, 0x2b50, 0x2b55]);

/** Columns a character takes in a terminal: 2 for East Asian wide and emoji-presentation characters, else 1. */
export function charWidth(ch: string): 1 | 2 {
  const cp = ch.codePointAt(0) as number;
  if (WIDE_SINGLES.has(cp)) return 2;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f900 && cp <= 0x1f9ff)) return 2;
  return 1;
}

interface Pen {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  inverse: boolean;
}

const fresh = (): Pen => ({ fg: null, bg: null, bold: false, dim: false, inverse: false });

function xterm256(n: number): string {
  if (n < 16) return THEME.ansi[n] as string;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const level = (x: number): number => (x === 0 ? 0 : 55 + x * 40);
  return `rgb(${level(Math.floor(i / 36))},${level(Math.floor(i / 6) % 6)},${level(i % 6)})`;
}

function applySgr(pen: Pen, params: number[]): void {
  for (let i = 0; i < params.length; i++) {
    const p = params[i] as number;
    if (p === 0) Object.assign(pen, fresh());
    else if (p === 1) pen.bold = true;
    else if (p === 2) pen.dim = true;
    else if (p === 22) pen.bold = pen.dim = false;
    else if (p === 7) pen.inverse = true;
    else if (p === 27) pen.inverse = false;
    else if (p >= 30 && p <= 37) pen.fg = THEME.ansi[p - 30] as string;
    else if (p >= 90 && p <= 97) pen.fg = THEME.ansi[p - 90 + 8] as string;
    else if (p === 39) pen.fg = null;
    else if (p >= 40 && p <= 47) pen.bg = THEME.ansi[p - 40] as string;
    else if (p >= 100 && p <= 107) pen.bg = THEME.ansi[p - 100 + 8] as string;
    else if (p === 49) pen.bg = null;
    else if (p === 38 || p === 48) {
      const target = p === 38 ? 'fg' : 'bg';
      if (params[i + 1] === 5) {
        pen[target] = xterm256(params[i + 2] ?? 0);
        i += 2;
      } else if (params[i + 1] === 2) {
        pen[target] = `rgb(${params[i + 2] ?? 0},${params[i + 3] ?? 0},${params[i + 4] ?? 0})`;
        i += 4;
      }
    }
  }
}

/** The screen as rows of cells, `columns` wide; missing characters are spaces. Only SGR is interpreted (capture-pane emits nothing else). */
export function parseAnsi(text: string, columns: number): Cell[][] {
  const rows: Cell[][] = [];
  const pen = fresh();
  for (const line of text.replace(/\r/g, '').replace(/\n$/, '').split('\n')) {
    const row: Cell[] = [];
    const push = (ch: string): void => {
      const width = charWidth(ch);
      const fg = pen.inverse ? (pen.bg ?? THEME.background) : pen.fg;
      const bg = pen.inverse ? (pen.fg ?? THEME.foreground) : pen.bg;
      row.push({ ch, width, fg, bg, bold: pen.bold, dim: pen.dim });
      if (width === 2) row.push({ ch: '', width: 1, fg, bg, bold: pen.bold, dim: pen.dim, continuation: true });
    };
    const re = /\u001b\[([0-9;]*)m|([^\u001b])/gu;
    for (let m = re.exec(line); m !== null; m = re.exec(line)) {
      if (m[2] !== undefined) push(m[2]);
      else applySgr(pen, (m[1] === '' ? '0' : (m[1] as string)).split(';').map(Number));
    }
    while (row.length < columns) row.push({ ch: ' ', width: 1, fg: null, bg: pen.bg, bold: false, dim: false });
    rows.push(row);
  }
  return rows;
}

const escapeXml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface SvgOptions {
  title: string;
  /** Font size in px; the cell is 0.602 em wide (DejaVu Sans Mono) and 1.3 em high. */
  fontSize?: number;
}

export const FONT_STACK = "'DejaVu Sans Mono', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

export function renderSvg(rows: Cell[][], options: SvgOptions): string {
  const fs = options.fontSize ?? 15;
  const cw = Math.round(fs * 0.602 * 100) / 100;
  const lh = Math.round(fs * 1.3 * 100) / 100;
  const columns = rows[0]?.length ?? 0;
  const padX = 22;
  const padTop = 52;
  const padBottom = 20;
  const width = Math.round(columns * cw + padX * 2);
  const height = Math.round(rows.length * lh + padTop + padBottom);
  const colour = (c: Cell): string => c.fg ?? THEME.foreground;
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(options.title)}">`);
  out.push(`<title>${escapeXml(options.title)}</title>`);
  out.push(`<rect width="${width}" height="${height}" rx="10" fill="${THEME.border}"/>`);
  out.push(`<rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="9" fill="${THEME.background}"/>`);
  out.push(`<path d="M1 36V10a9 9 0 0 1 9-9h${width - 20}a9 9 0 0 1 9 9v26z" fill="${THEME.chrome}"/>`);
  for (const [i, c] of ['#ff5f56', '#ffbd2e', '#27c93f'].entries()) out.push(`<circle cx="${22 + i * 20}" cy="19" r="6" fill="${c}"/>`);
  out.push(`<text x="${width / 2}" y="24" text-anchor="middle" font-family="${FONT_STACK}" font-size="13" fill="${THEME.title}">${escapeXml(options.title)}</text>`);
  out.push(`<g font-family="${FONT_STACK}" font-size="${fs}">`);
  // backgrounds: runs of cells with the same bg
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      const bg = (row[x] as Cell).bg;
      let end = x + 1;
      while (end < row.length && (row[end] as Cell).bg === bg) end++;
      if (bg) out.push(`<rect x="${(padX + x * cw).toFixed(2)}" y="${(padTop + y * lh).toFixed(2)}" width="${((end - x) * cw).toFixed(2)}" height="${lh}" fill="${bg}"/>`);
      x = end;
    }
  });
  // text: one element per word (a run of characters of one style without spaces), placed on its column
  rows.forEach((row, y) => {
    const baseline = padTop + y * lh + lh * 0.72;
    for (let x = 0; x < row.length; ) {
      const cell = row[x] as Cell;
      if (cell.continuation || cell.ch === ' ' || cell.ch === '') {
        x++;
        continue;
      }
      if (cell.ch === '│' || cell.ch === '─') {
        const cx = padX + x * cw;
        const cy = padTop + y * lh;
        out.push(cell.ch === '│' ? `<rect x="${(cx + cw / 2 - 0.5).toFixed(2)}" y="${cy.toFixed(2)}" width="1" height="${lh}" fill="${colour(cell)}" opacity="${cell.dim ? 0.5 : 0.8}"/>` : `<rect x="${cx.toFixed(2)}" y="${(cy + lh / 2 - 0.5).toFixed(2)}" width="${cw}" height="1" fill="${colour(cell)}" opacity="${cell.dim ? 0.5 : 0.8}"/>`);
        x++;
        continue;
      }
      if (cell.ch === '⏳' || cell.ch === '⧗') {
        // U+23F3 (emoji, two cells) and U+29D7 have no glyph in a monospace font: they are drawn as an hourglass in the cell's colour
        const span = cell.width;
        const cx = padX + (x + span / 2) * cw;
        const cy = padTop + y * lh + lh / 2;
        const w = cw * (span === 2 ? 0.42 : 0.38);
        const hh = lh * 0.34;
        const f = colour(cell);
        out.push(`<path d="M${(cx - w).toFixed(2)} ${(cy - hh).toFixed(2)}H${(cx + w).toFixed(2)}L${cx.toFixed(2)} ${cy.toFixed(2)}ZM${cx.toFixed(2)} ${cy.toFixed(2)}L${(cx + w).toFixed(2)} ${(cy + hh).toFixed(2)}H${(cx - w).toFixed(2)}Z" fill="${f}"${cell.dim ? ' opacity="0.6"' : ''}/>`);
        x += span;
        continue;
      }
      let end = x + 1;
      let text = cell.ch;
      let wide = cell.width === 2;
      while (end < row.length) {
        const next = row[end] as Cell;
        if (next.continuation) {
          end++;
          continue;
        }
        if (next.ch === ' ' || next.ch === '⧗' || next.ch === '⏳' || next.ch === '│' || next.ch === '─' || next.width === 2 || wide || next.fg !== cell.fg || next.bold !== cell.bold || next.dim !== cell.dim) break;
        text += next.ch;
        end++;
      }
      const attrs = [`x="${(padX + x * cw).toFixed(2)}"`, `y="${baseline.toFixed(2)}"`, `fill="${colour(cell)}"`];
      if (cell.bold) attrs.push('font-weight="700"');
      if (cell.dim) attrs.push('opacity="0.6"');
      // a word of narrow characters is stretched to its columns, so the grid holds in any monospace font
      if (!wide && [...text].length > 1) attrs.push(`textLength="${((end - x) * cw).toFixed(2)}"`, 'lengthAdjust="spacing"');
      out.push(`<text ${attrs.join(' ')}>${escapeXml(text)}</text>`);
      x = end;
      wide = false;
    }
  });
  out.push('</g>', '</svg>');
  return `${out.join('\n')}\n`;
}
