# Funkcje

## Zlecenia i cykl życia

Specyfikacja zawiera YAML między separatorami `---` i prompt poniżej. Jeden plik może zawierać kilka zleceń. `new` pokazuje plan i uruchamia pracę od razu; `queue` rejestruje ją do obsługi przez watch. Repozytoria mogą mieć osobne worktree, bazy, gałęzie i setup; linki i środowisko wynikają z warstw konfiguracji. Placeholdery `{task}`, `{TASK}` i `{cache}` rozwijają ścieżki. `class` wybiera model/effort z [macierzy](../../data/model-matrix.yaml); jawny model/effort wygrywa z ostrzeżeniem. `pin` zabrania translacji dostawcy i move. `touches` ostrzega o wspólnych plikach, ale ich nie blokuje.

`after` czeka na kompletne raporty poprzedników i akceptowany werdykt w pierwszej linii: domyślnie PASS, PASS with findings, PARTIAL lub GO. `after_verdict` zmienia zbiór, także na jawne FAIL/BLOCKED, jeśli to zamierzone; wymaga `after`. Nieznane zależności i cykle są błędem. Brak werdyktu oznacza oczekiwanie, gdy autor działa lub raport jeszcze się stabilizuje; jawne odrzucenie blokuje. Poprawiony akceptowany raport sam zwalnia zależne zadania zablokowane werdyktem przy następnym ticku watch (P94). `unblock` / `queue up` pozwalają ręcznie zwolnić zależność po ocenie brakującego wyniku.

Kolejka uruchamia high przed normal, FIFO w każdej klasie. `weight: heavy` współdzieli `limits.heavy` między dostawcami; natychmiastowe `new` jest poza tą regułą. Sloty, rezerwacje, opcjonalne sesje zewnętrzne, pauza, zależności, hold planu i ochrona dysku mogą opóźnić start. `queue show/list/up/rm/retry/pause/resume` wyjaśniają i obsługują kolejkę. Nieudany start domyślnie zostawia okno diagnostyczne i `start-failure-screen.txt`; retry najpierw zamyka to okno.

| Stan zadania | Znaczenie |
|---|---|
| `host-unreachable` | SSH nie dociera do hosta zadania; zachowaj okno i slot, ponawiaj z backoff |
| `needs-attention` | Problem dostarczenia, utraconego okna lub zapisu stanu wymaga uwagi |
| `overloaded` | Rozpoznane przeciążenie dostawcy |
| `working` | Trwa tura dostawcy |
| `background` | Trwają zadania dostawcy w tle |
| `waiting` | Agent jest bezczynny, bez kompletnego raportu |
| `needs-input` | Pytanie, zgoda lub onboarding czeka na właściciela |
| `needs-trust` | Zaufanie folderu wymaga człowieka w oknie |
| `limited` | Dostawca zgłasza wyczerpany limit/kredyty |
| `report-ready` | Raport bieżącej próby jest kompletny, agent bezczynny lub nieobecny |
| `superseded` | Pierwotne zadanie po jawnym move |
| `dead` | Brak okna i odpowiedniego raportu |
| `closed` | Właściciel zamknął zadanie; dostępne w widoku wszystkich |
| `cancelled` | Praca porzucona; worktree i gałąź zostają |
| `orphan` | Okno zadania bez metadanych |

`interrupt` kończy turę, zachowując okno. `send` dodaje instrukcję; wiadomości do zajętego Codexa czekają trwale do potwierdzonego końca tury i mają ID do `withdraw`. Dostarczenie jest sprawdzane; szkic w polu nie oznacza sukcesu. `answer` bezpiecznie wybiera obsługiwane pytanie; numerowane needs-input/needs-trust wymaga jawnego potwierdzenia dokładnego menu. Start/watch nigdy sam nie akceptuje trust. `resume` kontynuuje znaną sesję bez ponownego wklejania pierwszego promptu. `move` przechodzi na innego aktywnego dostawcę w tym samym worktree; odmawia przy pin i po wcześniejszym move. `adopt` odtwarza metadane na podstawie jawnych faktów. Zamknięcie, anulowanie, ukrycie, archiwizacja i usunięcie worktree to osobne czynności.

## Watch, board i powiadomienia

`watch` odpytuje zadania, obsługuje hooki i pasywne transkrypty, potwierdza dostarczenie promptów, wczytuje poprawny config, uruchamia pracę, zapisuje zdarzenia i prowadzi CONSULT. Restart uzgadnia trwały stan; istniejące okna zadań działają dalej. `up` organizuje watch, board i opcjonalnie manager; okna usług mają stałe role tmux. Powiadomienia desktopowe obejmują skonfigurowane zdarzenia, pytania, trust, raporty, limity i wyniki zapisów. Opcjonalne ntfy wysyła zdarzenia na telefon w trybie away (`away` / `ntfy-setup`); drugą ścieżką jest manager Claude z Remote Control. Żadna z nich nie wystawia lokalnego MCP publicznie.

Board Ink ma listę zadań i peek zaznaczonego zadania, kohorty i zwijanie grup, kolejkę, sekcje finished/closed/cancelled, wiadomości i potwierdzenia, log, limity, capacity, podgląd GC oraz WALL. `Enter` otwiera okno zadania; skonfigurowane `F12` wraca. `?` pokazuje klawisze, `k` filtruje kohortę, `g/E` zwija/otwiera grupy, `z/a` pokazuje finished/wszystkie, `L/C/D/l/W` otwiera limity/capacity/GC/log/WALL. `m` pisze wiadomość, `x/X` zamyka/anuluje po potwierdzeniu, `u/d/p` przesuwa/usuwa/pauzuje kolejkę. `o/p/f` ocenia skończoną pracę ok/partial/fail. Od 110 kolumn pojawia się peek. [Widoki pokazuje galeria](screenshots.md).

## Raporty, zdarzenia i przegląd

Raport ma kanoniczną dozwoloną ścieżkę, marker bieżącej próby i `<!-- agentctl:report-end -->` albo stabilizuje się po potwierdzonym końcu tury. Fragment lub raport starej próby nie jest gotowy. Ścieżki alternatywne są kandydatami; `report --from` jawnie kopiuje dozwolony zwykły plik. Pierwsza linia to `Verdict: …` lub `Werdykt: …`. Blok YAML `agentctl-outputs` w wersji 1 zawiera werdykt, commity, propozycje integracji, decyzje, działania, kontrole, opcjonalny preview i uwagi. Referencje Git sprawdzane są lokalnie; błędne wpisy ostrzegają, poprawne części zostają. Proponowane działania nie wykonują się automatycznie. `wall_posts` jest osobno sprawdzanym rozszerzeniem opisanym niżej.

`pull` kopiuje raporty; MCP `pull_ready` domyślnie daje podsumowanie. Dostarczenie podsumowania, pełne odebranie i ludzki `mark` są osobnymi faktami. `get_report` domyślnie oznacza pulled po podsumowaniu/pierwszej pełnej stronie; `mark_pulled: false` wyłącza, `true` jawnie potwierdza. Pozostałe strony pokrywają raport w dowolnej kolejności; sekcje domyślnie nie oznaczają. `review_of` łączy przegląd z autorem; `review: auto` kolejkuje innego dostępnego dostawcę po autorze, na zapisanych commitach i z polityką rerun. GO / GO-WITH-CHANGES / NO-GO mapuje się na PASS / PARTIAL / FAIL. `cohort show` agreguje outputs i wykrywa konflikt referencji.

`events_since` czyta przyrost na klienta, nie jest subskrypcją push. Wywołuj je na początku każdej odpowiedzi o pracy; podaj `as: "chat:<name>"` dla WALL. Pierwszy odczyt obejmuje 24 godziny; `peek: true` nie przesuwa kursora. Dziennik zawiera werdykty, pytania, trust, kolejkę/setup/błędy, blokady, limity, outputs i etapy CONSULT. Ciągła obserwacja wymaga watch. [MCP i Accepted](mcp-tools.md) opisują retry i stronicowanie.

## WALL i CONSULT

WALL to komunikacja kanałowa dopisywana do historii. Domyślne kanały to `agentctl`, `nc`, `hems`, `shared:sim`, `shared:weather` i `shared:maps`. Wiadomości mają typ info/question/decision-request/contract-change/answer, refs, wątki i status open/answered/accepted/rejected/superseded. Uprawnienia autorów i subskrypcje ograniczają dostęp; deklarowana tożsamość nie jest uwierzytelnianiem. CLI właściciela widzi wszystkie kanały. Board `W` czyta kanały, wiadomości i wątki; `s/t` filtruje status/typ, `r/R` oznacza przeczytanie. Nie zmienia statusu wiadomości: do tego służy CLI/MCP.

`wall: [nc, "shared:*"]` w specyfikacji dodaje ograniczony kontekst otwartych wiadomości jako dane tylko do odczytu. Raport zadania może zawierać `wall_posts: [{channel, kind, subject, body, refs}]` w outputs: watch/przetwarzanie raportu publikuje każdy dozwolony wpis raz na próbę jako `task:<ID>`. Odmowa wpisu jest uwagą, nie odrzuceniem raportu. Treść ma ≤8 KB; refs wskazują dozwolone ścieżki/commity/zadania/wiadomości bez załączników. Skaner odrzuca wykryte poświadczenia. Decyzje i zmiany kontraktu wymagają wyboru właściciela; czat podaje `owner_confirmed: true` dopiero po tym wyborze.

CONSULT prowadzi 2–26 panelistów z co najmniej dwóch aktywnych dostawców, 1–3 rundy (domyślnie 2), potem syntezę: paneliści × rundy + 1 zadań. Służy kosztownym decyzjom i pokazuje liczbę zadań oraz usage przed akceptacją. Odłączone snapshoty `read_only` pomijają setup/linki, mają blokadę commitów i bazę HEAD; to ochrona umowna, nie izolacja systemowa. Pierwsza runda jest niezależna; kolejne widzą stałe anonimowe etykiety i własną odpowiedź jako „yours”. Usuwanie nazw dostawców/autodeklaracji jest przybliżone. Odpowiedź wymaga Recommendation, Reasoning, Risks, Confidence 1–5, Unknowns, a później Changed. Synteza waży argumenty zamiast głosów i daje GO/NO-GO/SPLIT; dopiero po jej ukończeniu raport właściciela ujawnia mapę autorów. `post_to` opcjonalnie publikuje raz na WALL. Niepoprawne odpowiedzi czekają na naprawę; anulowanie blokuje. Restart naprawia częściową rejestrację.

## Ekonomia, utrzymanie i regresje

`limits` kontroluje liczbę równoległych okien; `capacity` łączy odczytane okna planu, sloty, kolejkę, dysk/load i oznaczone estymacje. `usage` czyta tokeny i plan, w tym osobne dane GLM. MCP `set_limits` składa wniosek o zmianę `queue_hold`, a właściciel może ją zastosować z tablicy lub CLI. [Ekonomia](token-economics.md) wyjaśnia braki danych i koszt benchmarku.

`log` i `stats` podsumowują próby i ludzkie oceny; `dataset export` eksportuje lokalny benchmark JSONL/CSV z pochodzeniem danych i jawnym włączeniem treści. `gc` najpierw pokazuje chroniony plan; brudna/aktywna/niescalona praca jest chroniona, gałęzie usuwa `git branch -d`. `history` to zapis prób dostępny przez log/stats/export, a nie polecenie CLI o nazwie history. `archive` archiwizuje stan zamkniętych zadań; `mirror_dir` kopiuje raporty/status dla lokalnego czytelnika. `doctor` diagnozuje połączenia, bezpieczeństwo, dostawców, stary MCP, dysk i config; `--timings` mierzy budżety odczytów.

[Katalog regresji](../../tests/regression/CATALOG.md) zapisuje deterministyczne scenariusze błędów, wersje napraw oraz dowód sprzed poprawki lub jawne noProof. `npm run regression` uruchamia katalog, a każdy `npm run gate -- quick|full|release` go zawiera. Kontrole dokumentacji/testów i wydania przechodzą przez gate; produkt nie scala ani nie publikuje automatycznie.

## Referencje worktree i szczegóły operacyjne

Linki mogą wskazywać repo tego samego spec przez {worktree:repo}, opcjonalnie {worktree:repo|fallback}; między zadaniami {task:TASK-ID,repo:repo}/sub/path używa zapisanego worktree. Brak/niejednoznaczność daje błąd podglądu; stare dziedziczone linki ostrzegają, bez samoczynnego przestawiania. Base task:<ID> rozwiązuje zapisany commit autora, nie ruchomą gałąź z czasu zlecenia. new --reuse jawnie wykorzystuje sprawdzony checkout; nie odzyskuje nieznanej rozmowy dostawcy.

Automatyczny review ma własny detached checkout i raport z zapisaną deltą/bazą. Czeka na koniec tury autora, stabilny raport z markerem, brak szkicu/pending delivery i aktywności Git; nowy commit przed startem przypina przegląd ponownie. Ten sam dostawca wymaga innego modelu. Ludzki mark obsługuje zadanie/kohortę zgodnie z referencją CLI. Selektory wielu zadań i operacje destrukcyjne pokazują rzeczywisty zakres.

Kontekst CONSULT obsługuje zwalidowane referencje task/WALL/file/commit w dozwolonych korzeniach, zamraża commity/kontekst i nie załącza dowolnej ścieżki z innego czatu. Raport może uruchomić chronione sprzątanie .cache worktree dopiero po stabilnym markerze i końcu tury, bez wspólnego checkoutu/symlinka poza nim; node_modules zostaje. report.clean_worktree_cache wyłącza tę politykę.

Manager i telefon wymagają lokalnej konfiguracji: ntfy-setup tworzy sekret subskrypcji; notify-test --phone jawnie testuje wysyłkę, away steruje zwykłymi powiadomieniami. Wewnętrzne event i usage-tap są callbackami, nie dostępem czatu do powłoki. Dokładne selektory/flagi i operacje terminalowe opisuje [generowana referencja CLI](../commands.md), a [mapa źródeł](../reference/source-map.md) wskazuje kod i testy.

## Operacje w 0.22.2–0.22.3

Podgląd MCP new/queue odkłada bazę, nakładanie worktree i kontrolę dysku do watch; po Accepted może przyjść zdarzenie błędu. Brak bazy daje teraz np. `base main not found – default branch is master`. Źródłem jest lokalny origin/HEAD albo HEAD main/master; brak danych jest jawnie nieznany. Popraw spec i ponów; nie ma automatycznej podmiany.

Weryfikacja send zachowuje własność przewiniętego wielowierszowego pola Codexa i wymaga dowodu dostarczenia, także potwierdzenia w transkrypcie; samo wklejenie nie oznacza dostarczenia. Zwinięte pytania Codexa zachowują tekst. Restart watch emituje `WATCH WZNOWIONY`. Pomoc boardu przewija się ↑↓/PgUp/PgDn i mieści się w wysokości terminala.

Identyfikatory baz i SHA outputs są tekstem YAML (cytuj SHA, również wyglądające jak liczba/notacja wykładnicza). Pierwsza linia przyjmuje `Verdict:` i `Werdykt:` oraz ma pierwszeństwo przed werdyktem outputs. Pod commits/integrate zwięzłe mapy outputs przyjmują `- repo: example, branch: dev, sha: "2742e697"` obok obiektów. Używaj istniejących gałęzi/SHA, bez placeholderów; checks przyjmuje name/result, mapy jednokluczowe lub tekst. Najczytelniejsze są wpisy name/result.

Confirm WALL zapisuje synchronicznie, bez obiegu przez watch. Zdarzenia używają kursora skonfigurowanego `as`, pokazują ograniczoną sekcję `WALL do Ciebie (open)` i oznaczają rzeczywiste własne wpisy `(yours)`; nieznane czaty dostają ostrzeżenie. [Semantyka MCP](mcp-tools.md) wyjaśnia wiek snapshotów i potwierdzanie raportów.

Blokady dostawców, wiek statusu, zastępowanie kolejki i kolizje integracji: [opis 0.22.4](configuration.md#hotfix-0224-wstrzymania-dostawców-snapshoty-i-integracje).
