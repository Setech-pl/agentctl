import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Alerts } from '../src/core/alert.ts';
import { Context } from '../src/core/context.ts';
import { handleEvent } from '../src/core/event-command.ts';
import { readJournal } from '../src/core/journal.ts';
import type { Notifier } from '../src/core/notify.ts';
import { extractMdPaths, findCandidates, globFiles, reportInfo, syncReport } from '../src/core/report-detect.ts';
import { resolveSpec, splitSpecs } from '../src/core/spec.ts';
import { collectStatus, statusMarkdown } from '../src/core/status.ts';
import { readTaskRecord } from '../src/core/taskstore.ts';
import { watchTick, WatchMemory } from '../src/core/watch.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();
const IDLE = 'Welcome\n❯ Try "x"\n  ⏵⏵ auto mode on';
const HOME = os.homedir();

class Quiet implements Notifier {
  readonly sent: string[] = [];
  async notify(_t: string, m: string): Promise<void> {
    this.sent.push(m);
  }
}

describe('extractMdPaths: the .md files in a message of an agent', () => {
  it('finds relative, absolute and ~ paths', () => {
    const text = 'Raport: docs/reports/nc-42-final.md, kopia w /Users/m/cache/nc-42/NC-42.md i ~/Projects/cache/nc-42/notes.md.';
    assert.deepEqual(extractMdPaths(text), ['docs/reports/nc-42-final.md', '/Users/m/cache/nc-42/NC-42.md', '~/Projects/cache/nc-42/notes.md']);
  });

  it('finds the path after pbcopy < and in backticks, quotes and markdown links', () => {
    const text = 'Skopiuj: `pbcopy < ~/Projects/cache/neon-city-nc-42/raport.md`\nalbo [raport](docs/reports/a.md) lub "docs/my report.md".';
    assert.deepEqual(extractMdPaths(text), ['~/Projects/cache/neon-city-nc-42/raport.md', 'docs/reports/a.md', 'docs/my report.md']);
  });

  it('lists several files in the order of their last mention and ignores URLs', () => {
    const text = 'a.md potem docs/b.md, https://github.com/x/y/blob/main/README.md, znowu a.md';
    assert.deepEqual(extractMdPaths(text), ['docs/b.md', 'a.md']);
  });

  it('finds nothing in a text without files', () => {
    assert.deepEqual(extractMdPaths('Gotowe. Testy przechodzą, markdown ok.'), []);
  });
});

describe('globFiles', () => {
  it('matches * and ? in a segment and ** across directories, files only', () => {
    const dir = scratch.sub('glob');
    fs.mkdirSync(path.join(dir, 'docs/reports/sub'), { recursive: true });
    for (const f of ['docs/reports/x-nc-1-y.md', 'docs/reports/other.md', 'docs/reports/sub/nc-1.md']) fs.writeFileSync(path.join(dir, f), 'x');
    assert.deepEqual(globFiles(path.join(dir, 'docs/reports/*nc-1*.md')), [path.join(dir, 'docs/reports/x-nc-1-y.md')]);
    assert.deepEqual(globFiles(path.join(dir, 'docs/**/nc-1.md')), [path.join(dir, 'docs/reports/sub/nc-1.md')]);
    assert.deepEqual(globFiles(path.join(dir, 'docs/reports/oth?r.md')), [path.join(dir, 'docs/reports/other.md')]);
  });
});

function setup(name: string, extra: Parameters<typeof seedTask>[2] = {}) {
  const root = scratch.sub(name);
  const config = makeConfig(root);
  const worktree = path.join(root, 'wt');
  fs.mkdirSync(path.join(worktree, 'docs/reports'), { recursive: true });
  const fake = new FakeTmux();
  fake.add('nc-1', IDLE);
  const runner = new DiskRunner({ dryRun: false, respond: fake.respond, startTime: Date.now() });
  const out: string[] = [];
  const ctx = new Context(runner, config, (l) => out.push(l));
  spawnSync('git', ['init', worktree]);
  spawnSync('git', ['-C', worktree, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-m', 'initial'], { env: { ...process.env, GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' } });
  const record = seedTask(config, 'NC-1', { reportAlt: ['docs/reports/*.md', path.join(root, 'cache/other-name/*.md')], repos: [{ path: path.join(root, 'repo'), worktree }], ...extra });
  const write = (file: string, text: string, when?: Date): string => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    if (when) fs.utimesSync(file, when, when);
    return file;
  };
  return { root, config, worktree, fake, runner, ctx, record, out, write };
}

describe('findCandidates', () => {
  it('0173-2: only fresh configured files with the task ID qualify', () => {
    const s = setup('cand');
    const old = s.write(path.join(s.worktree, 'docs/old.md'), 'old', new Date(Date.UTC(2026, 9, 1)));
    s.write(path.join(s.worktree, 'docs/notes.md'), 'n');
    s.write(path.join(s.worktree, 'docs/reports/nc-1-final.md'), 'r');
    const text = 'Zobacz docs/reports/nc-1-final.md i docs/old.md oraz docs/notes.md';
    const found = findCandidates(s.ctx, s.record);
    assert.deepEqual(found.map((c) => path.relative(s.worktree, c.file)), ['docs/reports/nc-1-final.md']);
    assert.deepEqual(found.map((c) => c.why), ['configured']);
    assert.ok(!found.some((c) => c.file === old));
  });

  it('prefers the latest mentioned among equals and reads absolute and ~ paths', () => {
    const s = setup('cand2', { reportAlt: [] });
    const a = s.write(path.join(s.root, 'cache/other-name/a.md'), 'a');
    s.write(path.join(s.worktree, 'b.md'), 'b');
    const found = findCandidates(s.ctx, s.record);
    assert.deepEqual(found, []);
    assert.equal(findCandidates(s.ctx, s.record).length, 0);
  });

  it('ignores the canonical file and the state folder', () => {
    const s = setup('cand3');
    s.write(s.record.report, 'canonical');
    assert.deepEqual(findCandidates(s.ctx, s.record), []);
  });

  it('uses the globs of the report list with {task} filled, the newest first, before the paths in the text', () => {
    const s = setup('cand4', { reportAlt: ['docs/reports/*nc-1*.md'] });
    s.write(path.join(s.worktree, 'docs/reports/a-nc-1.md'), 'a', new Date(Date.now() - 5000));
    s.write(path.join(s.worktree, 'docs/reports/b-nc-1.md'), 'b');
    s.write(path.join(s.worktree, 'docs/mentioned.md'), 'm');
    const found = findCandidates(s.ctx, s.record);
    assert.deepEqual(found.map((c) => [path.basename(c.file), c.why]), [['b-nc-1.md', 'configured'], ['a-nc-1.md', 'configured']]);
  });
});

describe('syncReport', () => {
  it('copies the report to the canonical path, remembers the source and writes "raport wykryty w …" to the journal', async () => {
    const s = setup('sync');
    const src = s.write(path.join(s.worktree, 'docs/reports/nc-1.md'), 'Werdykt: PASS\n');
    assert.equal((await syncReport(s.ctx, s.record)).action, 'none');
    assert.equal(fs.existsSync(s.record.report), false);
    const r = await syncReport(s.ctx, s.record, { from: src });
    assert.equal(r.action, 'copied');
    assert.equal(fs.readFileSync(s.record.report, 'utf8'), 'Werdykt: PASS\n');
    const stored = readTaskRecord(s.config, 'nc-1');
    assert.equal(stored?.reportSource, src);
    assert.ok(stored?.reportCopied);
    const entry = readJournal(s.config).find((e) => e.kind === 'report-detected');
    assert.match(entry?.text ?? '', /NC-1: raport wykryty w .*docs\/reports\/nc-1\.md/);
    assert.equal(fs.readFileSync(src, 'utf8'), 'Werdykt: PASS\n');
  });

  it('does not overwrite a canonical report the agent wrote, and says so', async () => {
    const s = setup('keep');
    s.write(s.record.report, 'canonical');
    s.write(path.join(s.worktree, 'docs/x.md'), 'other');
    const auto = await syncReport(s.ctx, s.record);
    assert.equal(auto.action, 'none');
    const manual = await syncReport(s.ctx, s.record, { from: 'docs/x.md' });
    assert.equal(manual.action, 'kept');
    assert.equal(fs.readFileSync(s.record.report, 'utf8'), 'canonical');
    const forced = await syncReport(s.ctx, s.record, { from: 'docs/x.md', force: true });
    assert.equal(forced.action, 'updated');
    assert.equal(fs.readFileSync(s.record.report, 'utf8'), 'other');
  });

  it('canonical wins even when an earlier detected source is newer', async () => {
    const s = setup('update');
    const src = s.write(path.join(s.worktree, 'docs/r.md'), 'v1');
    await syncReport(s.ctx, s.record, { from: 'docs/r.md' });
    let rec = readTaskRecord(s.config, 'nc-1')!;
    const later = new Date(Date.now() + 10_000);
    s.write(src, 'v2', later);
    assert.equal((await syncReport(s.ctx, rec, {})).action, 'none');
    assert.equal(fs.readFileSync(s.record.report, 'utf8'), 'v1');
    assert.equal(readJournal(s.config).filter((e) => e.kind === 'report-detected').length, 1, 'the update is not announced again');
    // somebody edits the canonical file: it is no longer a copy
    rec = readTaskRecord(s.config, 'nc-1')!;
    s.write(s.record.report, 'edited by hand', new Date(Date.now() + 60_000));
    s.write(src, 'v3', new Date(Date.now() + 120_000));
    assert.equal((await syncReport(s.ctx, rec, {})).action, 'none');
    assert.equal(fs.readFileSync(s.record.report, 'utf8'), 'edited by hand');
  });

  it('searches the last lines of the window (joined) when the message names nothing', async () => {
    const s = setup('pane');
    s.write(path.join(s.worktree, 'docs/reports/nc-1-raport.md'), 'Werdykt: PASS');
    s.fake.windows[0]!.screen = `${IDLE}\n⏺ pbcopy < ${path.join(s.worktree, 'docs/reports/nc-1-raport.md')}\n`;
    const r = await syncReport(s.ctx, s.record);
    assert.equal(r.action, 'none');
    assert.ok(readTaskRecord(s.config, 'nc-1')?.reportCandidate);
  });

  it('finds nothing without a candidate', async () => {
    const s = setup('none');
    assert.equal((await syncReport(s.ctx, s.record)).action, 'none');
    assert.equal(fs.existsSync(s.record.report), false);
  });
});

describe('the end of a turn and the watcher', () => {
  it('0173-2: Claude Stop records a candidate without copying', async () => {
    const s = setup('event');
    s.write(path.join(s.worktree, 'docs/reports/nc-1.md'), 'Werdykt: PASS – 3 testy\n\n# Raport\n');
    const notifier = new Quiet();
    const res = await handleEvent(s.ctx, new Alerts(s.ctx, notifier, { env: {} }), {
      task: 'NC-1',
      agent: 'claude',
      kind: 'stop',
      payload: { last_assistant_message: 'Zapisałem raport w docs/reports/nc-1.md. Werdykt na końcu.' },
    });
    assert.notEqual(res.announced?.state, 'report-ready');
    assert.equal(fs.existsSync(s.record.report), false);
    const kinds = readJournal(s.config).map((e) => e.kind);
    assert.ok(kinds.includes('report-candidate'));
    assert.ok(!kinds.includes('report-ready'));
  });

  it('0173-2: Codex notify cannot copy a mentioned file', async () => {
    const s = setup('codex', { agent: 'codex' });
    const abs = s.write(path.join(s.root, 'cache/other-name/NC-1-report.md'), 'Werdykt: PASS\n');
    const res = await handleEvent(s.ctx, new Alerts(s.ctx, new Quiet(), { env: {} }), {
      task: 'NC-1',
      agent: 'codex',
      payload: { type: 'agent-turn-complete', 'last-assistant-message': `Raport: ${abs}`, 'thread-id': 't' },
    });
    assert.notEqual(res.announced?.state, 'report-ready');
  });

  it('0173-3: watcher preserves waiting until explicit report confirmation', async () => {
    const s = setup('watch');
    s.write(path.join(s.worktree, 'docs/reports/nc-1.md'), 'Werdykt: PASS\n');
    s.fake.windows[0]!.screen = `${IDLE}\nraport: docs/reports/nc-1.md\n`;
    const notifier = new Quiet();
    const events = await watchTick(s.ctx, new WatchMemory(), notifier);
    assert.equal(fs.existsSync(s.record.report), false);
    const row = (await collectStatus(s.ctx, { progress: false })).find((r) => r.task === 'NC-1');
    assert.equal(row?.state, 'waiting');
    assert.equal(row?.reportCandidate, path.join(s.worktree, 'docs/reports/nc-1.md'));
    await syncReport(s.ctx, s.record, { from: 'docs/reports/nc-1.md' });
    const confirmed = await collectStatus(s.ctx, { progress: false });
    assert.ok(Array.isArray(events));
    assert.match(statusMarkdown(confirmed), /yes \(z .*docs\/reports\/nc-1\.md\)/);
  });
});

describe('agentctl report', () => {
  it('shows what the search finds and --from copies a file', async () => {
    const s = setup('cmd');
    s.write(path.join(s.worktree, 'docs/reports/nc-1.md'), 'R');
    s.fake.windows[0]!.screen = `${IDLE}\ndocs/reports/nc-1.md\n`;
    const info = await reportInfo(s.ctx, 'NC-1');
    assert.equal(info.canonicalExists, false);
    assert.equal(info.candidates[0]?.file, path.join(s.worktree, 'docs/reports/nc-1.md'));
    assert.equal(fs.existsSync(s.record.report), false, 'looking copies nothing');
    const done = await reportInfo(s.ctx, 'NC-1', { from: 'docs/reports/nc-1.md' });
    assert.equal(done.result?.action, 'copied');
    assert.equal(done.source, path.join(s.worktree, 'docs/reports/nc-1.md'));
  });

  it('refuses an unknown task and a missing file', async () => {
    const s = setup('cmd2');
    await assert.rejects(() => reportInfo(s.ctx, 'NC-99'), /unknown task/);
    assert.equal((await reportInfo(s.ctx, 'NC-1', { from: 'nope.md' })).result?.action, 'none');
  });
});

describe('report: as a list in the spec and the project', () => {
  const config = makeConfig(scratch.sub('speclist'), 'worktree_root: ~/wt\n');
  const resolve = (header: string, project?: { report?: string; reportAlt?: string[] }) => {
    const raw = splitSpecs(`---\ntask: NC-7\nagent: claude\n${header}repos:\n  - path: ~/code/app\n---\nHi\n`)[0]!;
    return resolveSpec(raw, { config, loadProject: () => (project ? { links: [], env: {}, defaults: {}, ...project } : undefined) });
  };

  it('the first entry is the canonical path, the others are kept with {task} and {TASK} filled', () => {
    const spec = resolve('report: ["~/Projects/cache/{task}/{TASK}.md", "docs/reports/*{task}*.md", "docs/reports/*{TASK}*.md"]\n');
    assert.equal(spec.report, path.join(HOME, 'Projects/cache/nc-7/NC-7.md'));
    assert.deepEqual(spec.reportAlt, ['docs/reports/*nc-7*.md', 'docs/reports/*NC-7*.md']);
  });

  it('a project list is used when the spec says nothing, and a single string stays as it was', () => {
    const spec = resolve('', { report: '~/c/{task}/{TASK}.md', reportAlt: ['docs/reports/*{task}*.md'] });
    assert.equal(spec.report, path.join(HOME, 'c/nc-7/NC-7.md'));
    assert.deepEqual(spec.reportAlt, ['docs/reports/*nc-7*.md']);
    assert.equal(resolve('report: /abs/r.md\n').reportAlt, undefined);
  });

  it('rejects an empty list and non-strings', () => {
    assert.throws(() => resolve('report: []\n'), /report must be a path, or a list/);
    assert.throws(() => resolve('report: [1]\n'), /report must be a path, or a list/);
  });
});
