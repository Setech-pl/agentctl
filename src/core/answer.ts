import path from 'node:path';
import fs from 'node:fs';
import { atomicWriteFile } from './atomic-file.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { Context } from './context.ts';
import { provider } from './providers/registry.ts';
import { classifyScreen } from './state.ts';
import type { ScreenState } from './state.ts';
import { extractQuestion } from './events.ts';
import { withFileLock } from './file-lock.ts';
import { recordJournal } from './journal.ts';
import { readTaskRecord } from './taskstore.ts';

/*
 * `agentctl answer` / MCP `answer` (P63: FACADE-S34-REVIEW, 2026-11-08 00:25 — a `send` of "1" to a Kimi standing on
 * its "Run this command? 1. Approve once …" menu went into the FIFO instead of answering the menu). Chooses a numbered
 * option of the menu the agent shows in its current frame. Two steps like send --enter-only: without the token it only
 * previews (options, question, token); with the token it captures again and sends the digit only when the menu is
 * exactly what the preview showed.
 */

export interface MenuOption {
  n: number;
  label: string;
  /** The menu marks it as the current choice ("▶ 1. Approve once", "❯ 1. Yes"). */
  selected: boolean;
}

export interface FrameMenu {
  options: MenuOption[];
  question: string | undefined;
}

/** A numbered menu row: "▶ 1. Approve once", "❯ 1. Yes", "  2. No", "› 1. Yes, proceed (y)". */
const OPTION_LINE = /^\s*(▶|❯|›|>|▸)?\s*(\d+)[.)]\s+(\S.*)$/u;

/**
 * The numbered menu of the current frame: the last contiguous run of option lines on the screen, exactly 1..k in
 * order (at least two). Prose lists higher up are not the last run; a menu with a fresh echo below it is history and
 * the caller's screen-state check refuses it anyway. Undefined when the frame shows no menu.
 */
export function menuInFrame(screen: string): FrameMenu | undefined {
  const lines = screen.split('\n').map((l) => l.trimEnd());
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (OPTION_LINE.test(lines[i]!)) { last = i; break; }
  }
  if (last < 0) return undefined;
  let first = last;
  while (first > 0 && OPTION_LINE.test(lines[first - 1]!)) first--;
  const options: MenuOption[] = [];
  for (let i = first; i <= last; i++) {
    const m = OPTION_LINE.exec(lines[i]!)!;
    options.push({ n: Number(m[2]), label: m[3]!.trim(), selected: Boolean(m[1]) });
  }
  if (options.length < 2 || !options.some(o => o.selected) || options.some((o, i) => o.n !== i + 1)) return undefined;
  if (lines.slice(last + 1).some(l => /^\s*(?:│\s*)?[❯›>](?:\s|$)/u.test(l) || /^\s*\?\s+\d+ questions?\b/i.test(l))) return undefined;
  return { options, question: extractQuestion(screen) };
}

/** The options of the menu a task in needs-input (or needs-trust) shows, for status; undefined when there is none. */
export function menuOptionLines(screen: string): string[] | undefined {
  const menu = menuInFrame(screen);
  return menu ? menu.options.map((o) => `${o.n}. ${o.label}`) : undefined;
}

export interface AnswerResult {
  /** `answered`: the key went in and the menu is gone; `pending`: the key went in, the menu still shows; `ready`: preview only; `refused`/`failed`: no key. */
  outcome: 'answered' | 'pending' | 'ready' | 'refused' | 'failed';
  message: string;
  keySent?: boolean | undefined;
  menu?: string[] | undefined;
  question?: string | undefined;
  screenState?: ScreenState | undefined;
  token?: string | undefined;
}

/** A fresh, single-use preview binds the entire untruncated frame and task/window identity. */
interface AnswerPreview { token: string; frame: string; option: number; at: number }
const frameIdentity = (screen: string, identity: unknown): string =>
  createHash('sha256').update(JSON.stringify([identity, screen])).digest('hex');

const sameMenu = (a: FrameMenu, b: FrameMenu): boolean =>
  a.question === b.question && a.options.length === b.options.length && a.options.every((o, i) => o.n === b.options[i]!.n && o.label === b.options[i]!.label);

export async function answerMenu(ctx: Context, window: string, option: number, options: { token?: string } = {}): Promise<AnswerResult> {
  if (ctx.runner.dryRun) return { outcome: options.token ? 'answered' : 'ready', message: 'dry run: no key is sent', ...(options.token ? { keySent: false } : {}) };
  const done = await answerOnce(ctx, window, option, options);
  if (done.keySent) {
    const record = readTaskRecord(ctx.config, window);
    if (record) await recordJournal(ctx, { kind: 'delivery', task: record.task, text: `${record.task}: answer ${option} – ${done.message}` });
  }
  return done;
}

async function answerOnce(ctx: Context, window: string, option: number, options: { token?: string }): Promise<AnswerResult> {
  return withFileLock(path.join(ctx.config.stateDir, window, 'prompt-delivery.lock'), async () => {
    const refused = (message: string, menu?: FrameMenu): AnswerResult => ({ outcome: 'refused', message, ...(menu ? { menu: menu.options.map((o) => `${o.n}. ${o.label}`) } : {}) });
    const record = readTaskRecord(ctx.config, window);
    if (!record || record.agent === 'unknown') return refused('nie ma stanu zadania tego okna – nic nie zatwierdzam');
    const settings = ctx.config.agents[record.agent] ?? provider(record.agent).defaultSettings();
    const screen = await ctx.tmux.capture(window, undefined, undefined, record.windowId, true);
    if (screen.code !== 0) return refused(`okno ${window} nie daje się odczytać – nic nie zatwierdzam`);
    const state = classifyScreen(screen.stdout, settings);
    if (state !== 'needs-input' && state !== 'needs-trust') return refused(`${record.task}: agent pokazuje ${state}, nie menu – nie ma numerowanej opcji do wybrania (answer wybiera opcję menu z bieżącej ramki; zwykłą wiadomość wyślij przez send)`);
    const menu = menuInFrame(screen.stdout);
    if (!menu) return refused(`${record.task}: w bieżącej ramce nie widać numerowanego menu – odpowiedz w oknie (attach)`);
    const chosen = menu.options.find((o) => o.n === option);
    if (!chosen) return refused(`${record.task}: opcja ${option} nie istnieje – menu ma opcje ${menu.options.map((o) => o.n).join(', ')}`, menu);
    const previewFile = path.join(ctx.config.stateDir, window, 'answer-preview.json');
    const frame = frameIdentity(screen.stdout, [window, record.windowId, record.started, record.attemptId, record.agent]);
    const shown = menu.options.map((o) => `${o.n}. ${o.label}`);
    if (!options.token) {
      const token = randomUUID();
      atomicWriteFile(previewFile, JSON.stringify({ token, frame, option, at: ctx.runner.now() } satisfies AnswerPreview));
      const what = menu.question ? `Menu: ${menu.question}\n` : '';
      return { outcome: 'ready', message: `${record.task}: ${what}${shown.map((l) => `  ${l}`).join('\n')}\nnic nie poszło; wybór ${option}. ${chosen.label} zostanie wysłany dopiero z tokenem ${token}`, menu: shown, question: menu.question, screenState: state, token };
    }
    let preview: AnswerPreview | undefined;
    try { preview = JSON.parse(fs.readFileSync(previewFile, 'utf8')); } catch { /* no current preview */ }
    const token = options.token;
    if (!preview || preview.token !== token || preview.frame !== frame || preview.option !== option || ctx.runner.now() - preview.at > ctx.config.preview.ttlS * 1000) return refused(`${record.task}: token nie pasuje do bieżącego menu (podgląd był dla innego menu albo innej opcji) – zrób podgląd jeszcze raz`, menu);
    // Consume before the side effect: uncertain delivery requires a new preview, never an automatic retry.
    fs.unlinkSync(previewFile);
    const pressed = await ctx.tmux.sendKey(window, String(option), record.windowId);
    if (pressed.code !== 0) return { outcome: 'failed', message: `klawisz ${option} nie poszedł: ${pressed.stderr.trim() || `tmux exit ${pressed.code}`}`, keySent: false };
    for (let poll = 0; poll < 6; poll++) {
      await ctx.runner.sleep(150);
      const pane = await ctx.tmux.capture(window, undefined, undefined, record.windowId, true);
      if (pane.code !== 0) break;
      const now = menuInFrame(pane.stdout);
      if (!now || !sameMenu(now, menu)) return { outcome: 'answered', message: `wybrano ${option}. ${chosen.label} – menu zniknęło z ekranu`, keySent: true, token };
    }
    return { outcome: 'pending', message: `wysłano klawisz ${option} (${chosen.label}), ale menu nadal jest na ekranie – sprawdź peek/attach`, keySent: true, token };
  });
}
