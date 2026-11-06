import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
for (const file of ['README.md', 'README.pl.md']) test(`${file}: dedicated dev server and migration instructions are runnable`, () => {
  const text = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const section = /<!-- tmux-dev-start -->([\s\S]*?)<!-- tmux-dev-end -->/.exec(text)?.[1];
  assert.ok(section, 'dedicated dev server section');
  assert.match(section, /tmux:\s*\n\s+socket: agentctl-dev/);
  assert.match(section, /tmux -L agentctl-dev attach -t '=agentctl-dev'/);
  assert.match(section, /tmux kill-session -t '=agentctl-dev'/);
  assert.match(section, /AGENTCTL_HOME/);
  assert.match(section, /resume/);
  assert.match(section, /new --reuse/);
  for (const block of section.matchAll(/```sh\n([\s\S]*?)```/g)) {
    assert.doesNotMatch(block[1]!, /#|<[^>]+>/);
    assert.doesNotMatch(block[1]!, /kill-server/);
  }
});
