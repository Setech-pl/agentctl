import assert from 'node:assert/strict';
import fs from 'node:fs';
import { it } from 'node:test';

it('R2 N6: the current release documents the integrated opt-ins and harness/config fixes', () => {
  const changelog = fs.readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(changelog.split('## [Unreleased]').length, 2, 'one Unreleased section');
  const unreleased = changelog.split(`## [${version}]`)[1]!.split('\n## [')[0]!;
  assert.match(unreleased, /Claude.*`\/usage`.*opt-in/);
  assert.match(unreleased, /`dataset export`/);
  assert.match(unreleased, /P29:.*explicit.*`AGENTCTL_LIVE_CACHE`/);
  assert.match(unreleased, /P30:.*config reload.*receipt/);
});

it('R2 N7: the Polish follow-up summary requires exact hook/wire or transcript proof', () => {
  const guide = fs.readFileSync(new URL('../docs/dispatcher.pl.md', import.meta.url), 'utf8');
  const summary = guide.split('\n\n').find(p => p.startsWith('`send` od razu'))!;
  assert.ok(summary);
  assert.match(summary, /Potwierdzenie follow-upu wymaga aktualnego dowodu hook\/wire albo dokładnego wpisu użytkownika w transkrypcie/);
  assert.match(summary, /Nowy stan pracy, echo ekranu, kolejka ani nowy kompletny raport nie potwierdzają follow-upu/);
});
