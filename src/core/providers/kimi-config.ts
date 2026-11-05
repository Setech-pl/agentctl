import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import type { GlobalConfig, Effort } from '../config.ts';
import { isObject, resolvePath } from '../util.ts';

export interface KimiModel { id: string; displayName: string; efforts: Effort[] }
export interface KimiConfig {
  file: string;
  mode: string;
  guard: boolean;
  rules: { decision: string; pattern: string; scope: string; reason: string }[];
  models: KimiModel[];
  defaultModel?: string;
  error?: string;
}
export const kimiHome = (env: Record<string, string | undefined> = process.env): string => resolvePath(env.KIMI_CODE_HOME ?? path.join(os.homedir(), '.kimi-code'));

/** Agent home wins; usage.kimi_dir remains a legacy explicit config fallback. */
export function resolvedKimiHome(config: Pick<GlobalConfig, 'usage'> & Partial<Pick<GlobalConfig, 'agents'>>, env: Record<string, string | undefined> = process.env): string {
  return kimiHome({ ...env, KIMI_CODE_HOME: config.agents?.kimi?.env?.KIMI_CODE_HOME ?? config.usage.kimiDir ?? env.KIMI_CODE_HOME });
}

export function kimiEnvironmentProblem(env: Record<string, string | undefined>): string | undefined {
  if (env.KIMI_CODE_TRUST_WORKSPACE !== undefined) return 'KIMI_CODE_TRUST_WORKSPACE is forbidden; trust must be manual';
  if (/^(false|0|off|no)$/i.test(env.KIMI_CODE_DANGEROUS_COMMAND_GUARD ?? '')) return 'KIMI_CODE_DANGEROUS_COMMAND_GUARD=false is forbidden';
  return kimiConfigProblem(readKimiConfig(env));
}

/** Read config.toml only. Never open credentials, OAuth, device IDs or write this file. */
export function readKimiConfig(env: Record<string, string | undefined> = process.env): KimiConfig {
  const file = path.join(kimiHome(env), 'config.toml');
  const result: KimiConfig = { file, mode: 'manual', guard: true, rules: [], models: [] };
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') result.error = 'cannot read Kimi config.toml'; return result; }
  let data: Record<string, unknown>;
  try { data = parse(text) as Record<string, unknown>; }
  catch { result.error = 'invalid TOML in Kimi config.toml; permissions and models were not interpreted'; return result; }
  if (typeof data.default_permission_mode === 'string') result.mode = data.default_permission_mode;
  if (typeof data.default_model === 'string') result.defaultModel = data.default_model;
  if (isObject(data.permission)) {
    result.guard = data.permission.dangerous_command_guard !== false;
    if (Array.isArray(data.permission.rules)) for (const rule of data.permission.rules) {
      if (!isObject(rule) || !['allow', 'deny', 'ask'].includes(String(rule.decision)) || typeof rule.pattern !== 'string') continue;
      result.rules.push({ decision: String(rule.decision), pattern: rule.pattern, scope: typeof rule.scope === 'string' ? rule.scope : 'user', reason: typeof rule.reason === 'string' ? rule.reason : '' });
    }
  }
  // Configured catalogs may be top-level or nested under a provider. Aliases are server-managed.
  const collect = (value: unknown, prefix = '') => {
    if (!isObject(value)) return;
    for (const [key, model] of Object.entries(value)) if (isObject(model)) {
      const efforts = Array.isArray(model.support_efforts) ? model.support_efforts.filter((e): e is Effort => ['low', 'high', 'max'].includes(String(e))) : [];
      result.models.push({ id: key.includes('/') ? key : `${prefix}${key}`, displayName: typeof model.display_name === 'string' ? model.display_name : key, efforts });
    }
  };
  collect(data.models, 'kimi-code/');
  if (isObject(data.providers)) for (const [id, entry] of Object.entries(data.providers)) if (isObject(entry)) collect(entry.models, `${id}/`);
  return result;
}
export const qualifiedModel = (model: string): string => model.includes('/') ? model : `kimi-code/${model}`;
export function configuredModel(config: KimiConfig, name: string): KimiModel | undefined {
  const id = name === 'default' ? config.defaultModel : name;
  return id ? config.models.find(m => m.id === qualifiedModel(id)) : undefined;
}
export function kimiConfigProblem(config: KimiConfig): string | undefined {
  if (config.error) return config.error;
  if (config.mode === 'auto') return `default_permission_mode=auto in ${config.file} enables Never Ask; use manual or yolo with dangerous_command_guard=true (agentctl never edits Kimi config)`;
  if (!['manual', 'yolo'].includes(config.mode)) return `unknown default_permission_mode=${config.mode}; cannot verify permissions`;
  if (!config.guard) return `permission.dangerous_command_guard=false in ${config.file} is forbidden`;
  return undefined;
}
