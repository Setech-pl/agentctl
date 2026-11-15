# Galeria ekranów TUI

To prawdziwe ekrany Ink/tmux 160×45, z capture-pane -e -p i renderera ANSI→SVG→PNG repozytorium (resvg, dołączony font DejaVu monospace, ciemny motyw). Nie rysowano zastępczego interfejsu.

Izolowany harness ma własny serwer/sesję tmux agentctl-demo i unikalny tymczasowy AGENTCTL_HOME zakończony agentctl-demo w cache zadania. Programy dostawców są atrapami; ekrany, potwierdzenia dostarczenia, raporty, tokeny/kwoty, zegar i dysk są syntetyczne. Prawdziwe CLI/core/Ink generuje widoki; CONSULT jest zarejestrowaną grupą, bez inference. Widać tylko ogólną ścieżkę ~/Projects/demo. Asercja odrzuca ścieżki/nazwy hosta zamiast je maskować.

Kolejka jest sekcją boardu, nie osobnym ekranem. Szczegóły to zaznaczony peek; Enter otwiera okno dostawcy. WALL tylko czyta i zapisuje lokalne oznaczenia przeczytania. Posty obejmują agentctl/shared:sim/nc, info/question/decision-request, odpowiedzi i statusy answered/accepted/open. PASS i FAIL są kompletnymi report-ready; werdykt i ludzki mark są osobne.

[Capture manifest](../reference/gallery.json) · [Reproducible script](../../scripts/docs-gallery.ts)

Uruchom z bezwzględnym AGENTCTL_LIVE_CACHE własnego zadania: node --experimental-strip-types --no-warnings scripts/docs-gallery.ts. Finally zatrzymuje procesy/serwer harnessu; npm run gate -- clean usuwa sandbox/home. Worktree node_modules zostaje.

## Lista: praca/oczekiwanie/pytanie/trust/limited, raporty PASS/FAIL, kohorty i queue_hold

![Lista: praca/oczekiwanie/pytanie/trust/limited, raporty PASS/FAIL, kohorty i queue_hold](../img/board-main.png)

## Szczegóły zadania i pytanie z menu

![Szczegóły zadania i pytanie z menu](../img/board-peek.png)

## Edytor wiadomości

![Edytor wiadomości](../img/board-message.png)

## Potwierdzenie zamknięcia

![Potwierdzenie zamknięcia](../img/board-confirm.png)

## Powód anulowania

![Powód anulowania](../img/board-cancel-reason.png)

## Pomoc i pełna lista klawiszy

![Pomoc i pełna lista klawiszy](../img/board-help.png)

## Wybór kohorty

![Wybór kohorty](../img/board-cohorts.png)

## Limity i hold dostawców

![Limity i hold dostawców](../img/board-limits.png)

## Capacity, odczyty planu i estymacje

![Capacity, odczyty planu i estymacje](../img/board-capacity.png)

## Chroniony podgląd sprzątania

![Chroniony podgląd sprzątania](../img/board-gc.png)

## Historia prób i ocena człowieka

![Historia prób i ocena człowieka](../img/board-log.png)

## Kolejka i spec zależności

![Kolejka i spec zależności](../img/board-queue.png)

## Kanały WALL i liczniki

![Kanały WALL i liczniki](../img/wall-channels.png)

## Wiadomości kanału

![Wiadomości kanału](../img/wall-messages.png)

## Filtr statusu

![Filtr statusu](../img/wall-filter-status.png)

## Filtr typu razem ze statusem

![Filtr typu razem ze statusem](../img/wall-filter-kind.png)

## Wiadomość, historia statusu i wątek odpowiedzi

![Wiadomość, historia statusu i wątek odpowiedzi](../img/wall-thread.png)

## Syntetyczne zadanie report-ready z FAIL

![Syntetyczne zadanie report-ready z FAIL](../img/board-report-fail.png)

## Zakończone zadanie bez okna: menu

![Zakończone zadanie bez okna: menu](../img/board-finished-menu.png)

## Widoczność finished/wszystkich

![Widoczność finished/wszystkich](../img/board-all.png)

Pomoc mieści się w wysokości terminala; ↑↓ i PgUp/PgDn przewijają, pozostałe klawisze wracają. Samą pomoc odtworzysz przez `scripts/docs-gallery.ts --help-only`, z powyższymi flagami Node.
