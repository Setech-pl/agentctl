import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { journalOutputs, parseOutputs } from '../src/core/outputs.ts';
import { journalPath, readJournal } from '../src/core/journal.ts';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import { channelMessages, findMessage, MAX_TASK_POSTS } from '../src/core/wall.ts';
import { makeConfig, makeContext, seedTask, useScratch, FakeTmux } from './helpers.ts';

/*
 * WALL-2 item 2: `wall_posts` in agentctl-outputs. agentctl publishes them as task:<ID> once the report is read (watch, events_since,
 * get_report, pull_ready, pull), through the checks of every post; a bad entry is a finding in the report-outputs event and never a block of
 * the report. Deterministic: seeded task and report, no tmux, no inference.
 */
const scratch = useScratch();

const report = (posts: string): string => `Werdykt: PASS

Done.

\`\`\`agentctl-outputs
version: 1
verdict: PASS
decisions: [weather API v1 stays]
actions: []
wall_posts:
${posts}
\`\`\`
<!-- agentctl:report-end -->
`;

const GOOD_AND_BAD = `  - {channel: nc, kind: info, subject: "Heights v2 in @neon-city/sim", body: "Towers stay at **120 m**.", refs: ["task:NC-7"]}
  - {channel: agentctl, kind: question, subject: "Should wall_read page by 20?", body: "Asking."}
  - {channel: nc, kind: decision-request, subject: "freeze v1", body: "x"}
  - {channel: nc, kind: info, subject: "env", body: "export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789"}
  - {channel: private, kind: info, subject: "not mine", body: "x"}
  - {channel: weather, kind: info, subject: "nowhere", body: "x"}
  - {channel: nc, kind: info, subject: "too many", body: "x"}`;

function fixture(name: string, posts: string) {
  const config = makeConfig(scratch.sub(name), 'mcp: {allow: [wall]}\nwall:\n  channels:\n    agentctl: {authors: ["*"]}\n    nc: {authors: [owner, chat:nc, "task:*"]}\n    private: {authors: [owner]}\n');
  const tmux = new FakeTmux();
  const { ctx } = makeContext(config, { dryRun: false, respond: tmux.respond });
  const record = seedTask(config, 'NC-1');
  fs.mkdirSync(path.dirname(record.report), { recursive: true });
  fs.writeFileSync(record.report, report(posts));
  const call = (toolName: string, args: Record<string, unknown> = {}) => {
    const tool = MCP_TOOLS.find((t) => t.name === toolName)!;
    return tool.run({ context: () => ctx, notify: async () => {} }, z.object(tool.input).parse(args) as never);
  };
  const event = () => readJournal(config, -1).filter((e) => e.kind === 'report-outputs' && e.task === 'NC-1');
  return { config, ctx, record, call, event };
}

describe('WALL-2: wall_posts of a task report', () => {
  it('publishes the valid posts as task:<ID>; every bad one is a finding of the event, and the report stays valid', async () => {
    const f = fixture('publish', GOOD_AND_BAD);
    const parsed = parseOutputs(fs.readFileSync(f.record.report, 'utf8'));
    assert.equal(parsed.outputs_valid, true, parsed.outputs_errors.join('; '));
    assert.deepEqual(parsed.outputs?.decisions, ['weather API v1 stays']);
    assert.equal('wall_posts' in (parsed.outputs ?? {}), false, 'bodies never travel with outputs');

    await journalOutputs(f.ctx, f.record);
    const nc = channelMessages(f.config, 'nc');
    assert.deepEqual(nc.map((m) => `${m.id} ${m.from} ${m.kind} ${m.status} ${m.subject}`), ['nc-1 task:NC-1 info answered Heights v2 in @neon-city/sim']);
    assert.deepEqual(nc[0]!.refs, ['task:NC-7']);
    assert.deepEqual(channelMessages(f.config, 'agentctl').map((m) => `${m.id} ${m.from} ${m.kind} ${m.status}`), ['agentctl-1 task:NC-1 question open']);
    assert.equal(channelMessages(f.config, 'private').length, 0);

    const [e] = f.event();
    assert.ok(e, 'one report-outputs event');
    assert.deepEqual(e.wallPosts?.posted, ['nc-1', 'agentctl-1']);
    const findings = e.wallPosts?.findings ?? [];
    assert.equal(findings.length, 4, findings.join('\n'));
    assert.match(findings[0]!, /^wall_posts\[2\] \(nc\): kind: a task posts info or question$/);
    assert.match(findings[1]!, /^wall_posts\[3\] \(nc\): rejected by the secret scan, nothing was posted: .*body: a GitHub token/);
    assert.match(findings[2]!, /^wall_posts\[4\] \(private\): task:NC-1 may not post in private/);
    assert.match(findings[3]!, new RegExp(`^wall_posts\\[${MAX_TASK_POSTS}\\]…: at most ${MAX_TASK_POSTS} posts per report, 2 not published`));
    assert.ok(!JSON.stringify(e).includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), 'a refused secret never reaches the journal');
    assert.match(e.text, /^NC-1: 1 decyzja, 0 akcji; WALL: posted nc-1, agentctl-1; 4 not posted: /);
    // Each published post is a WALL event of its channel (subject only, never the body).
    const wall = readJournal(f.config, -1).filter((x) => x.kind === 'wall');
    assert.deepEqual(wall.map((x) => x.wall?.id), ['nc-1', 'agentctl-1']);
    assert.ok(!JSON.stringify(wall).includes('120 m'));
  });

  it('is published once per attempt: again, and after a crash before the event, nothing is posted twice', async () => {
    const f = fixture('once', GOOD_AND_BAD);
    await journalOutputs(f.ctx, f.record);
    await journalOutputs(f.ctx, f.record);
    assert.equal(channelMessages(f.config, 'nc').length, 1);
    assert.equal(f.event().length, 1);
    // A process that died after posting and before writing the event: the event and the seen-mark are gone, the posts are not.
    fs.writeFileSync(journalPath(f.config), fs.readFileSync(journalPath(f.config), 'utf8').split('\n').filter((l) => !l.includes('"report-outputs"')).join('\n'));
    fs.rmSync(path.join(f.config.stateDir, f.record.window, 'outputs-seen.json'));
    await journalOutputs(f.ctx, f.record);
    assert.deepEqual(channelMessages(f.config, 'nc').map((m) => m.id), ['nc-1'], 'the origin finds the published post');
    assert.deepEqual(channelMessages(f.config, 'agentctl').map((m) => m.id), ['agentctl-1']);
    assert.deepEqual(f.event()[0]?.wallPosts?.posted, ['nc-1', 'agentctl-1']);
    assert.equal(readJournal(f.config, -1).filter((x) => x.kind === 'wall').length, 2, 'no second WALL event for the same post');
  });

  it('get_report publishes them when no watcher did (the report is read)', async () => {
    const f = fixture('get-report', '  - {channel: nc, kind: info, subject: "read by the chat", body: "ok"}');
    assert.equal(channelMessages(f.config, 'nc').length, 0);
    const r = await f.call('get_report', { task: 'NC-1' });
    assert.equal(r.isError, undefined, r.text);
    assert.equal(findMessage(f.config, 'nc-1').from, 'task:NC-1');
    assert.deepEqual(f.event()[0]?.wallPosts, { posted: ['nc-1'], findings: [] });
  });

  it('a malformed wall_posts is one finding; a report without it posts nothing and the event text is unchanged', async () => {
    const f = fixture('malformed', '  channel: nc');
    await journalOutputs(f.ctx, f.record);
    assert.deepEqual(f.event()[0]?.wallPosts, { posted: [], findings: ['wall_posts: expected a list of {channel, kind, subject, body, refs}'] });
    const h = fixture('entries', '  - {channel: weather, kind: info, subject: "nowhere", body: "x"}\n  - {channel: nc, kind: info, subject: "x", to: owner}\n  - "just text"');
    await journalOutputs(h.ctx, h.record);
    assert.deepEqual(h.event()[0]?.wallPosts?.findings.map((x) => x.replace(/ \(Channels:.*$/, '')), ['wall_posts[0] (weather): no WALL channel "weather"', 'wall_posts[1] (nc): unknown field to (allowed: channel, kind, subject, body, refs)', 'wall_posts[2]: expected a mapping {channel, kind, subject, body, refs}']);
    const g = fixture('none', '  []');
    await journalOutputs(g.ctx, g.record);
    assert.equal(g.event()[0]?.wallPosts, undefined);
    assert.equal(g.event()[0]?.text, 'NC-1: 1 decyzja, 0 akcji');
  });
});
