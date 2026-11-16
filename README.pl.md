# agentctl

Lokalny dispatcher zadań dla Claude Code, OpenAI Codex CLI, Kimi Code CLI i Z.ai GLM. Specyfikacja Markdown zamienia się w worktree Git, interaktywnego agenta tmux i raport do oceny. Watch obsługuje kolejkę, dostarczanie promptów, powiadomienia i konsultacje.

[English](README.md) · **[Polska instrukcja](docs/pl/overview.md)** · [Od zera](docs/pl/tutorial.md) · [Wydanie 0.22.3](docs/release-notes/0.22.3.pl.md)

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
./bin/agentctl-update --ref v0.22.3 --dry-run
~~~

Agentctl działa z twoimi uprawnieniami; worktree nie jest sandboxem OS. Trust folderu nigdy nie jest automatyczny. Lokalny MCP używa desktopowego stdio; web/telefon nie łączy się bezpośrednio. Właściciel ocenia dowody i decyduje o integracji/publikacji; actions to propozycje. [Granice](docs/pl/overview.md#granice).

[Współtworzenie](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [Licencja MIT](LICENSE). Używaj gate repo i cache własnego zadania. Wydanie łączy pełne instrukcje z poprawkami operacyjnymi 0.22.2, diagnostyką i pomocą boardu.

GC sprawdza `git status --porcelain --untracked-files=normal` w **każdym** worktree zadania oraz commity przed upstreamem (lub zapisaną bazą). Podgląd pokazuje liczbę zmienionych plików i niewysłanych commitów na repo, także przy rozmiarach z cache. Zmiany zostają bez jawnego CLI `--force-dirty` lub MCP `force_dirty: [TASK]`; wykonanie sprawdza stan ponownie. Pliki ignorowane są pomijane.

Cache zadania zostaje przy usuwaniu worktree. Usunięcie starych wpisów wymaga jawnej zgody właściciela: CLI `gc --include-cache --apply` lub MCP `gc {include_cache: true}`. Spec `keep_cache: true`, CLI `--keep-cache TASK...` i MCP `keep_cache: [TASK]` zachowują cały cache tych zadań. Odnośniki w raporcie, w tym `persist: [ścieżki]`, `artifacts: [ścieżka | {path: ...}]` i `refs: [ścieżka | {path: ...}]` w agentctl-outputs, chronią dane i katalogi nadrzędne także z include_cache. Ścieżki względne odnoszą się do katalogu raportu lub worktree zadania. Podgląd stronicuje ścieżki i rozmiary, a wykonanie ponownie sprawdza ochronę.

Token `answer` wiąże znormalizowane pytanie i etykiety opcji, niezależnie od przewijania menu, zaznaczenia, odstępów i odświeżenia ekranu. Przy potwierdzeniu wybrana opcja musi być widoczna z tą samą etykietą i pytaniem; zmienione menu, wygasły lub zużyty token i inne zadanie są odrzucane.
