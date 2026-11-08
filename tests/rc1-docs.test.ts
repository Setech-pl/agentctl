import assert from 'node:assert/strict';
import fs from 'node:fs';
import { it } from 'node:test';

it('R2 N6: the 0.18.2 release documents the integrated opt-ins and harness/config fixes', () => {
  const changelog = fs.readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  assert.equal(changelog.split('## [Unreleased]').length, 2, 'one Unreleased section');
  // These items shipped in 0.18.2; the section that documents them stays pinned so they are never dropped in a consolidation.
  const section = changelog.split('## [0.18.2]')[1]!.split('\n## [')[0]!;
  assert.match(section, /Claude.*`\/usage`.*opt-in/);
  assert.match(section, /`dataset export`/);
  assert.match(section, /P29:.*explicit.*`AGENTCTL_LIVE_CACHE`/);
  assert.match(section, /P30:.*config reload.*receipt/);
});

it('R2 N7: the Polish follow-up summary requires exact hook/wire or transcript proof', () => {
  const guide = fs.readFileSync(new URL('../docs/dispatcher.pl.md', import.meta.url), 'utf8');
  const summary = guide.split('\n\n').find(p => p.startsWith('`send` od razu'))!;
  assert.ok(summary);
  assert.match(summary, /Potwierdzenie follow-upu wymaga aktualnego dowodu hook\/wire albo dokładnego wpisu użytkownika w transkrypcie/);
  assert.match(summary, /Nowy stan pracy, echo ekranu, kolejka ani nowy kompletny raport nie potwierdzają follow-upu/);
});
