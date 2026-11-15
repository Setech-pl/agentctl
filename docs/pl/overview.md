# agentctl 0.22.1

agentctl zamienia zlecenie w Markdown na worktree Git, interaktywnego agenta w tmux oraz obserwowane zadanie zakończone raportem. Działa lokalnie i korzysta z zainstalowanych CLI dostawców, do których użytkownik sam się loguje. Obsługuje Claude Code, OpenAI Codex CLI, Kimi Code CLI i Z.ai GLM przez wrapper Claude Code.

Właściciel decyduje, co uruchomić, zatwierdza zaufanie folderów, ocenia dowody i publikuje zmiany. Czat może czytać stan i zlecać pracę przez lokalny serwer MCP. Board jest terminalowym widokiem właściciela; watch obsługuje kolejkę, dostarczanie promptów, zdarzenia, powiadomienia i konsultacje.

## Czytaj instrukcję

| Strona | Zastosowanie |
|---|---|
| [Funkcje](features.md) | Wszystkie bieżące przepływy i stany zadań |
| [Od zera](tutorial.md) | Instalacja, konfiguracja, pierwsze zadanie, MCP, WALL i CONSULT |
| [Konfiguracja](configuration.md) | Warstwy, klucze, wartości domyślne i specyfikacja |
| [Narzędzia MCP](mcp-tools.md) | Każde narzędzie, argumenty, uprawnienia i Accepted |
| [Dostawcy](providers.md) | Instalacja, logowanie, model/effort, sondy i ograniczenia |
| [Ekonomia tokenów](token-economics.md) | Okna planu, capacity, cache i koszt przyjętego zadania |
| [Rozwiązywanie problemów](troubleshooting.md) | Doctor, start, raporty, kolejka i odzyskiwanie |
| [Wstawka dla czatu](agent-insert.md) | Krótki blok instrukcji Projektu |
| [Przewodnik agenta zlecającego](agent-guide.md) | Pełny kontrakt operacyjny czatu |
| [Architektura](architecture.md) | C4 i diagramy sekwencji |
| [Galeria ekranów](screenshots.md) | Prawdziwe zrzuty TUI z syntetycznymi danymi |

[English](../en/overview.md) · [Referencja poleceń CLI](../commands.md) · [Informacje o wydaniu 0.22.1](../release-notes/0.22.1.pl.md)

## Granice

To orkiestracja, a nie piaskownica systemu operacyjnego. Procesy dostawców mają lokalne uprawnienia właściciela; worktree rozdziela checkouty, a nie poświadczenia ani sieć. MCP nie udostępnia merge, push, publish ani dowolnej powłoki. Proponowane polecenia w raportach pozostają danymi. Lokalny MCP stdio działa przez klienta desktopowego; claude.ai w przeglądarce i telefon nie łączą się z nim bezpośrednio. Opcjonalny manager Claude używa Remote Control do nadzoru z telefonu.

Procenty i aliasy modeli pochodzą z odczytów dostawców oraz konfiguracji. Nieznane odczyty pozostają `n/d`. Rozpoznawanie ekranu jest heurystyczne; zmiana CLI może wymagać zmiany wzorców. Wersja 0.22.1 zmienia dokumentację i jej narzędzia, bez nowego zachowania produktu.
