# Rozwiązywanie problemów

Zacznij od `agentctl doctor`, `agentctl version`, `agentctl status --all` i `agentctl queue list` w docelowym AGENTCTL_HOME. Nie naprawiaj instancji przez zmiany innego home. `doctor --timings` mierzy sekcje budżetu odczytu; MCP doctor używa cache/budżetu, nie testuje inference.

| Objaw | Sprawdzenie i naprawa |
|---|---|
| Brak CLI / zła wersja | Node ≥22.14.0, PATH, command -v agentctl i stabilna kopia. Dry-run updatera pokazuje cel. Bieżące npm Kimi wymaga ≥22.19.0. |
| Brak/stare narzędzia MCP | version/mcp_check; bezwzględne Node/skrypt/env w configu. Zamknij całą aplikację Cmd+Q i otwórz. Logi mcp-server-agentctl.log/mcp.log są w ~/Library/Logs/Claude. |
| Odmowa zapisu | config_show i ostrzeżenia mcp.allow. Dodaj tylko potrzebną nazwę/grupę; nie obchodź powłoką/tożsamością. |
| Podgląd wygasł/zmienił zakres | Nowy podgląd, pokaż zakres i uzyskaj brakującą zgodę. Zachowuj sesję/argumenty. Retry timeout używa tego samego tokenu, nie nowego zlecenia. |
| Accepted bez okna | Watch, events_since, queue_show/list: accepted → walidacja → queued/starting albo failed. Sprawdź zależności, sloty, pauzę, hold, heavy i setup. |
| needs-trust / onboarding | Otwórz okno i odpowiedz ręcznie; watch dostarczy pierwszy prompt po gotowości. Trust rodzica nie gwarantuje trust nowego Git worktree. |
| Nieudany start | start-failure-screen.txt/peek i setup.log. Okno domyślnie zostaje. Napraw przyczynę; queue_retry zamknie stare okno i zwaliduje ponownie. Nie usuwaj niepewnych pozostałości Git. |
| Brak dostarczenia promptu | prompt_delivery, ID wiadomości i peek. Nie wciskaj Enter w ciemno ani nie powtarzaj zlecenia. enter_only wymaga niezmienionego własnego pola/tokenu. |
| Follow-up Codex czeka | Zajęty Codex kolejkuje do potwierdzonego końca tury. Sprawdź message_id/pending; withdraw gdy zbędne. Raport pozostaje czytelny z ostrzeżeniem. |
| after blokuje | Pierwszy werdykt poprzednika. FAIL/BLOCKED/NO-GO zwykle blokuje; brak werdyktu w trakcie może czekać. Poprawiony raport sam odblokuje; ręczne unblock/drop-after to decyzja właściciela. |
| Brak/stary raport | Kandydaci, ścieżka kanoniczna, marker próby i report-end. Sam mtime nie uaktualnia próby. report_from tylko dozwolone zwykłe pliki, bez symlinków/wyjścia poza korzenie. |
| Podsumowanie przeczytane, nadal unpulled | `get_report` podsumowanie/pierwsza pełna strona oznacza domyślnie; sprawdź mark_pulled: false. Pozostałe strony łączą się w dowolnej kolejności. pull_ready skrót nie oznacza, full/ack tak; mark osobno. |
| limited / kwota n/d | Źródło/wiek/reset capacity. n/d to brak danych, zwłaszcza GLM. Sprawdź auto-resume albo jawne resume/move. Bez cichej zmiany dostawcy. |
| GLM motyw / banner auto-mode | Uruchom raz claude-glm w osobnym configu i ukończ onboarding. Banner/MCP auth warning nie blokuje startu. AUTO_MODE_SERVER=0 tylko dla zadania GLM. |
| Kimi odmawia bezpieczeństwa | Doctor czyta config.toml: auto lub wyłączony guard jest odrzucany. Zachowaj guard, wspierany manual/yolo config; nie obchodź trust flagami. |
| WALL niewidoczny / odmowa | as: chat:name i wall.chats/channels/subscriptions/authors. Nieznany czyta tylko agentctl. Treść przez wall_read ID; events daje nagłówki. |
| Odmowa statusu decyzji WALL | Decyduje właściciel; czat przekazuje z owner_confirmed true dopiero po decyzji. WALL na boardzie tylko czyta/oznacza przeczytanie. |
| CONSULT stoi | Watch, kohorta/stan consult i przyczyny raportów. Napraw strukturę/bieżącą próbę lub zdecyduj o anulowanym uczestniku; nie wymyślaj odpowiedzi. |
| Okno zniknęło | Status pokazuje dead/resumable; resume kontynuuje sesję, adopt odtwarza metadane wyłącznie z faktów. Restart watch nie odtwarza utraconego tmux. |
| Dysk / GC pomija | gc --preview pokazuje bajty/powody. Chroń aktywne, brudne, cudze, linkowane i niescalone. Apply po ocenie planu; nie usuwaj siłą dla gate. |
| Błędny reload configu | Poprzedni config działa; doctor/status/log wskazuje błąd. Popraw YAML/typ/klucz i zapisz. Tytuł boardu może wymagać restartu widoku. |

## Dane lokalne i diagnoza

Domyślne pliki są w ~/.agentctl (tasks, queue, archive, journal, wall, consult, usage, audyt/żądania/potwierdzenia MCP). Korzenie stanu/raportów mogą się różnić. Raport ma ścieżkę zadania; sprawdzaj task_spec/report/config_show, zamiast zgadywać. Wyjście z boardu nie zatrzymuje okien ani worktree. `q` kończy board, nie agentów.

Doctor sprawdza instalację/flagi, trust/onboarding, hooki/settings/MCP, stare procesy, config/linki i dysk. Ostrzeżenie o protokole Kimi, nieznanym modelu lub kwocie to ograniczenie obserwacji, nie dowód awarii. Sondy nie wykonują tur modelu; tylko opcjonalne neutralne /usage i RPC odczytu Codex. Testy/gate używają atrap, chyba że konkretny scenariusz live mówi inaczej.

Dla rozwoju uruchamiaj `npm run gate -- quick` z bezwzględnym AGENTCTL_LIVE_CACHE własnego zadania; szersze gate mają opisany zakres. Każdy poziom zawiera regresje. Nie zastępuj nieudanego testu wymyślonym PASS. Zobacz [katalog regresji](../../tests/regression/CATALOG.md) i [CONTRIBUTING](../../CONTRIBUTING.md).

<!-- tmux-dev-start -->
### Osobny serwer tmux dla developmentu

Używaj osobnego katalogu konfiguracji **i** serwera: sama inna nazwa sesji nadal współdzieli środowisko serwera, skróty klawiszowe i bufory. W katalogu checkoutu deweloperskiego ustaw home i edytuj istniejącą konfigurację, zachowując pozostałe ustawienia:

```sh
export AGENTCTL_HOME="$HOME/.agentctl-dev"
mkdir -p "$AGENTCTL_HOME"
${EDITOR:-vi} "$AGENTCTL_HOME/config.yaml"
```

Dodaj albo zmień te klucze najwyższego poziomu:

```yaml
session: agentctl-dev
tmux:
  socket: agentctl-dev
```

`tmux.socket` jest nazwą przekazywaną do `tmux -L`, a nie ścieżką gniazda. Pominięcie klucza zachowuje dotychczasowy wybór serwera. Watch, board, zadania, peek, send, close, attach i doctor używają tego serwera, także przy bezpośrednich wywołaniach tmux. Wskazówki attach cytują dokładny cel, więc `agentctl` nie wybierze prefiksem sesji `agentctl-dev`. Doctor pokazuje gniazdo i ostrzega o innym `AGENTCTL_HOME` w globalnym środowisku serwera lub środowisku sesji.

Uruchom z terminala poza tmux:

```sh
node --experimental-strip-types --no-warnings bin/agentctl.ts up --no-attach
node --experimental-strip-types --no-warnings bin/agentctl.ts doctor
tmux -L agentctl-dev attach -t '=agentctl-dev'
```

Aby przenieść istniejącą **sesję dev o nazwie agentctl-dev na domyślnym serwerze**, najpierw zachowaj starą konfigurację bez socket, sprawdź status i okna, a potem pozwól agentom skończyć lub zapisać rozmowy. Poniższe usunięcie starej sesji dev kończy jej procesy; wykonaj je dopiero po zapisaniu pracy i sprawdzeniu zapisów identyfikatorów sesji w stanie zadań dev. Nie zabijaj całego domyślnego serwera: może zawierać sesję produkcyjną.

```sh
export AGENTCTL_HOME="$HOME/.agentctl-dev"
node --experimental-strip-types --no-warnings bin/agentctl.ts status --json
tmux list-windows -t '=agentctl-dev'
tmux kill-session -t '=agentctl-dev'
${EDITOR:-vi} "$AGENTCTL_HOME/config.yaml"
```

Teraz dodaj powyższe klucze YAML, pozostaw stare worktree i stan zadań, a procesy dev uruchom ponownie, aby wczytały socket. Zrestartuj również proces MCP dev. tmux nie przenosi działających procesów agentów między serwerami; resume odtworzy ich okna na nowym serwerze.

```sh
node --experimental-strip-types --no-warnings bin/agentctl.ts up --no-attach
node --experimental-strip-types --no-warnings bin/agentctl.ts status
node --experimental-strip-types --no-warnings bin/agentctl.ts resume
node --experimental-strip-types --no-warnings bin/agentctl.ts doctor
tmux -L agentctl-dev attach -t '=agentctl-dev'
```

Po utracie serwera/sesji niedokończone zadania pokazują `needs-attention`, wskazówkę odzyskania i jedno zdarzenie `tmux-lost` w dzienniku na epizod utraty. Claude zapisuje identyfikator przy `SessionStart`; zapisy pozostałych dostawców zachowujemy od razu po otrzymaniu. Jeśli istnieje zapisana sesja, po sprawdzeniu listy użyj wskazanego `agentctl resume TASK`. Bez niej przygotuj spec z **nowym ID zadania**, skieruj repozytoria na stare worktree i uruchom zadanie zastępcze przez `agentctl new --reuse recovery.md`; nie zakładaj, że `--continue` lub `--last` wskaże utraconą rozmowę. Gotowe raporty oraz zadania zamknięte i anulowane zachowują dotychczasowy stan.
<!-- tmux-dev-end -->

Baza `main` nie istnieje: komunikat wskazuje lokalną gałąź domyślną (np. `master`) albo brak metadanych. Popraw `repos[].base` i ponów; agentctl nie zmienia jej automatycznie.

## Watch przestał odpowiadać lub wystąpił timeout `start.lock`

Sprawdź log watch i `agentctl events`. Zobaczysz etap, który się zatrzymał, odzyskanie blokady i wynik restartu. Po ponad trzech cyklach bez zakończenia etapu watch zapisuje jedno zdarzenie dla właściciela. Po dziesięciu minutach kończy działanie. Nadzorca tmux wznawia watch z rosnącą przerwą, do pięciu restartów w dziesięć minut. Po wyczerpaniu limitu sprawdź log i użyj `agentctl watch --tmux --restart`.

Przerwany start wraca do kolejki i wykorzystuje kompletne, zweryfikowane worktree. Watch zachowuje rozpoczęte dostarczanie promptu i odmawia użycia niepewnego checkoutu. Zapis MCP przerwany w trakcie wykonywania otrzymuje błąd z poleceniem sprawdzenia skutków i wykonania nowego podglądu.
