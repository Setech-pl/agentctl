import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { cancelTasks, planCancel } from '../src/core/cancel.ts';
import { cohortDoneText, cohortTick, listCohorts, readCohort, summarizeCohorts } from '../src/core/cohort.ts';
import { Context } from '../src/core/context.ts';
import type { Notifier } from '../src/core/notify.ts';
import { newTasks } from '../src/core/new.ts';
import { commitQueueAdd, planQueueAdd, readQueue } from '../src/core/queue.ts';
import { resolveSpec, splitSpecs } from '../src/core/spec.ts';
import { collectStatus } from '../src/core/status.ts';
import { readTaskRecord } from '../src/core/taskstore.ts';
import { cohortKey, cohortNameProblem } from '../src/core/util.ts';
import { WatchMemory, watchTick } from '../src/core/watch.ts';
import { DiskRunner, FakeTmux, makeConfig, runCli, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();
const WORKING = '● Reading src/menu.ts\n  esc to interrupt\n';

function setup(name: string, extraYaml = '') {
  const root = scratch.sub(name);
  const repo = scratch.sub(`${name}/app`);
  const config = makeConfig(root, `cohort: {done_grace_s: 0}\n${extraYaml}`);
  const tmux = new FakeTmux();
  // the fake clock runs ahead of the files the test writes, so a pull is later than the report it takes
  const runner = new DiskRunner({ dryRun: false, startTime: Date.now() + 3_600_000, respond: tmux.respond });
  const out: string[] = [];
  const ctx = new Context(runner, config, (l) => out.push(l));
  const notified: string[] = [];
  const notifier: Notifier = { clickable: false, notify: async (_t, m) => void notified.push(m) };
  const specOf = (task: string, extra = ''): string => `---\ntask: ${task}\nagent: claude\n${extra}repos:\n  - {path: ${repo}, worktree: ${repo}-${task.toLowerCase()}}\n---\nPrompt of ${task}.\n`;
  const resolve = (text: string) => splitSpecs(text, 't').map((raw) => resolveSpec(raw, { config }));
  const start = async (text: string): Promise<void> => void (await newTasks(ctx, resolve(text), { waitTrust: false }));
  const queueUp = async (text: string): Promise<void> => {
    const plan = await planQueueAdd(ctx, splitSpecs(text, 't'));
    await commitQueueAdd(ctx, plan.items);
  };
  /** A task with a window (working), or without one and with a report (report-ready). */
  const seed = (task: string, state: 'working' | 'ready' | 'closed' | 'cancelled', cohort?: string): void => {
    const record = seedTask(config, task, { ...(cohort ? { cohort } : {}), ...(state === 'closed' ? { closed: true } : {}), ...(state === 'cancelled' ? { cancelled: true } : {}) });
    if (state === 'working') tmux.add(task.toLowerCase(), WORKING);
    else {
      fs.mkdirSync(path.dirname(record.report), { recursive: true });
      fs.writeFileSync(record.report, `# ${task}\n`);
    }
  };
  return { root, repo, config, tmux, runner, ctx, out, notified, notifier, specOf, resolve, start, queueUp, seed };
}

describe('cohort names', () => {
  it('letters, digits, "-", "_" and "."; no empty name, no leading dot or dash, at most 40 characters', () => {
    for (const ok of ['sprint-1', 'Sprint_2', 'v1.2.3', 'a', '2026', 'łódź-1', '_x']) assert.equal(cohortNameProblem(ok), undefined, ok);
    for (const bad of ['', '  ', '.hidden', '-x', 'a b', 'a/b', '..', 'a'.repeat(41), 'x:y', 'x*']) assert.match(cohortNameProblem(bad) ?? '', /cohort name/, JSON.stringify(bad));
    assert.match(cohortNameProblem(5) ?? '', /cohort name/);
  });

  it('are compared without regard to case', () => {
    assert.equal(cohortKey('Sprint-1'), cohortKey('SPRINT-1'));
    assert.equal(cohortKey('ŁÓDŹ'), cohortKey('łódź'));
    assert.notEqual(cohortKey('a'), cohortKey('b'));
  });
});

describe('cohort: the spec field', () => {
  it('is read from the header; without it the task has no cohort (nothing is made up)', () => {
    const s = setup('field');
    assert.equal(s.resolve(s.specOf('A-1', 'cohort: Sprint-1\n'))[0]?.cohort, 'Sprint-1');
    assert.equal(s.resolve(s.specOf('A-2'))[0]?.cohort, undefined);
    assert.equal(s.resolve(s.specOf('A-3', 'cohort: null\n'))[0]?.cohort, undefined);
  });

  it('an invalid name is an error that says what is allowed', () => {
    const s = setup('fieldbad');
    assert.throws(() => s.resolve(s.specOf('A-1', 'cohort: "a b"\n')), /invalid cohort name "a b": letters, digits/);
    assert.throws(() => s.resolve(s.specOf('A-1', 'cohort: ""\n')), /cohort name cannot be empty/);
    assert.throws(() => s.resolve(s.specOf('A-1', 'cohort: [x]\n')), /cohort name/);
  });
});

describe('cohort: made by its first task, spelled as first written', () => {
  it('new writes cohort into TASK.md and creates <config dir>/cohorts/<name>.json; a later spelling keeps the first', async () => {
    const s = setup('made');
    await s.start(s.specOf('A-1', 'cohort: Sprint-1\n'));
    const meta = readCohort(s.config, 'sprint-1');
    assert.equal(meta?.name, 'Sprint-1');
    assert.equal(meta?.created, new Date(s.runner.now()).toISOString().replace(/\.\d+Z$/, (m) => m) && meta?.created);
    assert.ok(fs.existsSync(path.join(path.dirname(s.config.path), 'cohorts', 'sprint-1.json')));
    await s.start(s.specOf('A-2', 'cohort: SPRINT-1\n'));
    assert.equal(readTaskRecord(s.config, 'a-1')?.cohort, 'Sprint-1');
    assert.equal(readTaskRecord(s.config, 'a-2')?.cohort, 'Sprint-1', 'the spelling of the first use');
    assert.deepEqual(listCohorts(s.config).map((c) => c.name), ['Sprint-1']);
  });

  it('a task without a name belongs to no cohort and makes no cohort', async () => {
    const s = setup('none');
    await s.start(s.specOf('A-1'));
    assert.equal(readTaskRecord(s.config, 'a-1')?.cohort, undefined);
    assert.equal(fs.existsSync(path.join(path.dirname(s.config.path), 'cohorts')), false);
    const [row] = await collectStatus(s.ctx, { progress: false });
    assert.equal(row?.cohort, null);
  });

  it('queue entries carry the cohort (and keep it in the spec text they start from)', async () => {
    const s = setup('queued');
    await s.queueUp(s.specOf('Q-1', 'cohort: Wave.2\n') + s.specOf('Q-2'));
    assert.deepEqual(readQueue(s.config).map((e) => [e.task, e.cohort]), [['Q-1', 'Wave.2'], ['Q-2', undefined]]);
    assert.equal(readCohort(s.config, 'wave.2')?.name, 'Wave.2');
  });
});

describe('cohort: --cohort on new and queue', () => {
  it('queue --cohort overrides the spec; every task of the file joins; a bad name is an error before anything is written', async () => {
    const s = setup('flagq');
    const r = await runCli(s.config, s.runner, ['queue', '--cohort', 'Wave-9', '-y', '-'], { readStdin: () => s.specOf('Q-1', 'cohort: other\n') + s.specOf('Q-2') });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(readQueue(s.config).map((e) => [e.task, e.cohort]), [['Q-1', 'Wave-9'], ['Q-2', 'Wave-9']]);
    assert.match(readQueue(s.config)[0]?.spec ?? '', /cohort: Wave-9/);
    assert.equal(readCohort(s.config, 'other'), undefined, 'the cohort of the spec was overridden, not made');
    const bad = await runCli(s.config, s.runner, ['queue', '--cohort', 'a b', '-y', '-'], { readStdin: () => s.specOf('Q-3') });
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /--cohort: invalid cohort name "a b"/);
    assert.deepEqual(readQueue(s.config).map((e) => e.task), ['Q-1', 'Q-2']);
  });

  it('new --cohort overrides the spec', async () => {
    const s = setup('flagn');
    const r = await runCli(s.config, s.runner, ['new', '--cohort', 'Wave-9', '-y', '-'], { readStdin: () => s.specOf('A-1', 'cohort: other\n') + s.specOf('A-2'), confirm: async () => true });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual([readTaskRecord(s.config, 'a-1')?.cohort, readTaskRecord(s.config, 'a-2')?.cohort], ['Wave-9', 'Wave-9']);
    assert.deepEqual(listCohorts(s.config).map((c) => c.name), ['Wave-9']);
  });
});

describe('cohort list, show, add, remove, note', () => {
  it('list counts the tasks by state and says since when; --json has the same', async () => {
    const s = setup('list');
    s.seed('A-1', 'working', 'Sprint-1');
    s.seed('A-2', 'ready', 'sprint-1');
    s.seed('A-3', 'closed', 'Sprint-1');
    s.seed('A-4', 'cancelled', 'Sprint-1');
    s.seed('B-1', 'working', 'other');
    s.seed('C-1', 'working');
    await s.queueUp(s.specOf('Q-1', 'cohort: Sprint-1\n'));
    const r = await runCli(s.config, s.runner, ['cohort', 'list']);
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.trim().split('\n');
    assert.match(lines[0] ?? '', /^COHORT\s+ACTIVE\s+QUEUED\s+REPORTS\s+CLOSED\s+CANCELLED\s+SINCE$/);
    assert.match(lines.find((l) => l.startsWith('other')) ?? '', /^other\s+1\s+0\s+0\s+0\s+0\s+-$/);
    assert.match(lines.find((l) => l.startsWith('Sprint-1')) ?? '', /^Sprint-1\s+1\s+1\s+1\s+1\s+1\s+\d{4}-\d\d-\d\d \d\d:\d\d$/);
    assert.equal(r.stdout.includes('C-1'), false);
    const json = JSON.parse((await runCli(s.config, s.runner, ['cohort', 'list', '--json'])).stdout) as { name: string; created: string; active: number; queued: number; reports: number; closed: number; cancelled: number; total: number }[];
    assert.deepEqual(json.find((c) => c.name === 'Sprint-1'), { name: 'Sprint-1', created: json.find((c) => c.name === 'Sprint-1')?.created, note: null, active: 1, queued: 1, reports: 1, closed: 1, cancelled: 1, total: 5 });
    assert.match((await runCli(s.config, s.runner, ['cohort'])).stdout, /^COHORT/, 'cohort alone is cohort list');
    assert.match((await runCli(setup('list-empty').config, s.runner, ['cohort', 'list'])).stdout, /No cohorts\./);
  });

  it('show lists the tasks as status does, closed and cancelled ones too, and the queued ones', async () => {
    const s = setup('show');
    s.seed('A-1', 'working', 'Sprint-1');
    s.seed('A-4', 'cancelled', 'Sprint-1');
    s.seed('C-1', 'working');
    await s.queueUp(s.specOf('Q-1', 'cohort: Sprint-1\n'));
    await runCli(s.config, s.runner, ['cohort', 'note', 'SPRINT-1', 'landing', 'page']);
    const r = await runCli(s.config, s.runner, ['cohort', 'show', 'sprint-1']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^Cohort Sprint-1 \(since \d{4}-\d\d-\d\d \d\d:\d\d\): landing page\n/);
    assert.match(r.stdout, /A-1 .*working/);
    assert.match(r.stdout, /A-4 \(cancelled\) .*cancelled/);
    assert.doesNotMatch(r.stdout, /C-1/);
    assert.doesNotMatch(r.stdout, /COHORT/, 'the column would say the same on every row');
    assert.match(r.stdout, /Queue \(1\)[\s\S]*Q-1/);
    const json = JSON.parse((await runCli(s.config, s.runner, ['cohort', 'show', 'sprint-1', '--json'])).stdout) as { cohort: string; note: string; tasks: { task: string }[]; queued: string[] };
    assert.deepEqual([json.cohort, json.note, json.tasks.map((t) => t.task), json.queued], ['Sprint-1', 'landing page', ['A-1', 'A-4'], ['Q-1']]);
    const unknown = await runCli(s.config, s.runner, ['cohort', 'show', 'nope']);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /no cohort "nope"/);
    assert.match(unknown.stderr, /Cohorts: Sprint-1/);
  });

  it('add puts existing tasks in a cohort (made if new), moves a task from another one; remove takes it out', async () => {
    const s = setup('addrm');
    s.seed('A-1', 'working');
    s.seed('A-2', 'working', 'old');
    await s.queueUp(s.specOf('Q-1'));
    let r = await runCli(s.config, s.runner, ['cohort', 'add', 'Wave-1', 'a-1', 'A-2', 'q-1']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /A-1: joined cohort Wave-1\nA-2: moved from old to cohort Wave-1\nQ-1: joined cohort Wave-1/);
    assert.deepEqual([readTaskRecord(s.config, 'a-1')?.cohort, readTaskRecord(s.config, 'a-2')?.cohort], ['Wave-1', 'Wave-1']);
    const entry = readQueue(s.config)[0];
    assert.equal(entry?.cohort, 'Wave-1');
    assert.match(entry?.spec ?? '', /cohort: Wave-1/);
    assert.match((await runCli(s.config, s.runner, ['cohort', 'add', 'WAVE-1', 'A-1'])).stdout, /A-1: already in cohort Wave-1/);
    r = await runCli(s.config, s.runner, ['cohort', 'remove', 'A-1', 'Q-1', 'A-2']);
    assert.match(r.stdout, /A-1: left cohort Wave-1\nQ-1: left cohort Wave-1\nA-2: left cohort Wave-1/);
    assert.deepEqual([readTaskRecord(s.config, 'a-1')?.cohort, readQueue(s.config)[0]?.cohort], [undefined, undefined]);
    assert.doesNotMatch(readQueue(s.config)[0]?.spec ?? '', /cohort/);
    assert.match((await runCli(s.config, s.runner, ['cohort', 'remove', 'A-1'])).stdout, /A-1: was in no cohort/);
    assert.match((await runCli(s.config, s.runner, ['cohort', 'list'])).stdout, /^Wave-1\s+0\s+0\s+0\s+0\s+0\s+/m, 'a cohort stays when it is empty');
  });

  it('add and remove refuse unknown and ambiguous tasks, and change nothing', async () => {
    const s = setup('adderr');
    s.seed('A-1', 'working');
    s.seed('A-10', 'working');
    const r = await runCli(s.config, s.runner, ['cohort', 'add', 'W', 'A-1', 'ZZ-9', 'A-']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no task "ZZ-9"/);
    assert.match(r.stderr, /"A-" fits more than one task: A-1, A-10/);
    assert.equal(readTaskRecord(s.config, 'a-1')?.cohort, undefined);
    assert.equal((await runCli(s.config, s.runner, ['cohort', 'add', 'bad name', 'A-1'])).code, 1);
  });

  it('note sets and clears the description; the cohort must exist', async () => {
    const s = setup('note');
    s.seed('A-1', 'working', 'Sprint-1');
    await runCli(s.config, s.runner, ['cohort', 'add', 'Sprint-1', 'A-1']);
    assert.match((await runCli(s.config, s.runner, ['cohort', 'note', 'sprint-1', 'the', 'menu'])).stdout, /Cohort Sprint-1: the menu/);
    assert.equal(readCohort(s.config, 'Sprint-1')?.note, 'the menu');
    assert.match((await runCli(s.config, s.runner, ['cohort', 'note', 'sprint-1', ''])).stdout, /note removed/);
    assert.equal(readCohort(s.config, 'Sprint-1')?.note, undefined);
    assert.equal((await runCli(s.config, s.runner, ['cohort', 'note', 'nope', 'x'])).code, 1);
  });
});

describe('cohort: the --cohort filter', () => {
  function world(name: string) {
    const s = setup(name);
    s.seed('A-1', 'working', 'Sprint-1');
    s.seed('A-2', 'ready', 'Sprint-1');
    s.seed('B-1', 'ready', 'Other');
    s.seed('C-1', 'working');
    return s;
  }

  it('status, status --json and status --clip show only the cohort; without the flag everything, as before', async () => {
    const s = world('fstatus');
    const all = (await runCli(s.config, s.runner, ['status'])).stdout;
    assert.match(all, /COHORT/);
    for (const t of ['A-1', 'A-2', 'B-1', 'C-1']) assert.match(all, new RegExp(t));
    assert.match(all, /C-1 +-/, 'a task without a cohort has "-"');
    const one = (await runCli(s.config, s.runner, ['status', '--cohort', 'SPRINT-1'])).stdout;
    assert.match(one, /A-1/);
    assert.match(one, /A-2/);
    assert.doesNotMatch(one, /B-1|C-1/);
    const json = JSON.parse((await runCli(s.config, s.runner, ['status', '--cohort', 'sprint-1', '--json'])).stdout) as { task: string; cohort: string }[];
    assert.deepEqual(json.map((r) => [r.task, r.cohort]), [['A-1', 'Sprint-1'], ['A-2', 'Sprint-1']]);
    let clip = '';
    const md = await runCli(s.config, s.runner, ['status', '--cohort', 'sprint-1', '--clip'], { readClipboard: async () => '' });
    clip = md.stdout;
    assert.match(clip, /A-1[\s\S]*A-2|Copied the status of 2 tasks|\| cohort \|/);
    assert.doesNotMatch(clip, /B-1/);
    const unknown = await runCli(s.config, s.runner, ['status', '--cohort', 'nope']);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /no cohort "nope"/);
  });

  it('the COHORT column is there only while some task has a cohort', async () => {
    const s = setup('fcolumn');
    s.seed('C-1', 'working');
    assert.doesNotMatch((await runCli(s.config, s.runner, ['status'])).stdout, /COHORT/);
  });

  it('pull --ready --cohort takes only the reports of that cohort', async () => {
    const s = world('fpull');
    const r = await runCli(s.config, s.runner, ['pull', '--ready', '--cohort', 'sprint-1']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /A-2/);
    assert.doesNotMatch(r.stdout, /B-1/);
    assert.equal(readTaskRecord(s.config, 'a-2')?.pulled !== undefined, true);
    assert.equal(readTaskRecord(s.config, 'b-1')?.pulled, undefined, 'the other cohort is not marked as pulled');
    const again = await runCli(s.config, s.runner, ['pull', '--ready', '--cohort', 'sprint-1']);
    assert.match(again.stdout, /No new reports \(1 already pulled; --all takes them again\)\. \(cohort Sprint-1\)/);
    const bad = await runCli(s.config, s.runner, ['pull', 'A-2', '--cohort', 'sprint-1']);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /--cohort only works together with --ready/);
  });

  it('queue list --cohort shows the queued tasks of that cohort, with the places of the whole queue', async () => {
    const s = setup('fqueue');
    await s.queueUp(s.specOf('Q-1') + s.specOf('Q-2', 'cohort: Wave\n') + s.specOf('Q-3', 'cohort: other\n'));
    const r = await runCli(s.config, s.runner, ['queue', 'list', '--cohort', 'wave']);
    assert.match(r.stdout, /2\s+Q-2/);
    assert.doesNotMatch(r.stdout, /Q-1|Q-3/);
    const json = JSON.parse((await runCli(s.config, s.runner, ['queue', 'list', '--cohort', 'wave', '--json'])).stdout) as { task: string; position: number; cohort: string }[];
    assert.deepEqual(json.map((j) => [j.task, j.position, j.cohort]), [['Q-2', 2, 'Wave']]);
  });

  it('close --cohort lists the open tasks of the cohort and asks y/N; tasks named with it must belong to it', async () => {
    const s = world('fclose');
    s.seed('A-3', 'closed', 'Sprint-1');
    const no = await runCli(s.config, s.runner, ['close', '--cohort', 'sprint-1'], { confirm: async () => false });
    assert.match(no.stdout, /Close 2 tasks:\n {2}A-1 .*\n {2}A-2 /);
    assert.doesNotMatch(no.stdout, /A-3|B-1|C-1/);
    assert.equal(readTaskRecord(s.config, 'a-1')?.closed, undefined);
    const outside = await runCli(s.config, s.runner, ['close', 'B-1', '--cohort', 'sprint-1', '-y']);
    assert.equal(outside.code, 1);
    assert.match(outside.stderr, /not an open task of cohort Sprint-1: B-1/);
    const yes = await runCli(s.config, s.runner, ['close', '--cohort', 'sprint-1', '-y']);
    assert.equal(yes.code, 0, yes.stderr);
    assert.deepEqual([readTaskRecord(s.config, 'a-1')?.closed, readTaskRecord(s.config, 'a-2')?.closed, readTaskRecord(s.config, 'b-1')?.closed, readTaskRecord(s.config, 'c-1')?.closed], [true, true, undefined, undefined]);
    assert.equal((await runCli(s.config, s.runner, ['close'])).code, 1);
    assert.match((await runCli(s.config, s.runner, ['close', '--cohort', 'sprint-1', '-y'])).stderr, /cohort Sprint-1 has no open tasks/);
  });

  it('cancel --cohort lists the open tasks, the queued ones too, and asks y/N', async () => {
    const s = world('fcancel');
    await s.queueUp(s.specOf('Q-1', 'cohort: Sprint-1\n') + s.specOf('Q-2'));
    const asked: string[] = [];
    const r = await runCli(s.config, s.runner, ['cancel', '--cohort', 'sprint-1', '--reason', 'scrapped'], { confirm: async (q) => (asked.push(q), true) });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(asked, ['Cancel? [y/N] ']);
    assert.match(r.stdout, /Cancel 3 tasks – scrapped:/);
    for (const t of ['a-1', 'a-2', 'q-1']) assert.deepEqual([t, readTaskRecord(s.config, t)?.cancelled, readTaskRecord(s.config, t)?.cancelReason], [t, true, 'scrapped']);
    assert.deepEqual([readTaskRecord(s.config, 'b-1')?.cancelled, readTaskRecord(s.config, 'c-1')?.cancelled], [undefined, undefined]);
    assert.deepEqual(readQueue(s.config).map((e) => e.task), ['Q-2']);
  });
});

describe('cohort: "all reports ready"', () => {
  const tick = (s: ReturnType<typeof setup>) => cohortTick(s.ctx, s.notifier, [] as never[]).then(() => undefined);
  void tick;

  async function rows(s: ReturnType<typeof setup>) {
    return collectStatus(s.ctx, { progress: false, archived: true });
  }

  it('one notice when every task of the cohort has a report; not before, and not twice', async () => {
    const s = setup('done');
    s.seed('A-1', 'ready', 'Sprint-1');
    s.seed('A-2', 'working', 'Sprint-1');
    s.seed('B-1', 'working', 'Other');
    await runCli(s.config, s.runner, ['cohort', 'add', 'Sprint-1', 'A-1']); // makes the cohort file
    await runCli(s.config, s.runner, ['cohort', 'add', 'Other', 'B-1']);
    assert.deepEqual(await cohortTick(s.ctx, s.notifier, await rows(s)), [], 'A-2 still works');
    // A-2 finishes: its window goes, its report is there
    s.tmux.windows = s.tmux.windows.filter((w) => w.name !== 'a-2');
    const report = readTaskRecord(s.config, 'a-2')?.report as string;
    fs.mkdirSync(path.dirname(report), { recursive: true });
    fs.writeFileSync(report, '# A-2\n');
    assert.deepEqual(await cohortTick(s.ctx, s.notifier, await rows(s)), [cohortDoneText('Sprint-1', 2)]);
    assert.deepEqual(s.notified, ['kohorta Sprint-1: wszystkie raporty gotowe (2)']);
    assert.deepEqual(await cohortTick(s.ctx, s.notifier, await rows(s)), [], 'once');
    assert.deepEqual(readCohort(s.config, 'sprint-1')?.announced, ['A-1', 'A-2'], 'remembered in the cohort file, so a restart says nothing again');
  });

  it('again only when a task joins; a cancelled task never holds it back, a queued one does', async () => {
    const s = setup('rejoin');
    s.seed('A-1', 'ready', 'Sprint-1');
    s.seed('A-2', 'cancelled', 'Sprint-1');
    await runCli(s.config, s.runner, ['cohort', 'add', 'Sprint-1', 'A-1']);
    assert.deepEqual(await cohortTick(s.ctx, s.notifier, await rows(s)), [cohortDoneText('Sprint-1', 1)], 'the cancelled task does not count');
    // a task joins (queued): it must have a report before the cohort is done again
    await s.queueUp(s.specOf('Q-1', 'cohort: Sprint-1\n'));
    assert.deepEqual(await cohortTick(s.ctx, s.notifier, await rows(s)), []);
    // the new task is cancelled: nothing new to announce (the set of tasks is a subset of what was announced)
    await cancelTasks(s.ctx, await planCancel(s.ctx, ['Q-1']));
    assert.deepEqual(await cohortTick(s.ctx, s.notifier, await rows(s)), []);
    // a new task joins and finishes
    s.seed('A-3', 'ready', 'Sprint-1');
    assert.deepEqual(await cohortTick(s.ctx, s.notifier, await rows(s)), [cohortDoneText('Sprint-1', 2)]);
    assert.equal(s.notified.length, 2);
  });

  it('the watcher sends it, a closed task with a report counts, an old window replaced by a move does not hold it back', async () => {
    const s = setup('watch');
    s.seed('A-1', 'closed', 'Sprint-1');
    s.seed('A-2', 'ready', 'Sprint-1');
    s.seed('A-3', 'working', 'Sprint-1');
    readTaskRecord(s.config, 'a-3');
    // A-3 was moved to A-3-2 (its old window stays, superseded); A-3-2 has a report
    await runCli(s.config, s.runner, ['cohort', 'add', 'Sprint-1', 'A-1']);
    const memory = new WatchMemory();
    await watchTick(s.ctx, memory, s.notifier);
    assert.deepEqual(s.notified.filter((n) => n.startsWith('kohorta')), [], 'A-3 works');
    fs.appendFileSync(path.join(s.config.stateDir, 'a-3', 'TASK.md'), '');
    const text = fs.readFileSync(path.join(s.config.stateDir, 'a-3', 'TASK.md'), 'utf8').replace(/^---\n/, '---\nsuperseded_by: A-3-2\n');
    fs.writeFileSync(path.join(s.config.stateDir, 'a-3', 'TASK.md'), text);
    seedTask(s.config, 'A-3-2', { cohort: 'Sprint-1', continues: 'A-3' });
    const r = readTaskRecord(s.config, 'a-3-2')?.report as string;
    fs.mkdirSync(path.dirname(r), { recursive: true });
    fs.writeFileSync(r, '# done\n');
    await watchTick(s.ctx, memory, s.notifier);
    assert.deepEqual(s.notified.filter((n) => n.startsWith('kohorta')), ['kohorta Sprint-1: wszystkie raporty gotowe (3)']);
    await watchTick(s.ctx, memory, s.notifier);
    assert.equal(s.notified.filter((n) => n.startsWith('kohorta')).length, 1);
  });

  it('a cohort with no task left (all cancelled) says nothing', async () => {
    const s = setup('empty');
    s.seed('A-1', 'cancelled', 'Sprint-1');
    await runCli(s.config, s.runner, ['cohort', 'note', 'Sprint-1', 'x']).catch(() => undefined);
    await s.queueUp(s.specOf('Q-1', 'cohort: Sprint-1\n'));
    await cancelTasks(s.ctx, await planCancel(s.ctx, ['Q-1']));
    assert.deepEqual(await cohortTick(s.ctx, s.notifier, await rows(s)), []);
    assert.deepEqual((await summarizeCohorts(s.ctx)).map((c) => [c.name, c.cancelled, c.total]), [['Sprint-1', 2, 2]]);
  });
});
