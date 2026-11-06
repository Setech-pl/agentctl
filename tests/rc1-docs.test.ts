import assert from 'node:assert/strict';
import fs from 'node:fs';
import { it } from 'node:test';

it('R2 N6: Unreleased documents the integrated opt-ins and harness/config fixes', () => {
  const changelog = fs.readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  const unreleased = changelog.split('## [Unreleased]')[1]!.split('\n## [')[0]!;
  assert.match(unreleased, /Claude.*`\/usage`.*opt-in/);
  assert.match(unreleased, /`dataset export`/);
  assert.match(unreleased, /P29:.*explicit.*`AGENTCTL_LIVE_CACHE`/);
  assert.match(unreleased, /P30:.*config reload.*receipt/);
});
