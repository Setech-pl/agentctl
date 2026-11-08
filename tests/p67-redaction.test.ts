import assert from 'node:assert/strict';
import { it } from 'node:test';
import { secretRedactor } from '../src/core/secret-redaction.ts';
it('P67: short credentials do not replace substrings in UI text or task ids', () => {
  const clean = secretRedactor([{ API_KEY: 'no', TOKEN: 'con', PASSWORD: 'FACADE-S34-REVIEW' }], new Set(['FACADE-S34-REVIEW']));
  const text = 'Uruchomiono dostarczono economy FACADE-S34-REVIEW';
  assert.equal(clean(text), text);
  assert.equal(clean('API_KEY=no TOKEN=con'), 'API_KEY=*** TOKEN=***');
  assert.equal(clean({ API_KEY: 'no' }).API_KEY, '***');
});
it('P67: long secrets are replaced only as complete values and secret field names are recognised', () => {
  const clean = secretRedactor([{ API_TOKEN: 'private-credential', monkey: 'economy', bypass: 'no' }]);
  assert.equal(clean('private-credential economy Uruchomiono'), '*** economy Uruchomiono');
  assert.equal(clean('prefixprivate-credentialsuffix'), 'prefixprivate-credentialsuffix');
  assert.deepEqual(clean({ monkey: 'economy', bypass: 'no' }), { monkey: 'economy', bypass: 'no' });
});
