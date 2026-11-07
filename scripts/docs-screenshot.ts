import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { defaultCacheRoot } from './live-harness.ts';
import { captureBoard, captureChat, COLUMNS } from './demo-board.ts';
import { FONT_STACK, parseAnsi, renderSvg } from './render-ansi.ts';
import { boardTitle } from '../src/core/title.ts';
import { packageVersion } from '../src/core/version.ts';

/*
 * `npm run docs:screenshot`: runs the demo session (scripts/demo-board.ts) and writes
 *   docs/img/board.svg, docs/img/board.png          the board of the demo, rendered from its coloured screen (scripts/render-ansi.ts)
 *   docs/demo/events_since.txt, docs/demo/pull_ready.txt   what a chat gets from the same session (shown in the README)
 * The same code and the same fake agents give the same files; tests/docs.test.ts checks that the README shows these texts.
 * Nothing real is touched: own tmux server, fake agents, own AGENTCTL_HOME under .cache/ (or AGENTCTL_LIVE_CACHE).
 */
const root = path.resolve(import.meta.dirname, '..');
const cache = defaultCacheRoot();
fs.mkdirSync(cache, { recursive: true });

const board = await captureBoard(cache);
const chat = await captureChat(cache);

const img = path.join(root, 'docs', 'img');
fs.mkdirSync(img, { recursive: true });
const svg = renderSvg(parseAnsi(board.ansi, COLUMNS), { title: boardTitle(packageVersion()) });
fs.writeFileSync(path.join(img, 'board.svg'), svg);

// The PNG is rasterised with DejaVu Sans Mono (and DejaVu Sans for the symbols the mono face lacks) from node_modules, never from the system.
const require = createRequire(import.meta.url);
const { Resvg } = require('@resvg/resvg-js') as typeof import('@resvg/resvg-js');
const fonts = path.dirname(require.resolve('dejavu-fonts-ttf/package.json'));
const fontFiles = ['DejaVuSansMono.ttf', 'DejaVuSansMono-Bold.ttf', 'DejaVuSans.ttf'].map((f) => path.join(fonts, 'ttf', f));
const png = new Resvg(svg.replaceAll(FONT_STACK, "'DejaVu Sans Mono'"), { font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'DejaVu Sans Mono' }, fitTo: { mode: 'zoom', value: 1.5 } }).render().asPng();
fs.writeFileSync(path.join(img, 'board.png'), png);

const demo = path.join(root, 'docs', 'demo');
fs.mkdirSync(demo, { recursive: true });
fs.writeFileSync(path.join(demo, 'events_since.txt'), chat.events.endsWith('\n') ? chat.events : `${chat.events}\n`);
fs.writeFileSync(path.join(demo, 'pull_ready.txt'), chat.pull.endsWith('\n') ? chat.pull : `${chat.pull}\n`);
console.log(`wrote docs/img/board.svg (${svg.length} B), docs/img/board.png (${png.length} B), docs/demo/events_since.txt, docs/demo/pull_ready.txt`);
