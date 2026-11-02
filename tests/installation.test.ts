import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { installation, packageRoot } from '../src/core/installation.ts';
import { stableScript, pointsAtStable } from '../src/core/mcp-install.ts';
import { versionOf, parsePs } from '../src/core/mcp-processes.ts';
import { useScratch } from './helpers.ts';
const scratch = useScratch();

it('finds metadata through the compiled directory and distinguishes a linked clone from a shadowing command', () => {
  const root = scratch.sub('clone');
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, 'dist/bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ bin: { agentctl: 'dist/bin/agentctl.js' } }));
  const executable = path.join(root, 'dist/bin/agentctl.js');
  fs.writeFileSync(executable, '#!/usr/bin/env node\n');
  fs.chmodSync(executable, 0o755);
  assert.equal(packageRoot(path.dirname(executable)), root);
  const linked = scratch.sub('linked');
  fs.symlinkSync(executable, path.join(linked, 'agentctl'));
  assert.equal(installation(root, { PATH: linked }).source, 'npm link klonu');
  assert.equal(installation(root, { PATH: linked }).matches, true);
  const shadow = scratch.sub('shadow');
  fs.writeFileSync(path.join(shadow, 'agentctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const result = installation(root, { PATH: `${shadow}:${linked}` });
  assert.equal(result.matches, false);
  assert.equal(result.found, path.join(shadow, 'agentctl'));
  assert.equal(result.source, 'repo dev');
  fs.rmSync(path.join(root, '.git'), { recursive: true });
  assert.equal(installation(root, { PATH: linked }).source, 'npm global');
});

it('uses the built executable for a stable clone and reads the installed MCP version', () => {
  const root = scratch.sub('stable');
  fs.mkdirSync(path.join(root, 'dist/bin'), { recursive: true });
  const script = path.join(root, 'dist/bin/agentctl.js');
  fs.writeFileSync(script, '#!/usr/bin/env node\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.16.0' }));
  const env = { AGENTCTL_STABLE_DIR: root };
  assert.equal(stableScript(env), script);
  assert.equal(pointsAtStable({ args: [script, 'mcp'] }, env), true);
  assert.equal(versionOf(script), '0.16.0');
  assert.equal(parsePs(`123 Mon Nov  2 13:00:00 2026 /usr/bin/node ${script} mcp`).length, 1);
});
