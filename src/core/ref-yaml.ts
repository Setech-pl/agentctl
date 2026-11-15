import YAML from 'yaml';

/** Git identifiers are text even when YAML's core numeric resolver recognises an exponent or an integer. */
export function parseRefYaml(source: string): unknown {
  const doc = YAML.parseDocument(source);
  if (doc.errors.length) throw doc.errors[0];
  YAML.visit(doc, { Pair(_key, pair) {
    if (YAML.isScalar(pair.key) && ['base', 'branch', 'sha'].includes(String(pair.key.value)) && YAML.isScalar(pair.value) && typeof pair.value.value === 'number') {
      if (!pair.value.source) throw new Error('Cannot recover git identifier; quote the SHA');
      pair.value.value = pair.value.source;
    }
  } });
  return doc.toJS({maxAliasCount: 50});
}
