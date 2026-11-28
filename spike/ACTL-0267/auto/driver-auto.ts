// ACTL-0267 spike: observation record and the `driver: auto` rule. Pure functions; the store is a JSONL file per host in a real build.
export type Driver = 'screen' | 'headless' | 'protocol';
export type TaskClass = 'interactive' | 'review' | 'report' | 'simple' | 'gate';

/** One finished task (or one probe), written at task end. Never updated mid-task. */
export interface Observation {
  provider: string;            // claude | codex | kimi | glm
  version: string;             // CLI version from --version / initialize
  host: string;                // e.g. "darwin-arm64", "wsl2-x64", "linux-x64"
  driver: Driver;
  protocol?: string;           // "codex-app-server@0.167.0", "acp@1/claude-agent-acp@0.113.0"
  cls: TaskClass;
  at: number;                  // ms epoch, task end
  outcome: 'report' | 'done' | 'failed' | 'driver-error';
  readyMs?: number;            // spawn → accepted first prompt (ack by hook/protocol, not by screen guess)
  deliveryAcked: boolean;      // first prompt confirmed by hook/transcript/protocol
  lostPrompt: boolean;         // a prompt was neither acked nor visible (incident)
  stuckMin?: number;           // minutes in a state the driver misreported (owner had to intervene)
  interventions: number;       // manual answers/peeks/sends needed beyond the spec
  unknownEvents: number;       // protocol frames/records the parser did not know (schema drift signal)
  pollMs?: number;             // status collection cost for this task (median per poll)
}

export interface Pin { driver: Driver; version?: string /* glob: "0.167.*" */ }
export interface AutoConfig { minN: number; window: number; margin: number; fallbackMargin: number; maxDriverErrorRate: number; cooldownMs: number; pin?: Pin; allowed: Driver[] }
export const DEFAULTS: AutoConfig = { minN: 20, window: 40, margin: 0.05, fallbackMargin: 0.10, maxDriverErrorRate: 0.02, cooldownMs: 24 * 3600_000, allowed: ['screen', 'protocol'] };

export interface Decision { driver: Driver; reason: string }
export interface Prior { driver: Driver; since: number }

const glob = (pattern: string, v: string) => new RegExp('^' + pattern.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(v);
const minorOf = (v: string) => v.split('.').slice(0, 2).join('.');

interface Score { n: number; success: number; driverErrors: number; incidents: number; interventions: number }
function score(obs: Observation[]): Score {
  const n = obs.length;
  const ok = obs.filter(o => o.outcome === 'report' || o.outcome === 'done').length;
  return { n, success: n ? ok / n : 0, driverErrors: n ? obs.filter(o => o.outcome === 'driver-error').length / n : 0, incidents: obs.filter(o => o.lostPrompt || (o.stuckMin ?? 0) >= 10).length, interventions: n ? obs.reduce((a, o) => a + o.interventions, 0) / n : 0 };
}

/**
 * The driver for a NEW task of (provider, version, host, class). Called once at task start; the result is stored in the task record and
 * reused by resume/answer/close, so a task never changes driver mid-flight.
 *  - pin wins (version glob must match);
 *  - observations of the same provider+host+minor version count (a patch bump keeps history; a minor bump starts over);
 *  - a candidate replaces the incumbent only with ≥ minN observations of its own, driver-error rate ≤ max, no incidents in the window,
 *    and success ≥ incumbent + margin (or equal success with ≥ 30 % fewer interventions);
 *  - the incumbent falls back to screen when its success drops below screen − fallbackMargin or ≥ 2 incidents in the window (hysteresis:
 *    fallback needs a bigger gap than promotion);
 *  - no switch within cooldown of the previous switch, except fail-closed fallbacks.
 */
export function decide(all: Observation[], key: { provider: string; version: string; host: string; cls: TaskClass }, prior: Prior | undefined, now: number, cfg: AutoConfig = DEFAULTS): Decision {
  if (cfg.pin && (!cfg.pin.version || glob(cfg.pin.version, key.version))) return { driver: cfg.pin.driver, reason: `pinned ${cfg.pin.driver}${cfg.pin.version ? ` for ${cfg.pin.version}` : ''}` };
  const incumbent: Driver = prior?.driver ?? 'screen';
  const mine = all.filter(o => o.provider === key.provider && o.host === key.host && minorOf(o.version) === minorOf(key.version) && (key.cls === 'interactive' ? o.cls === 'interactive' : o.cls !== 'interactive'));
  const byDriver = (d: Driver) => mine.filter(o => o.driver === d).sort((a, b) => b.at - a.at).slice(0, cfg.window);
  const inc = score(byDriver(incumbent));
  // fail closed: the incumbent non-screen driver is unhealthy → screen now, cooldown or not
  if (incumbent !== 'screen') {
    const scr = score(byDriver('screen'));
    if (inc.incidents >= 2) return { driver: 'screen', reason: `fallback: ${inc.incidents} incidents in last ${inc.n} ${incumbent} tasks` };
    if (inc.n >= 5 && inc.driverErrors > cfg.maxDriverErrorRate * 2) return { driver: 'screen', reason: `fallback: driver errors ${(inc.driverErrors * 100).toFixed(0)}%` };
    if (scr.n >= cfg.minN && inc.n >= cfg.minN && inc.success < scr.success - cfg.fallbackMargin) return { driver: 'screen', reason: `fallback: success ${(inc.success * 100).toFixed(0)}% < screen ${(scr.success * 100).toFixed(0)}% − ${cfg.fallbackMargin * 100}pp` };
  }
  if (prior && now - prior.since < cfg.cooldownMs) return { driver: incumbent, reason: 'cooldown since last switch' };
  let best: Decision = { driver: incumbent, reason: inc.n < cfg.minN ? `keep ${incumbent}: N=${inc.n}` : `keep ${incumbent}` };
  for (const cand of cfg.allowed.filter(d => d !== incumbent && !(d === 'headless' && key.cls === 'interactive'))) {
    const c = score(byDriver(cand));
    if (c.n < cfg.minN) continue;
    if (c.driverErrors > cfg.maxDriverErrorRate || c.incidents > 0) continue;
    const better = c.success >= inc.success + cfg.margin || (Math.abs(c.success - inc.success) < 1e-9 && c.interventions <= inc.interventions * 0.7);
    if (better && inc.n >= cfg.minN) best = { driver: cand, reason: `promote ${cand}: success ${(c.success * 100).toFixed(0)}% vs ${(inc.success * 100).toFixed(0)}% (N=${c.n}/${inc.n})` };
  }
  return best;
}

/** How a candidate gets its first N observations without risking the owner's work: a share of low-risk classes only. */
export function exploreShare(cls: TaskClass, candidateN: number, cfg: AutoConfig = DEFAULTS): number {
  if (cls === 'interactive') return candidateN < cfg.minN ? 0.1 : 0;
  return candidateN < cfg.minN ? 0.3 : 0;
}
