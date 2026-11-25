import { BoardDisk, BoardLimits } from './header.ts';
import { providerHolds } from '../core/provider-hold.ts';
import type { RefreshClock } from './refresh-scheduler.ts';
import { RefreshScheduler } from './refresh-scheduler.ts';
import { collectDisk, refreshDiskFreeSpace } from '../core/disk.ts';
import { watchSnapshotTime, watchSnapshotWarning, watchStepWarning } from '../core/watch-snapshot.ts';
import fs from 'node:fs';
import path from 'node:path';
import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput, useWindowSize } from 'ink';
import {
  applySnapshot,
  boardColumns,
  boardLayout,
  activeRows,
  cancelledTitle,
  closedTitle,
  cohortLabel,
  finishedTitle,
  groupTitle,
  pulledTitle,
  bulkCloseLines,
  boardRefreshMs,
  clearNotice,
  handleKey,
  helpLines,
  headerCells,
  initialBoardState,
  KEY_HINTS,
  awayLabel,
  loadBoard,
  managerLine,
  loadLogLines,
  PREVIEW_LINES,
  ProgressCache,
  promptText,
  queueCells,
  queueTitle,
  queueViews,
  resumeTitle,
  rowCells,
  runBoardEffect,
  TickGate,
  usagePanel,
  loadViewLines,
  loadLimitsPanel,
  updateLimitsPanel,
  VIEW_TITLES,
  showNotice,
  visibleItems,
  WATCH_TICK_MIN_MS,
  withBusy,
  withLoadError,
  withSize,
} from '../core/board.ts';
import type { BoardCell, BoardEffect, BoardState } from '../core/board.ts';
import { accountTasks, taskNames } from '../core/task-accounting.ts';
import type { Context } from '../core/context.ts';
import { loadGlobalConfig } from '../core/config.ts';
import { ConfigStore } from '../core/config-store.ts';
import { pendingLimitRequests } from '../core/limit-requests.ts';
import type { SelfArgv } from '../core/events.ts';
import { navigationHint } from '../core/navigation.ts';
import { errorMessage } from '../core/util.ts';
import { beginTitle } from '../core/title.ts';
import { applyInstanceLabel, instanceName } from '../core/instance.ts';
import { packageVersion } from '../core/version.ts';
import { wallBadgeDue, wallUnread, wallView } from '../core/board-wall.ts';
import { loadWallBoard, markRead, ownerThreadLines } from '../core/wall.ts';
import { selectionColorDepth, selectionStyle, selectionText } from './selection.ts';

/*
 * The Ink front of `agentctl board`: draws a BoardState and forwards keys to handleKey. No JSX: the project runs on Node's
 * type stripping without a build step, and React.createElement needs none (see the README for why not htm).
 */

const h = React.createElement;

/** A notice stays on the footer this long. */
const NOTICE_MS = 6000;

function Cells(props: { cells: BoardCell[] }): React.ReactElement {
  return h(
    Box,
    { flexDirection: 'row' },
    ...props.cells.map((c) =>
      h(
        Box,
        { key: c.key, width: c.width, marginRight: c.key === 'report' ? 0 : 1 },
        h(Text, { wrap: 'truncate-end', ...(c.color ? { color: c.color } : {}), ...(c.dim ? { dimColor: true } : {}), ...(c.bold ? { bold: true } : {}) }, c.text),
      ),
    ),
  );
}

function Selection(props: { content: string | BoardCell[]; width: number; style: string }): React.ReactElement {
  return h(Text, { wrap: 'truncate-end' }, selectionText(props.content, props.width, props.style));
}

function TaskList(props: { state: BoardState; width: number; capacity: number; icons: Parameters<typeof rowCells>[3]; selection: string; versions: Record<string, string> }): React.ReactElement {
  const { state } = props;
  const cols = boardColumns(props.width);
  const visible = visibleItems(state, props.capacity);
  const facts = accountTasks(activeRows(state));
  const awaiting = [...facts.active.map(r => r.task), ...queueViews(state).map(v => v.entry.task)];
  const cells = (task: string, key: string, content: BoardCell[]) => state.selected === task
    ? h(Selection, { key, content, width: props.width, style: props.selection })
    : h(Cells, { key, cells: content });
  const body =
    visible.items.length === 0
      ? [h(Text, { key: 'empty', dimColor: true }, state.refreshedAt === null ? 'Loading…' : state.rows.length === 0 ? 'No tasks. Start one with "agentctl new <spec>".' : state.cohortFilter !== null ? 'No tasks in this cohort. k picks another.' : 'No active tasks. z opens the finished ones.')]
      : visible.items.map((item) =>
          item.kind === 'ready-title'
            ? h(Text, { key: 'ready-title', bold: true, color: 'green', wrap: 'truncate-end' }, `Raporty do pobrania (${item.count})${taskNames(facts.reports.map(r => r.task))}`)
            : item.kind === 'active-title'
            ? h(Text, { key: 'active-title', bold: true, wrap: 'truncate-end' }, `Aktywne i czekające (${item.count})${taskNames(awaiting)}`)
            : item.kind === 'pulled'
            ? state.selected === `@pulled:${item.key}`
              ? h(Selection, { key: `pulled-${item.key}`, content: `▸ ${pulledTitle(item)}`, width: props.width, style: props.selection })
              : h(Text, { key: `pulled-${item.key}`, wrap: 'truncate-end' }, `  ${pulledTitle(item)}`)
            : item.kind === 'group'
            ? h(Text, { key: `group-${item.section ?? 'active'}-${item.key}`, bold: true, wrap: 'truncate-end' }, groupTitle(item, props.icons))
            : item.kind === 'queue-title'
            ? h(Text, { key: 'queue-title', dimColor: true, wrap: 'truncate-end' }, `- ${queueTitle(item.count, item.paused)}`)
            : item.kind === 'resume-title'
            ? h(Text, { key: 'resume-title', color: 'yellow', wrap: 'truncate-end' }, `- ${resumeTitle(item.count)}`)
            : item.kind === 'resume'
            ? h(Text, { key: `r-${item.task}`, dimColor: true, wrap: 'truncate-end' }, `    ${item.task}`)
            : item.kind === 'queue'
              ? cells(item.view.entry.task, `q-${item.view.entry.task}`, queueCells(item.view, item.view.entry.task === state.selected, cols, props.versions))
              : item.kind === 'finished'
            ? h(Text, { key: 'finished', dimColor: true, wrap: 'truncate-end' }, `${item.expanded ? '-' : '+'} ${finishedTitle(item.count, item.expanded)}`)
            : item.kind === 'closed'
              ? h(Text, { key: 'closed', dimColor: true, wrap: 'truncate-end' }, `- ${closedTitle(item.count)}`)
              : item.kind === 'cancelled'
                ? h(Text, { key: 'cancelled', dimColor: true, wrap: 'truncate-end' }, `- ${cancelledTitle(item.count)}`)
                : cells(item.row.task, item.row.task, rowCells(item.row, item.row.task === state.selected, cols, props.icons, props.versions)),
        );
  return h(Box, { flexDirection: 'column', width: props.width }, h(Cells, { cells: headerCells(cols) }), ...body);
}

function Preview(props: { state: BoardState; width: number; room: number }): React.ReactElement {
  const { state } = props;
  const preview = state.preview;
  const length = preview?.lines.length ?? 0;
  const end = length - Math.min(state.previewFocus ?? 0, Math.max(0, length - props.room));
  const lines = preview?.lines.slice(Math.max(0, end - props.room), end) ?? [];
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
  const prompt = state.mode.kind === 'confirm' && state.mode.action === 'close-pulled' ? 'Zamknąć te zadania? Worktree pozostają. [y/N]' : promptText(state);
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

/** Optional clock/observer used by the accelerated board soak; production uses native timers. */
export interface BoardRuntime {
  clock: RefreshClock;
  now(): number;
  refreshed?(progressEntries: number, durationMs: number): void;
  rendered?(): void;
}

export function Board(props: { ctx: Context; insideTmux: boolean; self?: SelfArgv | undefined; runtime?: BoardRuntime | undefined }): React.ReactElement {
  const { ctx, insideTmux, self } = props;
  props.runtime?.rendered?.();
  const { exit } = useApp();
  const [instance] = useState(() => instanceName(ctx.config));
  const [colorDepth] = useState(() => selectionColorDepth(process.env));
  const size = useWindowSize();
  const [state, setState] = useState<BoardState>(() => initialBoardState(size.columns, size.rows));
  const current = useRef(state);
  const [watchAge, setWatchAge] = useState<{text: string; stale: boolean} | null>(null);
  const update = (fn: (s: BoardState) => BoardState): void => {
    current.current = fn(current.current);
    setState(current.current);
  };
  const cache = useRef(new ProgressCache());
  const actionRunning = useRef(false);
  const viewRunning = useRef(false);
  const pendingView = useRef<Extract<BoardEffect, { type: 'view' }> | null>(null);
  const mounted = useRef(true);
  const refreshNow = useRef<() => void>(() => {});
  const timers = props.runtime?.clock ?? {
    set: (callback: () => void, delay: number) => setTimeout(callback, delay),
    clear: (timer: unknown) => clearTimeout(timer as NodeJS.Timeout),
  };
  const noticeTimer = useRef<unknown>(undefined);
  const wallReadAt = useRef<number | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; pendingView.current = null; if (noticeTimer.current !== undefined) timers.clear(noticeTimer.current); };
  }, []);

  useEffect(() => update((s) => withSize(s, size.columns, size.rows)), [size.columns, size.rows]);

  useEffect(() => {
    let stopped = false;
    let diagnosticTimer: unknown;
    let diagnostics = '';
    let lastBoardRefresh: number | undefined;
    // The diagnostic line remains live while a regular board refresh is waiting on tmux or Git.
    const updateDiagnostics = () => {
      if (diagnosticTimer !== undefined) timers.clear(diagnosticTimer);
      diagnosticTimer = undefined;
      const now = ctx.runner.now(), at = watchSnapshotTime(ctx.config);
      const warning = watchStepWarning(ctx.config) ?? (at === undefined ? undefined : watchSnapshotWarning(at, now));
      const label = warning ?? (at === undefined ? '' : `Stan watch sprzed ${Math.max(0, Math.floor((now - at) / 1000))} s`);
      if (label !== diagnostics) {
        diagnostics = label;
        setWatchAge(label ? {text: label, stale: Boolean(warning)} : null);
      }
      if (at !== undefined && (lastBoardRefresh === undefined || now - lastBoardRefresh > 45_000)) {
        const disk = current.current.disk, refreshAt = lastBoardRefresh;
        const sample = disk ? refreshDiskFreeSpace(ctx, disk) : collectDisk(ctx, undefined, {records: []})
          .then(report => ({...report, worktreeBytes: null, measuring: true}));
        void sample.then(value => {
          if (!stopped && refreshAt === lastBoardRefresh) update(s => ({...s, disk: value}));
        }).catch(() => undefined);
      }
      if (at !== undefined || warning) diagnosticTimer = timers.set(updateDiagnostics, 15_000);
    };
    updateDiagnostics();
    const configStore = new ConfigStore(() => loadGlobalConfig(path.dirname(ctx.config.path), ctx.runner.now()), ctx.config);
    const scheduler = new RefreshScheduler(async () => {
      const started = props.runtime ? performance.now() : 0;
      const config = configStore.refresh(ctx.runner.now()).config;
      if (ctx.config !== config) ctx.setConfig(config);
      // Closed/cancelled rows are detailed only while their section is listed (the `a` key).
      const snap = await loadBoard(ctx, current.current.selected, cache.current, PREVIEW_LINES, { deepClosed: current.current.showHidden });
      lastBoardRefresh = ctx.runner.now();
      if (!stopped) {
        const limitPending = pendingLimitRequests(ctx.config, ctx.runner.now()).length;
        update((s) => ({ ...applySnapshot(s, snap), limitPending }));
        if (current.current.mode.kind === 'view' && current.current.mode.what === 'limits') runEffect({ type: 'view', what: 'limits' });
        props.runtime?.refreshed?.(cache.current.size, performance.now() - started);
      }
      // New WALL messages show while the view is open; the header's unread count is read in the background from the start, at most every
      // WALL_BADGE_REFRESH_MS (the index is incremental: a stat per channel, the new tail only). A background read never shows an error.
      const now = props.runtime?.now() ?? Date.now();
      if (!stopped && current.current.mode.kind === 'wall') loadWall();
      else if (!stopped && wallBadgeDue(wallReadAt.current, now)) { wallReadAt.current = now; loadWall(true); }
    }, () => boardRefreshMs(current.current.rows), (e) => {
      if (!stopped) update((s) => withLoadError(s, errorMessage(e).split('\n')[0] as string));
    }, props.runtime?.clock);
    refreshNow.current = () => scheduler.request();
    scheduler.start();
    // An agent's own event (agentctl event writes <state_dir>/<task>/event.json) shows at once, not at the next refresh;
    // a storm of events (one per agent hook) is coalesced to at most one extra tick per WATCH_TICK_MIN_MS.
    const gate = new TickGate(WATCH_TICK_MIN_MS, () => scheduler.request(), props.runtime?.clock, props.runtime?.now);
    let watcher: fs.FSWatcher | undefined;
    try {
      watcher = fs.watch(ctx.config.stateDir, { recursive: true }, (_type, name) => {
        if (diagnosticTimer === undefined && (name === 'mcp-state-snapshot.json' || name === 'watch-heartbeat.json')) updateDiagnostics();
        if (name && /event\.json$/.test(name)) gate.ping(props.runtime?.now() ?? Date.now());
      });
      watcher.on('error', () => watcher?.close());
    } catch {
      // no state folder yet, or no recursive watching here: the regular refresh still shows it
    }
    return () => {
      stopped = true;
      scheduler.stop();
      if (diagnosticTimer !== undefined) timers.clear(diagnosticTimer);
      refreshNow.current = () => {};
      gate.stop();
      watcher?.close();
    };
  }, []);

  /** The WALL data, read off the input path (setImmediate); a failure is a notice (none for a background read), never a crash. */
  const loadWall = (quiet = false): void => {
    setImmediate(() => {
      if (!mounted.current) return;
      try {
        const data = loadWallBoard(ctx.config, ctx.runner.now());
        update((s) => ({ ...s, wall: data }));
      } catch (e) {
        if (!quiet) update((s) => showNotice(s, { level: 'error', text: `WALL: ${errorMessage(e).split('\n')[0]}` }));
      }
    });
  };

  const runEffect = (effect: BoardEffect): void => {
    if (effect.type === 'quit') return exit();
    if (effect.type === 'wall-load') return loadWall();
    if (effect.type === 'wall-message') {
      setImmediate(() => {
        if (!mounted.current) return;
        let lines: string[];
        try { lines = ownerThreadLines(ctx.config, effect.id); } catch (e) { lines = [`cannot read ${effect.id}: ${errorMessage(e)}`]; }
        update((s) => (s.mode.kind === 'wall' && s.mode.level === 'message' && s.mode.id === effect.id ? { ...s, mode: { ...s.mode, lines, offset: 0 } } : s));
      });
      return;
    }
    if (effect.type === 'wall-read') {
      void markRead(ctx.config, effect.channel, { ...(effect.ids ? { ids: effect.ids } : {}), ...(effect.all ? { all: true } : {}) })
        .then(() => loadWall(), (e: unknown) => { if (mounted.current) update((s) => showNotice(s, { level: 'error', text: `WALL: ${errorMessage(e).split('\n')[0]}` })); });
      return;
    }
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
      pendingView.current = effect;
      if (viewRunning.current) return;
      viewRunning.current = true;
      void (async () => {
        while (pendingView.current && mounted.current) {
          const request = pendingView.current;
          pendingView.current = null;
          if (request.what === 'limits') {
            try {
              const data = await loadLimitsPanel(ctx);
              if (mounted.current && !pendingView.current) update((s) => (s.mode.kind === 'view' && s.mode.what === 'limits' ? { ...s, mode: updateLimitsPanel(s.mode, data) } : s));
              continue;
            } catch (e) {
              if (mounted.current) update((s) => showNotice(s, { level: 'error', text: errorMessage(e) }));
            }
          }
          const lines = await loadViewLines(ctx, request.what).catch((e: unknown) => [`cannot load: ${errorMessage(e)}`]);
          if (mounted.current && !pendingView.current) update((s) => (s.mode.kind === 'view' && s.mode.what === request.what ? { ...s, mode: { kind: 'view', what: request.what, lines, offset: 0 } } : s));
        }
      })().finally(() => { viewRunning.current = false; });
      return;
    }
    // A held key must not accumulate closures and stale commands behind a slow action.
    if (actionRunning.current) return;
    actionRunning.current = true;
    void (async () => {
      update((s) => withBusy(s, 'working…'));
      const notice = await runBoardEffect(ctx.runner, ctx.config, effect, { insideTmux, self });
      if (!mounted.current) return;
      update((s) => withBusy(showNotice(s, notice), null));
      if (noticeTimer.current !== undefined) timers.clear(noticeTimer.current);
      noticeTimer.current = timers.set(() => { noticeTimer.current = undefined; update(clearNotice); }, NOTICE_MS);
      refreshNow.current();
    })().catch((error: unknown) => {
      if (mounted.current) update((s) => withBusy(showNotice(s, { level: 'error', text: errorMessage(error) }), null));
    }).finally(() => { actionRunning.current = false; });
  };

  const layout = boardLayout(state.width, ctx.config.board.listWidth);
  const active = state.rows.filter((r) => !r.closed && !r.finished && !r.hidden).length;
  const hiddenCount = state.showHidden ? 0 : state.rows.filter((r) => r.hidden).length;
  const panel = usagePanel(state.plans, ctx.config.usage, Date.now(), providerHolds(ctx.config, Date.now()), ctx.config);
  const mline = managerLine(state, ctx.config.manager.autostart || ctx.config.manager.project !== null);
  const limitBanner = state.limitPending ? h(Text, { color: 'yellow', bold: true, wrap: 'truncate-end' }, `Zmiany limitów do decyzji: ${state.limitPending} (L)`) : null;
  const rowsForBody = Math.max(3, state.height - 5 - panel.length - (mline ? 1 : 0) - (state.disk ? 1 : 0) - (watchAge ? 1 : 0) - (limitBanner ? 1 : 0));
  const previewRoom = Math.max(1, rowsForBody - (state.preview?.model ? 3 : 1));
  useInput((input, key) => {
    const result = handleKey(current.current, input, key, previewRoom);
    if (actionRunning.current && result.effects.some(e => !['quit', 'refresh', 'view', 'log', 'wall-load', 'wall-message', 'wall-read'].includes(e.type))) return;
    update(() => result.state);
    for (const effect of result.effects) runEffect(effect);
  });
  const focusedStyle = selectionStyle(ctx.config.board.selection, colorDepth);
  const listStyle = state.previewFocus === undefined ? focusedStyle : selectionStyle(ctx.config.board.selection, colorDepth, false);
  const away = awayLabel(state.away);
  const header = h(
    Box,
    { width: state.width },
    h(Text, { bold: true, wrap: 'truncate-end' }, `${instance} ${packageVersion()} board`),
    h(Box, { flexShrink: 0, maxWidth: Math.max(0, state.width - 25) }, h(Text, { dimColor: true, wrap: 'truncate-end' }, ` · ${ctx.config.session} · ${active} task${active === 1 ? '' : 's'}${queueViews(state).length > 0 ? ` · ${queueViews(state).length} queued` : ''}${state.cohortFilter !== null ? ` · cohort: ${cohortLabel(state)}` : ''}${hiddenCount > 0 ? ` · ${hiddenCount} hidden (a)` : ''}${wallUnread(state.wall) > 0 ? ` · WALL ${wallUnread(state.wall)} unread (W)` : ''}${state.refreshedAt ? ` · ${state.refreshedAt}` : ''}`)),
    state.hosts && state.hosts.length > 0 ? h(Text, { wrap: 'truncate-end', ...(state.hosts.some((host) => host.state !== 'reachable') ? { color: 'yellow' } : { dimColor: true }) }, ` · hosts: ${state.hosts.map((host) => `${host.name} ${host.state}${host.gpu ? ` (${host.gpu})` : ''}${host.diskFreeGb !== undefined ? ` free ${host.diskFreeGb}G` : ''}`).join(' · ')} (H)`) : null,
    away ? h(Text, { wrap: 'truncate-end', ...(away.dim ? { dimColor: true } : { color: 'cyan', bold: true }) }, ` · ${away.text}`) : null,
  );
  const diskBox = state.disk ? h(BoardDisk, {disk: state.disk}) : null;
  const limitsBox = h(BoardLimits, {config: ctx.config});
  const watchBox = watchAge ? h(Text, { ...(watchAge.stale ? {color: 'yellow'} : {dimColor: true}), wrap: 'truncate-end' }, watchAge.text) : null;
  const managerBox = mline ? (mline.selected
    ? h(Selection, { content: mline.text, width: layout.listWidth, style: listStyle })
    : h(Text, { wrap: 'truncate-end', ...(mline.dim ? { dimColor: true } : { color: 'cyan' }) }, mline.text)) : null;
  const panelBox = panel.length === 0 ? null : h(Box, { flexDirection: 'column', width: state.width }, ...panel.map((l) => h(Text, { key: l.provider, wrap: 'truncate-end', ...(l.color ? { color: l.color } : { dimColor: true }) }, l.text)));
  const logMode = state.mode.kind === 'log' ? state.mode : null;
  const viewMode = state.mode.kind === 'view' ? state.mode : null;
  const limitsBody = (): React.ReactElement => {
    const mode = viewMode!;
    const panel = mode.limits!;
    const selected = panel.choices[panel.selected]?.line ?? 0;
    const room = Math.max(1, state.height - 4 - (limitBanner ? 1 : 0));
    const top = Math.min(Math.max(0, mode.lines.length - room), Math.max(0, selected ? selected - 1 + mode.offset : mode.offset));
    const hint = 'Limity · ↑↓ wybór · ←→ przewijanie · +/− i Enter · a zatwierdź · r odrzuć · Esc';
    return h(Box, { flexDirection: 'column' }, h(Text, { bold: true, wrap: 'truncate-end' }, hint), ...mode.lines.slice(top, top + room).map((text, i) => selected === top + i
      ? h(Selection, { key: i, content: `${text}${panel.draft === undefined ? '' : ` → ${panel.draft}`}`, width: state.width, style: focusedStyle })
      : h(Text, { key: i, wrap: 'truncate-end' }, text)));
  };
  const wallMode = state.mode.kind === 'wall' ? state.mode : null;
  const wallBody = (): React.ReactElement => {
    const view = wallView(state, wallMode!);
    const room = Math.max(1, state.height - 4);
    // Keep the selection on the screen: the window starts so that the selected line is inside it.
    const start = view.selected < 0 ? 0 : Math.max(0, Math.min(view.selected - Math.floor(room / 2), view.lines.length - room));
    return h(Box, { flexDirection: 'column' }, h(Text, { bold: true, wrap: 'truncate-end' }, view.title), ...view.lines.slice(start, start + room).map((l, i) => l.selected
      ? h(Selection, { key: i, content: l.text, width: state.width, style: focusedStyle })
      : h(Text, { key: i, wrap: 'truncate-end', bold: l.bold, dimColor: l.dim, color: l.color }, l.text === '' ? ' ' : l.text)));
  };
  const bulkClose = state.mode.kind === 'confirm' && state.mode.action === 'close-pulled';
  const fullScreen = bulkClose || state.mode.kind === 'help' || logMode !== null || viewMode !== null || wallMode !== null;
  const body =
    bulkClose
      ? h(Box, { flexDirection: 'column' }, ...bulkCloseLines(state).map((line, i) => h(Text, { key: i, bold: i === 0, wrap: 'truncate-end' }, line)))
      : wallMode
      ? wallBody()
      : viewMode
      ? viewMode.limits ? limitsBody() : h(Box, { flexDirection: 'column' }, h(Text, { bold: true }, `${VIEW_TITLES[viewMode.what]} (↑↓ scroll, Esc back)`), ...viewMode.lines.slice(viewMode.offset, viewMode.offset + Math.max(1, state.height - 4 - (limitBanner ? 1 : 0))).map((l, i) => h(Text, { key: i, wrap: 'truncate-end' }, l === '' ? ' ' : l)))
      : logMode
      ? h(Box, { flexDirection: 'column' }, h(Text, { bold: true }, `Log – ${logMode.lines.length > 1 ? logMode.lines.length - 1 : 0} task${logMode.lines.length === 2 ? '' : 's'} (↑↓ scroll, Esc back)`), ...logMode.lines.slice(logMode.offset, logMode.offset + Math.max(1, state.height - 4)).map((l, i) => h(Text, { key: i, wrap: 'truncate-end', ...(i === 0 && logMode.offset === 0 ? { dimColor: true } : {}) }, l === '' ? ' ' : l)))
      : state.mode.kind === 'help'
      ? h(Box, { flexDirection: 'column' }, ...helpLines(state).map((l, i) => h(Text, { key: i, wrap: 'truncate-end' }, l === '' ? ' ' : l)))
      : h(
          Box,
          { flexDirection: 'row', height: rowsForBody },
          h(TaskList, { state, width: layout.listWidth, capacity: rowsForBody - 1, icons: ctx.config.watch.windowIcons, selection: listStyle, versions: ctx.config.board.modelVersions }),
          layout.showPreview ? h(Preview, { state, width: layout.previewWidth, room: previewRoom }) : null,
        );
  return h(Box, { flexDirection: 'column', width: state.width, height: state.height }, header, limitBanner, fullScreen ? null : diskBox, fullScreen ? null : limitsBox, fullScreen ? null : watchBox, fullScreen ? null : managerBox, fullScreen ? null : panelBox, h(Box, { flexGrow: 1, flexDirection: 'column' }, body), h(Footer, { state, hint: navigationHint(ctx.config.board.returnKey) }));
}

/** Show the board until the user quits; resolves when it is gone. Needs a terminal. */
export async function runBoardApp(ctx: Context, insideTmux: boolean, { signal, ...streams }: { stdout?: NodeJS.WriteStream; stdin?: NodeJS.ReadStream; signal?: AbortSignal } = {}, self?: SelfArgv, runtime?: BoardRuntime): Promise<void> {
  if (signal?.aborted) return;
  const out = streams.stdout ?? process.stdout;
  const titled = ctx.config.board.windowTitle;
  const version = packageVersion();
  if (insideTmux) await applyInstanceLabel(ctx).catch(() => undefined);
  const restoreTitle = titled ? await beginTitle(ctx, out, version, 'board', insideTmux) : undefined;
  try {
    // interactive: true - Ink draws nothing in a "CI" environment (a CI or BUILD_* variable in the tmux server's environment), but the board only runs in a terminal.
    if (signal?.aborted) return;
    const app = render(h(Board, { ctx, insideTmux, self, runtime }), { alternateScreen: true, exitOnCtrlC: false, interactive: true, ...streams });
    const cancel = () => app.unmount();
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
    try { await app.waitUntilExit(); } finally { signal?.removeEventListener('abort', cancel); }
  } finally {
    await restoreTitle?.();
  }
}
