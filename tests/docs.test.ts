import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { COMMAND_EXAMPLES, commandPath } from '../src/examples.ts';
import { allCommands, loadProgram, renderCommandsMarkdown } from '../src/help.ts';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import { TASK_STATES } from '../src/core/icons.ts';
import { AGENT_KEYS, BOARD_KEYS, DEFAULT_AGENT_SETTINGS, DEFAULTS_KEYS, GLOBAL_KEYS, LAYER_KEYS, LINK_KEYS, MCP_KEYS, NOTIFY_KEYS, NTFY_KEYS, AWAY_KEYS, MANAGER_KEYS, WATCH_KEYS } from '../src/core/config.ts';
import { REPO_KEYS, SPEC_KEYS } from '../src/core/spec.ts';
import { REPO_ROOT } from './helpers.ts';

const read = (...p: string[]): string => fs.readFileSync(path.join(REPO_ROOT, ...p), 'utf8');

describe('docs: commands', () => {
  it('docs/commands.md is what npm run docs generates', async () => {
    const generated = renderCommandsMarkdown(await loadProgram()).replaceAll('the Neon City example from the README', 'the project example from the README');
    assert.equal(read('docs', 'commands.md'), generated, 'docs/commands.md is out of date: run npm run docs');
  });

  it('every command, subcommand, option and argument has a description, and the examples name existing commands', async () => {
    const program = await loadProgram();
    const commands = allCommands(program);
    assert.ok(commands.length >= 20);
    for (const cmd of commands) {
      const where = `agentctl ${commandPath(cmd)}`;
      assert.notEqual(cmd.description().trim(), '', `${where} has no description`);
      for (const o of cmd.options) assert.notEqual(o.description.trim(), '', `${where} ${o.flags} has no description`);
      for (const a of cmd.registeredArguments) assert.notEqual(a.description.trim(), '', `${where} <${a.name()}> has no description`);
    }
    const known = new Set(commands.map(commandPath));
    for (const key of Object.keys(COMMAND_EXAMPLES)) assert.ok(known.has(key), `examples for "${key}": there is no such command`);
    for (const cmd of commands.filter((c) => c.commands.length === 0 && c.name() !== 'event' && c.name() !== 'serve')) {
      assert.ok(COMMAND_EXAMPLES[commandPath(cmd)], `agentctl ${commandPath(cmd)} has no example`);
    }
  });

  it('--help of a command prints its options and its examples', async () => {
    const { main } = await import('../src/cli.ts');
    const out: string[] = [];
    const code = await main(['pull', '--help'], { stdout: (t) => out.push(t), stderr: () => {}, readStdin: () => '', stdinIsTTY: false, loadConfig: () => { throw new Error('not needed'); }, confirm: undefined, readClipboard: async () => '', watchCommand: () => '', makeRunner: () => { throw new Error('not needed'); } });
    assert.equal(code, 0);
    const text = out.join('');
    assert.match(text, /--ready/);
    assert.match(text, /Examples:\n {2}agentctl pull TASK-42/);
  });
});

describe('docs: configuration', () => {
  const doc = read('docs', 'configuration.md');
  /** A key is described when a table row starts with it: | `watch.interval` | … */
  const described = (key: string): boolean => doc.includes(`| \`${key}\` |`);

  it('describes every key of the global config, the project config, the spec and their sections', () => {
    const keys: string[] = [
      ...GLOBAL_KEYS,
      ...DEFAULTS_KEYS.map((k) => `defaults.${k}`),
      ...LINK_KEYS.map((k) => `links[].${k}`),
      ...AGENT_KEYS.map((k) => `agents.<agent>.${k}`),
      ...['claude', 'codex'].map((a) => `limits.${a}`),
      ...WATCH_KEYS.map((k) => `watch.${k}`),
      ...NOTIFY_KEYS.map((k) => `notify.${k}`),
      ...NTFY_KEYS.map((k) => `notify.ntfy.${k}`),
      ...AWAY_KEYS.map((k) => `away.${k}`),
      ...MANAGER_KEYS.map((k) => `manager.${k}`),
      ...BOARD_KEYS.map((k) => `board.${k}`),
      ...MCP_KEYS.map((k) => `mcp.${k}`),
      ...SPEC_KEYS,
      ...REPO_KEYS.map((k) => `repos[].${k}`),
    ];
    const missing = [...new Set(keys)].filter((k) => !described(k));
    assert.deepEqual(missing, [], `docs/configuration.md does not describe: ${missing.join(', ')}`);
  });

  it('says which keys a project config (.agentctl.yaml) takes', () => {
    for (const key of LAYER_KEYS) assert.match(doc, new RegExp(`\\| \`${key.replace(/[.[\]]/g, '\\$&')}\` \\|[^\\n]*\\|[^\\n]*\\|[^\\n]*\\|`), `${key} has no row with its layers`);
  });

  it('shows the built-in screen patterns exactly as the code has them', () => {
    for (const agent of ['claude', 'codex'] as const) {
      const s = DEFAULT_AGENT_SETTINGS[agent];
      for (const pattern of [s.readyPattern, s.trustPattern, s.workingPattern, s.questionPattern, ...s.footerPatterns, ...s.limitPatterns, ...s.backgroundPatterns]) {
        assert.ok(doc.includes(pattern), `${agent}: the default pattern ${pattern} is missing in docs/configuration.md`);
      }
      assert.ok(doc.includes(s.effortArgs.join(' ')) || doc.includes(JSON.stringify(s.effortArgs)) || doc.includes(`[${s.effortArgs.map((a) => `'${a}'`).join(', ')}]`), `${agent}: effort_args default`);
    }
  });

  it('the README mentions every task state', () => {
    for (const state of TASK_STATES) assert.ok(read('README.md').includes(`\`${state}\``), `README does not mention the state ${state}`);
  });
});

describe('docs: mcp', () => {
  const doc = read('docs', 'mcp.md');
  it('describes every tool', () => {
    for (const tool of MCP_TOOLS) assert.ok(doc.includes(`| \`${tool.name}\` |`), `docs/mcp.md has no row for the tool ${tool.name}`);
  });
});

describe('docs: links and versions', () => {
  const files = ['README.md', 'README.pl.md', 'CHANGELOG.md', 'CONTRIBUTING.md', ...fs.readdirSync(path.join(REPO_ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)];

  it('relative links and anchors in the documents point at something that exists', () => {
    const problems: string[] = [];
    const anchorsOf = (text: string): Set<string> => {
      const set = new Set<string>();
      for (const m of text.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) {
        set.add(m[1]!.toLowerCase().replace(/`/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s/g, '-'));
      }
      return set;
    };
    for (const file of files) {
      const text = read(file);
      const withoutCode = text.replace(/```[\s\S]*?```/g, '');
      for (const m of withoutCode.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1]!;
        if (/^(https?:|mailto:)/.test(target)) continue;
        const [rel, anchor] = target.split('#') as [string, string | undefined];
        const resolved = rel === '' ? path.join(REPO_ROOT, file) : path.resolve(REPO_ROOT, path.dirname(file), rel);
        if (!fs.existsSync(resolved)) {
          problems.push(`${file}: ${target} -> missing file`);
          continue;
        }
        if (anchor && resolved.endsWith('.md') && !anchorsOf(fs.readFileSync(resolved, 'utf8')).has(anchor)) problems.push(`${file}: ${target} -> no such heading`);
      }
    }
    assert.deepEqual(problems, []);
  });

  it('the README and README.pl link to each other, and package.json has the version of the newest CHANGELOG entry', () => {
    assert.match(read('README.md'), /README\.pl\.md/);
    assert.match(read('README.pl.md'), /README\.md/);
    const version = (JSON.parse(read('package.json')) as { version: string }).version;
    const newest = /^## \[(\d+\.\d+\.\d+)\]/m.exec(read('CHANGELOG.md'))?.[1];
    assert.equal(newest, version, 'the newest released version in CHANGELOG.md must be the version in package.json');
  });

  it('the English README has the diagrams of docs/diagrams.md, and the Polish one has the same five diagrams', () => {
    const blocks = (text: string): string[] => [...text.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]!);
    const diagrams = blocks(read('docs', 'diagrams.md'));
    assert.deepEqual(diagrams.map((d) => d.split('\n')[0]), ['sequenceDiagram', 'sequenceDiagram', 'sequenceDiagram', 'flowchart TB', 'stateDiagram-v2']);
    assert.deepEqual(blocks(read('README.md')).sort(), [...diagrams].sort());
    assert.deepEqual(blocks(read('README.pl.md')).map((d) => d.split('\n')[0]), diagrams.map((d) => d.split('\n')[0]));
  });
});

describe('docs: the README top (screenshot and demo output)', () => {
  it('both READMEs show the board image and the texts that `npm run docs:screenshot` writes', () => {
    for (const file of ['README.md', 'README.pl.md']) {
      const readme = read(file);
      assert.ok(readme.includes('](docs/img/board.svg)'), `${file}: no board image`);
      for (const name of ['events_since.txt', 'pull_ready.txt']) assert.ok(readme.includes(read('docs', 'demo', name).trimEnd()), `${file}: the block of docs/demo/${name} is missing or out of date`);
    }
    for (const image of ['board.svg', 'board.png']) assert.ok(fs.existsSync(path.join(REPO_ROOT, 'docs', 'img', image)), `docs/img/${image} is missing`);
  });

  it('nothing of the machine is in the generated texts and images', () => {
    for (const rel of ['img/board.svg', 'demo/events_since.txt', 'demo/pull_ready.txt']) assert.doesNotMatch(read('docs', ...rel.split('/')), /\/Users\/|\/home\/(?!demo\/)|neon/i, rel);
  });
});

describe('docs: details.pl.md is a full equivalent of details.md', () => {
  const en = read('docs', 'details.md');
  const pl = read('docs', 'details.pl.md');
  const headings = (text: string): string[] => [...text.replace(/```[\s\S]*?```/g, '').matchAll(/^(#{1,6})\s/gm)].map((m) => m[1]!);

  it('has the same headings (levels and order), code blocks and table rows', () => {
    assert.deepEqual(headings(pl), headings(en));
    assert.equal((pl.match(/```/g) ?? []).length, (en.match(/```/g) ?? []).length);
    assert.equal((pl.match(/^\|/gm) ?? []).length, (en.match(/^\|/gm) ?? []).length);
  });

  it('README.pl.md links to the Polish details, not the English ones', () => {
    const readme = read('README.pl.md');
    const links = [...readme.matchAll(/\]\((docs\/details(?:\.pl)?\.md)[#)]/g)].map((m) => m[1]);
    assert.ok(links.length > 5);
    assert.ok(links.every((l) => l === 'docs/details.pl.md' || l === 'docs/details.md'));
    assert.equal(readme.match(/\]\(docs\/details\.md#/g), null, 'an anchor link into the English details');
  });
});
