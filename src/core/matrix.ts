import { EFFORTS } from './config.ts';
import type { Effort } from './config.ts';
import type { ModelClass, ProviderId } from './providers/types.ts';
import { PROVIDER_IDS } from './providers/types.ts';
import { GENERATED_MODEL_MATRIX } from './model-matrix.ts';
import { AgentctlError, isObject } from './util.ts';

/*
 * The model matrix (task class -> per-provider model/effort) is data/model-matrix.yaml; the shipped constant is
 * the generated src/core/model-matrix.ts (npm run gen:matrix). Everything here derives from it, so the spec key
 * `class:` and the default equivalents table can never disagree. tests/model-matrix.test.ts guards the sync.
 */

export interface MatrixCell {
  model: string;
  effort: Effort;
}

export interface MatrixClass {
  name: string;
  /** Explicit-only classes dispatch restricted models (k3.1-pro*, gpt-6-astra): naming the class in a spec IS the explicit request. */
  explicit: boolean;
  /** A provider absent from `cells` has no model for the class (`none` in the YAML). */
  cells: Partial<Record<ProviderId, MatrixCell>>;
}

/** Validate the parsed YAML (or the generated constant): providers, "model/effort" cells, `none`, `explicit`. */
export function parseModelMatrix(data: unknown, where = 'model matrix'): MatrixClass[] {
  const problem = (text: string): never => {
    throw new AgentctlError(`${where}: ${text}`);
  };
  if (!isObject(data) || !isObject(data.classes)) problem('expected {version: 1, classes: {<name>: {claude|codex|kimi: "model/effort"|none, explicit?: true}}}');
  const rawClasses = (data as Record<string, unknown>).classes as Record<string, unknown>;
  const classes: MatrixClass[] = [];
  for (const [name, entry] of Object.entries(rawClasses)) {
    const at = `${where} class "${name}"`;
    if (!/^[a-z][a-z0-9-]*$/.test(name)) problem(`${at}: class names are lowercase letters, digits and "-"`);
    if (!isObject(entry)) problem(`${at} must be a mapping of provider -> "model/effort"`);
    const raw = entry as Record<string, unknown>;
    const explicit = raw.explicit === undefined ? false : raw.explicit === true ? true : problem(`${at}.explicit must be true when present`);
    const cells: MatrixClass['cells'] = {};
    for (const [key, value] of Object.entries(raw)) {
      if (key === 'explicit') continue;
      if (!(PROVIDER_IDS as readonly string[]).includes(key)) problem(`${at}: unknown provider "${key}" (allowed: ${PROVIDER_IDS.join(', ')})`);
      if (value === 'none') continue;
      if (typeof value !== 'string' || !value.includes('/')) {
        problem(`${at}.${key} must look like "model/effort" (or none)`);
        continue;
      }
      const cut = value.lastIndexOf('/');
      const model = value.slice(0, cut).trim();
      const effort = value.slice(cut + 1).trim();
      if (!model) problem(`${at}.${key}: the model is empty in ${JSON.stringify(value)}`);
      if (!(EFFORTS as readonly string[]).includes(effort)) problem(`${at}.${key}: effort must be one of ${EFFORTS.join(', ')} (got ${JSON.stringify(effort)})`);
      cells[key as ProviderId] = { model, effort: effort as Effort };
    }
    if (Object.keys(cells).length === 0) problem(`${at} needs at least one provider cell`);
    classes.push({ name, explicit, cells });
  }
  if (classes.length === 0) problem('no classes');
  return classes;
}

let cached: MatrixClass[] | undefined;

/** The shipped matrix: the generated constant, validated once. */
export function modelMatrix(): MatrixClass[] {
  return (cached ??= parseModelMatrix(GENERATED_MODEL_MATRIX, 'src/core/model-matrix.ts'));
}

export const classNames = (matrix: MatrixClass[] = modelMatrix()): string[] => matrix.map((c) => c.name);

export const matrixClass = (name: string, matrix: MatrixClass[] = modelMatrix()): MatrixClass | undefined => matrix.find((c) => c.name === name);

/**
 * The descriptive tier of a class (doctor/capacity lists; not a quality guarantee): the codex cell decides —
 * gpt-6-luna is light, a high effort is strong, everything else is medium.
 */
export const tierOf = (cls: MatrixClass): ModelClass => (cls.cells.codex?.model === 'gpt-6-luna' ? 'light' : cls.cells.codex?.effort === 'high' ? 'strong' : 'medium');

/** One built-in equivalents row, as written: provider -> "model/effort", plus the descriptive tier. */
export type EquivalentRow = Partial<Record<ProviderId, string>> & { class: ModelClass };

/**
 * The default equivalents table derived from the matrix: one row per class (first occurrence of each distinct
 * combination wins), skipping explicit-only classes so translation can never land on a restricted model.
 */
export function deriveEquivalentRows(matrix: MatrixClass[] = modelMatrix()): EquivalentRow[] {
  const rows: EquivalentRow[] = [];
  const seen = new Set<string>();
  for (const cls of matrix) {
    if (cls.explicit) continue;
    const row: EquivalentRow = { class: tierOf(cls) };
    for (const id of PROVIDER_IDS) {
      const cell = cls.cells[id];
      if (cell) row[id] = `${cell.model}/${cell.effort}`;
    }
    if (PROVIDER_IDS.filter((id) => row[id] !== undefined).length < 2) continue;
    const key = PROVIDER_IDS.map((id) => row[id] ?? '').join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  return rows;
}

/** The provider's model/effort list per descriptive tier (doctor, capacity), derived from the same matrix. */
export function deriveTierModels(provider: ProviderId, matrix: MatrixClass[] = modelMatrix()): Record<ModelClass, string[]> {
  const tiers: Record<ModelClass, string[]> = { light: [], medium: [], strong: [] };
  for (const cls of matrix) {
    if (cls.explicit) continue;
    const cell = cls.cells[provider];
    if (!cell) continue;
    const written = `${cell.model}/${cell.effort}`;
    const tier = tiers[tierOf(cls)];
    if (!tier.includes(written)) tier.push(written);
  }
  return tiers;
}

/** The Kimi model IDs the matrix itself uses: always "known", even when the user's Kimi catalog cannot be read. */
export function matrixKimiModels(matrix: MatrixClass[] = modelMatrix()): string[] {
  return [...new Set(matrix.flatMap((cls) => (cls.cells.kimi ? [cls.cells.kimi.model] : [])))];
}

/**
 * Restricted models: they run only when the spec orders them with an explicit `model:`, or when they come from a
 * class the matrix marks explicit-only (visual, escalate) — never from configured defaults or a translation.
 */
export function explicitOnlyModel(agent: ProviderId, model: string): boolean {
  if (agent === 'kimi') return model.replace(/^kimi-code\//, '').startsWith('k3.1-pro');
  if (agent === 'codex') return model === 'gpt-6-astra';
  return false;
}
