import fs from 'node:fs';
import path from 'node:path';
import { kimiProbeDir } from './kimi-probe.ts';
import { readKimiSnapshot } from './kimi-usage.ts';
import type { ProviderAdapter, DoctorLine } from './types.ts';
import { kimiSettings } from './kimi-settings.ts';
import { configuredModel, kimiConfigProblem, kimiEnvironmentProblem, resolvedKimiHome, qualifiedModel, readKimiConfig } from './kimi-config.ts';
import { kimiEvents } from './kimi-events.ts';
import { kimiUsage } from './kimi-usage.ts';
import { interactiveTokens } from './process.ts';

export const kimi: ProviderAdapter = {
  id: 'kimi', displayName: 'Kimi', boardLabel: 'ki', letter: 'K', command: 'kimi',
  processCommands: { launcher: /^(?:node|nodejs)$/, args: /(?:^|[\s/])kimi(?:\s|$)|(?:^|[\s/])node(?:js)?\s+\S*\/kimi-code\/dist\/main\.mjs(?:\s|$)/, pane: /^(?:\S*\/)?kimi(?:\s|$)|^(?:\S*\/)?node(?:js)?\s+\S*\/kimi-code\/dist\/main\.mjs(?:\s|$)/ },
  installHint: 'Install Kimi Code CLI: npm i -g @moonshot-ai/kimi-code@2.5.0.',
  capabilities: { remoteControl: false, statusLineTap: false, mcpInstall: false, busyPrompt: false },
  defaultSettings: kimiSettings,
  async detect(runner) {
    const version = await runner.exec('kimi', ['--version'], { readOnly: true });
    return { found: version.code === 0, version: /\d+\.\d+\.\d+/.exec(version.stdout)?.[0] ?? null, raw: version.stdout.trim().split('\n')[0] ?? '', features: {} };
  },
  doctor(detection, env, globalConfig) {
    const lines: DoctorLine[] = [{ name: 'kimi', level: detection.found ? 'ok' : 'warn', text: detection.found ? detection.raw : `not found. ${this.installHint}` }];
    if (detection.version && detection.version.localeCompare('2.5.0', undefined, { numeric: true }) > 0) lines.push({ name: 'kimi version', level: 'warn', text: `${detection.version} is newer than tested 2.5.0` });
    env = { ...env, ...globalConfig?.agents.kimi?.env };
    if (globalConfig) env.KIMI_CODE_HOME = resolvedKimiHome(globalConfig, env);
    const config = readKimiConfig(env), problem = kimiConfigProblem(config);
    lines.push({ name: 'kimi home', level: 'ok', text: path.dirname(config.file) });
    lines.push({ name: 'kimi permissions', level: problem ? 'fail' : 'ok', text: problem ?? `default_permission_mode=${config.mode}; dangerous_command_guard=${config.guard}; rules=${JSON.stringify(config.rules)}` });
    if (!config.guard || /^(false|0|off|no)$/i.test(env.KIMI_CODE_DANGEROUS_COMMAND_GUARD ?? '')) lines.push({ name: 'kimi guard', level: 'warn', text: 'dangerous_command_guard is disabled; it is a separate AST guard, not an allow-list' });
    if (env.KIMI_CODE_TRUST_WORKSPACE !== undefined) lines.push({ name: 'kimi trust', level: 'fail', text: 'KIMI_CODE_TRUST_WORKSPACE bypass is forbidden; trust must be manual' });
    lines.push({ name: 'kimi protocol', level: 'warn', text: 'wire protocol 1.5; session paths/interactions are hypotheses; unknown protocol uses screen only' });
    lines.push({ name: 'kimi models', level: 'ok', text: `Aliases are server-managed/dynamic: ${config.models.map(m => `${m.id}: ${m.displayName} [${m.efforts.join(',')}]`).join('; ') || 'catalog not available; effort will not be forced'}` });
    if (globalConfig) {
      if (globalConfig.capacity.kimiUsageProbe && !readKimiSnapshot(globalConfig)) lines.push({ name: 'kimi usage probe', level: 'warn', text: `No reading yet. Neutral folder needs manual trust: run kimi in ${kimiProbeDir(globalConfig)}; never /usage in task windows` });
      try {
        for (const window of fs.readdirSync(globalConfig.stateDir)) {
          try { const status = JSON.parse(fs.readFileSync(path.join(globalConfig.stateDir, window, 'kimi-wire-status.json'), 'utf8')); if (!status.supported) lines.push({ name: 'kimi wire', level: 'warn', text: `${window}: unknown wire protocol ${String(status.protocol)}; screen only` }); } catch { /* no passive wire diagnostic */ }
        }
      } catch { /* no tasks */ }
    }
    return lines;
  },
  argv(order, settings, extra) { return ['kimi', ...(order.model === 'default' ? [] : ['-m', qualifiedModel(order.model)]), ...settings.effortArgs.map(a => a.replaceAll('{effort}', order.effort)), ...settings.flags, ...extra]; },
  launchEnv(order, settings, env) {
    const config = readKimiConfig({ ...process.env, ...env }), model = configuredModel(config, order.model);
    return { KIMI_CODE_NO_AUTO_UPDATE: '1', KIMI_DISABLE_TELEMETRY: settings.env?.KIMI_DISABLE_TELEMETRY ?? '1', AGENTCTL_TASK: order.task, ...(model?.efforts.includes(order.effort) ? { KIMI_MODEL_THINKING_EFFORT: order.effort } : {}) };
  },
  // -m + --session has not been verified on 2.5.0; preserve the conversation's model.
  resumeArgv(_order, settings, extra, sessionId) { return ['kimi', ...(sessionId ? ['--session', sessionId] : ['--continue']), ...settings.flags, ...extra]; },
  resumeLabel: id => id ? `--session ${id}` : '--continue (kimi)',
  effort: { accepted: ['low', 'high', 'max'], mode: 'thinking', args: () => [] },
  screen: {
    echoMarker: '❯', stablePaste: true,
    draft(screen) { const line = screen.split('\n').filter(l => /^\s*│\s*>/.test(l)).at(-1); return line?.replace(/^\s*│\s*>\s*/, '').replace(/\s*│\s*$/, '').trim() || null; },
    question(screen) { return screen.split('\n').map(l => l.trim()).find(l => /^\?\s|Run this command\?|Ready to submit your answers\?/.test(l)); },
  },
  events: kimiEvents,
  usage: kimiUsage,
  models: {
    equivalents: { light: ['k3/low'], medium: ['k3/high'], strong: ['k3.1-pro/high', 'k3.1-pro/max', 'kimi-for-coding/max'] },
    label(model, effort, observed, versions) {
      const name = observed && observed !== 'unknown' ? observed : model ?? '';
      const configured = configuredModel(readKimiConfig(), name);
      const version = versions?.[model ?? ''] ?? /(?:^|\b)k(?:imi[- ]?)?(\d+(?:\.\d+)?)/i.exec(configured?.displayName ?? name)?.[1] ?? '';
      const support = configured?.efforts;
      const level = support && !support.length ? 'ON' : ({ low: 'LO', high: 'HI', max: 'MX' }[effort ?? ''] ?? (effort === 'unknown' ? '?' : 'ON'));
      return `K${version ? ` ${version}` : ''} ${level}`;
    },
  },
  safety: {
    forbiddenFlags: ['-y', '--yolo', '--yes', '--auto-approve', '--auto', '-p', '--prompt'],
    check: () => undefined,
    validate(order, _settings, env) {
      const problem = kimiEnvironmentProblem(env);
      if (problem) return problem;
      const config = readKimiConfig(env);
      const model = configuredModel(config, order.model);
      if (model?.efforts.length && !model.efforts.includes(order.effort)) return `${model.id} does not support effort ${order.effort}; use ${model.efforts.join(', ')}`;
      return undefined;
    },
  },
  isExternalSession(tokens) {
    const command = path.basename(tokens[0] ?? '');
    return (command === 'kimi' || (/^node(js)?$/.test(command) && /@moonshot-ai\/kimi-code\/dist\/main\.mjs$/.test(tokens[1] ?? ''))) && interactiveTokens(tokens) && !tokens.some(t => /^(-p|--prompt|--version|--help)(=|$)/.test(t));
  },
};
