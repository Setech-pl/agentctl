# Referencja konfiguracji

Kolejność: config globalny → .agentctl.yaml pierwszego repo → spec. Katalog to AGENTCTL_HOME, inaczej ~/.agentctl. Nieznane klucze są błędem; config MCP ostrzega i pomija błędne uprawnienia. Watch/MCP wczytuje poprawne edycje; błędne zachowują poprzedni config. Po zmianie providers restartuj MCP.

env scala się po kluczach, links po from, setup zastępuje całą listę ([] wyłącza). Repo używa repos[].setup lub własnego projektowego setup; globalny/top-level dotyczy pierwszego repo. Późniejsze report/root/default wygrywa. Ścieżki rozwijają ~ i {task}/{TASK}/{cache}. MCP odrzuca setup w przesłanym spec; sprawdzony setup projektu nadal działa.

Typy/domysły sprawdzono z [config.ts](../../src/core/config.ts), [spec.ts](../../src/core/spec.ts) i adapterami. g/p/s = globalny/projekt/spec. Część zwięzłych starszych wierszy podaje domyślne/typ w opisie. Dokładne regexy: [wspólne adaptery](../../src/core/providers/settings.ts), [Kimi](../../src/core/providers/kimi-settings.ts), [referencja szczegółowa](../configuration.md). Mapping raportu używa path ALBO paths oraz settle_s/clean_worktree_cache; gotowość nadal wymaga bieżącej próby. To nie pojemności konta właściciela.

## Warstwy i instancja

| Key | Typ / domyślne / warstwy | Znaczenie |
|---|---|---|
| `worktree_root` | path · none · g p | Katalog nowych worktree; bez niego każde repos podaje worktree. |
| `links` | list · `[]` · g p s | Linki w pierwszym worktree; późniejsze from wygrywa. |
| `links[].from` | path · required · g p s | Ścieżka linku względem worktree, także glob. |
| `links[].to` | path · required · g p s | Istniejący cel; para końcówek /* linkuje każdy element. |
| `env` | mapping · `{}` · g p s | Środowisko scalane po kluczach; wartości zamieniane na tekst. |
| `report` | path or list · `{cache}/{task}/{TASK}.md` · g p s | Ścieżka kanoniczna lub lista: pierwsza kanoniczna, reszta kandydatami; także mapping path/paths. |
| `setup` | list of strings · `[]` · g p s | Polecenia po worktree, przed linkami; lista zastępuje odziedziczoną, [] wyłącza. MCP spec odrzucony. |
| `defaults` | mapping · `{}` · g p | Domyślne pola pominiętego zamówienia. |
| `defaults.agent` | active provider · none · g p | Domyślny aktywny dostawca. |
| `defaults.model` | string · `default` · g p | Domyślny model; default bez flagi. |
| `defaults.effort` | `low` `medium` `high` `xhigh` `max` · `high` · g p | Domyślny effort, ograniczony adapterem. |
| `defaults.remote_control` | boolean · `false` · g p | Domyślny Remote Control Claude, nadpisywany w spec. |
| `providers` | global · `[claude, codex]` | Aktywni dostawcy; claude/codex obowiązkowe, kimi/glm opcjonalne. |
| `providers_config` | mapping · `{}` · g | Nadpisania startu GLM. |
| `providers_config.glm.command` | string · `claude-glm` · g | Jedna nazwa/ścieżka wrappera bez argumentów. |
| `providers_config.glm.env` | mapping · `{CLAUDE_CODE_AUTO_MODE_SERVER: "0"}` · g | Środowisko GLM: domyślnie CLAUDE_CODE_AUTO_MODE_SERVER=0; endpoint/token odrzucone, agents/spec env wygrywa. |
| `start_failure` | mapping · `{keep_window: true}` · g | Zachowanie po nieudanym starcie. |
| `start_failure.keep_window` | boolean · `true` · g | Zachowaj okno diagnostyczne; zapis ekranu powstaje też przy false. Dialog człowieka nigdy nie jest zamykany. |
| `cache` | path · ~/Projects/cache · g | Raporty w podkatalogach zadań; domyślnie ~/Projects/cache. |
| `state_dir` | path · `<config dir>/tasks` · g | Wewnętrzny stan zadań; archive obok, raporty poza nim. |
| `tmux` | mapping · socket unset · g | Opcjonalny osobny serwer tmux. |
| `tmux.socket` | string · unset · g | Nazwa tmux -L: litery/cyfry/_/-. |
| `session` | string · `agentctl` · g | Nazwa sesji: litery/cyfry/_/-. |
| `ui` | mapping · `{}` · g | Etykiety instancji. |
| `ui.instance_name` | string · automatic · g | Nazwa 1–64 znaki, stosowana przy starcie widoków. |
| `equivalents` | list · `[]` · g | Własne mapowania model/effort przed tabelą wbudowaną. |
| `mirror_dir` | path · none (off) · g | Kopie raportów/status.json przez status/pull. |
| `preview` | mapping · `{ttl_s: 600}` · g | Ustawienia podglądu. |
| `preview.ttl_s` | positive seconds · `600` · g | Żywotność tokenu w sekundach; scope/sesja nadal sprawdzane. |
| `delivery_confirm_s` | seconds · `60` · g | Deadline potwierdzenia niepewnego dostarczenia. |
| `AGENTCTL_HOME` | — | Katalog instancji zamiast ~/.agentctl. |
| `CODEX_HOME` | — | Katalog danych Codex. |
| `guide` | mapping (global), path (project) · `{lang: en}` globally · g, p | Projekt: ścieżka nakładki; globalnie mapping lang. |
| `guide.lang` | en or pl · en · g | Język en/pl wspólnego przewodnika. |

## Spec i przegląd

| Key | Typ / domyślne / warstwy | Znaczenie |
|---|---|---|
| `wall` | mapping · see below · g | Globalnie kanały/czaty/subskrypcje; w spec kontekst tylko do odczytu. |
| `task` | string · required · s | ID: litera, wielkie litery/cyfry/-/_, do 40; okno małe litery. |
| `agent` | active claude/codex/kimi/glm · `defaults.agent` · s | Aktywny dostawca. |
| `class` | one of the matrix classes · none · s | Klasa macierzy model/effort; jawne pola wygrywają, none odmawia. |
| `model` | string · `defaults.model`, else `default` · s | Alias; default pomija flagę. |
| `effort` | `low` `medium` `high` `xhigh` `max` · `defaults.effort`, else `high` · s | Poziom adaptera: Codex bez max, Kimi low/high/max. |
| `repos` | list · required · s | Niepusta lista; agent startuje w pierwszym worktree. |
| `repos[].path` | path · required · s | Repozytorium źródłowe. |
| `repos[].worktree` | path · `<worktree_root>/<repo>-<task>` · s | Docelowy checkout różny od path; fallback worktree_root. |
| `repos[].setup` | list of strings · none · s | Setup tego repo, fallback jego configu; MCP spec zabroniony. |
| `repos[].base` | git ref · none · s | Ref Git lub task:<ID>, zamrażany do commitu przy starcie. |
| `repos[].branch` | string · none · s | Gałąź; brak oznacza detached. |
| `review_of` | task ID or list · none · s | ID/lista recenzowanych zadań; inny agent/model, wspólny provider ostrzega. |
| `remote_control` | boolean · `false` · s | Tylko Claude; wymaga właściwego loginu i ręcznej zgody. |
| `pin` | boolean · `false` · s | Zabroń translacji dostawcy i move. |
| `after` | task ID or list · none · s | Kompletne raporty i akceptowany pierwszy werdykt; brak werdyktu może czekać, jawne odrzucenie blokuje. |
| `after_verdict` | non-empty verdict list · `[PASS, PARTIAL]` · s | Niepusta lista, wymaga after; domyślnie PASS/PARTIAL z aliasami. |
| `touches` | glob or list of globs · none · s | Globy do ostrzegania, nie blokady. |
| `integration` | boolean · false · s | Wycisz kolizje zadania integracyjnego z adnotacją; pozostałe zadania porównują bazę specyfikacji i pomijają przejęte merge. |
| `cohort` | name · none · s | Spec: grupa zadania; globalnie ustawienia ukończenia kohorty. |
| `weight` | `normal` or `heavy` · `normal` · s | normal/heavy, ciężkie dzielą cap kolejki. |
| `priority` | `high` or `normal` · `normal` · s | high/normal; FIFO w klasie, new pomija. |
| `report.settle_s` | — | Stabilizacja po końcu tury; 0 wyłącza zwłokę, nie walidację próby. |
| `report.path` | — | Kanoniczna ścieżka mapping. |
| `report.paths` | — | Pierwsza kanoniczna, reszta kandydatami. |
| `cohort.done_grace_s` | `300` | Cisza przed zdarzeniem ukończenia kohorty. |
| `review` | disabled · global, project, spec | auto/false albo mapping polityki przeglądu. |
| `review.default` | `false` · global, project | Domyślnie auto lub false. |
| `review.agent` | other provider · global, project, spec | Jawny dostawca przeglądu. |
| `review.model` | equivalents · global, project, spec | Jawny model przeglądu. |
| `review.effort` | equivalents · global, project, spec | Jawny effort przeglądu. |
| `review.template` | built-in · global, project | Ścieżka szablonu. |
| `review.prompt_template` | built-in · global, project, spec | Alias template. |
| `review.rerun` | `false` · global, project, spec | Nowy przegląd delty kolejnej próby. |
| `review.prefer` | provider IDs · `providers` order | Kolejność innego aktywnego dostępnego mapowalnego dostawcy. |
| `read_only` | — | Detached bez setup/linków, commit guard i baza HEAD; ochrona umowna, nie sandbox. |
| `report.clean_worktree_cache` | boolean · true · g | Usuń dozwolone .cache worktree po stabilizacji bieżącego raportu z markerem i końcu tury; wspólny checkout, symlinki poza worktree i raport wewnątrz cache są chronione. Nie usuwa node_modules. |

## Dostawcy i limity

| Key | Typ / domyślne / warstwy | Znaczenie |
|---|---|---|
| `limits` | mapping · none · g | Limity okien i heavy. |
| `limits.claude` | positive integer, `0` or `off` · unlimited · g | Claude: brak/0 bez limitu, off wyłączony. |
| `limits.codex` | positive integer, `0` or `off` · unlimited · g | Codex: brak/0 bez limitu, off wyłączony. |
| `limits.heavy` | positive integer · `1` · g | Wspólny limit ciężkich zadań kolejki. |
| `limits.count_report_ready` | boolean · `false` · g | Czy bezczynne okna z kompletnym raportem zajmują slot. |
| `limits.count_external` | boolean · `false` · g | Czy zewnętrzne interaktywne sesje dostawców zajmują slot. |
| `agents` | mapping · see below · g | Ustawienia aktywnych adapterów. |
| `usage` | mapping · see below · g | Tokeny i progi planu. |
| `usage.warn` | percentage or mapping · `80` · g | Próg procentowy wspólny lub na dostawcę. |
| `usage.critical` | percentage or mapping · `95` · g | Próg krytyczny, >= warn. |
| `usage.queue_hold` | percentage, mapping or `false` · `false` · g · The queue does not start a task of a provider whose plan is above this percentage (in any window); `queue list` says so. `false`: the plan never holds the queue. Set live with MCP `set_limits` `queue_hold` or `agentctl limits set queue_hold=90 · off | Próg znanego okna blokujący start kolejki; procent/mapping/false, CLI/MCP off wyłącza. |
| `usage.status_line` | boolean · `true` · g | Procenty planu w status barze. |
| `usage.claude_tap` | boolean · `true` · g | Task-scoped statusLine zbiera plan i przekazuje istniejącą komendę. |
| `usage.claude_dir` | path · `$CLAUDE_CONFIG_DIR`, else `~/.claude` · g | Korzeń transkryptów Claude. |
| `usage.codex_dir` | path · `$CODEX_HOME`, else `~/.codex` · g | Korzeń danych Codex. |
| `usage.glm_dir` | path · `$CLAUDE_CONFIG_DIR`, else `~/.claude` · g | Osobny korzeń transkryptów GLM; dopasuj do wrappera. |
| `agents.<agent>.flags` | list of strings · `[]` · g | Dodatkowe flagi; auto-accept zabronione. |
| `agents.<agent>.effort_args` | list of strings · claude `['--effort', '{effort}']`, codex `['-c', 'model_reasoning_effort={effort}']` · g | Argumenty effort z {effort}; [] nic nie dodaje, Kimi używa konfiguracji natywnej. |
| `agents.<agent>.ready_pattern` | regex · see below · g | Regex pola; geometria composera nadal sprawdzana. |
| `agents.<agent>.ready_timeout` | seconds · `60` · g | Sekundy oczekiwania na gotowość. |
| `agents.<agent>.trust_pattern` | regex · see below · g | Regex trust; nigdy automatycznie akceptowany. |
| `agents.<agent>.dialog_pattern` | regex · claude and glm: the first-run onboarding screens (see below), codex `'Update available\|Skip until next version'` · g | Onboarding/update modal czekający na człowieka. |
| `agents.<agent>.trust_timeout` | seconds · `600` · g | Sekundy oczekiwania na trust. |
| `agents.<agent>.working_pattern` | regex · see below · g | Regex pracy ze strukturalną kontrolą spinnera. |
| `agents.<agent>.delivery_pattern` | regex · see below · g | Nowe wyjście asystenta potwierdzające turę, nie szkic. |
| `agents.<agent>.interrupt_key` | tmux key name · `Escape` · g | Klawisz tmux przerywający turę. |
| `agents.<agent>.footer_patterns` | list of regexes · see below · g | Chrome pomijany przez status/peek. |
| `agents.<agent>.question_pattern` | regex · see below · g | Regex oczekującego pytania. |
| `agents.<agent>.async_question_pattern` | regex · see below · g | Pytanie async daje needs-input dopiero bez pracy. |
| `agents.<agent>.limit_patterns` | list of regexes · see below · g | Regexy wyczerpania limitu. |
| `agents.<agent>.background_patterns` | list of regexes · see below · g | Regexy własnych zadań tła. |
| `capacity` | mapping · see below · g | Odczyty planu, estymacje i sondy. |
| `capacity.load_threshold` | positive number · 3 × logical CPUs · g | Próg load 1-min; domyślnie 3 × logiczne CPU. |
| `capacity.snapshot` | boolean · true · g | Snapshot przy zlecaniu; MCP stopki opcjonalne. |
| `capacity.stale_minutes` | integer 1–10080 · 30 · g | Wiek ustawiający stale. |
| `capacity.sample_limit` | integer 2–10000 · 2048 · g | Limit zapisanych odczytów. |
| `capacity.thresholds` | percentage list · `[80, 95]` · g | Progi zdarzeń per okno/reset; niezależne od usage.warn/critical. |
| `capacity.codex_refresh` | boolean · true · g | RPC limitów bez tury, deadline 3 s; błąd zachowuje odczyt. |
| `overload` | — | Ograniczona kontynuacja po przeciążeniu. |
| `overload.auto_retry` | — | Pozwól na bezpieczne retry rozpoznanego overload. |
| `overload.retry_after` | — | Odstęp prób w sekundach. |
| `overload.max_retries` | — | Maksimum prób epizodu. |
| `overload.message` | — | Tekst kontynuacji. |
| `agents.<agent>.overload_patterns` | — | Bieżący kontekstowy overload poza cytatami/testami; [] wyłącza. |
| `overload.give_up_after` | — | Maksymalny czas epizodu także gdy retry niebezpieczne. |
| `overload.reset_after_s` | — | Ciągła praca do wyzerowania epizodu. |
| `limited` | see below · global | Kontynuacja na tym samym dostawcy po odzyskaniu planu. |
| `limited.auto_resume` | `true` · global | Bezpieczna kontynuacja po znanym resecie lub świeżym odczycie. |
| `limited.resume_above_percent` | `5` · global | Wymagany pozostały procent, ściśle powyżej progu. |
| `limited.message` | `kontynuuj` · global | Tekst kontynuacji. |
| `agents.<agent>.accepts_busy_prompt` | `true` · global | Czy można dostarczać podczas pracy; Kimi domyślnie false. |
| `agents.<agent>.env` | Global · `{}` | Środowisko dostawcy, spec env wygrywa. |
| `agents.<agent>.approval_pattern` | Global · Adapter default | Osobny regex modala zgody. |
| `agents.kimi` | mapping · adapter defaults | Ustawienia opcjonalnego Kimi. |
| `limits.kimi` | positive integer · unlimited | Kimi: brak/0 bez limitu, off wyłączony. |
| `usage.kimi_dir` | path/null · `$KIMI_CODE_HOME`, else `~/.kimi-code` | Jawny korzeń Kimi; agents.kimi.env.KIMI_CODE_HOME wygrywa. |
| `capacity.kimi_usage_probe_model` | string · `k3` | Alias sondy, domyślnie k3; bez Highspeed. |
| `capacity.kimi_usage_probe` | boolean · false | Neutralne /usage najwyżej co 5 min, bez inference. |
| `limits.glm` | positive integer, `0` or `off` · `2` · g | Osobny limit GLM, domyślnie 2 po aktywacji, 0 bez limitu, off wyłączony. |
| `capacity.claude_usage_probe` | boolean · false · g | Neutralne /usage bez inference; trust ręcznie. |
| `capacity.claude_usage_probe_interval_minutes` | integer 15–10080 · 15 · g | Odstęp prób 15–10080 min, także po błędach. |

## Watch, board i powiadomienia

| Key | Typ / domyślne / warstwy | Znaczenie |
|---|---|---|
| `watch` | mapping · see below · g | Obserwacja, ikony i status bar. |
| `notify` | mapping · see below · g | Powiadomienia i zdarzenia. |
| `board` | mapping · see below · g | Ustawienia boardu. |
| `away` | mapping · see below · g | Tryb powiadomień telefonu. |
| `manager` | mapping · see below · g | Sesja nadzorcza Claude Remote Control. |
| `watch.interval` | seconds · `15` · g | Odstęp ticków w sekundach. |
| `watch.idle_confirm_ticks` | positive integer · `2` · g | Kolejne odczyty idle przed waiting. |
| `watch.waiting_after` | seconds · `120` · g | Czas idle bez raportu przed powiadomieniem. |
| `watch.window_icons` | `true`, `false` or mapping · `true` · g | Ikony stanów; null wyłącza. |
| `watch.status_line` | boolean · `true` · g | Zbiorczy stan zadań w tej sesji tmux. |
| `notify.backend` | `auto`, `terminal-notifier`, `osascript` · `auto` · g | auto: terminal-notifier, fallback osascript. |
| `notify.events` | boolean · `true` · g | Obsługa hooków zdarzeń. |
| `notify.turn_end` | boolean · `true` · g | Polityka powiadomienia końca tury. |
| `notify.terminal_app` | bundle ID · detected · g | Terminal otwierany kliknięciem powiadomienia. |
| `notify.verdict_pattern` | regex · none · g | Regex pierwszej linii werdyktu. |
| `notify.ntfy` | mapping · none · g | Opcjonalne ntfy telefonu. |
| `notify.ntfy.server` | URL · `https://ntfy.sh` · g | Serwer ntfy. |
| `notify.ntfy.topic` | text · none · g | Prywatny temat ntfy. |
| `notify.ntfy.token` | text · none · g | Opcjonalny sekret uwierzytelniania. |
| `notify.ntfy.events` | list · all ten · g | Zdarzenia wysyłane na telefon. |
| `notify.ntfy.priority` | mapping · `needs-input`, `limited`, `usage-critical`: `high`; the rest `default` · g | Priorytet ntfy. |
| `notify.ntfy.include_question` | boolean · `false` · g | Dołącz pytanie. |
| `notify.ntfy.include_verdict` | boolean · `true` · g | Dołącz werdykt. |
| `notify.ntfy.click_url` | URL · none · g | Link kliknięcia. |
| `notify.ntfy.always` | boolean · `false` · g | Wysyłaj także poza away. |
| `away.auto_idle` | minutes · none · g | Sekundy bezczynności maszyny do away; 0 wyłącza. |
| `manager.project` | path · none · g | Repozytorium pracy managera. |
| `manager.name` | string · `agentctl manager` · g | Nazwa sesji Remote Control. |
| `manager.model` | string · `sonnet` · g | Model Claude managera. |
| `manager.effort` | `low` `medium` `high` `xhigh` `max` · `medium` · g | Effort managera. |
| `manager.guide` | path · none · g | Dodatkowy przewodnik managera. |
| `manager.autostart` | boolean · `false` · g | Czy up może uruchomić managera. |
| `board.auto_hide_pulled_dead` | boolean · `true` · g | Ukryj odebrany raport bez żywego okna. |
| `board.mouse` | boolean · `true` · g | Mysz tylko tej sesji tmux. |
| `board.return_key` | tmux key name or `false` · `F12` · g | Klawisz powrotu; null bez wiązania. |
| `board.model_versions` | alias → quoted version mapping · `{}` · g | Jawne fallbacki wersji aliasów, bez zgadywania. |
| `board.list_width` | integer >=64 or percentage string · automatic · g | Kolumny >=64 lub procent; z peek maksymalnie szerokość minus 32. |
| `board.cohorts_recent` | integer >= 1 · `10` · g | Ostatnie kohorty w wyborze, starsze pod osobną pozycją. |
| `board.window_title` | boolean · `true` · g | Tytuły terminala usług i tej sesji. |
| `board.selected_color` | Ink color name · `blue` · g | Kolor zaznaczenia poza komórką stanu. |
| `notify.mcp_writes` | `summary` · global | all/summary/off; domyślnie summary. |
| `notify.mcp_writes_interval_s` | `60` · global | Odstęp podsumowań zapisów. |

## Kolejka, MCP, WALL i utrzymanie

| Key | Typ / domyślne / warstwy | Znaczenie |
|---|---|---|
| `mcp` | mapping · see below · g | Uprawnienia i ograniczenia MCP. |
| `queue` | mapping · see below · g | Automatyczna kolejka. |
| `collisions` | mapping · see below · g | Ostrzeżenia o wspólnych plikach. |
| `cancel` | mapping · see below · g | Polityka przerywania pracy. |
| `mcp.allow` | list · `[]` · g | Dokładne zapisy lub grupy queue:*, cohort, manager:*, wall; [] tylko odczyt. |
| `mcp.allow_rm_worktree` | boolean · `false` · g | Dodatkowa zgoda na jawne usunięcie worktree. |
| `wall.channels` | mapping · `agentctl`, `nc`, `hems`, `shared:sim`, `shared:weather`, `shared:maps` · g | Mapa kanałów, małe litery i opcjonalny prefiks grupy. |
| `wall.channels.<name>.authors` | list · `[owner]` (built-in: `agentctl` and `shared:*` `["*"]`; `nc`/`hems` owner, their chat, `task:*`) · g | Autorzy owner/chat:/task: i wzorce; * tylko znane tożsamości. |
| `wall.channels.<name>.description` | text · none · g | Opis CLI/MCP/board. |
| `wall.chats` | mapping · `nc` (`nc`, `agentctl`, `shared:*`), `hems` (`hems`, `agentctl`, `shared:*`), `agentctl` (`agentctl`, `shared:*`) · g | Znane czaty; nieznany czyta tylko agentctl i nie publikuje. |
| `wall.chats.<name>.channels` | list · `[agentctl]` · g | Czytane kanały/wzorce; publikowanie wymaga też authors. |
| `wall.chats.<name>.clients` | list · `[]` · g | Nazwy klientów initialize rozpoznawane bez as. |
| `wall.subscriptions` | mapping · own channel + `agentctl` + `shared:*` · g | Kanały zdarzeń na czat/klienta w granicach odczytu. |
| `wall.ref_roots` | list · `[~/Projects/cache]` · g | Dozwolone korzenie ścieżek refs; bez czytania i załączników. |
| `queue.enabled` | boolean · `true` · g | Automatyczne starty przez watch. |
| `queue.parallel_starts` | positive integer · `2` · g | Maksymalna liczba równoległych startów/setup. |
| `cancel.grace` | seconds (0 or more) · `5` · g | Sekundy po przerwaniu przed zamknięciem. |
| `collisions.enabled` | boolean · `true` · g | Wykrywanie wspólnych plików. |
| `collisions.interval` | positive number · `300` · g | Odstęp kontroli. |
| `collisions.notify` | boolean · `true` · g | Powiadomienia nowych kolizji. |
| `collisions.ignore` | list of globs · `[]` · g | Ignorowane globy. |
| `disk` | mapping | Progi i pomiary w GiB. |
| `disk.worktree_share_percent` | `20` | Ostrzegaj o udziale worktree w ich filesystemie. |
| `disk.warn_gb` | `50` | Ostrzegaj poniżej wolnego miejsca GiB. |
| `disk.critical_gb` | `20` | Próg krytyczny <= warn; ostrzega przed potwierdzeniem. |
| `disk.workers` | `2` | Wspólny limit workerów pomiarowych 1–8. |
| `disk.measurement_timeout_s` | `600` | Deadline pomiaru; błąd zachowuje poprzednią wartość. |
| `git` | mapping | Limity czasu startu. |
| `git.timeout_s` | `600` | Timeout worktree add i każdego setup. |
| `mcp.client` | — | Opcjonalny wspólny sufiks kursora; domyślnie sesje niezależne. |
| `mcp.max_response_kb` | `8` | Budżet KiB; kontynuacje przez response_page. |

## Przykład

~~~yaml
providers: [claude, codex, kimi, glm]
worktree_root: ~/Projects/worktrees
cache: ~/Projects/cache
session: agentctl
limits: {claude: 2, codex: 2, kimi: 2, glm: 2, heavy: 1}
usage: {queue_hold: {claude: 90, codex: 85, kimi: 90, glm: 90}}
report: {path: "{cache}/{task}/{TASK}.md", settle_s: 30}
mcp: {allow: []}
~~~

[MCP](mcp-tools.md) · [Providers](providers.md) · [Tutorial](tutorial.md)

## WALL defaults / Domyślne czaty WALL

~~~yaml
mcp:
  allow: [wall]
wall:
  chats:
    nc: {channels: [nc, agentctl, "shared:*"]}
    hems: {channels: [hems, agentctl, "shared:*"]}
    agentctl: {channels: [agentctl, "shared:*"]}
~~~

## Hotfix 0.22.4: wstrzymania dostawców, snapshoty i integracje

`set_limits` przyjmuje `hold: {glm: "21:50"}` (najbliższa lokalna godzina), czas ISO, okres np. `"3h"` lub `"off"`. Obsługiwany jest każdy aktywny dostawca. CLI: `agentctl limits set hold.glm=3h`; wyłączenie: `hold.glm=off`. Trwała blokada działa niezależnie od procentowego `queue_hold` i odczytu zużycia. Blokuje kolejkę oraz jawne starty asynchroniczne, przetrwa restart watch, jest widoczna w queue_list/limits/capacity/board i wygasa ze zdarzeniem `limits-changed`. `off` usuwa bieżącą blokadę; nowy błąd dostawcy może ustawić kolejną.

Błąd quota/rate-limit w oknie, hooku lub przypisanym transkrypcie bieżącej próby ustawia `limited` i automatyczną blokadę dostawcy. Podany reset (ISO/godzina lokalna lub Retry-After) ma pierwszeństwo; bez niego blokada trwa godzinę. Stary komunikat nie przedłuża ani nie odnawia blokady. W transkrypcie liczą się rekordy błędów dostawcy, nie wypowiedzi użytkownika lub narzędzi. GLM może mieć zużycie n/d i aktywną blokadę. Fixture’y obejmują Z.ai 1113, 1302, 1308, zgodne z Anthropic 429 i istniejące błędy Kimi; [kody Z.ai](https://docs.z.ai/api-reference/api-code), [limity Claude](https://platform.claude.com/docs/en/api/rate-limits). To deterministyczne przykłady formatów z dokumentacji; testy nie wykonują inferencji ani zapytań sieciowych.

Tekst z cache zaczyna się od `stan z HH:MM, 2h 44m temu`; rekordy JSON mają `snapshot_age_s`, a odpowiedzi obiektowe także `snapshot_age`. Snapshot statusu lub cache odpowiedzi starszy niż pięć minut daje krótki fallback kolejki/dziennika z czasami ostatnich zdarzeń zamiast starej pełnej tabeli. Komunikat jawnie zaznacza brak odczytu żywych okien.

`integration: true` w specyfikacji wycisza ostrzeżenia o kolizjach z adnotacją. W pozostałych przypadkach porównanie używa merge-base bazy specyfikacji i pomija pliki przejęte przez merge wykonany przez poprzednika; zmiany bez commita nadal się liczą. Gałąź integrowaną deklaruj jako `repos[].base`. Flaga steruje ostrzeżeniami, nie daje uprawnień do scalenia.

Podgląd kolejki wskazuje oczekujące `queue_rm` i identyfikator requestu. MCP `queue` z `replace: true` usuwa oczekujący wpis i dodaje nową specyfikację w jednym ticku watch; rozpoczęte zadanie jest odrzucane. Usunięte zadania bez startu mają ukryty stan `cancelled`, bez alarmu utraty okna. Instrukcja raportu umieszcza marker próby po pierwszym wierszu werdyktu, a parser toleruje wcześniejsze komentarze. Odczyt raportu/zdarzenia pokazują `outputs_errors`; duplikaty bloków wybierają ostatni poprawny z uwagą. `Verdict:`, `Werdykt:` i udokumentowane aliasy checks nadal działają.
