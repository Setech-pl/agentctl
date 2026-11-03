import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import YAML from 'yaml';
import { REPO_ROOT, useScratch } from './helpers.ts';
const scratch = useScratch();

describe('0.17 OIDC publishing prerequisites', () => {
  it('workflow accepts a matching stable version with OIDC and uses the configured repository identity', () => {
    const workflow = YAML.parse(fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/publish.yml'), 'utf8'));
    assert.equal(workflow.permissions['id-token'], 'write');
    assert.deepEqual(workflow.on.release.types, ['published']);
    assert.equal(workflow.jobs.publish.if, "github.repository == 'Setech-pl/agentctl'");
    const steps = workflow.jobs.publish.steps;
    assert.ok(steps.some((s: { run?: string }) => s.run === 'npm publish --provenance --access public'));
    const guard = steps.find((s: { env?: { RELEASE_TAG?: string } }) => s.env?.RELEASE_TAG).run.split('\n')[0];
    for (const [tag, expected] of [['v0.17.2', 0], ['v0.16.0', 1], ['0.17.2', 1]] as const) {
      const r = spawnSync('/bin/sh', ['-c', guard], { cwd: REPO_ROOT, env: { ...process.env, RELEASE_TAG: tag }, encoding: 'utf8' });
      assert.equal(r.status, expected, tag);
    }
  });
  for (const mode of ['absent', 'present', 'unavailable'] as const) it(`registry ${mode}: publish decision is explicit and bootstrap 0.17 is never republished`, () => {
    const dir = scratch.sub(mode); const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    fs.writeFileSync(path.join(bin, 'npm'), mode === 'present' ? '#!/bin/sh\necho \'"0.17.2"\'\n' : `#!/bin/sh\necho '${mode === 'absent' ? 'E404 not found' : 'E503 unavailable'}' >&2\nexit 1\n`, { mode: 0o755 });
    const output = path.join(dir, 'output');
    const result = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts/release-version.mjs')], { cwd: REPO_ROOT, env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, GITHUB_OUTPUT: output }, encoding: 'utf8' });
    assert.equal(result.status, mode === 'unavailable' ? 1 : 0);
    if (mode !== 'unavailable') assert.equal(fs.readFileSync(output, 'utf8'), `publish=${mode === 'absent'}\n`);
    else assert.equal(fs.existsSync(output), false);
  });
});
