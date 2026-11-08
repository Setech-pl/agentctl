import assert from 'node:assert/strict';
import { it } from 'node:test';
import { limitsDiffText } from '../src/core/limits.ts';
it('P51: limit events include optional configured providers', () => {
  assert.equal(limitsDiffText({ claude: 1, codex: 2, kimi: 1 } as never, { claude: 1, codex: 2, kimi: 'off' } as never), 'limity: kimi 1 → off; providers: claude=1, codex=2, kimi=off');
});
