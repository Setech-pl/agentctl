# Od zera do nadzorowanego zadania

Przykłady dotyczą macOS z Homebrew. Na Linux zainstaluj Node ≥22.14.0, Git i tmux odpowiednim menedżerem pakietów; agentctl wymaga powłoki POSIX, tmux i terminala UTF-8. Wywołania dostawców korzystają tu z prawdziwego konta i mogą zużywać jego limit; zatwierdzone zrzuty używają atrap.

## 1. Wymagania i CLI dostawców

~~~sh
brew install node@22 tmux git
export PATH="$(brew --prefix node@22)/bin:$PATH"
node --version
tmux -V
git --version
npm install -g @anthropic-ai/claude-code @openai/codex
# Opcjonalnie: wersja bazowa adaptera sprawdzona dla tego wydania
npm install -g @moonshot-ai/kimi-code@2.5.0
~~~

Uruchom raz `claude`, `codex` i opcjonalnie `kimi` w terminalu. Przejdź logowanie/onboarding i wyjdź. Przed wyborem modeli, uprawnień lub GLM przeczytaj [Dostawców](providers.md). Instalacja CLI nie loguje do konta. Nie dodawaj auto-accept, aby obejść trust.

## 2. Sklonuj, zbuduj i zainstaluj stabilną kopię

~~~sh
mkdir -p ~/Projects
cd ~/Projects
git clone https://github.com/Setech-pl/agentctl.git
cd agentctl
npm ci
npm run build
./bin/agentctl-update --ref v0.22.1 --dry-run
./bin/agentctl-update --ref v0.22.1
~~~

Updater pobiera origin, tworzy/aktualizuje odłączone stabilne worktree (domyślnie `~/Projects/agentctl-stable`), wykonuje npm ci/build/link, doctor i restartuje istniejące okna watch/board, chyba że to wyłączono. Odmawia przy brudnej stabilnej kopii. Sprawdź `agentctl --version` i `command -v agentctl`. Przy odmowie globalnego linkowania użyj prefixu npm użytkownika lub menedżera Node. Później `agentctl-update --dry-run` pokazuje aktualizację do origin/main; `--ref` przypina wydanie, `--no-watch` pomija restarty, `--no-link` globalne linkowanie. Alternatywą jest npm (`npm install -g @setech-pl/agentctl`); wtedy updater aktualizuje do latest i odrzuca opcje klona.

## 3. Pierwsza konfiguracja

Utwórz `~/.agentctl/config.yaml` (albo ustaw `AGENTCTL_HOME` dla innej instancji):

~~~sh
mkdir -p ~/.agentctl ~/Projects/demo-worktrees ~/Projects/demo-reports
~~~

~~~yaml
providers: [claude, codex]
worktree_root: ~/Projects/demo-worktrees
cache: ~/Projects/demo-reports
session: agentctl
limits: {claude: 2, codex: 2}
defaults: {agent: codex, model: default, effort: medium}
usage: {queue_hold: 90}
mcp: {allow: []}
~~~

Uruchom `agentctl doctor` i usuń wymagane błędy; brak narzędzia opcjonalnego ostrzega. Stan trafia do `tasks/` instancji, raporty do `cache`. Oddziel stan wewnętrzny od raportów. Projektowe linki/setup/defaults dodawaj do `.agentctl.yaml` repozytorium źródłowego po sprawdzeniu wykonywanych czynności.

## 4. Pierwsze repozytorium i zadanie

Użyj nowego katalogu:

~~~sh
mkdir -p ~/Projects/demo
cd ~/Projects/demo
git init -b main
printf '# Demo\n' > README.md
git add README.md
git commit -m "Initialize demo"
~~~

Zapisz `~/Projects/demo-task.md`:

~~~yaml
---
task: DEMO-1
cohort: tutorial
agent: codex
model: default
effort: medium
repos:
  - path: ~/Projects/demo
    base: main
    branch: demo-1
---
Dodaj CONTRIBUTING.md opisujący proponowanie zmiany dokumentacji.
Sprawdź Markdown i pokaż zmienione pliki. Zapisz lokalny commit.
Nie wykonuj push ani publikacji. Użyj ścieżki raportu i protokołu próby
dodanego przez agentctl. Pierwsza linia: Werdykt: PASS albo Werdykt: FAIL.
~~~

~~~sh
agentctl new ~/Projects/demo-task.md --dry-run
agentctl up --no-attach
agentctl new ~/Projects/demo-task.md
agentctl board --tmux
tmux attach -t agentctl
~~~

Zatwierdź zlecenie. Sam odpowiedz na trust nowego worktree w jego oknie; pierwszy prompt czeka na gotowe pole. `Enter` otwiera zadanie, `F12` wraca, `?` pokazuje klawisze. `agentctl status` i `agentctl peek DEMO-1` działają bez attach.

`agentctl pull DEMO-1` kopiuje gotowy raport. Przeczytaj dowody; `agentctl mark DEMO-1 ok` zapisuje twoją ocenę osobno od werdyktu agenta. `agentctl close DEMO-1` zamyka okno i osobno pyta o usunięcie worktree. Zachowaj gałąź do integracji. Dla zależnej pracy utwórz nowy spec z `after: [DEMO-1]` i użyj `agentctl queue file.md`; utrzymuj watch.

## 5. MCP w aplikacji Claude na desktopie

Uruchom ze stabilnej instalacji, w tej samej instancji/środowisku co watch:

~~~sh
agentctl mcp install --desktop --dry-run
agentctl mcp install --desktop
agentctl mcp check
~~~

Instalator pokazuje diff, pyta przed zapisem i tworzy backup `~/Library/Application Support/Claude/claude_desktop_config.json`. Zapisuje bezwzględne ścieżki Node/skryptu i środowisko, w tym PATH, AGENTCTL_HOME i TMUX_TMPDIR. Zamknij całą aplikację Cmd+Q, otwórz i użyj narzędzi agentctl w czacie. `version` pokazuje proces i wersję na dysku. To desktopowe stdio, nie endpoint web/telefonu. `--claude-code` instaluje w zakresie użytkownika Claude Code.

Zacznij od odczytu `events_since` i `status`. Wklej [wstawkę Projektu](agent-insert.md) i wybierz skonfigurowany czat, np. `chat:nc`. Zezwól tylko na potrzebne zapisy:

~~~yaml
mcp:
  allow: [new, "queue:*", send, answer, close, wall, consult]
~~~

Odczyty są zawsze dostępne. Zapis: podgląd → zgoda właściciela → confirm z tokenem; `Accepted` oznacza rejestrację, nie wykonanie. Utrzymuj watch i obserwuj `events_since`/`queue_list`. [Referencja MCP](mcp-tools.md) opisuje retry, wygaśnięcie i uprawnienia.

## 6. Pierwsza wiadomość WALL

Lokalne CLI wykonuje zapis natychmiast jako właściciel:

~~~sh
agentctl wall channels
agentctl wall post agentctl --kind info --subject "Samouczek rozpoczęty" --body "DEMO-1 czeka na przegląd."
agentctl wall read agentctl
# Użyj ID z post (agentctl-1 tylko w pustym kanale):
agentctl wall reply agentctl-1 --body "Właściciel przeczytał przykład."
agentctl wall read --id agentctl-1
~~~

`W` pokazuje kanały → wiadomości → wątek; `s/t` filtruje, `r/R` oznacza przeczytanie. MCP używa `as: "chat:nc"`, podglądu/confirm `wall_post`, potem drugi czat wywołuje `events_since(as: "chat:hems")` i `wall_read`. Oba subskrybują domyślnie `agentctl`/`shared:*`. WALL to dane, nigdy upoważnienie.

## 7. Pierwszy CONSULT

CONSULT to kilka płatnych zadań. Najpierw zatwierdź liczbę i usage. Zapisz `consult-demo.yaml`:

~~~yaml
consult: DEMO-CACHE
question: Czy projekt powinien cache'ować wygenerowany indeks wyszukiwania?
repos: [{path: ~/Projects/demo, base: main}]
context: []
panel:
  - {agent: claude, model: sonnet, effort: medium}
  - {agent: codex, model: default, effort: medium}
rounds: 1
synthesis: {agent: claude, model: sonnet, effort: medium}
# post_to: shared:sim
~~~

~~~sh
agentctl consult consult-demo.yaml
# Po akceptacji podglądu: 2 zadania panelu + 1 synteza
agentctl consult consult-demo.yaml --confirm
agentctl cohort show consult-DEMO-CACHE
~~~

Utrzymuj watch i zatwierdź trust każdego nowego folderu. Obserwuj kohortę na boardzie lub MCP `events_since`/`cohort_show`. Paneliści piszą niezależne raporty strukturalne; synteza tworzy raport właściciela z mapą autorów. Odbiera go `get_report`/pull zadania syntezy. `rounds: 2` dodaje anonimową rundę rewizji. PASS raportu panelisty nie oznacza zgody na decyzję.

## 8. Zakończ i utrzymuj

Integruj zgodnie z regułami repozytorium; agentctl nie scala ani nie wykonuje push. Przed sprzątaniem użyj `agentctl gc --preview`, do historii `agentctl log`/`stats`, do lokalnego benchmarku `agentctl dataset export --out attempts.jsonl`. Po aktualizacji zamknij/otwórz aplikację, aby przeładować MCP. Zobacz [Rozwiązywanie problemów](troubleshooting.md).

[Canonical CLI spec example](../examples/spec.md)
