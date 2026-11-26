# Bezpieczeństwo wydania

W czystym checkoutcie kandydata ustaw bezwzględną ścieżkę zadania w `AGENTCTL_LIVE_CACHE`. Na końcowym SHA uruchom `npm run gate -- quick`, `npm run gate -- full --node26-only` i `npm run gate -- release`. Dopiero potem utwórz tag. Bramka wydania porównuje SHA i zawartość plików przed każdym krokiem i po nim. Obejmuje katalog regresji, testy zainstalowanej paczki na Node 22 i 26, scenariusze live i canary o skali produkcji. Ostatni test można uruchomić samodzielnie przez `npm run gate -- prodshape`. Pliki robocze usuwa `npm run gate -- clean`.

Scenariusz produkcyjny ma 1500 rekordów zadań, ponad 2000 katalogów worktree na symulowanych woluminach, 40 zleceń z czterech czatów i 150 wiadomości WALL. Uruchamia właściwy watch na co najmniej 20 przebiegów z atrapami agentów, obciążeniem co najmniej dwukrotności liczby rdzeni i opóźnionymi odczytami dysku. Dopuszczone zlecenie musi wystartować w ciągu dwóch przebiegów. Test sprawdza pełny snapshot młodszy niż 60 sekund, najwyżej trzy kolejne pominięcia etapu, pełne odczyty MCP poniżej ośmiu sekund, potwierdzenia queue/close/GC oraz dysk i limity w nagłówku board. Przekroczenie ośmiu sekund przez MCP przy obciążeniu ponad trzykrotności liczby rdzeni powoduje jedno powtórzenie canary.

Katalog regresji obejmuje utratę danych przez GC w 0.22.4 (D1, D2), odzyskiwanie watch i zapisu po ENOSPC w 0.23.1 (FIELD0253-ENOSPC), start kolejki i zablokowane wiadomości w 0.25.2 (FIELD0253-ADMISSION, FIELD0253-BACKGROUND), woluminy zewnętrzne (W102-VOLUME) oraz dziewięć zgłoszeń z 0.26.0 (W110-A–W110-I). [Katalog regresji](../../tests/regression/CATALOG.md)

## Próba na danych produkcyjnych przed aktualizacją

Na maszynie dev uruchom CLI kandydata na kopii albo widoku produkcyjnego `AGENTCTL_HOME` dostępnym do odczytu. Cache canary umieść poza źródłowym katalogiem, jego katalogiem stanu i cache.

```sh
cd ~
~/Projects/agentctl/dist/bin/agentctl.js canary --from "$PROD_AGENTCTL_HOME" --minutes 30
```

Polecenie odczytuje konfigurację i stan źródła. Zachowuje liczby zadań i zleceń, zależności, ścieżki i czasy w prywatnej kopii tymczasowej. Podstawia sztuczne prompty i raporty oraz pomija dane uwierzytelniające, transkrypcje, hooki i polecenia setup. Git, tmux i dostawcy są symulowani. Kopia ma symulowane limity z zapasem dla zleceń kontrolnych. Wynik pokazują kod wyjścia i metryki. Po zakończeniu kopia jest usuwana.

## Aktualizacja stabilnego klona

Przy pierwszym przejściu z wydania bez rollbacku użyj skryptu kandydata. Gdy tag jest dostępny w klonie, uruchom:

```sh
cd ~
repo="$HOME/Projects/agentctl"
git -C "$repo" show v0.27.2:bin/agentctl-update | AGENTCTL_REPO="$repo" bash -s -- --ref v0.27.2
```

Przy kolejnych aktualizacjach używaj `agentctl-update --ref vX.Y.Z`. Skrypt zachowuje poprzednią kompilację, zależności, checkout i konfigurację. Restartuje watch oraz istniejące okno board. W ciągu trzech minut kandydat musi potwierdzić wersję, dwa ukończone przebiegi watch i świeży snapshot, prawidłowe powody oczekiwania w kolejce i próbne dopuszczenie zadania na atrapie dostawcy, pełne odczyty MCP i nagłówek board. Przy błędzie skrypt podaje przyczynę, odtwarza poprzednią kopię z konfiguracją, restartuje usługi, wysyła do właściciela informację na WALL i kończy się kodem błędu. Kopia zostaje do następnej udanej aktualizacji. `--no-rollback` pozostawia kandydata po awarii. `--no-watch` pomija restart usług i kontrolę zdrowia. Opcje klona nie dotyczą instalacji przez npm.

## Raporty i kwoty

Zacznij raport od werdyktu w pierwszym wierszu. Rozpoznawane są `PASS with findings` (PARTIAL dla zależności), `PASS`, `PARTIAL`, `FAIL`, `BLOCKED` i `GO` oraz dotychczasowe warianty werdyktów przeglądu. Możesz dopisać szczegóły w tym samym wierszu. Gotowy raport przy bezczynnym oknie oznacza report-ready. Watch odnotowuje niejasny werdykt oraz zakończone zależności `after` bez werdyktu. W bloku `agentctl-outputs` wersji 1 można podać `deferred: [{cell: smoke, where: pc}]`. Klucze najwyższego poziomu z prefiksem `x_` są pomijane.

W kwocie czatu `set_limits` wartość `{chat: nc, codex: 0}` blokuje starty Codex dla tego czatu. `codex: "off"` albo `codex: null` usuwa kwotę tego dostawcy dla czatu. Nadal obowiązuje limit globalny. Woluminy stanu i cache obowiązuje `disk.min_free_state_gb` (domyślnie 5 GiB), a woluminy worktree `disk.min_free_start_gb` (domyślnie 30 GiB).

## Ręczny powrót do 0.26

Przed zmianą wersji uruchom `agentctl config downgrade-check --to 0.26.x`. Polecenie wskazuje klucze odrzucane przez 0.26.0 i usuwa wygasłe limity czasowe. Użyj `--to 0.26.1`, aby sprawdzić tę konkretną wersję. Zwolnij wskazane rezerwacje czasowe przed zmianą wersji, bo 0.26 ich nie wygasza. Po aktualizacji zamknij Claude przez ⌘Q i otwórz aplikację ponownie, aby każdy czat uruchomił nowy serwer MCP. Watch blokuje bezpośrednią zmianę limitów z serwerów sprzed 0.27.
