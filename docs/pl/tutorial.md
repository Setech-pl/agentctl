# Od zera do nadzorowanego zadania

Przykłady dotyczą macOS z Homebrew. Na Linux zainstaluj Node ≥22.14.0, Git i tmux odpowiednim menedżerem pakietów; agentctl wymaga powłoki POSIX, tmux i terminala UTF-8. Wywołania dostawców korzystają tu z prawdziwego konta i mogą zużywać jego limit; zatwierdzone zrzuty używają atrap.

## Oszczędzanie miejsca na dysku

Dodaj wybrane opcje do `.agentctl.yaml` repozytorium albo do `~/.agentctl/config.yaml`. W `cleanup` podaj ścieżki, które projekt może odtworzyć, na przykład profile przeglądarki utworzone na potrzeby zadania.

```yaml
setup: {node_modules: clone, commands: [npm ci]}
close: {cleanup: [".cache", "dist*", ".chrome-profile*"]}
worktrees: {root: /Volumes/AgentWork/worktrees, mount: /Volumes/AgentWork}
```

Przy pierwszym zgodnym checkout agentctl uruchamia `npm ci` i zapisuje kopię dla repozytorium i lockfile. Kolejne worktree na tym samym systemie plików otrzymują niezależny klon APFS na macOS lub kopię GNU `cp --reflink=auto` na Linuksie. Aby klonować na dysku zewnętrznym, umieść `AGENTCTL_HOME` na tym samym systemie plików. Przy błędzie kopiowania, zmianie lockfile lub rozdzieleniu woluminów agentctl wykonuje zwykłą instalację. Magazyn obsługuje osobne `npm ci` z opcjonalnymi `--no-audit` i `--no-fund`. Własne skrypty instalacyjne, npm workspaces i zależności lokalne korzystają ze zwykłego setup. Brak skonfigurowanych poleceń w trybie `clone` oznacza domyślne `npm ci`, gdy istnieje lockfile npm.

`agentctl status`, `agentctl capacity` i `agentctl events` pokazują zajętość magazynu lub wynik setup. `agentctl gc --preview` wyświetla nieużywane wpisy, a `agentctl gc --apply` przenosi je do kosza. Po `agentctl close TASK` pasujące ignorowane ścieżki trafiają do kosza, a dziennik podaje ich nazwy i rozmiar. Śledzone pliki, nieignorowane pliki nieśledzone, raporty i katalogi używane przez inne otwarte zadanie zostają. Miejsce zwalnia opróżnienie kosza. Na Linuksie obsługuje go `gio`.

Po odłączeniu dysku zadanie ma stan `blocked` i przyczynę `volume missing`. Zamontuj dysk i przy działającym `watch` uruchom `agentctl unblock TASK`. Pliki przerwanego checkout zostają do sprawdzenia. Dla punktów montowania poza `/Volumes/<nazwa>` lub `/mnt/<nazwa>` podaj `worktrees.mount`. SSH korzysta z `work_dir` hosta i zgłasza brak obsługi klonowania, sprzątania przy zamknięciu, projektowego katalogu worktree i odzyskiwania blokad Git. SSH sprawdza montowanie `work_dir` w dwóch powyższych układach ścieżek.

## Przeglądy i integracje bez zapełniania dysku

Utrzymuj osobne worktree dla każdego zadania. Każdą próbę `FIX` zacznij od poprzedniej gałęzi, a przeglądowi Codexa nadaj osobne ID. Gdy projekt ma ustawione `worktree_root`, nagłówek specyfikacji przeglądu Neon City może wyglądać tak:

```yaml
task: NC-42-REVIEW-CX
agent: codex
review_of: NC-42
after: [NC-42]
setup: {from_task: NC-42}
merge_base_check: block
repos: [{path: ~/Projects/neon-city}]
```

Przy zlecaniu zadań przez MCP podaj `as: "chat:nc"`, żeby przypisać je do czatu. Jeśli klient i backend są w osobnych repozytoriach, wymień je w `repos`. `setup.from_task` (alias `link-from`) dopasowuje je osobno. Zgodny lockfile npm i system plików obsługujący copy-on-write pozwalają sklonować `node_modules` autora i pominąć osobne `npm ci` (także z `--no-audit` i `--no-fund`). Pozostałe kroki setup działają w tej samej kolejności. Przy braku źródła, różnym lockfile, niedostępnym klonie lub symlinku wychodzącym poza `node_modules` działa skonfigurowany setup. Jeśli nie ustawiono polecenia instalacji, opcja próbuje sklonować zależności, a po nieudanej próbie pozostawia instalację zadaniu. `setup.commands: []` wyłącza ten krok. MCP przyjmuje mapowanie zawierające samo źródło.

`merge_base_check: warn` zapisuje ostrzeżenie w `TASK.md` i statusie. `block` czeka w kolejce, aż gałąź autora będzie zawierać lokalne `main` albo `master`. `candidate` używa osobnej lokalnej gałęzi `review/NC-42-REVIEW-CX` i wymaga Git 2.38 lub nowszego. Przy konflikcie kolejka pokazuje listę ścieżek. Rozwiąż konflikt na gałęzi autora, a potem uruchom `agentctl queue retry NC-42-REVIEW-CX`. Po przeglądzie kandydata `agentctl close NC-42-REVIEW-CX --rm-worktree` usuwa jego checkout i zachowuje gałąź oraz raport.

Aby użyć najmniej miejsca, zatrzymaj autora poleceniem `agentctl close NC-42` i wstaw `review: {mode: readonly-on-author}` zamiast `setup.from_task`. Przegląd otwiera się w worktree autora, a dowody trafiają do `$AGENTCTL_REVIEW_EVIDENCE` pod `cache`. Agentctl pomija setup i linki oraz odmawia startu, gdy okno autora nadal istnieje. Hooki Git blokują zwykłe commity i push w procesie recenzenta. Hooki autora pozostają na miejscu, a nadpisanie wygasa wraz z procesem recenzenta. Proces zachowuje swoje uprawnienia do systemu plików, więc może zmienić pliki lub użyć niskopoziomowych poleceń Git. Tryb `candidate` wymaga osobnego worktree.

Gdy `MERGE-TRAIN` jest gotowy, przesuń lokalne `main` albo `master` przez fast-forward. Przy pierwszej obserwacji watch zapamiętuje pozycję gałęzi, a po kolejnych przesunięciach proponuje sprzątanie. Przy domyślnym `gc: {after_integration: propose}` każdy czat będący właścicielem zadań objętych planem dostaje jedną wiadomość WALL. Plan obejmuje czyste, zintegrowane worktree zadań zamkniętych lub anulowanych. Otwarte zadanie, pin lub symlink z innego worktree chronią katalog. Wiadomość podaje szacowane bajty i `request_id`. Wywołaj MCP `gc` z tym ID, sprawdź zakres i po zgodzie właściciela przekaż `confirm: true` z otrzymanym `preview_token`. Watch ponownie sprawdza katalogi przed usunięciem. `gc: {after_integration: off}` wyłącza propozycje.

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
./bin/agentctl-update --ref v0.22.3 --dry-run
./bin/agentctl-update --ref v0.22.3
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
git config user.name "Demo User"
git config user.email demo@example.invalid
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

## Kilka czatów na jednej instancji

### Limity dla kilku czatów

Połącz ten przykład z konfiguracją dyspozytora. Zachowaj dotychczasowe kanały WALL i mapowania klientów.

```yaml
providers: [claude, codex, kimi, glm]
limits:
  change_policy: owner-approve
  claude: 7
  codex: 10
  kimi: 3
  glm: off
  profiles:
    day: {claude: 7, codex: 10, kimi: 3, glm: off}
    night: {claude: 4, codex: 6, kimi: 2, glm: off}
  schedule:
    timezone: Europe/Warsaw
    switches: {"07:00": day, "22:00": night}
quotas:
  overprovision: 1.5
  floor: 1
  chats:
    nc: {share: 40}
    hems: {share: 40}
    vs65: {share: 20}
```

Przy siedmiu miejscach Claude udziały 40/40/20 dają po zaokrągleniu pułapy 4/4/2. Przy czterech miejscach w nocy dają 2/2/1. O liczbie jednocześnie działających okien nadal decyduje pułap globalny. Obniżenie pułapu dotyczy następnych startów, a już działające zadania mogą się zakończyć.

Przy migracji z 0.25 dobierz procenty do względnego zapotrzebowania czatów. Dawny pułap 4 miejsc przy limicie globalnym 7 i mnożniku 1.5 odpowiada około 38%. Usuń stare klucze dostawców tam, gdzie ma obowiązywać udział. Zostaw klucz, aby zachować wyjątek, np. `nc: {share: 40, codex: 5}`. Sprawdź wynik przez `agentctl limits` i `agentctl capacity` przed usuwaniem pozostałych nadpisań.

Przy `new` i `queue` w MCP podaj `as: "chat:nc"` lub nazwę własnego czatu. Jeśli potrzebujesz zmiany, wyślij `set_limits({as: "chat:nc", claude: 9, reason: "Dwa dodatkowe okna recenzji"})`. Agentctl utworzy wniosek na WALL i powiadomi właściciela. Na tablicy otwórz `L`, wybierz wniosek strzałkami, a następnie użyj `a` do zatwierdzenia lub `r` do odrzucenia. W terminalu właściciela użyj `agentctl limits requests`, a potem `agentctl limits approve ID` lub `agentctl limits reject ID`. Wniosek wygasa po dwóch godzinach.

W panelu wybierz dostawcę, zmień limit klawiszem `+` lub `-` i zastosuj go przez Enter. Aby zmienić profil, wybierz go i naciśnij Enter. W CLI możesz użyć `agentctl limits profile night` i `agentctl limits set claude=10 --until 23:00`. Zastosowane wartości i aktualne pułapy pojawiają się automatycznie na WALL. [Konfiguracja](configuration.md#kwoty-czatów)

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
