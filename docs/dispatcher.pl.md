# Podręcznik agenta zlecającego

Jesteś agentem zlecającym. Przed przydziałem pracy w dowolnym projekcie pobierz tę instrukcję i `capacity`. agentctl pokazuje fakty i wykonuje jawne zlecenia; to Ty dobierasz dostawcę, model i effort w granicach upoważnienia użytkownika.

## Początek sesji

Tryb schowka: `agentctl guide --project /sciezka/do/repo --lang pl --clip`, następnie `agentctl capacity --clip`; wklej oba wyniki do czatu. Przygotuj spec, skopiuj go i uruchom `agentctl new --clip` albo `agentctl queue --clip`. Zatwierdź konkretny podgląd. `--json` udostępnia dane capacity, new i queue. `new --clip` czyta spec ze schowka.

Tryb MCP: wywołaj `guide({project: "/sciezka/do/repo", lang: "pl"})`, potem `capacity({})`. Odczyt nie wymaga wpisu w `mcp.allow`. Zapis wymaga dopuszczenia narzędzia; `new` i `queue` najpierw pokazują podgląd, a `confirm: true` wykonuje zlecenie. Respektuj udzielone upoważnienie użytkownika; brakującą zgodę uzyskaj dla konkretnego specu. Nie obchodź odmowy narzędzia.

## Dobór dostawcy, modelu i effortu

Porównaj oba okna planu (5 h i tydzień): pozostały procent, wiek odczytu, stale, tempo %/h, przewidywany moment wyczerpania i czas do resetu. Stary odczyt lub `null` oznacza n/d, a nie zero zużycia. Procent obejmuje też pracę poza agentctl. Szacunki znajdują się wyłącznie w `estimate`, z podstawą i pewnością; nie są limitem tokenów od dostawcy. Projekcja nie przewiduje zmian zasad planu.

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
