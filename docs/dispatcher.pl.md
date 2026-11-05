# Podręcznik agenta zlecającego

Jesteś agentem zlecającym. Przed przydziałem pracy w dowolnym projekcie pobierz tę instrukcję i `capacity`. agentctl pokazuje fakty i wykonuje jawne zlecenia; to Ty dobierasz dostawcę, model i effort w granicach upoważnienia użytkownika.

## Początek sesji

Tryb schowka: `agentctl guide --project /sciezka/do/repo --lang pl --clip`, następnie `agentctl capacity --clip`; wklej oba wyniki do czatu. Przygotuj spec, skopiuj go i uruchom `agentctl new --clip` albo `agentctl queue --clip`. Zatwierdź konkretny podgląd. `--json` udostępnia dane capacity, new i queue. `new --clip` czyta spec ze schowka.

Tryb MCP: wywołaj `guide({project: "/sciezka/do/repo", lang: "pl"})`, potem `capacity({})`. Odczyt nie wymaga wpisu w `mcp.allow`. Zapis wymaga dopuszczenia narzędzia; `new` i `queue` najpierw pokazują podgląd, a `confirm: true` wykonuje zlecenie. Respektuj udzielone upoważnienie użytkownika; brakującą zgodę uzyskaj dla konkretnego specu. Nie obchodź odmowy narzędzia.

## Dobór dostawcy, modelu i effortu

Porównaj odczytane okna planu (5 h, tydzień lub miesiąc): pozostały procent, wiek odczytu, stale, tempo %/h, przewidywany moment wyczerpania i czas do resetu. Stary odczyt lub `null` oznacza n/d, a nie zero zużycia. Procent obejmuje też pracę poza agentctl. Szacunki znajdują się wyłącznie w `estimate`, z podstawą i pewnością; nie są limitem tokenów od dostawcy. Projekcja nie przewiduje zmian zasad planu.

Sprawdź wolne sloty, limit, rezerwę i najbliższe zadanie kolejki. Brak limitu slotów oznacza brak ograniczenia konfiguracyjnego, nie zmierzoną liczbę wolnych miejsc. Zobacz stats model × effort z 7 dni: liczebność, ok/partial/fail, nieocenione, medianę czasu i tokenów. Małe próbki i różna trudność zadań ograniczają porównania. Tabela równoważników to konfiguracja, nie potwierdzenie uprawnień dostawcy.

Dobierz rozumowanie do zakresu i ryzyka; nie wybieraj domyślnie najwyższego modelu i effortu. Prosta poprawka może wymagać mniejszego modelu, trudny projekt lub ryzykowny przegląd może uzasadniać większy. Uzasadnij dobór potrzebami zadania i capacity. Planuj przegląd krzyżowy innym modelem lub dostawcą, z `review_of` i `after`; ponownie pobierz capacity przed startem. Narzędzie nie wybiera dostawcy i nie przenosi pracy po przekroczeniu progu.

## Spec

Spec zawiera nagłówek YAML między liniami `---`, a potem prompt. Jeden plik może zawierać kilka speców. W prompcie określ kryteria odbioru, ograniczenia, testy i dowody wymagane w raporcie.

```yaml
---
task: APP-101
cohort: wydanie-1
agent: claude
model: sonnet
effort: medium
repos:
  - path: /sciezka/do/repo
    worktree: /sciezka/do/worktrees/app-101
    base: main
    branch: app-101
report:
  - /sciezka/do/raportow/APP-101.md
  - docs/reports/APP-101.md
pin: false
priority: normal
touches: [src/api/**, tests/api/**]
remote_control: false
---
Wprowadź zmianę API, sprawdź kryteria odbioru i zapisz raport.
```

- `task`: unikalny identyfikator. `cohort`: opcjonalna grupa do statusu, raportów i zakończenia całości.
- `agent`, `model`, `effort`: żądany dostawca i ustawienia. Dostawcy: claude, codex. Poziomy effort: low, medium, high, xhigh, max, z walidacją zależną od dostawcy. Zobacz równoważniki w capacity. `pin: true` blokuje tłumaczenie dostawcy i move.
- `repos`: lista repozytoriów; `path` wskazuje repo źródłowe, `worktree` izolowany checkout, `base` ref bazowy, `branch` nową gałąź. Bez branch możliwy jest detached checkout. Przestrzegaj zasad projektu dotyczących gałęzi i własności worktree.
- `report`: lista ścieżek lub globów; pierwsza jest kanoniczna, pozostałe służą wykrywaniu raportu. Ścieżki mogą być bezwzględne lub względne do worktree. Pierwsza linia raportu: `Werdykt: PASS`, `Werdykt: PARTIAL` albo `Werdykt: FAIL`; dalej ustalenia, commity, walidacja i ograniczenia. Werdykt nie zastępuje oceny użytkownika zapisywanej przez `mark`.
- `review_of`: przeglądane zadanie; użyj innego modelu/dostawcy. `after`: lista zadań, których raporty muszą istnieć przed startem. Zależności obsługuje kolejka.
- `priority`: normal albo high w kolejce. `touches`: spodziewane globy plików do ostrzeżeń o kolizjach, nie blokady plików.
- `remote_control`: Claude Remote Control, gdy wspierany i upoważniony; nie omija pytań o uprawnienia.
- Pola dziedziczone: `links` (symlinki from/to), `env`, `worktree_root`, `defaults`, `setup`. Polecenia setup trzymaj w zaufanej konfiguracji projektu; MCP odrzuca setup przysłany w specu. `guide:` w `.agentctl.yaml` wskazuje nakładkę względną do repo albo zaczynającą się od `~`. Brak pliku daje ostrzeżenie, nie blokuje zlecenia.

## Cykl pracy

`new` uruchamia od razu, `queue` czeka na sloty lub raporty. Grupuj zadania w kohorty i sprawdzaj `cohort list/show`, pozycję oraz warunki startu. Kolejką zarządzają `queue pause/resume/up/retry/rm`. Anulowana zależność daje `blocked`: świadomie wykonaj `unblock` (ewentualnie `--drop-after TASK`) lub anuluj potomków. MCP `resume` wznawia zadania; `unblock` usuwa zależność w kolejce, a `queue_retry` ponawia nieudany start.

Każdą odpowiedź czatu o pracy zacznij od `events_since` (bez osobnego `status`). Pobierz nowe raporty przez `pull_ready`, wskazaną sekcję przez `get_report` z parametrem `section`, a pytanie lub postęp przez `peek`. Nie uznawaj samego report-ready za sukces: przeczytaj dowody i werdykt. `mark` zapisuje upoważnioną ocenę. Na pytania o uprawnienia i zaufanie odpowiadaj przez terminal lub Remote Control; nie akceptuj ich automatycznie.

Przykładowa sekwencja MCP (instalacja może dodawać prefiks nazw):

```text
guide({project: "/sciezka/do/repo", lang: "pl"})
capacity({})
new({spec: "---\ntask: APP-101\nagent: claude\nmodel: sonnet\neffort: medium\nrepos:\n  - path: /sciezka/do/repo\n    worktree: /sciezka/do/worktrees/app-101\nreport: [/sciezka/do/raportow/APP-101.md]\n---\nZaimplementuj i sprawdź zmianę."})
new({spec: "<ten sam spec>", confirm: true})
events_since({since: "last"})
status({})
pull_ready({})
get_report({task: "APP-101"})
queue({spec: "---\ntask: APP-102\nagent: codex\nmodel: gpt-6.1-sol\neffort: medium\nreview_of: APP-101\nafter: [APP-101]\nrepos:\n  - path: /sciezka/do/repo\n    worktree: /sciezka/do/worktrees/app-102\n---\nNiezależnie przejrzyj raport i implementację."})
queue({spec: "<ten sam spec przeglądu>", confirm: true})
```

Przy `limited` sprawdź capacity i stan zadania. Poczekanie na reset, zmiana zlecenia, cancel lub jawny `move` wymagają decyzji zlecającego i użytkownika; pin zabrania move. Przeniesienie kontynuuje pracę w istniejącym worktree i zachowuje oryginalny raport. Po pobraniu i ocenie `close` zamyka okno; usunięcie worktree wymaga osobnego upoważnienia i konfiguracji. `cancel` zatrzymuje zbędną pracę, domyślnie zachowując raport i worktree.

## Granice

agentctl nie scala, nie pushuje, nie publikuje, nie tworzy PR, nie wybiera dostawcy, nie ocenia poprawności raportu i nie przenosi automatycznie zadań. Nie zamienia n/d w liczbę. Zdarzenia zapisują obserwujące polecenia i watch; events_since nie jest subskrypcją w tle. Włącz watch (`agentctl up --no-attach`) dla kolejki i powiadomień. Okna watch i board mają stabilną opcję tmux `@agentctl-role`; restartuj przez `agentctl watch --tmux --restart` lub `agentctl board --tmux --restart`, bez zależności od nazwy okna.

Od 0.17.1 MCP udostępnia ponawianie i sterowanie kolejką, kohorty, sprzątanie `gc` i diagnostykę. Sprawdź `capacity.disk` przed zleceniem pracy. Przy `failed` przeczytaj powód i zaproponuj naprawę lub `queue_retry`; przy `disk-warn` zaproponuj `gc_preview`, a przy `disk-critical` poproś o zgodę na `gc` albo użyj go w ramach uprawnień użytkownika. Każde usuwanie/start wymaga podglądu i potwierdzenia; samo `mcp.allow` nie zastępuje potwierdzenia. Szczegóły: [MCP](mcp.md).

Raporty pobieraj przez `pull_ready` w trybie skrótu; `get_report` tylko ze wskazaną sekcją. Przydział opieraj na procentach dostawcy, resecie i stats. Estymaty tokenów są informacyjne. `self_verdict` to samoocena agenta, `mark` to ocena człowieka.

0.17.2 review correction / poprawka po przeglądzie: summary_delivered ≠ pulled ≠ mark. Use full report pages or explicit ack; reports require current attempt plus report-end or settled ended turn. Stable client event cursors and bounded pages are described in [mcp.md](mcp.md); report.settle_s and overload.give_up_after in [configuration.md](configuration.md).

Nie podawaj events_since.client dla niezależnych równoległych sesji. Nowa sesja dziedziczy zapisaną pozycję klienta; client ustawiaj tylko, gdy chcesz świadomie współdzielić pobieranie zdarzeń.

## Workflow NC: raporty, przeglądy i wiadomości

Protokół kompletnego raportu prosi o wersjonowany blok YAML przed `<!-- agentctl:report-end -->`:

```agentctl-outputs
version: 1
verdict: PASS
commits: [{repo: app, branch: feature, sha: aaaaaaa}]
integrate: [{repo: app, branch: feature, sha: aaaaaaa, note: propozycja integracji}]
decisions: [Wybierz termin wdrożenia]
actions: [{title: Wdrożenie po zgodzie, shell: "echo proponowana komenda"}]
checks: [{name: unit tests, result: PASS}]
preview: https://example.invalid/preview
notes: []
```

`outputs`, `outputs_valid` i `outputs_errors` opisują fakty. Gałęzie i SHA muszą istnieć w repozytoriach zadania. Brak/błąd danych ostrzega, lecz kompletny raport nadal jest gotowy. Akcje są propozycjami; agentctl nie wykonuje ich komend, nie ocenia wyniku i nie scala. `status` liczy decyzje/akcje; `pull_ready` i `get_report` pokazują dane. `cohort_show` zbiera propozycje integracji (oznacza duplikaty i różne SHA tej samej gałęzi), decyzje, akcje i sprawdzenia z ID zadań. `events_since` dodaje nowe decyzje/akcje do `needYou` raz na hash raportu. Walidacja jest per sekcja i per wpis: zły wpis odpada z ostrzeżeniem w `outputs_errors`, poprawna reszta zostaje w `outputs` (`outputs_partial: true`, `outputs_valid: false`), a `status` i `cohort_show` liczą zachowane decyzje i akcje. Cały blok odrzuca tylko zła `version`/`verdict`. Wpisy `checks` mają postać `{name, result: PASS|FAIL|WARN|SKIP, note?}` (forma standardowa); sam tekst (`"unit: PASS"`) lub mapa z jednym kluczem (`- unit: PASS`, tak YAML czyta niecytowany zapis) są przyjmowane i normalizowane, bez względu na wielkość liter.

```yaml
review: auto
# Lub w .agentctl.yaml:
# review: {default: auto, rerun: true, template: review.md}
after: [{task: IMPLEMENT, verdict: [PASS, PARTIAL]}]
repos:
  - path: ~/code/app
    worktree: ~/work/app-check
    branch: check
    base: "@IMPLEMENT:app"
```

Automatyczny przegląd dodaje `TASK-REV` po raporcie autora, na jego gałęzi i w tej samej kohorcie. Preferuje innego dostępnego dostawcę z `review.*` lub `equivalents`; w razie niedostępności wymaga innego skonfigurowanego modelu. Brak poprawnej pary daje jawny wpis o oczekującym przeglądzie. Recenzent dostaje własny odłączony worktree (`<worktree_root>/<repo>-<task>-rev`, po jednym na repozytorium autora, przypięty do commita autora) i pisze raport pod `cache/<task-rev>/<TASK-REV>.md`; nigdy nie dzieli checkoutu ani gałęzi z autorem. Startuje dopiero po zakończonej turze autora (report-end, czas settle raportu, brak follow-upu w kolejce lub niepotwierdzonego, brak szkicu, brak git w checkoucie autora); do tego czasu kolejka pokazuje `czeka na autora …`. Jeśli autor zrobi nowy commit przed startem, przegląd przypina się do nowego SHA (delta i heads zaktualizowane, wpis `review-repinned`). `review.rerun: true` tworzy `REV2` po nowym raporcie, z SHA zapisanym dla poprzedniego przeglądu jako bazą delty. Pierwszą bazą jest zapisana baza autora. Szablon znajduje się w `docs/examples/`, a ustawienia opisuje dokument konfiguracji.

`base: "@TASK"` przy starcie wybiera commit z outputs tego zadania, a bez niego HEAD jego gałęzi; przy wielu repozytoriach podaj `:repo-name`. Konkretny commit widać w podglądzie new i w TASK.md. Brak lub niejednoznaczność blokuje start. Warunkowe `after` blokuje przy innym werdykcie albo z powodem `brak werdyktu`; zwykłe `after: TASK` nadal czeka wyłącznie na kompletny raport.

`send` od razu wkleja follow-up pracującemu Claude/Codexowi. Potwierdzenie wymaga przyjęcia, nowego stanu pracy, echa transkryptu/kolejki lub nowego kompletnego raportu. Sam `idle_prompt` ani spóźniony Stop nie potwierdza dostarczenia; zablokowane pole daje `needs-attention` po `delivery_confirm_s`. Adapter wymagający bezczynności (`accepts_busy_prompt: false`) lub niepotwierdzona poprzednia wiadomość zatrzymuje kolejne w trwałej kolejce FIFO. Status/peek pokazują kolejkę, odpowiedź mówi „wklejono”, pozycję w kolejce albo „niepotwierdzone”. Watch wysyła po kolei.

Limit dostawcy daje jedno powiadomienie na epizod, z czasem resetu albo `n/d`. Świeży odczyt wolnego limitu powyżej `limited.resume_above_percent` (domyślnie 5) lub upłynięcie znanego resetu dopuszcza wysłanie `limited.message` (`kontynuuj`) do bezczynnego okna z pustym polem. Zabezpieczenia overload sprawdzają warunki przed wklejeniem i Enterem; licznik prób i ograniczenia przeżywają restart. `limited.auto_resume: false` wyłącza wysyłanie. Dostawca i model pozostają te same.

`agentctl mark --cohort NC ok --note "sprawdzone"` pokazuje dokładny zakres; `--yes` go potwierdza. MCP przyjmuje `task`, `tasks` lub `cohort`; więcej niż jedno zadanie wymaga podglądu/potwierdzenia. Przy filtrze kohorty board `o/p/f` pokazuje ID przed oceną. Agentctl zapisuje wynik podany przez człowieka. Zamknięcie wszystkich zadań kohorty daje `gc_suggest` z chronionym planem sprzątania tej kohorty, bez automatycznego usuwania.

Podglądy MCP mają niezależne `preview_token`, ważne dziesięć minut, i odmawiają wykonania po zmianie zakresu. Przekaż token oraz identyczne argumenty z `confirm: true`; bez tokena działa ostatni pasujący podgląd. `gc_preview` dla kohorty podaje tylko liczbę obcych worktree; potwierdzone `gc` zwraca wyniki bez powtarzania planu. `notify.mcp_writes` domyślnie ma `summary`, najwyżej raz na 60 sekund; dostępne też `all` i `off`. Audyt pozostaje pełny. F12 wraca do boarda własnej sesji, także przy równoległym dev. Czas obejmuje checkout/setup przed uruchomieniem agenta; ostrzeżenie o starym odczycie planu pojawia się raz na odczyt.

## Aktywni dostawcy i Kimi

Dobieraj spośród aktywnych `providers`: Claude i Codex są obowiązkowe, Kimi opcjonalny. Equivalents według klas modeli to mapowania do przydziału pracy; sprawdź aktualne capacity i miejsca. Przy trzech dostawcach move wymaga jawnego `--agent`. Automatyczny review kieruje się `review.prefer` lub kolejnością providers, pomija autora, niedostępne CLI i cele bez mapowania.

Kimi Code 2.5.0 nie ma sandboxa CLI. Ręczne reguły zgód określają pytania narzędzi; Write może przejść bez dialogu. Trust/login/update rozstrzyga człowiek. Effort low/high/max działa wyłącznie według `support_efforts` modelu z configu; bez danych katalogu nie wymuszamy env effort. Nazwy wyświetlane i aliasy bez wersji są dynamiczne. Manager i Remote Control pozostają Claude-only.

Capacity planu Kimi to n/d bez `capacity.kimi_usage_probe`; neutralna sesja wymaga ręcznego trust. Limitowana sonda `/usage` odczytuje TUI, bez credentials/OAuth ani API, nigdy w oknie zadania. Uwzględniaj 5h/Weekly/Monthly wyłącznie, gdy występują. Prompt, odczytane pliki, wyniki poleceń i diffy trafiają do Moonshot AI; domyślne wyłączenie telemetrii nie zatrzymuje przesyłania danych zadania. Guide projektu może jawnie zakazać Kimi w danym repo.

```yaml
---
task: EXAMPLE-KIMI
agent: kimi
model: k3
effort: high
repos: [{path: /path/to/repo, worktree: /path/to/worktree, branch: task/example}]
---
Zapisz kryteria odbioru, ograniczenia i wymagania raportu.
```

Wzorce auth/limit/overload/background Kimi, stopka kolejki w trakcie pracy, ścieżki sesji i interakcje wire są hipotezami z syntetycznymi fixture; nie opisuj ich jako potwierdzonego działania prawdziwej wersji 2.5.0.
