# Referencja narzędzi MCP

`agentctl mcp` obsługuje lokalne stdio przez oficjalny SDK MCP. Stdout zawiera wyłącznie protokół; nie ma nasłuchującego portu. CLI i MCP używają wspólnych operacji. Instaluj ze stabilnej kopii przez `agentctl mcp install --desktop` lub `--claude-code`; najpierw podgląd `--dry-run`. Instalator desktopu tworzy backup i zachowuje inne serwery. Po aktualizacji restartuj aplikację.

## Odczyt, podgląd, confirm, obserwacja

Odczyty nie wymagają allow. Każdy zapis jest wyłączony do wpisania nazwy lub jawnej grupy do `mcp.allow`. Wszystkie zarejestrowane zapisy mają wrapper podgląd/confirm, także follow-up: pokaż właścicielowi dokładny cel i argumenty. W tej samej sesji MCP użyj zwróconego `preview_token` z `confirm: true`. Confirm samym tokenem wykorzystuje zapisane argumenty. Domyślnie token żyje `preview.ttl_s: 600`. Zmieniony zakres, uprawnienia, sesja lub wygaśnięcie wymaga nowego podglądu. Retry znanego tokenu odtwarza trwały wynik zamiast dublować wykonanie.

Confirm `new`/`queue` wymaga watch. Zapisuje spec jako `accepted` pod krótką blokadą, zwraca `Accepted` bez ponownego planowania, start.lock i tworzenia worktree. Podgląd sprawdza tanio składnię, model i duplikaty; rozwiązanie bazy, nakładanie worktree i kontrola dysku czekają na watch. Następnie watch sprawdza aktualne fakty; poprawne wpisy kolejkuje/uruchamia, błędne oznacza failed z przyczyną/zdarzeniem/powiadomieniem. `queue_retry` waliduje ponownie. Accepted oznacza rejestrację, nie dowód startu, dostarczenia ani ukończenia.

Przy działającym watch potwierdzone narzędzia zapisują też trwałe żądania: consult, unblock, queue_up/rm/retry, close, cancel, send (w tym withdraw/potwierdzone enter_only), mark, hide/unhide, archive, cohort_add/remove/archive/note. Watch ponownie sprawdza zgodę/zakres, wykonuje i zapisuje `mcp-applied` („MCP WYKONANE”) albo `mcp-failed` („MCP BŁĄD”). Bez watch większość grupy wykonuje się na miejscu; CONSULT wymaga watch. Domyślnie `set_limits` składa wniosek do właściciela. Czasowe wstrzymania dostawców i zapisy WALL są synchroniczne. `wall_post`, `wall_reply` i `wall_set_status` sprawdzają uprawnienia/refs/sekrety i dopisują wynik przed zwróceniem ID/statusu, także przy działającym watch; powiadomienia nie opóźniają confirm. Obserwuj events_since; po timeout nie twórz nowego zlecenia. Confirm ponawiaj tylko tym samym tokenem, potem czytaj stan trwały.

`answer` ma dodatkowy `token` znormalizowanego pytania i etykiet opcji, niezależny od przewijania; wybrana opcja musi być widoczna i niezmieniona. Zgoda na polecenie nadal wiąże jego treść. `send enter_only` ma osobny token dokładnego pola i uprawnienie `send_enter`; wysyła tylko niezmieniony tekst pozostawiony przez wcześniejsze send. Żaden mechanizm nie daje automatycznej zgody trust.

Podgląd wiadomości pokazuje dokładny proponowany tekst, stan okna i bieżącą zawartość pola wpisywania, jeśli jest czytelna. Przy zajętym agencie podgląd opisuje dostarczenie z kolejki. Dopiero potwierdzenie rejestruje dostarczenie lub wysyła klawisze. Dotyczy to okien lokalnych i hostów SSH. Potwierdzenia wymagają też pojedyncza ocena i wycofanie wiadomości. Gdy watch ma przygotować plan zdalnego GC, użyj narzędzia odczytu `gc_preview`. Jeśli pierwszy prompt Kimi utknął w stanie needs-attention, potwierdzona wiadomość może go zastąpić, gdy pole wpisywania jest gotowe i puste. Pierwotne instrukcje zostają w `TASK.md`.

Zapisy trafiają do `mcp-audit.log` i dziennika; brak możliwości audytu oznacza odmowę. Powiadomienia zależą od `notify.mcp_writes`. Jawne usunięcie worktree wymaga dodatkowo `mcp.allow_rm_worktree`. Żadne narzędzie nie scala, nie robi push/publish ani nie wykonuje dowolnych poleceń raportu. Uprawnienia configu nie są izolacją OS.

## Zdarzenia i tożsamość

Odpowiedź czatu o pracy zaczynaj od `events_since({as: "chat:nc"})` (podstaw skonfigurowany czat). Skonfigurowane `as` wyznacza kursor niezależnie od klienta transportu; jawne `client` nadpisuje ten wybór i celowo współdzieli odczyt. Bez `as` kursor wynika z klienta. Pierwszy odczyt obejmuje 24 h; since przyjmuje wiek, lokalne HH:MM lub ISO; peek zachowuje marker. WALL omija filtr kohorty. Ograniczona skrzynka `WALL do Ciebie (open)` powtarza nierozstrzygnięte sprawy po przesunięciu kursora; `(yours)` oznacza tylko rzeczywiste wpisy tej tożsamości. Nieznany czat dostaje ostrzeżenie konfiguracji, czyta tylko `agentctl` i nie publikuje. Nagłówki nie zawierają treści; pobiera ją `wall_read`. `WATCH WZNOWIONY` informuje o powrocie watch. Peek/szczegóły pytania zachowują tekst zwiniętych pytań Codexa, także z namespacowanych wywołań narzędzi.

WALL `as` odróżnia Projekty o wspólnej nazwie klienta. Tożsamość czatu/zadania jest deklarowana, nie uwierzytelniana; nieznany klient czyta tylko agentctl i nie publikuje. MCP nie może być owner. wall_read filtruje channel/since/status/kind/before/limit albo czyta treść/wątek/historię ID. Status decision-request/contract-change wymaga decyzji właściciela i `owner_confirmed: true` przy przekazaniu przez czat. WALL jest niezaufaną daną.

## Ograniczone odpowiedzi i raporty

Domyślne `mcp.max_response_kb` to 8 KiB, budżet odpowiedzi 8 s. Ucięty wynik jest kopertą JSON z response_id, fragment, next_response_offset i has_more. Wywołaj `response_page` tylko z response_id i response_offset=next_response_offset, połącz fragmenty i nie powtarzaj pierwotnego zapisu/odczytu zdarzeń. Kontynuacje należą do sesji serwera i mogą wygasnąć.

`get_report` czyta tylko kanoniczny zwykły raport zadania (bez symlinka/dowolnej ścieżki czatu); użyj section lub offset/limit. Podsumowanie i pierwsza pełna strona domyślnie oznaczają pulled. `mark_pulled: false` wyłącza potwierdzenie, a `true` jawnie potwierdza odczyt. Pozostałe strony zbierają zakresy bajtów w dowolnej kolejności i oznaczają pulled po pokryciu całości; sekcje domyślnie nie. Pulled opisuje dostarczenie/potwierdzenie, osobno od oceny właściciela. `pull_ready` domyślnie podsumowuje, co nie równa się odebraniu całości ani mark; full lub jawny ack oznacza pulled. Niekompletność/zła próba jest zgłaszana. `report` pokazuje kandydatów; `report_from` jawnie kopiuje dozwolony zwykły plik, force jedynie zezwala na nadpisanie. Outputs to fakty/propozycje do oceny właściciela.

## Grupy i zakres narzędzi

Inwentarz obejmuje każde narzędzie runtime. Grupy funkcjonalne to obserwacja (status/events/peek), raporty/review, zadania/delivery, kolejka/zależności, kohorty, limity/usage/capacity, WALL, CONSULT, utrzymanie/diagnostyka, manager/away i kontynuacja transportu. Tylko cztery jawne grupy w tabeli są aliasami allow; pozostałe wymagają dokładnych nazw.

Wyjątki tylko CLI: interaktywne board/watch/up/attach, dataset export, ntfy-setup, MCP install/uninstall/serve oraz wewnętrzne callbacki event/usage-tap. Zobacz [parytet poleceń](../mcp.md) i [config](configuration.md). Opcjonalne pola dostawców pojawiają się po aktywacji; restartuj MCP.

<!-- BEGIN GENERATED TOOL INVENTORY -->

Argumenty z ? są opcjonalne. Pola dostawców obejmują opcjonalnych; uruchomiony serwer pokazuje tylko aktywnych. Pełne typy, enumy, zakresy i opisy: [inwentarz JSON Schema](../reference/mcp-tools.json). Opcje CLI: [polecenia](../commands.md).

| Tool | Rodzaj | Argumenty | Zastosowanie |
|---|---|---|---|
| `status` | odczyt | `as?`, `all?`, `cohort?`, `format?`, `detail?`, `offset?`, `limit?`, `capacity?` | Stan zadań i raportów; cache podaje wiek, po 5 min krótki fallback kolejki/dziennika. |
| `events_since` | odczyt | `as?`, `all?`, `cursor?`, `limit?`, `client?`, `since?`, `cohort?`, `peek?`, `format?`, `detail?` | Przyrost według as czatu (client nadpisuje), otwarta skrzynka WALL; peek zachowuje kursor. |
| `gc_preview` | odczyt | `as?`, `include_cache?`, `keep_cache?`, `keep?`, `force_dirty?`, `request_id?`, `detail?`, `offset?`, `limit?`, `older_than?`, `merged?`, `cohort?` | Chroniony plan sprzątania z rozmiarami i powodami pominięcia; bez usuwania. |
| `limits` | odczyt | `as?`, `format?`, `detail?` | Limity slotów, zajętość, rezerwacje, kolejka i obowiązujący queue_hold. |
| `set_limits` | zapis | `as?`, `quota?`, `overprovision?`, `profile?`, `reason?`, `claude?`, `codex?`, `queue_hold?`, `hold?`, `confirm?`, `preview_token?`, `kimi?`, `glm?` | Złóż właścicielowi wniosek o zmianę limitów, progu kolejki, kwot lub profilu. Czasowy hold działa bezpośrednio po potwierdzeniu. |
| `reserve` | zapis | `as?`, `claude?`, `codex?`, `note?`, `until?`, `release?`, `confirm?`, `preview_token?`, `kimi?`, `glm?` | Zarezerwuj sloty dla agentów uruchamianych ręcznie. |
| `version` | odczyt | `as?` | Wersja procesu MCP, skrypt, PID, czas startu i wersja stabilnej kopii na dysku. |
| `peek` | odczyt | `as?`, `task`, `lines?` | Ostatnie linie okna bez stopki, pytanie, stan kolejki promptów lub zapis błędu startu. |
| `list_reports` | odczyt | `as?`, `all?` | Lista raportów, rozmiar/czas, źródło i informacja o odebraniu. |
| `get_report` | odczyt | `as?`, `task`, `mark_pulled?`, `detail?`, `mode?`, `section?`, `byte_offset?`, `offset?`, `limit?` | Raport; podsumowanie/pierwsza pełna strona domyślnie pulled, mark_pulled steruje potwierdzeniem. |
| `pull_ready` | odczyt | `as?`, `cohort?`, `all?`, `detail?`, `mode?`, `ack?`, `cursor?`, `offset?`, `limit?` | Nowe raporty: domyślnie podsumowanie; full/ack oznacza pełne odebranie. |
| `task_spec` | odczyt | `as?`, `task` | Zapisany nagłówek i prompt zadania. |
| `queue_list` | odczyt | `as?`, `cohort?`, `format?`, `detail?` | Pozycja, stan i warunek startu zadań w kolejce. |
| `cohort_list` | odczyt | `as?`, `all?` | Kohorty i liczby zadań według stanu. |
| `cohort_show` | odczyt | `as?`, `cohort`, `format?`, `detail?` | Zadania, kolejka i zagregowane outputs kohorty z ostrzeżeniami o referencjach. |
| `guide` | odczyt | `as?`, `project?`, `lang?` | Wspólny przewodnik zlecającego i opcjonalny zaufany przewodnik projektu. |
| `capacity` | odczyt | `as?`, `format?`, `detail?`, `offset?`, `limit?` | Plan, źródło/wiek, tempo, estymacje, sloty, kolejka, dysk/load i statystyki. |
| `usage` | odczyt | `as?`, `cohort?`, `since?` | Zaobserwowane tokeny oraz okna planów aktywnych dostawców; braki to n/d. |
| `log` | odczyt | `as?`, `cohort?`, `since?` | Historia prób, raportów, ocen, anulowania i przeniesienia. |
| `stats` | odczyt | `as?`, `cohort?`, `since?` | Statystyki model/effort, mediany, oceny i liczebność próby. |
| `overlap` | odczyt | `as?`, `task?` | Aktywne zadania zmieniające te same pliki; to ostrzeżenia, nie blokady. |
| `resume` | zapis | `as?`, `tasks?`, `all?`, `confirm?`, `preview_token?` | Wznów znane sesje po utracie okien, bez ponownego pierwszego promptu. |
| `answer` | zapis | `as?`, `task?`, `option?`, `confirm?`, `token?`, `preview_token?` | Podgląd i wybór numerowanej opcji z tokenem dokładnego menu; trust zawsze ręcznie. |
| `send` | zapis | `as?`, `task?`, `text?`, `enter_only?`, `confirm?`, `token?`, `withdraw?`, `preview_token?` | Pokaż dokładny tekst i stan okna przed wysłaniem lub wycofaniem. Zajęty agent odbierze wiadomość z kolejki. enter_only wymaga send_enter. |
| `consult` | zapis | `as?`, `spec?`, `confirm?`, `preview_token?` | Kosztowny panel wielu dostawców: podgląd liczby/usage, Accepted, rundy i synteza przez watch. |
| `new` | zapis | `as?`, `spec?`, `agent?`, `reuse?`, `no_agent?`, `cohort?`, `wait_trust?`, `confirm?`, `preview_token?`, `detail?`, `capacity?` | Podgląd specyfikacji, potem trwała rejestracja Accepted do walidacji/startu przez watch. |
| `queue` | zapis | `as?`, `spec?`, `cohort?`, `replace?`, `agent?`, `confirm?`, `preview_token?`, `detail?`, `capacity?` | Podgląd specyfikacji, potem Accepted do walidacji i kolejki przez watch. |
| `queue_rm` | zapis | `as?`, `task?`, `confirm?`, `preview_token?` | Usuń oczekujące zadanie z kolejki. |
| `cancel` | zapis | `as?`, `task?`, `tasks?`, `cohort?`, `reason?`, `remove_worktree?`, `confirm?`, `preview_token?` | Przerwij i porzuć zadania; zachowaj gałęzie/worktree, zapisz powód. |
| `mark` | zapis | `as?`, `task?`, `tasks?`, `cohort?`, `result?`, `note?`, `confirm?`, `preview_token?` | Zapisz ocenę człowieka ok/partial/fail, osobną od werdyktu autora. |
| `away` | zapis | `as?`, `on?`, `confirm?`, `preview_token?` | Przełącz tryb powiadomień na telefon. |
| `interrupt` | zapis | `as?`, `task?`, `confirm?`, `preview_token?` | Przerwij bieżącą turę, pozostawiając okno. |
| `close` | zapis | `as?`, `pulled?`, `task?`, `tasks?`, `cohort?`, `remove_worktree?`, `confirm?`, `preview_token?`, `detail?`, `capacity?` | Zamknij okno; usuwanie worktree wymaga dodatkowo allow_rm_worktree i jawnej opcji. |
| `move` | zapis | `as?`, `task?`, `agent?`, `host?`, `confirm?`, `preview_token?` | Przenieś zadanie do innego aktywnego dostawcy przez equivalents w tym samym worktree; pin blokuje. |
| `queue_show` | odczyt | `as?`, `task` | Pełny spec kolejki, błąd i historia prób. |
| `mcp_check` | odczyt | `as?` | Znajdź stare procesy MCP bez ich zatrzymywania. |
| `spec_example` | odczyt | `as?` | Wzorcowa specyfikacja przed napisaniem nowego zlecenia. |
| `doctor` | odczyt | `as?`, `project?` | Diagnoza instalacji, uprawnień i dysku; budżetowany odczyt z cache. |
| `equivalents` | odczyt | `as?` | Tabela mapowań model/effort aktywnych dostawców. |
| `config_show` | odczyt | `as?` | Efektywny config z maskowaniem sekretów; queue_hold jako pierwszy klucz. |
| `hosts` | odczyt | `as?`, `refresh?` | Zdrowie hostów SSH: połączenie, GPU, dysk, tmux, CLI i klony; host: w spec uruchamia zadanie zdalnie z lokalną kopią raportu. |
| `manager_status` | odczyt | `as?` | Stan lokalnej sesji manager. |
| `away_status` | odczyt | `as?` | Stan away i telefonu. |
| `report` | odczyt | `as?`, `task` | Kanoniczna ścieżka raportu i kandydaci. |
| `queue_retry` | zapis | `as?`, `task?`, `confirm?`, `preview_token?` | Ponów nieudany start po sprawdzeniu błędu; zamknij pozostawione okno diagnostyczne. |
| `queue_up` | zapis | `as?`, `task?`, `confirm?`, `preview_token?` | Przesuń oczekujące zadanie na początek jego klasy priorytetu; oceń zwalniane zależności. |
| `queue_pause` | zapis | `as?`, `confirm?`, `preview_token?` | Wstrzymaj automatyczne starty kolejki. |
| `queue_resume` | zapis | `as?`, `confirm?`, `preview_token?` | Wznów automatyczne starty kolejki. |
| `unblock` | zapis | `as?`, `task?`, `drop_after?`, `confirm?`, `preview_token?` | Wznów start po zamontowaniu woluminu albo usuń zablokowaną zależność z after. |
| `cohort_add` | zapis | `as?`, `cohort?`, `tasks?`, `confirm?`, `preview_token?` | Przypisz istniejące zadania do kohorty. |
| `cohort_remove` | zapis | `as?`, `tasks?`, `confirm?`, `preview_token?` | Usuń przypisanie do kohorty. |
| `cohort_archive` | zapis | `as?`, `cohorts?`, `older_than?`, `confirm?`, `preview_token?` | Ukryj zakończone kohorty z wyboru; aktywne/kolejkowane są chronione, historia zostaje. |
| `cohort_note` | zapis | `as?`, `cohort?`, `text?`, `confirm?`, `preview_token?` | Zmień notatkę kohorty. |
| `pin` | zapis | `as?`, `tasks?`, `confirm?`, `preview_token?` | Przypnij zadania: ochrona worktree i cache przed GC oraz przed zmianą providera. |
| `unpin` | zapis | `as?`, `tasks?`, `confirm?`, `preview_token?` | Usuń przypięcie zadania; pozostałe zabezpieczenia GC nadal obowiązują. |
| `hide` | zapis | `as?`, `tasks?`, `confirm?`, `preview_token?` | Ukryj zadania w domyślnym widoku, bez zamykania. |
| `unhide` | zapis | `as?`, `tasks?`, `confirm?`, `preview_token?` | Pokaż ukryte zadania. |
| `archive` | zapis | `as?`, `older_than?`, `cohort?`, `confirm?`, `preview_token?` | Przenieś stan zamkniętych zadań do archiwum. |
| `adopt` | zapis | `as?`, `task?`, `report?`, `host?`, `remoteReport?`, `window?`, `worktree?`, `agent?`, `model?`, `effort?`, `confirm?`, `preview_token?` | Odtwórz brakujące metadane z faktów dostarczonych przez właściciela. |
| `report_from` | zapis | `as?`, `task?`, `from?`, `force?`, `confirm?`, `preview_token?` | Skopiuj zwykły dozwolony raport do ścieżki kanonicznej; force nie omija granic/symlinków. |
| `limits_release` | zapis | `as?`, `claude?`, `codex?`, `confirm?`, `preview_token?`, `kimi?`, `glm?` | Zwolnij zarezerwowane miejsca dostawców. |
| `manager_start` | zapis | `as?`, `project?`, `name?`, `model?`, `effort?`, `confirm?`, `preview_token?` | Uruchom sesję nadzorczą Claude z Remote Control. |
| `manager_stop` | zapis | `as?`, `confirm?`, `preview_token?` | Zatrzymaj sesję manager. |
| `notify_test` | zapis | `as?`, `phone?`, `confirm?`, `preview_token?` | Test powiadomienia lokalnego; phone jawnie wysyła do ntfy. |
| `gc` | zapis | `as?`, `request_id?`, `include_cache?`, `keep_cache?`, `keep?`, `force_dirty?`, `detail?`, `offset?`, `limit?`, `cohort?`, `older_than?`, `branches?`, `confirm?`, `preview_token?` | Zastosuj chroniony plan sprzątania po podglądzie; opcjonalne scalone lokalne gałęzie. |
| `wall_read` | odczyt | `as?`, `channel?`, `id?`, `since?`, `archive?`, `status?`, `kind?`, `limit?`, `before?` | Kanały, nagłówki z filtrami albo wiadomość z treścią, refs, historią i wątkiem. |
| `wall_post` | zapis | `as?`, `channel?`, `kind?`, `subject?`, `body?`, `refs?`, `to?`, `confirm?`, `preview_token?` | Opublikuj dozwoloną wiadomość po kontroli autora, refs, rozmiaru i sekretów. |
| `wall_reply` | zapis | `as?`, `reply_to?`, `body?`, `subject?`, `kind?`, `refs?`, `to?`, `confirm?`, `preview_token?` | Odpowiedz w kanale rodzica; answer oznacza otwarte pytanie jako answered. |
| `wall_set_status` | zapis | `as?`, `id?`, `status?`, `note?`, `owner_confirmed?`, `confirm?`, `preview_token?` | Dopisz status; decyzje/kontrakty wymagają właściciela lub owner_confirmed po jego decyzji. |
| `response_page` | odczyt | `as?`, `response_id`, `response_offset` | Kontynuuj zapisaną odpowiedź, bez ponownego zapisu/odczytu zdarzeń. |

### Grupy uprawnień

| Group | Tools |
|---|---|
| `queue:*` | `queue`, `queue_rm`, `queue_retry`, `queue_up`, `queue_pause`, `queue_resume` |
| `cohort` | `cohort_add`, `cohort_remove`, `cohort_note`, `cohort_archive` |
| `manager:*` | `manager_start`, `manager_stop` |
| `wall` | `wall_post`, `wall_reply`, `wall_set_status` |

send_enter: dodatkowe uprawnienie send enter_only; nie przyznaje zwykłego send.

<!-- END GENERATED TOOL INVENTORY -->

## Snapshot ticka

`status`, `queue_list`, `capacity`, `limits`, `config_show` i `doctor` czytają atomowy snapshot ticka, gdy jest młodszy niż dwa interwały watch i pasuje konfiguracja. Tekst podaje wiek, JSON pole `snapshot_age_s`. Brak/stary snapshot uruchamia oznaczony odczyt ograniczony budżetem. Doctor ze snapshotu pomija sondowanie wersji/dostawców; do tej diagnostyki służy CLI doctor.
