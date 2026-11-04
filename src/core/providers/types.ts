import type { AgentSettings, Effort, GlobalConfig } from '../config.ts';
import type { Context } from '../context.ts';
import type { Runner } from '../runner.ts';
import type { TaskRecord } from '../taskstore.ts';
import type { AgentEvent } from '../events.ts';
import type { PlanState } from '../usage.ts';
import type { SessionStats } from '../usage-parse.ts';
import type { UsageReader } from '../usage-sources.ts';

export const PROVIDER_IDS = ['claude', 'codex'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];      // config.ts: export type AgentName = ProviderId

/** Klasa modelu w tabeli equivalents (opis dla dyspozytora, nie gwarancja jakości). */
export type ModelClass = 'light' | 'medium' | 'strong';

/** To, co spec zamawia; `model: 'default'` = bez flagi modelu. */
export interface LaunchOrder {
  model: string;
  effort: Effort;
  task: string;
  remoteControl?: boolean;
}

export interface ProviderDetection {
  found: boolean;
  /** "2.1.309", "0.166.0", "2.5.0"; null, gdy --version nie dało się odczytać. */
  version: string | null;
  /** Pierwsza linia `--version` (do doctor/log). */
  raw: string;
  /** Cechy odczytane z `--help` (np. effortFlag, remoteControl, appendSystemPromptFile, thinkingFlag). */
  features: Readonly<Record<string, boolean>>;
}

export interface DoctorLine { name: string; level: 'ok' | 'warn' | 'fail'; text: string }

/** Jak dostawca wyraża effort. */
export interface EffortSupport {
  /** Wartości effort przyjmowane w specu (dziś CODEX_EFFORTS w plan.ts); reszta to błąd planu. */
  accepted: readonly Effort[];
  /** 'flag' – natywna flaga (claude --effort); 'config' – nadpisanie configu (codex -c model_reasoning_effort=); 'thinking' – tylko włącz/wyłącz myślenie; 'none' – tylko nagłówek promptu. */
  mode: 'flag' | 'config' | 'thinking' | 'none';
  /** argv dla danego effort przy danych ustawieniach (domyślnie: settings.effortArgs z podstawionym {effort}). */
  args(effort: Effort, settings: AgentSettings): string[];
}

/** Co ekran wymaga poza regexami z AgentSettings. */
export interface ScreenProfile {
  /** Znak, którym transkrypt zaczyna wysłaną linię użytkownika ('❯' Claude, '›' Codex, '❯' Kimi): echo w prompt-delivery. */
  echoMarker: string;
  /** Dodatkowe wyciąganie pytania (Codex: zwinięte „? N questions”); undefined = tylko ogólne extractQuestion. */
  question?(screen: string): string | undefined;
  /** Pytanie z logu sesji (dziś sessionQuestion tylko dla Codexa). */
  sessionQuestion?(config: GlobalConfig, record: TaskRecord): string | undefined;
}

export interface SessionRef { id: string; transcript?: string }
export interface RawEvent { kind?: string; payload: unknown; raw?: string; prompt?: string }

export interface EventWiringInput {
  task: string; window: string; config: GlobalConfig;
  self: string[];                       // stableSelfArgv
  env: Record<string, string>;          // env specu (CODEX_HOME, KIMI_CODE_HOME…)
  worktree?: string;
  readConfig?: (file: string) => string | undefined;
}
export interface EventWiring { args: string[]; files: { path: string; content: string }[]; env?: Record<string, string>; note: string }

/** Źródła zdarzeń, które dostawca sam oferuje. */
export interface EventSupport {
  emits: { turnEnd: boolean; needsInput: boolean; limit: boolean; overload: boolean; promptSubmit: boolean };
  /** Dozwolone `--kind` dla `agentctl event --agent <id>` (Claude: CLAUDE_KINDS; Codex: brak; Kimi: zob. §3). */
  kinds: readonly string[];
  /** Skąd czytać ładunek: 'stdin' (hooki Claude), 'argv' (notify Codexa). */
  payloadFrom: 'stdin' | 'argv' | 'wire';
  plan(input: EventWiringInput): EventWiring;
  parse(e: RawEvent): AgentEvent | undefined;
  /** Sesja nazwana przez zdarzenie (rememberSession). */
  session(e: RawEvent): SessionRef | undefined;
  /** Czy zdarzenie potwierdza dostarczenie promptu (delivery-evidence.json). */
  acknowledgesPrompt?(e: RawEvent): boolean;
}

export interface UsageCandidate { file: string; firstAt: number | null; explicit: boolean }

/** Zużycie i limity. */
export interface UsageSupport {
  /** Katalog domowy dostawcy: config.usage.<id>_dir ?? env[homeEnv] ?? domyślny. */
  home(config: Pick<GlobalConfig, 'usage'>, env?: Record<string, string | undefined>): string;
  /** Zmienna środowiska przenosząca katalog (CLAUDE_CONFIG_DIR, CODEX_HOME, KIMI_CODE_HOME) – także dla tests/isolation.ts i live-harness. */
  homeEnv: string | null;
  /** Logi sesji zadania: najpierw jawnie nazwane sesje (sessions.json), potem po cwd w worktree. */
  sessions(reader: UsageReader, home: string, record: TaskRecord, worktrees: string[], known: SessionRef[], now: number): UsageCandidate[];
  /** Dodatkowe pliki dołączone do kandydata (Claude: subagents/agent-*.jsonl). */
  related?(reader: UsageReader, file: string): string[];
  /** Parser jednej linii logu → SessionStats (tokeny per dzień|model, observed model/effort/cliVersion, id, cwd). */
  feedLine(stats: SessionStats, line: string): void;
  /** Stan planu (okna 5 h / 7 dni, procent, reset, źródło, nota „n/d”). */
  readPlan(config: GlobalConfig, reader: UsageReader, now: number): PlanState;
  /** Ograniczone odświeżenie bez tury modelu (Codex: app-server account/rateLimits/read). Zwraca notę albo null. */
  refreshPlan?(ctx: Context): Promise<string | null>;
  /** Nazwa źródła w capacity (`claude-statusline`, `codex-session-log`, `codex-app-server:…`, `kimi-…`). */
  planSources: readonly string[];
}

export interface ModelCatalog {
  /** Wiersze wbudowanej tabeli equivalents tego dostawcy, wg klasy (model/effort). */
  equivalents: Readonly<Partial<Record<ModelClass, readonly string[]>>>;
  /** Etykieta modelu na boardzie bez prefiksu dostawcy: "S 5.5 HI", "S 6.1 MD", "K 2.7 MD". */
  label(model: string | null | undefined, effort: string | null | undefined, observed?: string | null, versions?: Readonly<Record<string, string>>): string;
}

export interface SafetyRules {
  /** Flagi zakazane zawsze (bez wartości). */
  forbiddenFlags: readonly string[];
  /** Kontrole z wartością (claude --permission-mode bypassPermissions…, codex -a never, -c approval_policy=never, …). */
  check(args: string[]): string | undefined;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly displayName: string;   // 'Claude' | 'Codex' | 'Kimi'
  readonly boardLabel: string;    // 'cl' | 'cx' | 'ki'
  readonly letter: string;        // 'C' | 'X' | 'K'  (linia tmux, planStatusLine)
  readonly command: string;       // 'claude' | 'codex' | 'kimi'
  readonly installHint: string;
  readonly capabilities: Readonly<{ remoteControl: boolean; statusLineTap: boolean; mcpInstall: boolean; busyPrompt: boolean }>;
  defaultSettings(): AgentSettings;
  detect(runner: Runner): Promise<ProviderDetection>;
  doctor(d: ProviderDetection, env: NodeJS.ProcessEnv): DoctorLine[];
  argv(order: LaunchOrder, settings: AgentSettings, extra: string[]): string[];
  /** Zmienne okna wymagane przez sam start (Kimi: KIMI_MODEL_THINKING_EFFORT, KIMI_CODE_NO_AUTO_UPDATE, AGENTCTL_TASK); doklejane do spec.env w new/resume
   *  niezależnie od notify.events (planEventWiring jest dziś warunkowe: new.ts:141). Claude/Codex: {}. */
  launchEnv(order: LaunchOrder, settings: AgentSettings): Record<string, string>;
  resumeArgv(order: LaunchOrder, settings: AgentSettings, extra: string[], sessionId?: string): string[];
  /** Tekst do `resume --list`: '--continue' / 'resume --last' / '--continue (kimi)'. */
  resumeLabel(sessionId?: string): string;
  effort: EffortSupport;
  screen: ScreenProfile;
  events: EventSupport;
  usage: UsageSupport;
  models: ModelCatalog;
  safety: SafetyRules;
  /** Czy linia `ps` (tokeny polecenia) to interaktywna sesja tego dostawcy (limits.count_external). */
  isExternalSession(tokens: readonly string[]): boolean;
}
