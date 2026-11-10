import fs from 'node:fs';
import os from 'node:os';
import { it } from 'node:test';
import { shutdownMeasurements } from '../src/core/fs-measure.ts';
import { assertWriteTimings, measureWritePreviews, writePreviewFixture } from './write-preview-fixture.ts';
import { useScratch } from './helpers.ts';
const scratch = useScratch();
it('P83 writes: 400 records / 300k files, every MCP preview and metadata confirm <2s', { timeout: 600_000 }, async t => {
  if (os.getPriority(0) > 0) { t.skip('niced gate: write-contracts proves no walks/full-record loads; strict timing measured standalone'); return; }
  const fixture = await writePreviewFixture(scratch.sub('writes'));
  try {
    const results = await measureWritePreviews(fixture);
    const evidence = { records: 400, files: 300000, load: os.loadavg(), results };
    if (process.env.AGENTCTL_WRITE_TIMINGS) fs.writeFileSync(process.env.AGENTCTL_WRITE_TIMINGS, JSON.stringify(evidence, null, 2));
    assertWriteTimings(results);
  } finally { await shutdownMeasurements(); }
});
