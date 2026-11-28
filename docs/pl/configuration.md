# Referencja konfiguracji

Kolejność: config globalny → .agentctl.yaml pierwszego repo → spec. Katalog to AGENTCTL_HOME, inaczej ~/.agentctl. Nieznane klucze są błędem; config MCP ostrzega i pomija błędne uprawnienia. Watch/MCP wczytuje poprawne edycje; błędne zachowują poprzedni config. Po zmianie providers restartuj MCP.

`env` scala się po kluczach, a `links` po `from`. Lista `setup` zastępuje odziedziczone polecenia, a `[]` je wyłącza. Repo używa `repos[].setup` albo własnej konfiguracji projektu. Polecenia globalne i z głównego poziomu specyfikacji dotyczą pierwszego repo. Ścieżki rozwijają `~` i `{task}/{TASK}/{cache}`. MCP przyjmuje mapowanie `setup` wskazujące źródło klonu i odrzuca polecenia powłoki przesłane w specyfikacji.

Typy/domysły sprawdzono z [config.ts](../../src/core/config.ts), [spec.ts](../../src/core/spec.ts) i adapterami. g/p/s = globalny/projekt/spec. Część zwięzłych starszych wierszy podaje domyślne/typ w opisie. Dokładne regexy: [wspólne adaptery](../../src/core/providers/settings.ts), [Kimi](../../src/core/providers/kimi-settings.ts), [referencja szczegółowa](../configuration.md). Mapping raportu używa path ALBO paths oraz settle_s/clean_worktree_cache; gotowość nadal wymaga bieżącej próby. To nie pojemności konta właściciela.

## Hosty

`hosts.<name>` konfiguruje SSH, zdalne klony, dostawców, env i opcjonalne limity dostawców. Spec z `host: <name>` działa zdalnie, a raport ma lokalną kopię. [Hosty](hosts.md): pełny config, limity, odzyskiwanie połączenia i przykład na PC.

| Key | Typ / domyślne / warstwy | Znaczenie |
|---|---|---|
| `hosts` | mapping · `{}` · g | Nazwane hosty SSH: ssh, port, identity_file, work_dir, repos, providers, limits, env. [Pełny config hostów](hosts.md). |
| `perf` | mapa · 30m, 2048 MiB · g | Czas oczekiwania na wyłączność hosta i limit rozmiaru artefaktów. |
| `placement` | mapa · local · g | Wybór hosta, preferencje, czas przełączenia i reguły czatów i kohort. |
| `host` | nazwa · brak · s | Uruchom zadanie na skonfigurowanym hoście; lokalna kopia raportu oraz limity konta i hosta. |
| `on_pass` | kohorta lub wzorzec · brak · s | Czekaj na PASS pasującej integracji. |
| `at` | HH:MM · brak · s | Najbliższa wskazana godzina czasu lokalnego dla zlecenia. |
| `start_after` | znacznik ISO · brak · s | Najwcześniejszy start pomiaru. |
| `results` | ścieżka względna · brak · s | Katalog wyników perf do skopiowania na Maca. |
| `artifacts` | lista · [] · s | Katalogi buildów do przesłania z Maca przed pomiarem. |
| `reuse_worktree` | ID zadania · brak · s | Użyj worktree zamkniętego zadania na jego hoście. |
| `base_task` | ID zadania · brak · s | Użyj wyniku lub gałęzi wskazanego zadania jako bazy. |

## Warstwy i instancja

| Key | Typ / domyślne / warstwy | Znaczenie |
|---|---|---|
| `worktree_root` | path · none · g p | Katalog nowych worktree; bez niego każde repos podaje worktree. |
| `worktrees` | mapowanie · brak · g p | Katalog worktree i opcjonalny zewnętrzny punkt montowania. |
| `worktrees.root` | ścieżka · brak · g p | Odpowiednik `worktree_root` w formie mapowania. W jednym pliku używaj jednej formy. |
| `worktrees.mount` | ścieżka · wykrywana pod `/Volumes/<nazwa>` i `/mnt/<nazwa>` · g p | Punkt montowania zawierający katalog worktree. Ustaw dla innych lokalizacji dysku zewnętrznego. Brak woluminu blokuje start i jest widoczny w `status`. |
| `links` | list · `[]` · g p s | Linki w pierwszym worktree; późniejsze from wygrywa. |
| `links[].from` | path · required · g p s | Ścieżka linku względem worktree, także glob. |
| `links[].to` | path · required · g p s | Istniejący cel; para końcówek /* linkuje każdy element. |
| `env` | mapping · `{}` · g p s | Środowisko scalane po kluczach; wartości zamieniane na tekst. |
| `report` | path or list · `{cache}/{task}/{TASK}.md` · g p s | Ścieżka kanoniczna lub lista: pierwsza kanoniczna, reszta kandydatami; także mapping path/paths. |
| `setup` | list of strings · `[]` · g p s | Polecenia po worktree, przed linkami; lista zastępuje odziedziczoną, [] wyłącza. W specyfikacji MCP można podać tylko źródło klonu. |
| `setup.commands` | lista poleceń · dziedziczona · g p s | Polecenia w formie mapowania można podać z CLI, w konfiguracji globalnej i projektowej. `[]` wyłącza także domyślne `npm ci`. |
| `setup.from_task` | ID zadania · brak · s | Alias `link-from`. Próbuje sklonować `node_modules` metodą copy-on-write z odpowiadającego repozytorium lokalnego zadania. |
| `setup.node_modules` | `clone` lub `off` · `off` · g p | Klonuje zgodne instalacje npm z `<AGENTCTL_HOME>/nm-store` w obrębie tego samego systemu plików. Repozytorium może zmienić ustawienie globalne. |
| `close` | mapowanie · `{}` · g p | Ustawienia stosowane po zamknięciu zadania. |
| `close.cleanup` | lista ścieżek względnych lub globów · `[]` · g p | Po zamknięciu zadania usuwa pasujące pliki ignorowane przez Git zgodnie z `gc.delete_mode`. Glob dopasowuje jeden segment ścieżki. Lista projektu zastępuje globalną. |
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
| `launch` | mapping · `{grace_s: 120}` · g | Automatyczne wznowienie zakończonego okna agenta. |
| `launch.grace_s` | sekundy od zera · `120` · g | Watch ponawia start raz po wyjściu przed potwierdzeniem polecenia albo w tym przedziale. |
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
| `repos[].base_task` | ID zadania · brak · s | Wyznacz bazę jednego repozytorium z wyniku zadania. |
| `repos[].branch` | string · none · s | Gałąź; brak oznacza detached. |
| `review_of` | task ID or list · none · s | ID/lista recenzowanych zadań; inny agent/model, wspólny provider ostrzega. |
| `review.mode` | `readonly-on-author` · własne worktree · s | Korzysta z worktree zatrzymanego lokalnego autora. Osobny raport i dowody są pod `cache`. Wymaga jednego `review_of`. |
| `merge_base_check` | `warn`, `block`, `candidate` · brak · s | Przed startem sprawdza lokalne `main`/`master`. `warn` zapisuje ostrzeżenie. `block` czeka na aktualizację. `candidate` używa osobnej gałęzi `review/<TASK>` i blokuje start przy konflikcie. |
| `keep_cache` | boolean · `false` · s | Zachowaj cały cache zadania podczas gc. Usuwanie cache jest domyślnie wyłączone; include_cache: true / --include-cache wymaga jawnej zgody właściciela. Ścieżki persist/artifacts/refs w raporcie także chronią dane. |
| `remote_control` | boolean · `false` · s | Tylko Claude; wymaga właściwego loginu i ręcznej zgody. |
| `pin` | boolean · `false` · s | Zabroń translacji dostawcy i move. |
| `after` | task ID or list · none · s | Kompletne raporty i akceptowany pierwszy werdykt; brak werdyktu może czekać, jawne odrzucenie blokuje. |
| `after_verdict` | non-empty verdict list · `[PASS, PARTIAL]` · s | Niepusta lista, wymaga after; domyślnie PASS/PARTIAL z aliasami. |
| `touches` | glob or list of globs · none · s | Globy do ostrzegania, nie blokady. |
| `integration` | boolean · false · s | Wycisz kolizje zadania integracyjnego z adnotacją; pozostałe zadania porównują bazę specyfikacji i pomijają przejęte merge. |
| `owner` | nazwa czatu · ustalana przy rejestracji · s | Zapasowy właściciel zlecenia dla kwot. Przyjmuje nazwę czatu, `chat:<nazwa>` lub `default`. |
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
| `usage.queue_hold` | percentage, mapping or `false` · `false` · g · The queue does not start a task of a provider whose plan is above this percentage (in any window); `queue list` says so. `false`: the plan never holds the queue. Request through MCP `set_limits` `queue_hold` or apply from the owner CLI `agentctl limits set queue_hold=90 · off | Próg znanego okna blokujący start kolejki; procent/mapping/false, CLI/MCP off wyłącza. |
| `usage.status_line` | boolean · `true` · g | Procenty planu w status barze. |
| `usage.claude_tap` | boolean · `true` · g | Task-scoped statusLine zbiera plan i przekazuje istniejącą komendę. |
| `usage.claude_dir` | path · `$CLAUDE_CONFIG_DIR`, else `~/.claude` · g | Korzeń transkryptów Claude. |
| `usage.codex_dir` | path · `$CODEX_HOME`, else `~/.codex` · g | Korzeń danych Codex. |
| `usage.glm_dir` | path · `$CLAUDE_CONFIG_DIR`, else `~/.claude` · g | Osobny korzeń transkryptów GLM; dopasuj do wrappera. |
| `agents.<agent>.flags` | list of strings · `[]` · g | Dodatkowe flagi; auto-accept zabronione. |
| `agents.<agent>.effort_args` | list of strings · claude `['--effort', '{effort}']`, codex `['-c', 'model_reasoning_effort={effort}']` · g | Argumenty effort z {effort}; [] nic nie dodaje, Kimi używa konfiguracji natywnej. |
| `agents.<agent>.ready_pattern` | regex · see below · g | Regex pola; geometria composera nadal sprawdzana. |
| `agents.<agent>.ready_timeout` | seconds · `60` · g | Sekundy oczekiwania na gotowość (wartość bazowa; nadpisuje ją `providers_config.<p>.ready_timeout_s`, obie rosną z load1/rdzenie do 180 s). |
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
| `capacity.load_threshold` | liczba dodatnia · 3 × logiczne CPU dla alertów · g | Próg obciążenia z jednej minuty. Próg wstrzymuje przyjmowanie z kolejki po włączeniu `queue.hold_on_load: true`. |
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

## Kwoty czatów

| Klucz globalny | Domyślnie | Działanie |
| --- | --- | --- |
| `limits.change_policy` | `owner-approve` | MCP `set_limits` składa wniosek. Właściciel ma dwie godziny na decyzję przez `L` na tablicy lub `agentctl limits approve ID` / `reject ID`. `direct` przywraca wcześniejsze uprawnienia MCP oraz podgląd i potwierdzenie. |
| `limits.profiles.<nazwa>` | brak | Limity dostawców (`0` oznacza brak pułapu, `off` wyłącza dostawcę). Opcjonalne `shares: {nc: 40}` zmienia udziały w aktywnym profilu. Pominięte klucze dziedziczą ustawienia bazowe. |
| `limits.schedule` | brak | Codzienne przełączenia profilu. `timezone` wskazuje strefę IANA, a `switches` przypisuje nazwy profili do lokalnych godzin `HH:MM` w cudzysłowie. Wiosną brakującą godzinę przesuwa różnica czasu, jesienią obowiązuje pierwsze wystąpienie godziny. |
| `limits.active_profile`, `limits.timed_overrides` | brak | Agentctl zapisuje tu ręczny wybór profilu i limity czasowe. Ustawiaj je z tablicy lub CLI. |
| `quotas` | brak | Włącza przydział miejsc według czatu. |
| `quotas.chats.<nazwa>.share` | brak | Udział od 0 do 100%. Dodatni udział daje pułap `max(podłoga, round(limit globalny × overprovision × udział / 100))`. Udział 0 lub dostawca `off` daje zero miejsc. Dodatni udział dostawcy bez limitu jest bez pułapu. |
| `quotas.chats.<nazwa>.<dostawca>` | dziedziczenie | Liczba całkowita od zera zastępuje obliczany pułap tego dostawcy. |
| `quotas.default.<dostawca>` | bez pułapu w granicach limitu globalnego | Wspólny pułap dla czatów bez osobnej konfiguracji i starszych zadań bez właściciela. Nazwane czaty sięgają po niego, jeśli brak udziału i nadpisania dostawcy. |
| `quotas.floor` | `1` dla nazwanego czatu z dodatnim pułapem | Liczba całkowita od zera ustala podłogę kwot procentowych. Dotychczasowe mapowanie per dostawca pozostaje obsługiwane. Kolejka rozdziela priorytet podłogi w kolejności nazw czatów do wysokości globalnego limitu, z domyślnym koszykiem na końcu. |
| `quotas.overprovision` | `1.5` | Mnożnik co najmniej 1. Doctor i MCP `config_show` ostrzegają o przekroczeniu budżetu i podłóg. Starty nadal ogranicza pułap globalny. |
| `quotas.cohorts.<kohorta>` | brak | Zastępczy właściciel kohorty, bez rozróżniania wielkości liter. Wartość to nazwa czatu, `chat:<nazwa>` lub `default`. |
| `quotas.per_host` | `false` | Przy `true` użycie pułapu jest liczone osobno na każdym hoście. Limit i użycie podłogi pozostają globalne. |
| `quotas.self_service` | `off` | W trybie `direct` wartość `within_overprovision` pozwala czatowi zmienić własną kwotę w ramach budżetu. |

Dyspozytor ustala właściciela przy rejestracji według `as: "chat:<nazwa>"` z MCP, mapy `wall.chats.<nazwa>.clients`, `owner:` ze specyfikacji, `quotas.cohorts` oraz domyślnego koszyka. Kolejka najpierw obsługuje uprawnione czaty poniżej podłogi, potem według najniższego stosunku użycia do pułapu, a następnie priorytetu i kolejności. Rezerwacje i liczone sesje zewnętrzne zajmują miejsca globalne. `limits.count_report_ready` steruje liczeniem okien z gotowym raportem w obu limitach.

`agentctl limits set quota.nc.share=40` ustawia udział, a `quota.nc.claude=4` sztywny pułap. Zmiana stała zapisuje się w aktywnym profilu, jeśli profil ma dane ustawienie, a w pozostałych przypadkach w bazie. `agentctl limits profile night` przełącza profil do następnej zmiany z harmonogramu, a bez harmonogramu do ręcznej zmiany. `agentctl limits set claude=10 --until 23:00` czasowo nadpisuje pułap bazowy i profilowy. Po wygaśnięciu zaczyna obowiązywać aktualny profil. `HH:MM` oznacza lokalny czas dyspozytora. Polecenie przyjmuje też czas ISO lub okres, np. `3h`.

Tablica, CLI i MCP `limits` oraz `capacity` pokazują obliczone pułapy. MCP `config_show` podaje je w `effective_chat_ceilings`. Po każdej zastosowanej zmianie ustawień na kanale `agentctl` pojawia się jedno WALL info ze źródłem, porównaniem wartości oraz efektywnymi kwotami. Oryginalny wniosek zmienia status po zatwierdzeniu, odrzuceniu lub wygaśnięciu. Czasowe wstrzymanie dostawcy (`hold`) i blokada szczytu GLM działają bez decyzji właściciela. Działający watch stosuje zmiany czasowe w kolejce i zapisuje zdarzenia. Migrację opisuje poradnik [Limity dla kilku czatów](tutorial.md#limity-dla-kilku-czatów).

## Watch, board i powiadomienia

Tablica, limity i doctor pokazują czas pierwszego odrzucenia edycji konfiguracji oraz datę wersji nadal używanej. Odpowiedź narzędzia z serwera MCP starszego niż działający watch zawiera ostrzeżenie o wersji. Watch odświeża pomiary worktree partiami i zapisuje wykryte zmiany do późniejszego odtworzenia, jeśli etap dziennika się opóźni. `events_since` wymienia nieodebrane raporty w zakresie danego czatu i w granicach limitu odpowiedzi.

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
| `board.auto_hide_pulled_dead` | boolean · `true` · g | Ukryj odebrane zakończone zadania poza report-ready; report-ready pozostaje widoczne do zamknięcia. |
| `board.pulled_collapse_after` | number · `0` · g | Minuty od odebrania raportu do zwinięcia w kohorcie; 0 natychmiast. |
| `board.pulled_auto_close_after` | number/false · `false` · g | Jawna zgoda właściciela: watch zamyka odebrane report-ready po N godzinach od odbioru, ze zdarzeniem, bez usuwania worktree. |
| `board.mouse` | boolean · `true` · g | Mysz tylko tej sesji tmux. |
| `board.return_key` | tmux key name or `false` · `F12` · g | Klawisz powrotu; null bez wiązania. |
| `board.model_versions` | alias → quoted version mapping · `{}` · g | Jawne fallbacki wersji aliasów, bez zgadywania. |
| `board.list_width` | integer >=64 or percentage string · automatic · g | Kolumny >=64 lub procent; z peek maksymalnie szerokość minus 32. |
| `board.cohorts_recent` | integer >= 1 · `10` · g | Ostatnie kohorty w wyborze, starsze pod osobną pozycją. |
| `board.window_title` | boolean · `true` · g | Tytuły terminala usług i tej sesji. |
| `board.selection` | mapa · `{}` · g | Pola to `bg` i `fg` (cytowane `"#RRGGBB"` lub liczba całkowita 0–255), `bold` (logiczna, domyślnie `true`) oraz `style` (`bar` lub `reverse`, domyślnie `bar`). |
| `board.selected_color` | starsza nazwa koloru Ink · g | Akceptowana dla zgodności. Do ustawiania kolorów zaznaczenia służy `board.selection`. |
| `notify.mcp_writes` | `summary` · global | all/summary/off; domyślnie summary. |
| `notify.mcp_writes_interval_s` | `60` · global | Odstęp podsumowań zapisów. |

Zaznaczenie pokrywa całą szerokość panelu listy, łącznie z przerwami między kolumnami. Terminale z 256 kolorami lub truecolor domyślnie pokazują pogrubiony biały tekst na ciemnoniebieskim tle. Gdy podgląd jest widoczny, Tab oraz strzałki w lewo i w prawo przełączają aktywny panel. Strzałki w górę i w dół oraz Page Up i Page Down przewijają aktywny podgląd, a zaznaczenie na liście pozostaje widoczne na szaroniebieskim tle. W terminalach z 256 kolorami zapis szesnastkowy jest dopasowywany do najbliższego koloru z rozszerzonej palety. Terminal z 16 kolorami stosuje odwrócenie kolorów z pogrubieniem, gdy lista jest aktywna. Terminal monochromatyczny lub niepuste `NO_COLOR` włącza odwrócenie kolorów. `agentctl doctor` zgłasza błędne ustawienia zaznaczenia.

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
| `queue.hold_on_load` | bool · `false` · g | Po włączeniu watch wstrzymuje kolejkę powyżej jawnego `capacity.load_threshold` i podaje powód. |
| `cancel.grace` | seconds (0 or more) · `5` · g | Sekundy po przerwaniu przed zamknięciem. |
| `collisions.enabled` | boolean · `true` · g | Wykrywanie wspólnych plików. |
| `collisions.interval` | positive number · `300` · g | Odstęp kontroli. |
| `collisions.notify` | boolean · `true` · g | Powiadomienia nowych kolizji. |
| `collisions.ignore` | list of globs · `[]` · g | Ignorowane globy. |
| `disk` | mapping | Progi i pomiary w GiB. |
| `disk.worktree_share_percent` | `20` | Odnotuj przekroczenie tego udziału worktree w danych szczegółowych dysku. Poziom i kolor dysku na board zależą od świeżego odczytu wolnego miejsca. Rozmiar worktree i wiek pomiaru są informacyjne. |
| `disk.warn_gb` | `50` | Ostrzegaj poniżej wolnego miejsca GiB. |
| `disk.critical_gb` | `20` | Próg krytyczny <= warn; ostrzega przed potwierdzeniem. |
| `disk.workers` | `2` | Wspólny limit workerów pomiarowych 1–8. |
| `disk.measurement_timeout_s` | `600` | Deadline pomiaru; błąd zachowuje poprzednią wartość. |
| `git` | mapping | Limity czasu startu. |
| `git.timeout_s` | `600` | Dodatni limit czasu etapu checkoutu Git w sekundach. |
| `start_lock_stale_s` | `180` | Czas w sekundach przed odzyskaniem blokady bez właściciela. Blokadę po zakończonym PID można odzyskać od razu. |
| `setup.timeout_s` | `900` | Łączny limit setupu zadania w sekundach. Ustaw go w globalnej mapie `setup`. Dotychczasowy zapis listy poleceń nadal działa. |
| `gc.delete_mode` | `delete` | Usuwa wybrane pliki cache, stare node_modules i wyniki sprzątania po zamknięciu od razu. `trash` zapisuje ścieżkę po przeniesieniu do kosza systemowego i usuwa wskazany element. Git wymusza usunięcie wyłącznie dla jawnie zatwierdzonych zadań ze zmianami. |
| `gc` | mapowanie | Ustawienia sprzątania po integracji. |
| `gc.after_integration` | `propose` | `propose` tworzy plan GC z identyfikatorem żądania po przesunięciu lokalnego `main`/`master` i przekazuje wiadomość WALL każdemu czatowi będącemu właścicielem zadań. `off` wyłącza propozycje. |
| `mcp.client` | — | Opcjonalny wspólny sufiks kursora; domyślnie sesje niezależne. |
| `mcp.max_response_kb` | `8` | Budżet KiB; kontynuacje przez response_page. |

## Zarządzanie dyskiem

Progi są podawane w GiB. `disk.warn_gb` (50) i `disk.critical_gb` (20) określają poziom wolnego miejsca osobno dla każdego woluminu. `disk.min_free_start_gb` (30) wstrzymuje lokalne starty i starty z kolejki poniżej progu lub bez świeżego pomiaru. Gdy automatyczne GC jest włączone, brak miejsca przy starcie zleca też przebieg GC, co widać w powodzie wstrzymania.

Właściciel włącza automatyczne GC w `config.yaml`. Dodaj poniższe ustawienia do istniejącej sekcji `disk`. To zalecany bezpieczny start (0.26.4): przez pierwsze 24 godziny zostaw `dry_run: true`. W tym trybie watch tylko publikuje plan (`Automatyczne GC — plan`) na kanale WALL `agentctl` i w dzienniku. Przejrzyj te plany i czas przebiegu (`czas … s`) w każdym wpisie, a potem ustaw `dry_run: false`.

~~~yaml
disk:
  auto_gc:
    enabled: true
    dry_run: true            # pierwsze 24 h: tylko plan na WALL; potem false
    trigger_free_gb: 50
    target_free_gb: 60
    older_than: 2d
    categories: [own_trash, stale_node_modules, closed_clean_worktrees, closed_task_cache]
    max_per_run_gb: 50
    max_run_s: 300
    report_every: 12h
    ignored_ok: [node_modules, .cache/vite, dist, coverage, .turbo]
    cohorts_exclude: []
~~~

Automatyczne GC jest domyślnie wyłączone. Wartości domyślne:

- próg uruchomienia to `disk.warn_gb`;
- cel to najwyższy z progów uruchomienia, ostrzeżenia i startu;
- limit to 50 GiB szacowanych danych na przebieg;
- `max_run_s` (domyślnie 300) to limit czasu jednego przebiegu;
- `report_every` (domyślnie `12h`) określa, po jakim czasie WALL powtórzy niezmieniony plan. Zmiany są publikowane po ukończeniu planu. Plan wstrzymany przez limit czasu jest wznawiany przy kolejnym przebiegu w tym samym procesie watch. Pominięte kategorie pokazują zmierzone GiB, wiek pomiarów i liczbę brakujących odczytów. Wiersze `pinned` liczą osobne zadania i podają działania dla właściciela.
- `ignored_ok` to lista ścieżek ignorowanych przez git, z którymi worktree nadal może zostać usunięte. Sama nazwa, np. `node_modules`, pasuje na każdej głębokości. Ścieżka z `/`, np. `.cache/vite`, liczy się od katalogu głównego worktree.

Watch sprawdza osobno dysk wewnętrzny i skonfigurowane woluminy zewnętrzne. Przechodzi kategorie w podanej kolejności i sprawdza pozycję dopiero wtedy, gdy jest potrzebna jako następna. Po każdym usunięciu sprawdza wolne bloki. Kończy po osiągnięciu celu, limitu danych, `max_run_s` albo wyczerpaniu pozycji. Jeden przebieg korzysta z jednego spisu zadań, jednego indeksu linków i dowiązań symbolicznych oraz jednego odczytu raportów. W `node_modules` czyta dowiązania tylko na poziomie pakietów. Każde przeglądanie katalogów oddaje sterowanie pętli zdarzeń, więc tick watch nie jest blokowany.

Usunąć można tylko dane, których właściciela w agentctl da się potwierdzić. Zostają:

- przypięte i aktywne zadania, lokalne i niewysłane zmiany, linki, główne gałęzie i `keep_cache`;
- raporty i wykluczone kohorty;
- worktree z plikami ignorowanymi spoza `ignored_ok` (np. `.env` lub `.cache/evidence`);
- worktree, których ignorowane pliki są wskazane w raporcie;
- wszystko, czego potrzebuje zadanie w kolejce, w trakcie startu albo wymagające uwagi: zadania z `review_of`, `after` i `base: "@TASK"`, samo zadanie (ponowienie używa jego worktree) oraz ścieżki z jego specyfikacji lub promptu.

Przed usunięciem watch zajmuje ścieżkę tak samo jak start, pod blokadą startu. Następnie ponownie sprawdza kolejkę, własność, wiek i granice woluminu. Start, który potrzebuje tej samej ścieżki, czeka na koniec usuwania. Zajęcie ścieżki zapisuje swój czas i czas startu procesu, więc ponownie użyty PID jej nie blokuje.

Automatyczne GC uruchamia tylko watch. Gdy start z CLI lub MCP trafi na brak miejsca, zostawia `auto-gc-kick.json` dla następnego ticku watch i sam niczego nie usuwa. Ctrl-C w watch pozwala dokończyć bieżącą pozycję i zatrzymuje przebieg przed następną. Przeładowanie konfiguracji przerywa przebieg tylko wtedy, gdy zmieniły się ustawienia `disk.auto_gc`.

Zmieniony plan albo wynik trafia do dziennika i kanału WALL `agentctl`. Wpis zawiera czas przebiegu i odzyskane bajty według `statfs`.

Użyj `agentctl gc --purge-trash`, aby obejrzeć podgląd, a następnie `--apply`, aby zatwierdzić. W MCP wywołaj `gc` z `purge_trash: true`, pobierz token podglądu (przez `request_id`, gdy plan przygotowuje watch) i potwierdź tym tokenem. Zapis przeniesienia wskazuje konkretny element. Starsze pozycje pojawiają się osobno i wymagają znacznika własności agentctl. Faktyczny odzysk jest mierzony według wolnych bloków każdego woluminu. Właściciel może jawnie zatwierdzić usunięcie wskazanych worktree ze zmianami przez `--force-dirty TASK` lub MCP `force_dirty: [TASK]`. Zgoda trafia do dziennika.

Zapis przez MCP wymaga `gc` w `mcp.allow`. `mcp.gc_scope` przyjmuje `all` (domyślnie), `own-cohort` (czat wykonuje tylko plany dla kohort, których jest jedynym właścicielem) i `owner` (wykonanie dla właściciela przez terminal). Przy `own-cohort` podaj `as: "chat:<nazwa>"` lub użyj klienta przypisanego w `wall.chats`. Watch ponownie sprawdza zakres za każdym razem przed wykonaniem.

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

### Cykl życia WALL (0.22.7)

`watch` przy każdym ticku porządkuje WALL. Zamknięte wiadomości (`answered`,
`accepted`, `rejected`, `superseded`, `stale`), których ostatni status jest starszy
niż `wall.archive_after_days` (domyślnie **14**), przenosi do
`~/.agentctl/wall/archive/<kanał>-<YYYY-MM>.jsonl` (miesiąc publikacji).
Zostaje cała treść i historia statusów. Każdy plik jest podmieniany atomowo pod
blokadą zapisu WALL; zapis archiwum przed podmianą aktywnego pliku i deduplikacja
pozwalają bezpiecznie dokończyć przerwaną operację. ID i wątki nadal działają,
także po restarcie, a numeracja nowych wiadomości nie zaczyna się od nowa.

Lista `wall_read` domyślnie ma `since: 7d`. Jawne `since` przeszukuje podany okres
w aktywnych plikach i archiwach, a `archive: true` całą historię. Odczyt po ID
zawsze uwzględnia archiwum. W CLI: `wall read --since 30d`, `wall read --archive`
lub `wall read --id <id>`.

Otwarte pytanie lub prośba bez odpowiedzi/zmiany statusu przez
`wall.remind_after_hours` (domyślnie **24**) dostaje jedno trwałe przypomnienie:
`WALL czeka na odpowiedź: <id>`. Czat autora i adresat widzą je w `events_since`;
adresat będący kanałem oznacza subskrybujące go czaty. Po
`wall.stale_after_days` (domyślnie **7**) nieaktywne pytanie otrzymuje status
`stale` z notatką w historii. Prośby o decyzję i zmiany kontraktu dostają
przypomnienie, lecz nigdy automatyczny `stale`: nadal zamyka je wyłącznie właściciel
lub czat z `owner_confirmed` po jego decyzji. `stale` jest statusem zamkniętym dla
skrzynki i archiwum; ponowne otwarcie wymaga właściciela.

W planszy **W** nieprzeczytane to ostatnie 7 dni oraz wszystkie otwarte pozycje.
**A** przełącza aktywne i archiwalne listy wiadomości; `stale` jest przygaszony,
szary. `events_since` pokazuje wiek otwartych pozycji i pomija `stale`.
Po obsłużeniu pytania: `wall_reply` lub `wall_set_status`.

```yaml
wall:
  archive_after_days: 14
  remind_after_hours: 24
  stale_after_days: 7
```

Progi muszą być dodatnimi, skończonymi liczbami. Porządkowanie wymaga watch;
okna list oraz odczyt po ID/z archiwum działają również bez niego.

Podgląd GC rozdziela **Would remove**, **Skipped (uncommitted changes)** i **Skipped (pinned)** z rozmiarami. JSON MCP zawiera ten sam opis w `text`; pominięte bajty nie zwiększają miejsca do odzyskania.

`agentctl pin TASK` / `unpin TASK` (MCP `pin` / `unpin`, `tasks: [TASK]`, osobne uprawnienia mcp.allow) zapisują pin w stanie zadania, także zamkniętego/zarchiwizowanego. GC nie usuwa przypiętych worktree ani cache nawet z flagami force; pin blokuje też zmianę providera. `agentctl gc --keep TASK` / MCP `gc` lub `gc_preview` z `keep: [TASK]` chroni te zasoby w jednym przebiegu. Status i plansza pokazują 📌.

Kolejka wymaga aktualnego wolnego miejsca ≥ `disk.min_free_start_gb` (domyślnie 30, GiB). Zbyt mało miejsca lub brak odczytu wstrzymuje starty z kolejki i MCP new; działające zadania trwają dalej. `queue.max_parallel_setups` (domyślnie 2) ogranicza fazy worktree/setup niezależnie od `parallel_starts` (obejmującego też oczekiwanie na gotowość agenta). Podgląd szacuje rozmiar worktree każdego repo na podstawie ostatniego pomiaru z jego wiekiem; brak pomiaru to n/d.

Status/capacity i zdarzenia dyskowe odświeżają wolne miejsce przez statfs; sumy worktree zachowują czas i wiek ostatniego pomiaru. Ostrzeżenia o udziale worktree również podają ten wiek. Wskazówka GC wyjaśnia blokady: pin, aktywne zadania, niezapisane/niewysłane zmiany, linki i domyślna ochrona cache; nie obiecuje odzyskania tych bajtów.

Harmonogram szczytu dotyczy nowych startów, także bezpośrednich; działające zadania trwają dalej. Domyślnie GLM: `providers_config.glm.peak: [{days: mon-fri, from: "14:00", to: "18:00", tz: Asia/Singapore}]`, `peak_policy: hold`. To 07:00–11:00 zimą i 08:00–12:00 latem w Warszawie. Forma singapurska podąża za Z.ai; `tz: Europe/Warsaw, from: "07:00", to: "11:00"` utrzymuje stałe godziny polskie. Te pola obsługują też inni providerzy. `peak: []` wyłącza harmonogram. `peak_policy: short_only` dopuszcza klasy report/simple/smoke/gate lub boolowskie `peak_ok: true` w spec. Obsługiwane są zakresy/listy dni i okna nocne; koniec jest wyłączny. Kolejka/plansza/status pokazują lokalną godzinę końca szczytu.

Po `notify.attention_after_min` (domyślnie 15) ciągłego needs-trust/needs-input watch wysyła jedno powiadomienie pulpitu, skonfigurowanego telefonu i decision-request WALL na kanale `agentctl` do właściciela. Timer i zapis jednokrotnego wysłania na próbę zadania przetrwają restart. Watch oznacza swój wpis WALL jako `answered` po ustaniu oczekiwania albo `superseded` po zamknięciu lub anulowaniu zadania. Powód zapisuje w historii statusu. Eskalacja telefonu działa także bez away, respektuje `notify.ntfy.events`, prywatność i ponawianie wysyłki. Zwykłe powiadomienia o zmianach stanu działają niezależnie.

Każde narzędzie MCP przyjmuje opcjonalne `as`; wykorzystują je WALL/events. Filtr kohorty statusu korzysta ze świeżego snapshotu watch, a overlap pojawia się tylko przy kolizjach. Podglądy potwierdzeń pokazują ISO `expires_at` i `expires_at_local`.

Domyślne linki projektu do worktree zadań zamkniętych/anulowanych/zarchiwizowanych są błędem, także gdy cel już nie istnieje. Użyj własnego worktree backendu (`{worktree:backend}` z backendem w repos) albo `links: []`. Domyślny link do repo już zawartego w spec jest pomijany; celowe linki `{worktree:...}` pozostają. Jawne linki spec są świadomym wyborem i nadal przechodzą sprawdzenia celu.

Wpisy integrate w `agentctl-outputs` przyjmują opcjonalne `base` obok repo/branch/sha/note. Repo spoza spec jest zachowane z `outputs_warnings` i wskazówką dodania do repos; jego referencje Git nie mogą być zweryfikowane i nie są sprawdzane. Ostrzeżenie nie unieważnia outputs; niejednoznaczne aliasy repo i błędne referencje nadal są błędami.

### Ustawienia 0.22.8

| Klucz | Domyślnie | Znaczenie |
|---|---|---|
| `disk.min_free_start_gb` | `30` | Minimalne wolne GiB przed startem z kolejki. |
| `disk.min_free_state_gb` | `5` | Minimalne wolne GiB na każdym woluminie stanu i cache. |
| `queue.max_parallel_setups` | `2` | Maksymalna liczba równoległych faz worktree/setup. |
| `notify.attention_after_min` | `15` | Minuty do jednokrotnej eskalacji desktop/telefon/WALL. |
| `providers_config.<p>.peak` | `glm: Singapore 14:00–18:00 mon-fri` | Okna {days, from, to, tz}; strefa IANA, peak: [] wyłącza. |
| `providers_config.<p>.peak_policy` | `hold` | hold lub short_only; dotyczy nowych startów. |
| `peak_ok` | `false` | Flaga spec dopuszczająca start przy short_only. |
