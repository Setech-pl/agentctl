# agentctl

Lokalny dispatcher zadań dla Claude Code, OpenAI Codex CLI, Kimi Code CLI i Z.ai GLM. Specyfikacja Markdown zamienia się w worktree Git, interaktywnego agenta tmux i raport do oceny. Watch obsługuje kolejkę, dostarczanie promptów, powiadomienia i konsultacje.

[English](README.md) · **[Polska instrukcja](docs/pl/overview.md)** · [Od zera](docs/pl/tutorial.md) · [Wydanie 0.23.1](docs/release-notes/0.23.1.pl.md)

![Prawdziwy board, syntetyczne zadania, bez inference](docs/img/board-main.png)

Zależności i werdykty, sloty/hold, bezpieczne follow-upy, raporty, kohorty, WALL i CONSULT: [wszystkie funkcje](docs/pl/features.md). [Galeria widoków TUI](docs/pl/screenshots.md) obejmuje pomoc, capacity, filtry i wątki WALL.

| Początek | Referencja |
|---|---|
| [Instalacja i pierwsze zadanie](docs/pl/tutorial.md) | [Konfiguracja/specyfikacje](docs/pl/configuration.md) |
| [Dostawcy/logowanie](docs/pl/providers.md) | [Wszystkie narzędzia MCP i Accepted](docs/pl/mcp-tools.md) |
| [Ekonomia tokenów](docs/pl/token-economics.md) | [Problemy/doctor](docs/pl/troubleshooting.md) |
| [Wstawka do instrukcji Projektu](docs/pl/agent-insert.md) | [Przewodnik agenta zlecającego](docs/pl/agent-guide.md) |
| [Polecenia CLI](docs/commands.md) | [Katalog regresji](tests/regression/CATALOG.md) |

## Architektura

![C4 System Context](docs/diagrams/context.svg)

[Kontenery i sekwencje](docs/pl/architecture.md) pokazują Accepted, trust, raporty/odzyskiwanie, WALL i CONSULT; lokalne źródła PlantUML/C4 oraz SVG/PNG.

## Instalacja

Wymagane są Node ≥22.14.0, Git, tmux i osobno zainstalowane/zalogowane CLI dostawców. Bieżące npm CLI Kimi wymaga Node ≥22.19.0. Samouczek opisuje stabilną instalację i pierwszy config.

~~~sh
git clone https://github.com/Setech-pl/agentctl.git
cd agentctl
npm ci
npm run build
./bin/agentctl-update --ref v0.23.1 --dry-run
~~~

[Bezpieczeństwo wydania, canary i rollback](docs/pl/release-safety.md) · [Informacje o wydaniu 0.27.2](docs/release-notes/0.27.2.pl.md).

Polecenie `./bin/agentctl-dev-update v0.23.1` przebudowuje `~/Projects/agentctl-wt/devtest` z konfiguracją `~/.agentctl-dev`. Przyjmuje tag, gałąź lub SHA oraz opcje `--status`, `--rollback`, `--no-restart` i `--skip-ci`.

Agentctl działa z twoimi uprawnieniami; worktree nie jest sandboxem OS. Trust folderu nigdy nie jest automatyczny. Lokalny MCP używa desktopowego stdio; web/telefon nie łączy się bezpośrednio. Właściciel ocenia dowody i decyduje o integracji/publikacji; actions to propozycje. [Granice](docs/pl/overview.md#granice).

## Hosty

`host: pc` uruchamia zadanie na skonfigurowanym hoście SSH: worktree/setup/agent zdalnie, zwykłe operacje zadania i lokalna kopia raportu. [Konfiguracja i przykład na PC](docs/pl/hosts.md). Wersja 0.23.1 obejmuje limity konta/hosta, blokady dostawców, bezpieczny zdalny GC, zadania hosta na boardzie oraz restart/adopt/resume; kolejkę przenosi `move --host pc|local`. [Informacje o wydaniu](docs/release-notes/0.23.1.pl.md).

[Współtworzenie](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [Licencja MIT](LICENSE). Używaj gate repo i cache własnego zadania.

GC sprawdza zmiany i niewysłane commity w każdym repo; cache domyślnie zostaje. Jawne `include_cache` nadal chroni pin/keep/keep_cache i artefakty raportów; zdalny GC nigdy nie wymusza usunięcia. [Bezpieczeństwo GC i konfiguracja](docs/pl/configuration.md).

Token `answer` wiąże znormalizowane pytanie i etykiety opcji, niezależnie od przewijania menu, zaznaczenia, odstępów i odświeżenia ekranu. Przy potwierdzeniu wybrana opcja musi być widoczna z tą samą etykietą i pytaniem; zmienione menu, wygasły lub zużyty token i inne zadanie są odrzucane.

Klasa zadania `gate` używa Claude Sonnet medium, Codex `gpt-6-luna/medium`, Kimi `k3-256k/low` i GLM `glm-5.3-flash/medium`. Domyślne odpowiedniki wynikają z tej samej macierzy modeli.

Odziedziczone linki projektu do zamkniętych lub zarchiwizowanych zadań są błędem: użyj własnego worktree backendu lub links: []. Stare domyślne linki do repozytorium już podanego w specyfikacji również są pomijane. Jawne linki specyfikacji i placeholdery projektu `{worktree:repo}` pozostają świadomym wyborem.

Każdy zapis MCP obsługuje `{preview_token, confirm: true}` po podglądzie, także `away`. Zapis WALL przyjmuje też `{as, preview_token, confirm: true}`, gdy `as` zgadza się z podglądem; channel/kind/subject/body i pozostałe argumenty są odtwarzane z tej sesji. Inny autor lub narzędzie, wygasły token i zmiana zakresu są odrzucane; ponowienie korzysta z potwierdzenia wykonania.

Odebrane raporty w stanie report-ready zwijają się w kohortach do „odebrane, do zamknięcia (N)”, pod aktywnymi i czekającymi zadaniami. Enter rozwija wybrany wiersz; `B` pokazuje listę odebranych zadań kohorty i pyta o zamknięcie okien. Raporty, gałęzie i worktree pozostają. Nieodebrane raporty tworzą wyróżnioną sekcję na górze całej planszy, także bez okna.

`board.pulled_collapse_after: 0` określa opóźnienie w minutach (domyślnie natychmiast). `board.pulled_auto_close_after: false` domyślnie wyłącza automatyczne zamykanie. Liczba nieujemna włącza zamykanie przez watch po tylu godzinach od odebrania bieżącego raportu report-ready; zdarzenie `pulled-auto-close` trafia do dziennika, worktree pozostają. Po zmianie uruchom watch/board ponownie.

`agentctl status` i status MCP grupują odebrane raporty jako „odebrane, niezamknięte”; JSON zachowuje znacznik odbioru. `agentctl close --cohort NAZWA --pulled` pokazuje listę i pyta o zgodę (`--yes` wykonuje); MCP `close` przyjmuje `{cohort: "NAZWA", pulled: true}`, potem potwierdzenie tokenem podglądu. Nie można łączyć tego wyboru z identyfikatorami zadań ani usuwaniem worktree.

Zamykanie odebranych zadań w CLI odrzuca zmianę listy lub raportu w trakcie potwierdzania. Uruchom podgląd ponownie, aby zatwierdzić aktualny zakres.

[Cykl życia WALL: archiwum i przypomnienia](docs/pl/configuration.md#cykl-życia-wall-0227).
