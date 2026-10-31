import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadGlobalConfig } from '../src/core/config.ts';
import type { Layer } from '../src/core/config.ts';
import { resolveSendSpec, resolveSpec, splitSpecs } from '../src/core/spec.ts';
import { makeConfig, useScratch } from './helpers.ts';

const scratch = useScratch();
const config = makeConfig(scratch.dir, 'worktree_root: ~/wt\n');
const noProject = (): undefined => undefined;

const resolve = (text: string, loadProject: (p: string) => Layer | undefined = noProject) =>
  splitSpecs(text).map((raw) => resolveSpec(raw, { config, loadProject }));

const SPEC_ONE = `---
task: NC-1
agent: claude
model: opus
effort: high
repos:
  - path: ~/code/app
    worktree: ~/wt/app-nc-1
    base: main
    branch: nc-1
links:
  - from: node_modules/@x/*
    to: ~/other/packages/*
env:
  FOO: bar
report: ~/reports/NC-1.md
---
Do the thing.

Second paragraph.
`;

describe('splitSpecs', () => {
  it('parses a single spec into header and prompt', () => {
    const [spec, ...rest] = splitSpecs(SPEC_ONE);
    assert.equal(rest.length, 0);
    assert.equal(spec?.header.task, 'NC-1');
    assert.equal(spec?.prompt, 'Do the thing.\n\nSecond paragraph.');
  });

  it('parses several specs in one file', () => {
    const text = `${SPEC_ONE}---\ntask: NC-2\nagent: codex\nrepos:\n  - path: ~/code/app\n---\nReview NC-1.\n`;
    const specs = splitSpecs(text);
    assert.deepEqual(specs.map((s) => [s.index, s.header.task, s.prompt]), [
      [1, 'NC-1', 'Do the thing.\n\nSecond paragraph.'],
      [2, 'NC-2', 'Review NC-1.'],
    ]);
  });

  it('keeps markdown rules and fenced prose inside the prompt', () => {
    const text = `---\ntask: NC-1\nagent: claude\n---\nIntro\n\n---\n\nAfter the rule\n\n---\nsome fenced prose\n---\nEnd\n`;
    const [spec] = splitSpecs(text);
    assert.match(spec?.prompt ?? '', /Intro[\s\S]*---[\s\S]*After the rule[\s\S]*some fenced prose[\s\S]*End/);
  });

  it('rejects text that does not start with a header', () => {
    assert.throws(() => splitSpecs('Just a prompt'), /must start with a YAML header/);
    assert.throws(() => splitSpecs('   \n'), /is empty/);
  });

  it('rejects an unclosed or malformed header', () => {
    assert.throws(() => splitSpecs('---\ntask: NC-1\nPrompt'), /never closed/);
    assert.throws(() => splitSpecs('---\ntask: [unclosed\n---\nPrompt'), /invalid YAML/);
    assert.throws(() => splitSpecs('---\n- a list\n---\nPrompt'), /must be a YAML mapping/);
  });
});

describe('resolveSpec', () => {
  it('resolves a complete spec and expands ~', () => {
    const [spec] = resolve(SPEC_ONE);
    assert.ok(spec);
    const home = os.homedir();
    assert.equal(spec.task, 'NC-1');
    assert.equal(spec.window, 'nc-1');
    assert.deepEqual([spec.agent, spec.model, spec.effort], ['claude', 'opus', 'high']);
    assert.deepEqual(spec.repos, [
      { path: path.join(home, 'code/app'), worktree: path.join(home, 'wt/app-nc-1'), base: 'main', branch: 'nc-1' },
    ]);
    assert.deepEqual(spec.links, [{ from: 'node_modules/@x/*', to: path.join(home, 'other/packages/*') }]);
    assert.deepEqual(spec.env, { FOO: 'bar' });
    assert.equal(spec.report, path.join(home, 'reports/NC-1.md'));
  });

  it('defaults model/effort and derives worktree and report', () => {
    const [spec] = resolve('---\ntask: AB-7\nagent: codex\nrepos:\n  - path: ~/code/app\n---\nHi\n');
    assert.ok(spec);
    assert.equal(spec.model, 'default');
    assert.equal(spec.effort, 'high');
    assert.equal(spec.repos[0]?.worktree, path.join(os.homedir(), 'wt', 'app-ab-7'));
    assert.equal(spec.report, path.join(config.cache, 'ab-7', 'AB-7.md'));
  });

  it('reports every validation problem with a readable message', () => {
    const bad = '---\ntask: nc-3\nagent: gemini\neffort: extreme\nefort: low\n---\n';
    assert.throws(
      () => resolve(bad),
      (e: Error) => {
        assert.match(e.message, /Spec #1 \(nc-3\) is invalid/);
        assert.match(e.message, /invalid task ID "nc-3": use UPPERCASE/);
        assert.match(e.message, /agent must be one of claude, codex \(got "gemini"\)/);
        assert.match(e.message, /effort must be one of low, medium, high \(got "extreme"\)/);
        assert.match(e.message, /unknown key "efort"/);
        assert.match(e.message, /"repos" must list at least one repository/);
        assert.match(e.message, /the prompt is empty/);
        return true;
      },
    );
  });

  it('requires task and agent', () => {
    const noTask = '---\nagent: claude\nrepos:\n  - path: ~/x\n---\nHi\n';
    assert.throws(() => resolve(noTask), /missing "task"/);
    const noAgent = '---\ntask: NC-1\nrepos:\n  - path: ~/x\n---\nHi\n';
    assert.throws(() => resolve(noAgent), /missing "agent" \(one of claude, codex\)/);
  });

  it('needs a worktree from the spec or a worktree_root', () => {
    const bare = makeConfig(scratch.sub('bare'));
    const raw = splitSpecs('---\ntask: NC-1\nagent: claude\nrepos:\n  - path: ~/code/app\n---\nHi\n')[0]!;
    assert.throws(() => resolveSpec(raw, { config: bare, loadProject: noProject }), /no worktree for ~\/code\/app/);
  });
});

describe('configuration layers: global < project < spec', () => {
  const layered = makeConfig(
    scratch.sub('layered'),
    [
      'defaults: {effort: low, model: global-model}',
      'env: {A: global, B: global}',
      'report: "{cache}/{task}/global-{TASK}.md"',
      'worktree_root: ~/wt-global',
      'links: [{from: "a/*", to: "~/g/*"}]',
    ].join('\n'),
  );
  const project: Layer = {
    defaults: { effort: 'medium' },
    env: { B: 'project', C: 'project', TASK_ID: '{TASK}' },
    report: '~/proj/{task}.md',
    worktreeRoot: '~/wt-project',
    links: [{ from: 'a/*', to: '~/p/*' }, { from: 'b', to: '~/b' }],
  };
  const run = (header: string) => {
    const raw = splitSpecs(`---\ntask: NC-9\nagent: claude\n${header}repos:\n  - path: ~/code/app\n---\nHi\n`)[0]!;
    return resolveSpec(raw, { config: layered, loadProject: () => project });
  };

  it('project overrides global, spec overrides project', () => {
    const fromProject = run('');
    assert.equal(fromProject.effort, 'medium');
    assert.equal(fromProject.model, 'global-model');
    assert.deepEqual(fromProject.env, { A: 'global', B: 'project', C: 'project', TASK_ID: 'NC-9' });
    assert.equal(fromProject.report, path.join(os.homedir(), 'proj/nc-9.md'));
    assert.equal(fromProject.repos[0]?.worktree, path.join(os.homedir(), 'wt-project', 'app-nc-9'));

    const fromSpec = run('effort: high\nenv: {C: spec}\nreport: /abs/r.md\n');
    assert.equal(fromSpec.effort, 'high');
    assert.equal(fromSpec.env.C, 'spec');
    assert.equal(fromSpec.report, '/abs/r.md');
  });

  it('merges links; a later layer replaces an earlier one with the same "from"', () => {
    const spec = run('links: [{from: b, to: "~/b-spec"}]\n');
    const home = os.homedir();
    assert.deepEqual(spec.links, [
      { from: 'a/*', to: path.join(home, 'p/*') },
      { from: 'b', to: path.join(home, 'b-spec') },
    ]);
  });

  it('reads the project layer from <repo>/.agentctl.yaml', () => {
    const repo = scratch.sub('proj-repo');
    fs.writeFileSync(path.join(repo, '.agentctl.yaml'), 'worktree_root: /wt\nenv: {FROM_PROJECT: "{task}"}\ndefaults: {agent: codex}\n');
    const raw = splitSpecs(`---\ntask: NC-5\nrepos:\n  - path: ${repo}\n---\nHi\n`)[0]!;
    const spec = resolveSpec(raw, { config });
    assert.equal(spec.agent, 'codex');
    assert.equal(spec.env.FROM_PROJECT, 'nc-5');
    assert.equal(spec.repos[0]?.worktree, path.join('/wt', 'proj-repo-nc-5'));
  });

  it('rejects an invalid project config with its path', () => {
    const repo = scratch.sub('bad-proj');
    fs.writeFileSync(path.join(repo, '.agentctl.yaml'), 'wortree_root: /wt\n');
    const raw = splitSpecs(`---\ntask: NC-6\nagent: claude\nrepos:\n  - path: ${repo}\n---\nHi\n`)[0]!;
    assert.throws(() => resolveSpec(raw, { config }), /unknown key "wortree_root"/);
  });
});

describe('global config', () => {
  it('has sensible defaults without a file', () => {
    const c = loadGlobalConfig(scratch.sub('no-config'));
    assert.equal(c.loaded, false);
    assert.equal(c.session, 'agentctl');
    assert.equal(c.cache, path.join(os.homedir(), 'Projects', 'cache'));
    assert.deepEqual(c.limits, {});
  });

  it('rejects typos, bad limits and auto-accept flags', () => {
    const dir = scratch.sub('bad-config');
    fs.writeFileSync(
      path.join(dir, 'config.yaml'),
      'limits: {claude: 0}\nagents:\n  codex:\n    flags: [--full-auto]\n  claude:\n    flags: [--permission-mode, bypassPermissions]\nsesion: x\n',
    );
    assert.throws(
      () => loadGlobalConfig(dir),
      (e: Error) => {
        assert.match(e.message, /unknown key "sesion"/);
        assert.match(e.message, /limits\.claude must be a positive integer/);
        assert.match(e.message, /"--full-auto" enables auto-accept/);
        assert.match(e.message, /"--permission-mode bypassPermissions" enables auto-accept/);
        return true;
      },
    );
  });
});

describe('resolveSendSpec', () => {
  it('needs only a task and a prompt', () => {
    const [raw] = splitSpecs('---\ntask: NC-1\n---\nContinue with part 2.\n');
    assert.deepEqual(resolveSendSpec(raw!), { task: 'NC-1', window: 'nc-1', prompt: 'Continue with part 2.' });
    assert.throws(() => resolveSendSpec(splitSpecs('---\ntask: NC-1\n---\n')[0]!), /prompt is empty/);
  });
});
