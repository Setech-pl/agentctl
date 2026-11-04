import { diskLine } from '../core/disk.ts';
import fs from 'node:fs';
import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput, useWindowSize } from 'ink';
import {
  applySnapshot,
  boardColumns,
  boardLayout,
  cancelledTitle,
  closedTitle,
  cohortLabel,
  finishedTitle,
  groupTitle,
  BOARD_REFRESH_MS,
  clearNotice,
  handleKey,
  HELP_LINES,
  headerCells,
  initialBoardState,
  KEY_HINTS,
  awayLabel,
  loadBoard,
  managerLine,
  modelHelp,
  loadLogLines,
  ProgressCache,
  promptText,
  queueCells,
  queueTitle,
  resumeTitle,
  rowCells,
  runBoardEffect,
  usagePanel,
  loadViewLines,
  VIEW_TITLES,
  showNotice,
  visibleItems,
  withBusy,
  withLoadError,
  withSize,
} from '../core/board.ts';
import type { BoardCell, BoardEffect, BoardState } from '../core/board.ts';
import type { Context } from '../core/context.ts';
import type { SelfArgv } from '../core/events.ts';
import { navigationHint } from '../core/navigation.ts';
import { errorMessage } from '../core/util.ts';
import { tmuxTitleString, titleEnd, titleStart } from '../core/title.ts';
import { packageVersion } from '../core/version.ts';

/*
 * The Ink front of `agentctl board`: draws a BoardState and forwards keys to handleKey. No JSX: the project runs on Node's
 * type stripping without a build step, and React.createElement needs none (see the README for why not htm).
 */

const h = React.createElement;

/** A notice stays on the footer this long. */
const NOTICE_MS = 6000;

function Cells(props: { cells: BoardCell[]; inverse?: boolean }): React.ReactElement {
  return h(
    Box,
    { flexDirection: 'row' },
    ...props.cells.map((c) =>
      h(
        Box,
        { key: c.key, width: c.width, marginRight: c.key === 'report' ? 0 : 1 },
        h(Text, { wrap: 'truncate-end', ...(c.color ? { color: c.color } : {}), ...(c.dim ? { dimColor: true } : {}), ...(c.bold ? { bold: true } : {}), ...(props.inverse ? { inverse: true } : {}) }, c.text),
      ),
    ),
  );
}

function TaskList(props: { state: BoardState; width: number; capacity: number; icons: Parameters<typeof rowCells>[3]; selectedColor: string; versions: Record<string, string> }): React.ReactElement {
  const { state } = props;
  const cols = boardColumns(props.width);
  const visible = visibleItems(state, props.capacity);
  const body =
    visible.items.length === 0
      ? [h(Text, { key: 'empty', dimColor: true }, state.refreshedAt === null ? 'Loading…' : state.rows.length === 0 ? 'No tasks. Start one with "agentctl new <spec>".' : state.cohortFilter !== null ? 'No tasks in this cohort. k picks another.' : 'No active tasks. z opens the finished ones.')]
      : visible.items.map((item) =>
          item.kind === 'group'
            ? h(Text, { key: `group-${item.key}`, bold: true, wrap: 'truncate-end' }, groupTitle(item, props.icons))
            : item.kind === 'queue-title'
            ? h(Text, { key: 'queue-title', dimColor: true, wrap: 'truncate-end' }, `- ${queueTitle(item.count, item.paused)}`)
            : item.kind === 'resume-title'
            ? h(Text, { key: 'resume-title', color: 'yellow', wrap: 'truncate-end' }, `- ${resumeTitle(item.count)}`)
            : item.kind === 'resume'
            ? h(Text, { key: `r-${item.task}`, dimColor: true, wrap: 'truncate-end' }, `    ${item.task}`)
            : item.kind === 'queue'
              ? h(Cells, { key: `q-${item.view.entry.task}`, cells: queueCells(item.view, item.view.entry.task === state.selected, cols, props.selectedColor, props.versions) })
              : item.kind === 'finished'
            ? h(Text, { key: 'finished', dimColor: true, wrap: 'truncate-end' }, `${item.expanded ? '-' : '+'} ${finishedTitle(item.count, item.expanded)}`)
            : item.kind === 'closed'
              ? h(Text, { key: 'closed', dimColor: true, wrap: 'truncate-end' }, `- ${closedTitle(item.count)}`)
              : item.kind === 'cancelled'
                ? h(Text, { key: 'cancelled', dimColor: true, wrap: 'truncate-end' }, `- ${cancelledTitle(item.count)}`)
                : h(Cells, { key: item.row.task, cells: rowCells(item.row, item.row.task === state.selected, cols, props.icons, props.selectedColor, props.versions) }),
        );
  return h(Box, { flexDirection: 'column', width: props.width }, h(Cells, { cells: headerCells(cols) }), ...body);
}

function Preview(props: { state: BoardState; width: number; height: number }): React.ReactElement {
  const { state } = props;
  const preview = state.preview;
  const lines = preview ? preview.lines.slice(-Math.max(1, props.height - (preview?.model ? 3 : 1))) : [];
  return h(
    Box,
    { flexDirection: 'column', width: props.width, borderStyle: 'single', borderTop: false, borderRight: false, borderBottom: false, paddingLeft: 1 },
    h(Text, { dimColor: true, wrap: 'truncate-end' }, preview ? (preview.note ? `${preview.task} · ${preview.note}` : `${preview.task} · last ${preview.lines.length} lines`) : ''),
    preview?.model ? h(Text, { dimColor: true }, preview.model) : null,
    ...lines.map((l, i) => h(Text, { key: i, wrap: 'truncate-end' }, l === '' ? ' ' : l)),
  );
}

function Footer(props: { state: BoardState; hint: string }): React.ReactElement {
  const { state } = props;
  const prompt = promptText(state);
  const status = state.busy ?? (state.loadError ? `refresh failed: ${state.loadError}` : null) ?? props.hint;
  return h(
    Box,
    { flexDirection: 'column' },
    prompt
      ? h(Text, { wrap: 'truncate-end', color: state.mode.kind === 'input' ? 'cyan' : 'yellow', bold: true }, prompt)
      : state.notice
        ? h(Text, { wrap: 'truncate-end', color: state.notice.level === 'error' ? 'red' : 'green' }, state.notice.text)
        : h(Text, { wrap: 'truncate-end', ...(state.loadError ? { color: 'red' } : { dimColor: true }) }, status ?? ' '),
    h(Text, { wrap: 'truncate-end', dimColor: true }, KEY_HINTS),
  );
}

export function Board(props: { ctx: Context; insideTmux: boolean; self?: SelfArgv | undefined }): React.ReactElement {
  const { ctx, insideTmux, self } = props;
  const { exit } = useApp();
  const size = useWindowSize();
  const [state, setState] = useState<BoardState>(() => initialBoardState(size.columns, size.rows));
  const current = useRef(state);
  const update = (fn: (s: BoardState) => BoardState): void => {
    current.current = fn(current.current);
    setState(current.current);
  };
  const cache = useRef(new ProgressCache());
  const queue = useRef<Promise<void>>(Promise.resolve());
  const refreshNow = useRef<() => void>(() => {});
  const noticeTimer = useRef<NodeJS.Timeout | undefined>(undefined);

  useEffect(() => update((s) => withSize(s, size.columns, size.rows)), [size.columns, size.rows]);

  useEffect(() => {
    let stopped = false;
    let running = false;
    let again = false;
    const tick = async (): Promise<void> => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          try {
            const snap = await loadBoard(ctx, current.current.selected, cache.current);
            if (!stopped) update((s) => applySnapshot(s, snap));
          } catch (e) {
            if (!stopped) update((s) => withLoadError(s, errorMessage(e).split('\n')[0] as string));
          }
        } while (again && !stopped);
      } finally {
        running = false;
      }
    };
    refreshNow.current = () => void tick();
    void tick();
    const timer = setInterval(() => void tick(), BOARD_REFRESH_MS);
    // An agent's own event (agentctl event writes <state_dir>/<task>/event.json) shows at once, not at the next refresh.
    let watcher: fs.FSWatcher | undefined;
    try {
      watcher = fs.watch(ctx.config.stateDir, { recursive: true }, (_type, name) => {
        if (name && /event\.json$/.test(name)) void tick();
      });
      watcher.on('error', () => watcher?.close());
    } catch {
      // no state folder yet, or no recursive watching here: the 2 s refresh still shows it
    }
    return () => {
      stopped = true;
      clearInterval(timer);
      watcher?.close();
    };
  }, []);

  const runEffect = (effect: BoardEffect): void => {
    if (effect.type === 'quit') return exit();
    if (effect.type === 'refresh') return refreshNow.current();
    if (effect.type === 'log') {
      let lines: string[];
      try {
        lines = loadLogLines(ctx);
      } catch (e) {
        lines = [`cannot read the history: ${errorMessage(e)}`];
      }
      return update((s) => (s.mode.kind === 'log' ? { ...s, mode: { kind: 'log', lines, offset: 0 } } : s));
    }
    if (effect.type === 'view') {
      return void loadViewLines(ctx, effect.what).catch((e: unknown) => [`cannot load: ${errorMessage(e)}`]).then((lines) => update((s) => (s.mode.kind === 'view' && s.mode.what === effect.what ? { ...s, mode: { kind: 'view', what: effect.what, lines, offset: 0 } } : s)));
    }
    queue.current = queue.current.then(async () => {
      update((s) => withBusy(s, 'working…'));
      const notice = await runBoardEffect(ctx.runner, ctx.config, effect, { insideTmux, self });
      update((s) => withBusy(showNotice(s, notice), null));
      clearTimeout(noticeTimer.current);
      noticeTimer.current = setTimeout(() => update(clearNotice), NOTICE_MS);
      refreshNow.current();
    });
  };

  useInput((input, key) => {
    const result = handleKey(current.current, input, key);
    update(() => result.state);
    for (const effect of result.effects) runEffect(effect);
  });

  const layout = boardLayout(state.width, ctx.config.board.listWidth);
  const active = state.rows.filter((r) => !r.closed && !r.finished && !r.hidden).length;
  const hiddenCount = state.showHidden ? 0 : state.rows.filter((r) => r.hidden).length;
  const panel = usagePanel(state.plans, ctx.config.usage, Date.now());
  const mline = managerLine(state, ctx.config.manager.autostart || ctx.config.manager.project !== null);
  const rowsForBody = Math.max(3, state.height - 4 - panel.length - (mline ? 1 : 0));
  const away = awayLabel(state.away);
  const header = h(
    Box,
    { width: state.width },
    h(Text, { bold: true, wrap: 'truncate-end' }, `agentctl ${packageVersion()} board`),
    h(Text, { dimColor: true, wrap: 'truncate-end' }, ` · ${ctx.config.session} · ${active} task${active === 1 ? '' : 's'}${state.queue.length > 0 ? ` · ${state.queue.length} queued` : ''}${state.cohortFilter !== null ? ` · cohort: ${cohortLabel(state)}` : ''}${hiddenCount > 0 ? ` · ${hiddenCount} hidden (a)` : ''}${state.refreshedAt ? ` · ${state.refreshedAt}` : ''}`),
    state.disk ? h(Text, { color: state.disk.level === 'critical' ? 'red' : state.disk.level === 'warn' ? 'yellow' : 'green', wrap: 'truncate-end' }, ` · ${diskLine(state.disk)}`) : null,
    away ? h(Text, { wrap: 'truncate-end', ...(away.dim ? { dimColor: true } : { color: 'cyan', bold: true }) }, ` · ${away.text}`) : null,
  );
  const managerBox = mline ? h(Text, { wrap: 'truncate-end', ...(mline.selected ? { bold: true, ...(process.env.NO_COLOR ? { inverse: true } : { color: ctx.config.board.selectedColor }) } : mline.dim ? { dimColor: true } : { color: 'cyan' }) }, mline.text) : null;
  const panelBox = panel.length === 0 ? null : h(Box, { flexDirection: 'column', width: state.width }, ...panel.map((l) => h(Text, { key: l.provider, wrap: 'truncate-end', ...(l.color ? { color: l.color } : { dimColor: true }) }, l.text)));
  const logMode = state.mode.kind === 'log' ? state.mode : null;
  const viewMode = state.mode.kind === 'view' ? state.mode : null;
  const body =
    viewMode
      ? h(Box, { flexDirection: 'column' }, h(Text, { bold: true }, `${VIEW_TITLES[viewMode.what]} (↑↓ scroll, Esc back)`), ...viewMode.lines.slice(viewMode.offset, viewMode.offset + Math.max(1, state.height - 4)).map((l, i) => h(Text, { key: i, wrap: 'truncate-end' }, l === '' ? ' ' : l)))
      : logMode
      ? h(Box, { flexDirection: 'column' }, h(Text, { bold: true }, `Log – ${logMode.lines.length > 1 ? logMode.lines.length - 1 : 0} task${logMode.lines.length === 2 ? '' : 's'} (↑↓ scroll, Esc back)`), ...logMode.lines.slice(logMode.offset, logMode.offset + Math.max(1, state.height - 4)).map((l, i) => h(Text, { key: i, wrap: 'truncate-end', ...(i === 0 && logMode.offset === 0 ? { dimColor: true } : {}) }, l === '' ? ' ' : l)))
      : state.mode.kind === 'help'
      ? h(Box, { flexDirection: 'column' }, ...[...modelHelp(state), ...HELP_LINES].map((l, i) => h(Text, { key: i }, l === '' ? ' ' : l)))
      : h(
          Box,
          { flexDirection: 'row', height: rowsForBody },
          h(TaskList, { state, width: layout.listWidth, capacity: rowsForBody - 1, icons: ctx.config.watch.windowIcons, selectedColor: ctx.config.board.selectedColor, versions: ctx.config.board.modelVersions }),
          layout.showPreview ? h(Preview, { state, width: layout.previewWidth, height: rowsForBody }) : null,
        );
  return h(Box, { flexDirection: 'column', width: state.width, height: state.height }, header, state.mode.kind === 'help' || logMode || viewMode ? null : managerBox, state.mode.kind === 'help' || logMode || viewMode ? null : panelBox, h(Box, { flexGrow: 1, flexDirection: 'column' }, body), h(Footer, { state, hint: navigationHint(ctx.config.board.returnKey) }));
}

/** Show the board until the user quits; resolves when it is gone. Needs a terminal. */
export async function runBoardApp(ctx: Context, insideTmux: boolean, streams: { stdout?: NodeJS.WriteStream; stdin?: NodeJS.ReadStream } = {}, self?: SelfArgv): Promise<void> {
  const out = streams.stdout ?? process.stdout;
  const titled = ctx.config.board.windowTitle;
  const version = packageVersion();
  if (titled) {
    out.write(titleStart(version));
    // The outer terminal's title, for the agentctl session only (no -g): the options are session options.
    if (insideTmux) {
      await ctx.tmux.setSessionOption('set-titles', 'on').catch(() => undefined);
      await ctx.tmux.setSessionOption('set-titles-string', tmuxTitleString(version)).catch(() => undefined);
    }
  }
  try {
    // interactive: true - Ink draws nothing in a "CI" environment (a CI or BUILD_* variable in the tmux server's environment), but the board only runs in a terminal.
    const app = render(h(Board, { ctx, insideTmux, self }), { alternateScreen: true, exitOnCtrlC: false, interactive: true, ...streams });
    await app.waitUntilExit();
  } finally {
    if (titled) out.write(titleEnd());
  }
}
