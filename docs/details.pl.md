# Szczegóły

Jak działają poszczególne elementy i co sprawdzono na prawdziwych narzędziach (Claude Code 2.1.309, Codex 0.166.0). Przegląd jest w [README](../README.pl.md); opcje każdego polecenia w [commands.md](commands.md) (po angielsku), a każdy klucz w [configuration.md](configuration.md) (po angielsku). Teksty paska stanu i powiadomień cytowane poniżej pochodzą dosłownie z kodu i miejscami są po polsku.

Paczka npm zawiera JavaScript kompilowany przez `npm run build` do `dist/` (importy `.ts` stają się `.js`). Źródła i testy uruchamiamy bezpośrednio przez wycinanie typów w Node 22.14+. Publikacja nie wymaga wycinania typów wewnątrz `node_modules`.

## Setup

`setup` to lista komend shell (spec > `.agentctl.yaml` projektu > config globalny; wygrywa pierwsza warstwa, która go ustawia, `setup: []` wyłącza).
`new` uruchamia je per repozytorium, każdą w jego worktree (`repos[].setup`, w razie braku `.agentctl.yaml` tego repo; `setup` ze specu/globalny należy do pierwszego repo), każdą jako osobne `sh -c`, w tej kolejności: `git worktree add` → **setup** → linki → TASK.md → okno → agent.

- Wyjście trafia do `<state_dir>/<task>/setup.log`.
- Komenda, która się nie udaje, zatrzymuje `new` z jej kodem wyjścia i ostatnimi 15 liniami wyjścia. Worktree zostaje, okno nie jest tworzone; usuń przyczynę i uruchom `agentctl new --reuse` (setup uruchomi się ponownie).
- `--dry-run` wypisuje komendy jako `(cd <worktree> && sh -c '…')`.
- `new --no-agent` zatrzymuje się po setupie i linkach: bez TASK.md, okna i agenta. Przydatne do sprawdzenia setupu projektu.

Dla projektu Node wymagającego instalacji zależności w każdym worktree dodaj do `.agentctl.yaml`:

```yaml
setup:
  - npm ci --prefer-offline --no-audit --no-fund
```

## Linki

Linki to klej, dzięki któremu worktree używa kodu *innego* worktree (na przykład klient wobec backendu pod testem).

- `from` jest względne wobec pierwszego worktree, `to` to cel, na który ma wskazywać.
- `to` musi istnieć (sprawdzane, zanim cokolwiek powstanie), inaczej `new` zatrzymuje się z listą brakujących celów.
- `to` bez `*`: każde dopasowanie globu `from` staje się symlinkiem do `to`. `from` bez znaków globu to **ścieżka dosłowna**: jest linkowana, nawet jeśli nic tam jeszcze nie ma, a jej katalogi nadrzędne są tworzone (`mkdir -p`), więc `from: node_modules/@scope/protocol` działa w worktree bez `node_modules`.
- Glob, który niczego nie dopasuje, tylko ostrzega, a ostrzeżenie wskazuje ścieżki dosłowne.
- `to` kończące się na `/*` (i `from` kończące się na `/*`): jeden link na każdy wpis tego katalogu, nazwany jak wpis.
  `from: node_modules/@scope/*`, `to: ~/backend/packages/*` linkuje `node_modules/@scope/foo` do `~/backend/packages/foo` i tak dalej.
- Istniejące **symlinki** są zastępowane. Niczego, co nie jest symlinkiem, nie ruszamy: `new` zatrzymuje się i mówi, która ścieżka stoi na drodze.

## Effort

Prompt zawsze zaczyna się od linii `Model: <model> · effort <effort>`, niezależnie od flag.
Poza tym agent jest uruchamiany z własnym ustawieniem effortu tam, gdzie takie istnieje. Co znalazłem w zainstalowanych wersjach:

| Agent | Sprawdzona wersja | Wynik |
|---|---|---|
| Claude Code | 2.1.309 | Natywna flaga: `claude --effort <low\|medium\|high\|xhigh\|max>`. agentctl przekazuje `--effort <effort>`. |
| Codex | 0.166.0 | Brak dedykowanej flagi. `-c, --config <key=value>` nadpisuje dowolny klucz `config.toml`, a `model_reasoning_effort` to klucz, którego używa `~/.codex/config.toml`. agentctl przekazuje `-c model_reasoning_effort=<effort>`. |

Nadpisanie w Codexie sprawdzono na żywo: `codex -c model_reasoning_effort=low` w pustej sesji tmux pokazało `GPT-6.1-Sol low`
w stopce, choć `~/.codex/config.toml` mówi `high`. `--effort low` w Claude pokazało `Opus 5.5 with low effort`.
Jeśli przyszła wersja to zmieni, ustaw `agents.<name>.effort_args` (`[]`, żeby nie przekazywać niczego). `agentctl doctor` pokazuje, który
mechanizm wykrywa.

## Odpowiedniki modeli

Modele Claude i Codexa nie odpowiadają sobie jeden do jednego, więc agentctl trzyma tabelę par, które uznajesz za równoważne
(`config.equivalents`, działa w obie strony). Wbudowana tabela:

| Claude (`model/effort`) | Codex (`model/effort`) |
|---|---|
| `haiku/low` | `gpt-6-luna/medium` |
| `haiku/medium` | `gpt-6-luna/high` |
| `sonnet/medium` | `gpt-6.1-sol/medium` |
| `sonnet/high` | `gpt-6.1-sol/high` |
| `opus/high` | `gpt-6-astra/medium` |
| `opus/xhigh` | `gpt-6-astra/xhigh` |

Własne pary dodajesz w `~/.agentctl/config.yaml`; mają pierwszeństwo przed wbudowanymi:

```yaml
equivalents:
  - {claude: "opus/medium", codex: "gpt-6-astra/low"}
```

`fable` i effort `max` są celowo niemapowane. Tam, gdzie tabela nie ma pary, dostajesz błąd z linią do dodania.

- `agentctl new --agent codex spec.md` uruchamia każdy spec na Codexie, tłumacząc `model/effort` przez tabelę
  (`opus/high` staje się `gpt-6-astra/medium`). To jawne polecenie, więc o nic nie pyta.
- Gdy limit okien wskazanego dostawcy jest pełny, a drugi ma miejsce, `new` **pyta**, czy zmienić
  (`... Switch to codex gpt-6-astra/medium (equivalent of claude opus/high)? [y/N]`). Bez terminala albo z
  `--no-switch` kończy się błędem z listą żywych okien. Nigdy nie zmienia po cichu.
- `pin: true` w specu zakazuje każdej zmiany (przez limit lub `--agent`).
- `TASK.md` i `status` trzymają zarówno **żądanego**, jak i **faktycznego** agenta/model/effort. `review_of` jest sprawdzane na
  wartościach faktycznych, po mapowaniu: recenzent przesunięty na agenta i model autora zostaje odrzucony.

## Utracony stan: orphany i adopt

agentctl trzyma własne pliki (`TASK.md`, `setup.log`, znacznik `pulled`) w `state_dir` (domyślnie `~/.agentctl/tasks/<task>/`), a
`<cache>/<task>/` zostawia agentowi, który dostaje tylko ścieżkę raportu. Starsze wersje trzymały wszystko w folderze cache, a agent
Codexa, który posprzątał swój folder, usunął `TASK.md`: zadanie znikało ze `status`, `watch` i `pull`.

- **Migracja.** Każde polecenie (poza `--dry-run`) najpierw szuka plików `TASK.md` zapisanych przez agentctl w `<cache>/<task>/` i przenosi je
  razem z `setup.log` do `<state_dir>/<task>/`, wypisując jedną linię `migration: moved …` na zadanie. Istniejący stan nigdy nie jest nadpisywany.
- **Orphany.** Okno tmux w sesji agentctl (inne niż `watch`) bez pliku stanu pojawia się w `status` jako stan `orphan`
  z linią podpowiedzi, a `watch` powiadamia o nim raz.
- **Adopt.** `agentctl adopt NC-42 --report ~/workspace/cache/nc-42/NC-42.md` zapisuje nowy plik stanu. Prompt przepada, tak samo
  agent, model i effort, chyba że podasz `--agent`, `--model`, `--effort` (pokazują się jako `unknown`). Dodaj `--worktree <path>`, żeby
  `close --rm-worktree` znało worktree. `--window <name>`, jeśli okno nie nazywa się ID zadania małymi literami. Odmawia, gdy plik stanu istnieje.

## Przerwanie

`agentctl interrupt NC-42` wysyła klawisz przerwania agenta (`agents.<name>.interrupt_key`, domyślnie `Escape` dla obu) do
okna zadania. Niczego więcej nie wpisuje i nie zamyka okna. Celowo wysyłany jest tylko jeden klawisz: sprawdzone na żywo,
pojedynczy `Escape` przy bezczynnym prompcie nic nie robi w Claude Code 2.1.309 i Codexie 0.166.0, a podwójny `Escape` w Codexie
otwiera „edit previous message”. `--dry-run` wypisuje `tmux send-keys`, które by uruchomił.

## Attach i peek

`agentctl attach [TASK]` zabiera Cię do okna zadania. Poza tmux wybiera okno i uruchamia `tmux attach-session`;
wewnątrz tmux (ustawione `$TMUX`) wybiera okno i uruchamia `tmux switch-client`. Zanim odda terminal, wypisuje jedną linię:

```
Ctrl-b d – wyjście bez przerywania agenta; nie wciskaj Esc ani Ctrl-c
```

Odłączenie przez `Ctrl-b d` zostawia agenta w pracy; `Esc` i `Ctrl-c` trafiłyby do samego agenta. Bez argumentu `attach` idzie do
jedynego działającego zadania; przy kilku pokazuje numerowaną listę do wyboru (bez terminala: listę i błąd).

`agentctl peek TASK [-n 40]` wypisuje ostatnie N linii zawartości okna (ekran i scrollback) bez dołączania. Linie stopki agenta
(`footer_patterns`), ramki wokół pola wejściowego i puste prompty wejścia są pomijane, tym samym filtrem, którego używa `status` dla `LAST LINE`.

`TASK` w obu nie rozróżnia wielkości liter, a wystarczy jednoznaczny prefiks (`agentctl peek nc-4` znajdzie `NC-42`). Dokładne ID zawsze wygrywa z dłuższym, którego jest prefiksem
(`NC-4` przed `NC-42`). Niejednoznaczny prefiks to błąd z listą kandydatów; zadanie, którego okno zniknęło, mówi o tym wprost.
Pozostałe polecenia (`send`, `pull`, `close`, `interrupt`, …) nadal przyjmują pełne ID.

## Postęp

`PROGRESS` w `status` (tabela, `--json` jako `progress`, `--clip`, `status.json` mirrora) pokazuje, co każde zadanie ma na swoim koncie:
`2c 7f` to 2 commity ponad bazą i 7 zmienionych plików, zsumowane po worktree zadania. Bazą jest `base` repo ze specu, inaczej `main`, inaczej `master`.
Commity to `git rev-list --count <base>..HEAD`. Pliki to suma `git diff --name-only <base>...HEAD` (co ta gałąź zmieniła, odkąd odeszła od bazy; trzy kropki,
więc zmiany, które baza dostała w międzyczasie, się nie liczą) i `git status --porcelain` (pliki niezacommitowane i nieśledzone, dla całkowicie nieśledzonego katalogu zwinięte do katalogu),
każdy plik liczony raz. Bez bazy commity to `?` (`?c 3f`); worktree, którego nie ma, to `-`. `--json` niesie liczby per worktree.

## Wykrywanie raportu

Spec mówi, gdzie ma trafić raport (`report:`, domyślnie `<cache>/<task>/<TASK>.md`), ale agenci zapisują go, gdzie chcą: `docs/reports/<…>.md` w worktree, `~/workspace/cache/<inna nazwa>/…`. Zadanie wisi wtedy jako `waiting`, a `pull --ready` go nie widzi. agentctl szuka raportu sam.

- **Kiedy.** Po każdym końcu tury (hook Claude `Stop` z `last_assistant_message`, Codex `notify` z `last-assistant-message`) i przy każdym ticku `watch` dla zadania w stanie `waiting`. Dopóki plik kanoniczny jest na miejscu (zapisany po starcie zadania), nic nie jest szukane, także gdy agentctl wcześniej zrobił kopię.
- **Gdzie.** Wyłącznie skonfigurowane alternatywne ścieżki/globy report, względne do worktree. Wzmianki o plikach nie są przeszukiwane.
- **Kandydaci.** Tylko pliki pasujące do alternatywnych globów report, zmodyfikowane w bieżącej próbie i z ID zadania w nazwie. Wzmianki w prompcie i ekranie nie są źródłem. Kopia wyłącznie po jawnym `report --from` / `report_from`.
- **Lista.** `report:` w specu, `.agentctl.yaml` albo `config.yaml` może być listą. Pierwszy wpis to ścieżka kanoniczna; pozostałe to miejsca do przeszukania, ścieżki lub globy (`*`, `?`, `**`), absolutne, `~/…` albo względne do worktree, z `{task}`/`{TASK}`: `report: [~/workspace/cache/{task}/{TASK}.md, docs/reports/*{task}*.md, docs/reports/*{TASK}*.md]`.
- **Co się dzieje.** Autodetekcja zapisuje flagę kandydata i zdarzenie, bez kopiowania. Jawne --from kopiuje do ścieżki kanonicznej i zapisuje report_source, report_copied oraz report_source_mtime. Świeży plik kanoniczny wygrywa, chyba że jawnie podano --force.
- **Ręcznie.** `agentctl report <TASK>` pokazuje ścieżkę kanoniczną, źródło i to, co wyszukiwanie znajduje teraz (niczego nie kopiuje). `agentctl report <TASK> --from <ścieżka>` czyni ten plik źródłem i kopiuje go (`--force` także na raport, który napisał agent; `--dry-run` niczego nie kopiuje). `pull <TASK>` uruchamia wyszukiwanie, gdy raportu brak.
- **Gdzie to widać.** `status` (kolumna raportu: `yes (z <ścieżka>)`; `--json`: `reportSource`), board (notatka pod podglądem: `report from <ścieżka>`), MCP `list_reports` (`source`) i `task_spec` (`report_source`).

## Zdarzenia

Czytanie ekranu co 15 sekund to zgadywanie, co robi agent. Dlatego `agentctl new` prosi też każdego agenta, żeby zgłaszał się sam, a `agentctl event` (polecenie, którego nigdy nie wpisujesz) przyjmuje wiadomość:
dopisuje linię do `<state_dir>/events.log`, zapisuje `<state_dir>/<task>/event.json` (więc `status` i [board](#board) od razu pokazują nowy stan, board nawet przeładowuje się, gdy plik się zmieni) i od razu wysyła powiadomienie.
Zawsze kończy się kodem 0 i nic nie wypisuje, więc zepsuty hook nigdy nie zaszkodzi agentowi. Zadanie uruchomione bez zdarzeń (starsze zadania, `notify.events: false`) dalej działa samym czytaniem ekranu.

| Agent | Zdarzenie | agentctl |
|---|---|---|
| Claude | `Notification` `permission_prompt` / `elicitation_dialog` (dowolny dialog uprawnień; `AskUserQuestion` wysyła ten sam typ) | `needs-input`, powiadomienie z pytaniem |
| Claude | `Notification` `idle_prompt` („Claude is waiting for your input”, minutę po Stop) | tylko w logu |
| Claude | `Stop` (koniec tury; niewysyłane, gdy przerwiesz przez Esc) | tura się kończy: `report-ready`, jeśli raport jest, inaczej `waiting` |
| Claude | `StopFailure` z `rate_limit` lub `billing_error` | `limited` (inne błędy trafiają do logu) |
| Codex | `agent-turn-complete` (koniec tury; wysyłane też raz dla tury, która zapisuje tytuł sesji, i to jest ignorowane) | jak `Stop` |
| Codex | prośba o zatwierdzenie, `request_user_input` | **brak zdarzenia w 0.166.0**: wyłapuje je czytanie ekranu (`question_pattern`) |

**Claude Code 2.1.x.** `new` zapisuje `<state_dir>/<task>/claude-settings.json` z hookami `UserPromptSubmit`, `Notification`, `Stop` i `StopFailure`, każdy uruchamia
`<this agentctl> event --task <TASK> --agent claude --kind <user-prompt-submit|notification|stop|stop-failure>` (JSON hooka przychodzi na stdin), i uruchamia `claude … --settings <ten plik>`.
*Historyczne sprawdzenie 2.1.309:* `--settings` **łączy się** z pozostałymi źródłami. Przy hooku użytkownika w `~/.claude/settings.json` (przykładowy zestaw: SessionStart, UserPromptSubmit, PreToolUse, Stop), projektowym `.claude/settings.json` z hookiem Stop i `--settings` z własnymi hookami Stop i Notification
jedno uruchomienie `claude -p` wykonało je wszystkie (`--debug-file` wypisuje każde `Hooks: Stop [...] finished with status 0`; znaczniki z hooka projektu i wstrzykniętego zostały zapisane). Żaden istniejący hook nie jest wyłączany ani zastępowany, a plik zawiera tylko hooki zdarzeń.
`UserPromptSubmit` jest udokumentowany od 1.0.54; poprawka P sprawdza nową ścieżkę potwierdzenia wyłącznie na atrapach w izolacji ([hooki](https://code.claude.com/docs/en/hooks), [changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)).

**Codex 0.166.0.** `new` dodaje `-c notify=["…agentctl", "event", "--task", "<TASK>", "--agent", "codex", "--forward", "<json>"]`; Codex dopisuje zdarzenie jako JSON do tego argv. *Sprawdzone na żywo:* `-c notify=` **zastępuje** `notify` z `config.toml`
(hook `turn-ended` aplikacji Computer Use przestał działać), więc agentctl czyta `notify` najwyższego poziomu z `$CODEX_HOME/config.toml` (`~/.codex`, chyba że `env` specu ustawia `CODEX_HOME`) i przekazuje go jako `--forward`:
`event` uruchamia go potem z tym samym JSON-em, tak jak zrobiłby to Codex. `~/.codex/config.toml` nigdy nie jest zmieniany.
Codex 0.166.0 ma też hooki (`PermissionRequest`, `Stop`, …), które zgłaszałyby zatwierdzenia, ale trzeba im najpierw zaufać: Codex pokazuje dialog „Hooks need review” i zapisuje zaufanie w `config.toml`. agentctl nie odpowiada na dialogi
ani nie zapisuje Twojego configu, więc z nich nie korzysta. Narzędzie `request_user_input` jest za flagą funkcji `default_mode_request_user_input` („under development”, wyłączona), więc nie dało się go wypróbować; jego ekran (`? <question>` … `Waiting for your answer`) pozostaje objęty przez `question_pattern`.

**Tekst needs-input.** Pytanie jest brane z ekranu, gdy otwarty jest dialog z ponumerowanymi opcjami: ostatnia linia kończąca się na `?` nad opcjami, plus to, czego dotyczy, dla ogólnego
(`Do you want to proceed? touch approved.txt`, `Would you like to run the following command? $ printf 'yes' > approved.txt`), najwyżej 120 znaków. JSON hooka Claude mówi tylko „Claude needs your permission”.
Zdarzenie rozstrzyga o stanie tylko tam, gdzie ekran nie może: dialog uprawnień, którego nie zna żaden wzorzec, liczy się jako `needs-input`, dopóki pole wejściowe jest ukryte, i traci ważność, gdy pole wraca. Trwająca tura zawsze wygrywa.

## Powiadomienia

Każde powiadomienie ma tytuł `agentctl` i dźwięk. Tekst na przejście: `NC-42: <pytanie>` (needs-input), `NC-42: raport gotowy – <werdykt>` (report-ready), `NC-42: skończył turę i czeka na Ciebie – <ostatnie słowa>` (koniec tury bez raportu; wyłączane przez `notify.turn_end: false`),
`NC-42: claude wyczerpał limit użycia – agentctl move NC-42 przeniesie zadanie na codex` (limited), a do tego `needs-trust`, `dead`, `orphan` i przypomnienie po `watch.waiting_after`.

**Jedno przejście, jedno powiadomienie.** Zdarzenie i obserwator mogą zobaczyć to samo przejście. Ogłoszony stan jest trzymany w `<state_dir>/<task>/notified.json` razem ze źródłem: gdy drugie źródło ogłosiło ten sam stan mniej niż `max(90 s, 3 × watch.interval)` temu, to drugie tylko zapisuje w swoim logu
(`already announced by the agent's event`). Dwa zdarzenia agenta nigdy się nie łączą (drugi dialog uprawnień to nowe pytanie).

**Kliknięcie prowadzi do okna.** Z [`terminal-notifier`](https://github.com/julienXX/terminal-notifier) (`brew install terminal-notifier`; `doctor` mówi, gdy go brakuje) kliknięcie uruchamia

```
<this agentctl> attach NC-42 --switch-client      # wybierz okno, przełącz klienta tmux podłączonego do sesji agentctl
```

i wysuwa terminal na wierzch (`-activate`): `notify.terminal_app`, inaczej wykrywane z `TERM_PROGRAM` (`Apple_Terminal` → `com.apple.Terminal`, `iTerm.app` → `com.googlecode.iterm2`), inaczej ze środowiska, w którym wystartował serwer tmux; dla każdego innego terminala żadna aplikacja nie jest aktywowana.
Gdy do sesji agentctl **nie jest podłączony żaden klient**, nie ma czego przełączać: kliknięcie tylko wysuwa terminal, a tekst kończy się na `· agentctl attach NC-42`. Polecenie kliknięcia niesie ścieżki bezwzględne oraz własne `PATH`, `AGENTCTL_HOME` i `TMUX_TMPDIR`,
bo kliknięcie działa z gołym środowiskiem (na żywo: bez `PATH` nie znajdowano tmux, a bez `LANG` tmux drukował tabulator swoich formatów `-F` jako `_`, więc agentctl sam daje tmux lokalizację UTF-8).
Bez terminal-notifier powiadomienie jest tym starym, przez `osascript` (`notify-send` na Linuksie), bez akcji. terminal-notifier 3.x nie pokazuje niczego, dopóki macOS nie da mu uprawnień (pierwsze powiadomienie o nie prosi) i dopóki jego styl alertu nie jest `None`
(Ustawienia systemowe > Powiadomienia > terminal-notifier); `doctor` uruchamia `terminal-notifier -diagnose` i ostrzega dokładnie o tym.

**Backend i rezerwa (`notify.backend`).** `auto` (domyślnie) najpierw próbuje terminal-notifier. terminal-notifier 3.x może zakończyć się komunikatem `Could not request notification permission: Notifications are not allowed for this application`, a tego uprawnienia nie da się nadać z wiersza poleceń: gdy kończy się kodem niezerowym albo wypisze ten komunikat, to samo powiadomienie idzie przez `osascript` (bez akcji kliknięcia), a terminal-notifier dostaje spokój na godzinę (`<config dir>/notifier.json`, żeby obserwator i hooki widziały to wszystkie); jednolinijkowe ostrzeżenie trafia do `<config dir>/notifier.log`. `terminal-notifier` albo `osascript` używają tylko tego kanału (bez rezerwy, nic nie jest zapamiętywane).
`agentctl notify-test` wysyła jedno powiadomienie i mówi, który kanał je przeniósł, próbuje terminal-notifier jeszcze raz, nawet jeśli jest zapamiętany jako zepsuty, i kończy się kodem 1, gdy żaden kanał nie zadziałał. Żeby odzyskać kliknięcie do okna: Ustawienia systemowe > Powiadomienia > terminal-notifier > Zezwalaj na powiadomienia, styl alertu Banery; jeśli terminal-notifier nie ma na tej liście, ustaw `notify: {backend: osascript}`. `doctor` pokazuje ten stan i kroki.

**Werdykt.** Powiadomienie `report-ready` cytuje werdykt raportu, bez markdownu, najwyżej 100 znaków, w tej kolejności: `verdict` bloku `agentctl-outputs`, pierwsza linia pasująca do `notify.verdict_pattern` (regex; jego pierwsza grupa, inaczej cała linia),
potem linia werdyktu w nagłówku raportu (przed pierwszym nagłówkiem `##`, blokiem kodu lub linią prozy; bloki w płotkach i cytaty są pomijane): `Werdykt`, `Verdict` lub `Status` po `:`, `-`, `–` albo `—` (`**Werdykt:** PASS`; jeśli etykieta stoi sama, wartością jest następna linia). Nigdy dowolna linia tekstu.

## Powiadomienia na telefon

Gdy away jest włączone, kopia zdarzeń, które dostaje Mac, idzie na telefon przez [ntfy](https://ntfy.sh). Przegląd i kroki konfiguracji są w [README](../README.pl.md#powiadomienia-na-telefon); tu jest opis działania.

- **Jedno miejsce.** Każde ogłoszone zdarzenie trafia do dziennika (`<katalog konfiguracji>/journal.jsonl`) raz, po deduplikacji Maca (zdarzenie agenta i odczyt ekranu przez obserwatora tej samej zmiany to jedno). Zapis przechodzi przez `notifyPhone`: jeśli ustawiony jest temat, away jest włączone (albo `notify.ntfy.always`) i zdarzenie jest w `notify.ntfy.events`, wysyła żądanie. Telefon nie może więc dostać zdarzenia dwa razy ani takiego, którego Mac nie ogłosił. Wpis w dzienniku dostaje `phone: sent` albo `phone: queued` (`events` drukuje za nim 📱). `orphan` i `usage-critical` (okno planu powyżej `usage.critical`) stały się w tym celu zdarzeniami dziennika; zwykłe ostrzeżenie `usage` zostaje na Macu.
- **Away.** `<katalog konfiguracji>/away.json` trzyma `{on, since, by}`; `by` to `cli`, `board`, `mcp` albo `auto`. Obserwator, hooki zdarzeń, board i serwer MCP czytają ten sam plik, więc zmiana jest widoczna wszędzie od razu. Z `away.auto_idle: N` każdy tick obserwatora pyta `ioreg -c IOHIDSystem` o `HIDIdleTime`: bezczynność przez N minut włącza away (`by: auto`), pierwsza aktywność wyłącza je z powrotem, ale tylko to, co włączyło `auto`. Ręczne `away off` przy wciąż bezczynnym Macu nie jest cofane, dopóki nie wystąpi aktywność. Gdy `ioreg` zawodzi, nic się nie dzieje.
- **Żądanie.** `POST <serwer>/<temat>`; tekst to treść żądania; nagłówki `Title`, `Priority` (`min`, `low`, `default`, `high`, `urgent`), `Tags` (kod emoji dla zdarzenia: `white_check_mark` dla raportu, `question` dla pytania, `skull` dla zniknięcia okna …), `Click` (`click_url`) i `Authorization: Bearer <token>`. Nagłówek ze znakiem spoza ASCII (polski tytuł) jest wysyłany jako RFC 2047 (`=?UTF-8?B?…?=`), co ntfy dekoduje; `fetch` odrzuciłby go w surowej postaci. Limit czasu to 5 sekund.
- **Tekst.** Budowany z rodzaju zdarzenia oraz z ID zadania, nazwy kohorty i (`report-ready`, `include_verdict`) linii werdyktu: `NC-42: raport gotowy – Werdykt: PASS`. Linia werdyktu to ta sama, którą pokazuje Mac, skrócona do 100 znaków, a każde słowo wyglądające jak ścieżka lub nazwa pliku jest zastępowane przez `…`. Pytania domyślnie zostają lokalnie (`notify.ntfy.include_question: false`): telefon dostaje tylko instrukcję otwarcia (liczbę i skrót dla zwiniętych pytań Codexa) i dotychczasowe podpowiedzi managera/Remote Control; `true` włącza treść pytania przyciętą do 120 znaków, a zmiana przeładowuje się na żywo, także dla ponowień. Na publicznym ntfy.sh temat jest jedynym zabezpieczeniem, więc zachowaj go w tajemnicy i włączaj treść pytań tylko wtedy, gdy akceptujesz wysyłanie tam treści pracy. Tekst błędu i treść raportu poza werdyktem nigdy nie są dołączane; testy sprawdzają, że raport pełen sekretów i ścieżek nie wycieka żadnego z nich do żądania.
- **Awarie.** Pierwsze żądanie idzie od razu. Gdy się nie uda (brak sieci, przekroczenie czasu, status inny niż 2xx), wiadomość trafia do `<katalog konfiguracji>/phone-queue.json`, a obserwator ponawia ją w każdym ticku, gdy nadejdzie jej czas: po 30 sekundach, potem po 2 minutach, potem po 10 minutach. Po trzecim ponowieniu jest porzucana z wpisem w `<katalog konfiguracji>/phone.log`. Każda awaria to linia w `phone.log`; log obserwatora dostaje jedno ostrzeżenie na godzinę. Proces inny niż obserwator (`agentctl event`) robi tylko pierwszą próbę, kolejkuje i nigdy nie czeka.
- **Konfiguracja.** `agentctl ntfy-setup` edytuje `config.yaml` przez API dokumentu YAML, tak jak `limits set` (komentarze i kolejność kluczy zostają, `config.yaml.bak`, wynik jest ładowany w ramach sprawdzenia). Temat to `agentctl-` i 24 losowe cyfry szesnastkowe (96 bitów z `crypto.randomBytes`). `doctor` uznaje temat za słaby, gdy ma mniej niż 24 znaki, nie ma cyfr albo powtarza kilka znaków, i ostrzega przed serwerem prywatnym bez tokenu.
- **Sprawdzone na żywo** (sandbox `scripts/live-harness.ts`, `scripts/live-phone.ts`): zdarzenie `report-ready` fałszywego agenta przy włączonym away daje jedno żądanie do serwera-atrapy (Bearer, Priority, Tags, Click, treść bez raportu), przy wyłączonym żadnego, a obserwator nie dodaje drugiego; martwy serwer kolejkuje żądanie, a obserwator dostarcza je po 30 sekundach; `notify-test --phone` także dostaje HTTP 200 z lokalnej atrapy, bez kontaktu z publicznym ntfy.sh. Link subskrypcji `ntfy://<host>/<temat>` z `--show-qr` nie był próbowany na telefonie.

## Zdalne sterowanie i manager

Przegląd i kroki są w [README](../README.pl.md#sterowanie-z-telefonu); tu jest, jak to działa i co sprawdzono (a czego nie). Źródła: strona Remote Control w dokumentacji Claude Code (https://code.claude.com/docs/en/remote-control, opis CLI i opis błędów) oraz `claude --help` i `claude remote-control --help` zainstalowanego Claude Code 2.1.309 - czytane były tylko teksty pomocy, żadna prawdziwa sesja nie została uruchomiona.

| Sposób | Co to jest | Użycie w agentctl |
|---|---|---|
| `claude remote-control` | Tryb serwera: bez lokalnej sesji, kilka na żądanie. Globalna flaga przed `remote-control`, której nie może przekazać swoim sesjom (np. `--settings`), zatrzymuje go z błędem. | Nie: nie przeniesie haków zdarzeń, roli ani konfiguracji MCP |
| `claude --remote-control [nazwa]` (`--rc`) | Zwykła sesja interaktywna z włączonym Remote Control; flagi globalne (`--settings`, `--model`, `--effort`, `--mcp-config`, `--append-system-prompt-file`) są jej własne. | Tak: manager i `remote_control: true` w specu |
| `/remote-control [nazwa]` | Włącza Remote Control w działającej sesji. | Nie: trzeba by pisać do okna |
| `remoteControlAtStartup: true` (`/config`, ustawienia użytkownika) | Każda sesja interaktywna łączy się sama. | Nie: agentctl nigdy nie zmienia Twoich ustawień Claude; ustaw to sam, jeśli chcesz mieć w aplikacji każde okno zadania |

- **Polecenie.** Zawsze sesja interaktywna, nazwa zawsze podana (żeby opcjonalna wartość `--remote-control` nie zabrała następnej flagi), wieloargumentowe `--mcp-config` przed inną flagą i nigdy flaga auto-accept:

```sh
claude --model sonnet --effort medium --mcp-config ~/.agentctl/manager/mcp.json \
  --remote-control "agentctl manager" --settings ~/.agentctl/manager/settings.json \
  --append-system-prompt-file ~/.agentctl/manager/role.md
```

- **Pliki** powstają przy każdym starcie w `<katalog konfiguracji>/manager/`: `role.md` (rola, narzędzia zapisu, które przepuszcza `mcp.allow`, i tekst `manager.guide` do 60 000 znaków), `settings.json` (`permissions.allow` z narzędziami do odczytu serwera MCP, żeby telefon nie pytał o `status`; narzędzi zmieniających coś nie ma na liście, więc Claude Code najpierw pyta Ciebie) i `mcp.json` (ten sam wpis serwera, który rejestruje `agentctl mcp install --claude-code`, pod tą samą nazwą, więc narzędzia to `mcp__agentctl__*`). Do projektu nie jest zapisywane nic. Wznowiona rozmowa zachowuje prompt systemowy, z którym wystartowała (`--system-prompt-snapshot`), więc zmieniona rola obowiązuje w nowej sesji managera; tworzą ją `agentctl manager stop` i `agentctl manager`.
- **Okno.** `manager` w sesji agentctl, w `manager.project` (inaczej `--project`, inaczej tam, gdzie jesteś), utworzone przez `new-window` z komendą wpisaną do jego powłoki, jak zadanie. `status`, `close`, `cancel`, `gc` i `limits` nie widzą go jako zadania (jak `watch` i `board` jest zarezerwowaną nazwą okna); na liście okien nie ma znacznika agenta, więc nie zajmuje miejsca w limicie dostawcy, a procesy w nim są wewnątrz okna agentctl, więc `limits.count_external` też ich nie liczy. Zadanie nie może nazywać się `MANAGER`.
- **Okna dialogowe.** Zaufanie do folderu i jednorazowe „Enable Remote Control" należą do człowieka: `agentctl manager` czeka na znak zachęty do wpisywania, a gdy na ekranie jest okno dialogowe, zatrzymuje się i mówi, do którego okna iść. `agentctl up` (z `manager.autostart`) w ogóle nie czeka.
- **Co agentctl czyta z ekranu** (z dokumentacji, nigdy nie widziane na prawdziwym ekranie):

| Stan | Ekran pokazuje | Board mówi |
|---|---|---|
| `connected` | `/rc active` | połączony |
| `waiting` | znak zachęty, bez wskaźnika (kilka sekund po starcie to normalne) | czeka na połączenie |
| `confirm` | okno zaufania do folderu albo `Enable Remote Control` (nie wiersz „Enable Remote Control for all sessions" z `/config`) | czeka na potwierdzenie w oknie |
| `failed` | `Remote Control failed`, `Remote Control disconnected` i inne odmowy z opisu błędów | połączenie nie działa |
| `starting` | cokolwiek innego: Claude Code nie jest jeszcze przy swoim polu wpisywania | uruchamia się |
| `missing` | brak okna | nie działa |

- **`manager --url`** czyta ostatnie 600 linii okna i drukuje ostatni adres `https://claude.ai/code/…` oraz kod QR (ciąg co najmniej 12 linii ze znaków blokowych). Niczego nie wpisuje do okna. Gdy nie ma ani jednego, ani drugiego, mówi, żeby wpisać tam `/remote-control` albo otworzyć aplikację Claude, stuknąć Code i wybrać sesję po nazwie.
- **Zadanie z `remote_control: true`** startuje z `--remote-control <TASK>` po `agents.claude.flags` i przed `--settings`, więc haki zdarzeń, `--model` i `--effort` są bez zmian; sesja w aplikacji nazywa się jak zadanie. Obowiązują te same okna dialogowe (`new` czeka na człowieka, jak przy zaufaniu do folderu). `remote_control` jest zapisane w `TASK.md` i używane ponownie przez `resume` (przed `--resume`/`--continue`; Claude Code sam podłącza sesję wznowionej rozmowy). Zadanie Codex go mieć nie może (błąd); `defaults.remote_control` dotyczy tylko zadań Claude; zadanie przeniesione do Codex przez `move` albo limit traci go. `agents.claude.flags` nie może zawierać `--remote-control`, `--rc` ani `remote-control` (błąd).
- **Telefon.** Gdy okno managera działa, `needs-input`, `report-ready` i `cohort-done` kończą się: „Otwórz sesję „<manager.name>” w aplikacji Claude."; `needs-input` zadania z `remote_control` kończy się zamiast tego: „Odpowiesz w aplikacji Claude: <TASK>". Tylko tekst: bez linku, bez ścieżki, bez adresu sesji. Gdy okna nie ma, nic nie jest dopisywane.
- **Uśpienie i sieć** (dokumentacja): sesja rozmawia z Anthropic tylko wychodzącym HTTPS i nie otwiera portu; gdy Mac zaśnie albo sieć zniknie, sesja interaktywna łączy się ponownie po powrocie Maca, tryb serwera poddałby się po około dziesięciu minutach. Proces `claude` musi działać, więc zamknięcie okna albo restart Maca kończy sesję; `agentctl manager` (albo `up` z `manager.autostart`) przywraca ją jako nową rozmowę.
- **Wymagania i odmowy** (dokumentacja): logowanie przez claude.ai (`claude auth login`) na Pro, Max, Team lub Enterprise; nie klucz API, nie `CLAUDE_CODE_OAUTH_TOKEN` z `setup-token`, nie Bedrock, Vertex, Foundry ani `ANTHROPIC_BASE_URL` inny niż api.anthropic.com; nie z `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` ani `DISABLE_GROWTHBOOK`. `doctor` ostrzega, gdy któraś z tych zmiennych jest ustawiona w jego środowisku (serwer tmux uruchomiony z takiej powłoki przekazuje je dalej). Team i Enterprise: Owner włącza Remote Control, a Trusted Devices może poprosić telefon o rejestrację. Gdy sesja jest połączona, transkrypt jest przechowywany na serwerach Anthropic; `disableRemoteControl` w ustawieniach wyłącza całą funkcję.
- **Sprawdzone** (sandbox `scripts/live-harness.ts`, `scripts/live-manager.ts`, atrapa `claude`, która na `--help` odpowiada flagami i drukuje `/rc active`, gdy wystartuje z `--remote-control`): dokładna linia poleceń managera i zadania, pliki, projekt nietknięty, brak drugiego okna, `--url` z adresem na ekranie, `stop`, `up` z `manager.autostart`, `resume` z flagą, odmowa dla zadania Codex, `doctor` z kodem 0. **Niesprawdzone na prawdziwym Claude Code** (zużyłoby plan i zarejestrowało sesje na koncie): że `--remote-control` jest przyjmowane razem z `--settings`, `--mcp-config` i `--append-system-prompt-file` (dokumentacja nazywa to zwykłą sesją interaktywną, a pomoc wymienia je jako opcje tego samego polecenia), teksty ekranu powyżej, czy pierwszy start w ogóle pokazuje okno „Enable Remote Control", jak wyglądają na telefonie prośby o zgodę na narzędzia MCP i jak linia managera zachowuje się po uśpieniu Maca.

## Limity i move

Gdy plan albo limit szybkości dostawcy się wyczerpie, zadanie ma stan `limited` (ikona `⛔`, board, `status --tmux-line`), dostajesz powiadomienie z propozycją, a `agentctl move` przenosi zadanie. Limit wykrywany jest z dwóch źródeł: zdarzenia Claude `StopFailure` (`rate_limit`, `billing_error`)
i ekranu, przez `agents.<name>.limit_patterns` (wyrażenia regularne, bez rozróżniania wielkości liter, dopasowywane linia po linii; komunikat musi **otwierać** linię, po znacznikach punktorów takich jak `⎿ ● ■`, żeby nie wziąć za niego diffa ani zacytowanego zdania; trwająca tura nigdy nie jest `limited`).
Domyślne wzorce to ciągi znalezione w zainstalowanych binarkach; nie wywołałem prawdziwego limitu (zużyłoby to plan), więc wygląd w TUI jest **wywnioskowany, nie zaobserwowany**:

| Agent | Tekst (wersja) | Wzorzec | Pewność |
|---|---|---|---|
| Claude | `You've hit your session limit · resets 3pm`, `… weekly limit`, `… <model> limit`, `… monthly spend limit` (2.1.309) | `You.ve hit your .{0,60}limit` | wysoka co do tego, że ciągi istnieją (szablon `You've hit your ${window}${reset}` w binarce); miejsce w TUI nie zaobserwowane |
| Claude | `Usage limit reached`, `You're out of extra usage` | dosłownie | średnia: widziane jako ciągi, kontekst niezweryfikowany |
| Claude | `Request rejected (429)` (limit szybkości; drukowany także przy chwilowym problemie z przepustowością) | `Request rejected \(429\)` | niska: może być przejściowy, wtedy stan sam się czyści |
| Claude | hook `StopFailure` z `error: rate_limit` lub `billing_error` | zdarzenie | schemat z binarki; próbka w testach jest syntetyczna |
| Codex | `You've hit your usage limit. …` (z U+2019; warianty: `… for <model>. Switch to another model now`, `Upgrade to Plus …`, `… purchase more credits`) (0.166.0) | `You.ve hit your usage limit` | wysoka co do tego, że ciągi istnieją; miejsce w TUI nie zaobserwowane |
| Codex | `Usage limit reached`, `You're out of credits`, `Your workspace is out of credits`, `You hit your spend cap …` | dosłownie | średnia |

**`agentctl move <task> [--agent claude|codex] [-y]`** przenosi zadanie do drugiego dostawcy (albo do tego z `--agent`):

- model i effort pochodzą z [tabeli odpowiedników](#odpowiedniki-modeli) (`claude opus/high` → `codex gpt-6-astra/medium`); brak pary (Fable, `max`) to błąd z podpowiedzią;
- `pin: true` w specu (od tej wersji zapisywane w `TASK.md`; starsze zadania liczą się jako nieprzypięte) to błąd: przypięte zadania nigdy nie zmieniają dostawcy;
- nowe okno `<task>-2` (`-3`, … jeśli zajęte) startuje w **tym samym worktree** z tym samym env i ścieżką raportu; jego prompt to oryginalny z `TASK.md` plus
  `Poprzedni agent (<agent> <model>) przerwał przez limit. Kontynuuj od bieżącego stanu worktree: przeczytaj git log i git diff względem bazy, nie powtarzaj zrobionej pracy. Raport zapisz do <report>.`;
- zawsze pyta y/N; bez terminala i bez `-y` to błąd. `limits` docelowego dostawcy nadal obowiązują;
- stare okno **zostaje**: `status` i board pokazują je jako `superseded` (`↪`, bez powiadomień), a zamykasz je sam, `agentctl close <task>`.

Na boardzie `M` robi to samo po pytaniu `[y/N]`.

## Ikony okien i pasek stanu tmux

Dopóki działa `agentctl watch`, ustawia on stan każdego żywego okna przed jego nazwą, więc `Ctrl-b w` i pasek stanu pokazują, co się dzieje:

| Ikona | Stan |
|---|---|
| `⚙` | `working` |
| `⏸` | `waiting` |
| `?` | `needs-input` |
| `🔒` | `needs-trust` |
| `⛔` | `limited` |
| `✓` | `report-ready` |
| `↪` | `superseded` |
| `✗` | `orphan` (i `dead`, które nie ma okna do nazwania) |

Okno wygląda wtedy tak: `⚙ nc-42`. Jest przemianowywane tylko przy zmianie stanu, a gdy obserwator się zatrzyma (Ctrl-C albo zabicie okna), zwykłe nazwy wracają.
Wyłączysz to przez `watch.window_icons: false` albo podmienisz pojedyncze ikony (`watch.window_icons: {working: "▶", needs-input: "❓"}`; `"?"` ujmij w cudzysłów w YAML).
Okna `watch` i `board` nigdy nie są przemianowywane.

Każde polecenie agentctl znajduje okno po nazwie zadania, cokolwiek stoi przed nią. `new` i `adopt` zapisują też własny ID okna tmux (`@12`) jako `window_id`
w `TASK.md`, a polecenia celują w ten ID, dopóki okno nosi nazwę zadania (tmux używa ID ponownie po restarcie, więc nieaktualny ID nigdy nie jest brany na wiarę).
Zadania uruchomione przed tą wersją nie mają ID i są dopasowywane po nazwie. Jeśli `watch` zostanie zabity brutalnie (`kill -9`), ikony zostają na oknach do następnego uruchomienia `watch`;
w międzyczasie wszystko działa. Zmieniaj ikony, gdy obserwator jest zatrzymany (rozpoznaje swoje stare ikony tylko wtedy, gdy są symbolami albo są w configu).

`agentctl status --tmux-line` drukuje liczbę zadań na stan jako jedną linię, `2⚙ 1✓ 1?`, a po niej zadania w kolejce jako `3⧗` (`2⚙ 1⏳ 3⧗`; zerowe liczby pomijane; raporty, które już pobrałeś, nie liczą się jako `✓`;
`orphan` i `dead` dzielą `✗`). Nie wykonuje wywołań gita i nie drukuje niczego więcej, więc tmux może go uruchamiać. `agentctl watch --tmux` ustawia, **tylko dla sesji agentctl**
(`set-option -t =agentctl:`, nigdy `-g`):

```
status-right    #(<this agentctl> status --tmux-line)
status-interval 10
```

`<this agentctl>` to bezwzględna ścieżka node'a i skryptu tego checkoutu z bieżącym `AGENTCTL_HOME`, a nie goły `agentctl`, bo `PATH` serwera tmux często go nie zawiera.
To zastępuje `status-right` sesji; cofniesz przez `tmux set-option -u -t agentctl: status-right`. Pasek zostawisz w spokoju przez `watch --tmux --no-status-line` albo `watch.status_line: false`.

## Zamykanie i ukrywanie zadań

Trzy różne rzeczy, od najlżejszej:

- **Zakończone.** Zadanie, którego okna już nie ma (zamknąłeś agenta w oknie, zawiesił się albo został przeniesiony do drugiego dostawcy), ale którego nikt nie zamknął przez `agentctl close`. Zostaje w `status`, a na boardzie siedzi pod zamkniętym tytułem **Finished (N)**, przyciemnione. `Enter` otwiera tam menu (`c` kopiuj raport, `x` zamknij, `h` ukryj, `Esc`), bo nie ma okna, do którego można przejść.
- **Ukryte.** `agentctl hide <task…>` (board: `h`) ustawia `hidden: true` w `TASK.md`. Zadanie znika ze `status` i z boardu (`status --all` i klawisz boardu `a` je przywracają, `agentctl unhide` / `h` pokazuje je znowu). Nic nie jest zamykane i żaden worktree nie jest ruszany. Przy `board.auto_hide_pulled_dead: true` (domyślnie) zadanie **bez okna, którego raport został pobrany** (`pull`, `pull --ready`, `c` albo `r` na boardzie, MCP `pull_ready`), ukrywa się samo; bez raportu zostaje pod Finished. `unhide` zapisuje `hidden: false`, co utrzymuje to zadanie widocznym. agentctl nigdy sam nie zamyka zadania ani nie usuwa worktree.
- **Zamknięte.** `agentctl close` (board: `x`) zabija okno i zapisuje `closed: true` oraz `closed_at` w `TASK.md`. Zamknięte zadanie znika ze `status`, z boardu, z `pull --ready`, z `watch` (zamknięcie zadania bez raportu nie jest alarmem „okno zniknęło”) i z [limitów okien](#limity-okien-i-cross-review); `status --all` i klawisz boardu `a` wymieniają je jako `closed`. Stan i raport zostają.
  `agentctl archive [--older-than 7d]` przenosi folder stanu zamkniętych zadań do `~/.agentctl/archive/<task>/` (obok folderu stanu). Folder, który jest w archiwum, przeniesiony tam przez `archive` albo ręcznie, to zamknięte zadanie, nigdy orphan ani błąd; żywe okno o tej samej nazwie ma nad nim pierwszeństwo.

## Anulowanie zadań

Czasem praca zostaje porzucona w połowie. `agentctl cancel <TASK…> [--reason "…"] [--rm-worktree] [-y]` (board: `X`; MCP: `cancel`) pokazuje listę i pyta y/N, a potem:

- **Zadanie w pracy:** wysyłany jest klawisz przerwania agenta (jak w `interrupt`), agentctl czeka `cancel.grace` sekund (domyślnie 5, raz dla wszystkich zadań jednego polecenia), po czym okno jest zamykane. `TASK.md` dostaje `cancelled: true`, `cancelled_at`, `cancel_reason` (jeśli podano) i `cancel_source` (`cli`, `board` lub `mcp`).
- **Zadanie w kolejce:** jest zdejmowane z kolejki (`queue rm` robi to samo bez powodu) i dostaje własny `TASK.md` z tymi samymi polami, żeby było widać je w `status --all`, a zadania, które na nie czekają, mogły zobaczyć, że go nie ma.
- **Zadanie, które przeniosłeś** (`agentctl move`): stare zadanie (`superseded`) i jego następca to jedna praca, więc oba są anulowane, po jednym pytaniu.
- **Worktree i gałąź zostają**, bo częściową pracę często warto zachować. `--rm-worktree` uruchamia `git worktree remove` (nigdy `--force`; niewyczyszczony worktree jest zgłaszany i zostawiany); gałąź nigdy nie jest usuwana.

`cancelled` to osobny stan, nie `closed`. Anulowane zadanie znika ze `status` i z boardu (`status --all` i klawisz boardu `a` wymieniają je pod **Cancelled**), nie liczy się do [limitów okien](#limity-okien-i-cross-review), nigdy nie jest brane przez `pull --ready` i nie daje alarmu „okno zniknęło”. Raport, który agent zdążył napisać, zostaje: czytają go `agentctl pull <TASK>` i MCP `get_report`. Anulowanie z terminala albo z boardu niczego nie ogłasza; to, o które prosi czat (MCP `cancel`, `queue_rm`), pokazuje zwykłe powiadomienie na pulpicie.

## Kohorty

Zadania można grupować pod wybraną nazwą: `cohort: sprint-1` w specu, `--cohort sprint-1` przy `new` i `queue` (flaga wygrywa ze specem) albo `agentctl cohort add sprint-1 NC-41 NC-42` dla zadań, które już istnieją. Zadanie bez nazwy należy do **żadnej kohorty**: nie ma kohorty domyślnej i agentctl nigdy żadnej nie wymyśla.

- **Nazwy.** Litery, cyfry, `-`, `_` i `.`, najwyżej 40 znaków, zaczynają się od litery, cyfry lub `_`. Porównanie ignoruje wielkość liter; nazwa jest pokazywana tak, jak została zapisana za pierwszym razem. Kohortę tworzy jej pierwsze zadanie; `<config dir>/cohorts/<name>.json` trzyma czas utworzenia i opcjonalny opis (`agentctl cohort note sprint-1 "…"`).
- **Gdzie zadanie ją trzyma.** `cohort:` w jego `TASK.md` (i w jego wpisie kolejki, gdy czeka), obok `cancelled`/`cancel_reason`, żeby późniejszy kamień milowy z użyciem lub statystykami mógł liczyć zadania na kohortę i anulowania.
- **Polecenia.** `cohort list` (zadania na kohortę według stanu: aktywne, w kolejce, raporty, zamknięte, anulowane; od kiedy), `cohort show <name>` (zadania jak w `status`), `cohort add <name> <TASK…>`, `cohort remove <TASK…>`, `cohort note <name> "…"`.
- **Filtry.** `--cohort <name>` przy `status` (także `--json` i `--clip`), `pull --ready`, `close`, `cancel` i `queue list`. Bez niego chodzi o wszystkie zadania, jak dotąd. `close --cohort X` i `cancel --cohort X` pokazują listę i pytają y/N.
- **Powiadomienie.** Gdy każde nieanulowane zadanie kohorty ma raport (także te w kolejce), obserwator mówi `kohorta <nazwa>: wszystkie raporty gotowe (N)`: raz na kohortę i ponownie tylko wtedy, gdy od tego czasu dołączyło nowe zadanie.

## Limity na żywo i przeładowanie konfiguracji

- **`agentctl limits`** liczy na dostawcę: okna sesji agentctl (przypisane przez `TASK.md`), plus zarezerwowane miejsca, plus sesje zewnętrzne, gdy `limits.count_external` jest włączone; wolne = limit − zajęte. To samo liczenie rozstrzyga `new` (błąd albo propozycja zmiany), `queue` (co mówi podsumowanie), tyknięcia kolejki w `watch` i `queue list`.
- **`limits set`** edytuje plik przez API dokumentu pakietu `yaml`: komentarze, kolejność kluczy i pozostałe wartości zostają (komentarz w linii jest zapisywany po jednej spacji). Stary plik jest kopiowany do `config.yaml.bak`; wynik jest raz ładowany dla sprawdzenia, a stary tekst wraca, jeśli się nie ładuje. `off` (albo `none`) usuwa klucz.
- **Rezerwacje** to `<config dir>/reservations.json`: na dostawcę liczba i notatka. `reserve` dodaje, `release claude=1` odejmuje, `release claude` zrzuca wszystkie.
- **Sesje zewnętrzne** (`limits.count_external: true`): `ps -U <uid> -o pid=,ppid=,command=` wypisuje procesy. Proces się liczy, gdy jego komendą jest `claude` lub `codex` (albo `node …/claude-code/….js`, `node …/@openai/codex/….js`) bez `mcp`, `mcp-server`, `app-server`, `exec`, `-p`, `--print`, `usage-tap` ani `agentctl` wśród argumentów, gdy żaden przodek nie jest procesem panelu sesji agentctl (`tmux list-panes -s`) i gdy żaden przodek sam nie jest policzoną sesją (proces pomocniczy sesji nie jest drugą sesją). Katalog pochodzi z `lsof -a -d cwd`. Nic nie jest zabijane ani ruszane.
- **Przeładowanie.** `ConfigStore` trzyma obowiązującą konfigurację i tekst, z którego została załadowana. `watch` wywołuje go przy każdym tyknięciu i z `fs.watch` folderu configu; serwer MCP wywołuje go przy każdym wywołaniu narzędzia (zawsze czytał plik od nowa; teraz plik, który się nie ładuje, nie przewraca już serwera). Tekst, który się ładuje, zastępuje obowiązującą konfigurację (`Context.setConfig`: klient tmux podąża za zmienionym `session` lub ikonami okien), a log watch mówi `config: reloaded (limits, mcp)`. Tekst, który się nie ładuje, jest zgłaszany raz (`config: config.yaml does not load, the previous settings stay in force: …`), `config-state.json` to zapisuje, `doctor` pokazuje ostrzeżenie `config reload`, MCP `status` i `version` niosą ostrzeżenie, a polecenie CLI, które nie może załadować pliku, wspomina, że obserwator zachowuje poprzednie ustawienia. Zmiana `notify` sprawia, że obserwator buduje swój notifier od nowa.

## Zdarzenia dla czatu

- **Dziennik** `<config dir>/journal.jsonl`: `{at, kind, task?, cohort?, text, verdict?, level?, phone?}` (`level` wpisu `usage`: `warn` lub `critical`; `phone`: `sent` lub `queued`, zob. [Powiadomienia na telefon](#powiadomienia-na-telefon)). Rodzaje: `report-ready`, `queue-start`, `queue-failed`, `needs-input`, `needs-trust`, `blocked`, `cancelled`, `limited`, `dead`, `orphan`, `cohort-done`, `usage`, `limits-changed`. Piszą do niego: obserwator (przejście, którego nie ogłosiło już własne zdarzenie agenta), polecenie event, kolejka (start, nieudany start, zablokowanie), `cancel`, sprawdzanie kohorty, progi planu, `limits set`/`reserve`/`release` i przeładowanie konfiguracji (zapisywane raz, jeśli obie strony zobaczyły tę samą zmianę). Zdarzenie zadania dostaje kohortę zadania.
- **Znacznik** `<config dir>/events-seen.json`: czas ostatniego wywołania na klienta (`cli`, `mcp`). `since: last` oznacza po tym czasie; pierwsze wywołanie klienta patrzy 24 godziny wstecz; `--keep` / `peek: true` i `--clip` zostawiają znacznik. Próbny przebieg też go zostawia.
- **Linia podsumowania** liczy zadania z oknem, które nie są zakończone (i ile z nich pracuje), zadania czekające na Ciebie (needs-input, needs-trust, waiting), kolejkę oraz gotowe i niepobrane raporty.
- Zdarzenia istnieją tylko wtedy, gdy działa `agentctl watch` (albo gdy polecenie samo je zapisuje: cancel, limits). Czat, który wywoła `events_since` po nocy bez obserwatora, i tak dostanie podsumowanie obecnego stanu.

## Sprzątanie (`gc`)

- **Na co patrzy:** rekordy zadań z `state_dir` i z archiwum, dla zadań `closed`, `cancelled` lub zarchiwizowanych i bez okna. Wszystko inne jest poza zasięgiem: aktywne zadanie, worktree, którego używa też inne niezakończone zadanie (`move` dzieli jeden), folder cache, który nie należy do żadnego rekordu.
- **Worktree:** `git status --porcelain` musi być puste, wyewidencjonowana gałąź nie może być `main`/`master`, główny checkout nigdy nie jest kandydatem; usunięcie to `git worktree remove <path>` bez `--force`. `git worktree list --porcelain` wymienia też worktree tych samych repozytoriów, których nie posiada żadne zadanie; są tylko wypisywane jako pominięte.
- **Pliki obok raportów:** w folderze raportu takiego zadania każdy wpis, który nie jest `*.md` i którego najnowszy plik jest starszy niż `--older-than`. Folder liczy się po najnowszej rzeczy w nim.
- **Stan:** `<state_dir>/<task>/` zamkniętych zadań przechodzi do archiwum (to samo przeniesienie co `agentctl archive`); historia (`history.jsonl`) i raporty nie są ruszane.
- **Gałęzie** (`--branches`): gałąź wpisu repo zadania, jeśli jeszcze istnieje, nie jest `main`/`master`/bieżącą gałęzią/bazą, nie jest używana przez niezakończone zadanie, nie jest wyewidencjonowana w innym worktree (ten, który gc usuwa w tym samym przebiegu, się nie liczy) i `git merge-base --is-ancestor <branch> <base>` się udaje. Wtedy `git branch -d`; własne sprawdzenie gita to druga siatka bezpieczeństwa. Gałęzie zdalne nigdy nie są ruszane.
- `--apply` pokazuje listę, pyta y/N (`-y` pomija to bez terminala), robi worktree, pliki, przeniesienia do archiwum, potem gałęzie, i raportuje, co zwolniono, a co się nie udało. Porażka jednego elementu nie zatrzymuje pozostałych i daje kod wyjścia 1.

## Wznawianie i `up`

- **Które zadania:** niezamknięte, nieanulowane, niezarchiwizowane, nieukryte, niezastąpione (`superseded`), z rekordem, który wskazuje agenta, istniejącym worktree, bez okna tmux i bez raportu (`--all` bierze także zadania z raportem). Wpisane ID zadań muszą być wśród nich.
- **Co jest uruchamiane:** okno powstaje tak, jak robi to `new` (env zadania, nowa sesja, gdy stara zniknęła), okablowanie zdarzeń jest zapisywane na nowo (plik ustawień z hookami i usage tap, `notify` Codexa), potem agent: Claude `claude --model … --effort … --settings … --resume <id>` / `--continue`, Codex `codex resume <id> …` / `codex resume --last …`, a po nich te same flagi co przy starcie (sprawdzone przez `codex resume --help` z 0.166.0: opcje idą po `resume`). ID sesji to ostatni zapisany w `<state_dir>/<task>/sessions.json` przez hooki albo usage tap. Żaden prompt nie jest wklejany, a dialog zaufania do folderu nie jest odpowiadany.
- **Limity:** miejsca dostawcy są liczone jak przy `new`; zadanie, które się nie mieści, jest pomijane i jest o tym informacja.
- **`agentctl up`:** `watch --tmux` i `board --tmux` (każde tylko jeśli brakuje jego okna), podpowiedź o wznowieniu, potem `attach`/`switch-client` do okna boardu; bez terminala (albo z `--no-attach`) drukuje `tmux attach -t <session> \; select-window -t board`.

## Użycie i limity

`agentctl usage [--cohort X] [--since 7d] [--json] [--clip]` odpowiada na dwa pytania, zanim rozdasz więcej pracy: ile tokenów zużywają zadania i jak blisko limitów są plany Claude Code i Codexa. Czego dostawca nie mówi, to **n/d**; żadna liczba nigdy nie jest szacowana.

**Co dają źródła.** Sprawdzone na Claude Code 2.1.309 i Codex 0.166.0 (formaty są własne agentów, nie udokumentowanym interfejsem: mogą się zmienić).

| | Claude Code | Codex |
|---|---|---|
| Log sesji | `<claude home>/projects/<cwd, każdy znak niealfanumeryczny jako "-">/<session id>.jsonl`; subagenci w `<session id>/subagents/agent-*.jsonl` | `<codex home>/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl` |
| Tokeny | `message.usage` każdej linii `assistant`: `input_tokens`, `output_tokens` (z myśleniem), `cache_read_input_tokens`, `cache_creation_input_tokens`; `message.model`. Wiadomość jest zapisywana raz na blok treści z tym samym `message.id` i usage: liczona jest raz | `event_msg` `token_count`: `info.total_token_usage`, skumulowane dla sesji (`input_tokens` zawiera `cached_input_tokens`); model jest w `turn_context`. Różnica między dwoma odczytami to praca pomiędzy nimi |
| Które zadanie | `cwd` w każdej linii (worktree albo folder pod nim), `sessionId`; `transcript_path` i `session_id` w wejściu hooków i statusLine | `session_meta.cwd` (worktree), `session_meta.id`; `thread-id` w argumencie `notify` |
| Limity planu | `rate_limits.five_hour` i `.seven_day` (`used_percentage`, `resets_at` w sekundach epoki) w JSON-ie, który komenda **statusLine** dostaje na stdin; tylko dla claude.ai Pro, Max i Ultra i tylko po pierwszej odpowiedzi sesji. Nie ma ich w transkryptach, nie ma lokalnego pliku | `rate_limits` w każdym `token_count`: okna `primary` i `secondary` z `used_percent`, `window_minutes` (300 = 5 godzin, 10080 = tydzień) i `resets_at`, plus `plan_type`. Niektóre plany mają tylko jedno okno; limit bez okien (`premium`) nic nie mówi |
| Wiarygodność | Wiarygodne: tokeny i modele. Wiarygodne tylko przez tap: limity | Wiarygodne: tokeny, modele i limity (mówi najnowszy log; to konto, nie zadanie) |

- **Tokeny.** Pokazywana liczba (`TOKENS` w `status` i na boardzie, `usage`) to input + output + zapisy cache. Odczyty cache są pominięte: długa sesja czyta swój kontekst od nowa w każdej turze i zagłuszyłyby resztę; są w `--json` i w tabeli *by model*. Liczba Codexa jest rozdzielana tak, żeby `input` było tylko świeżą częścią. Rozliczenia planów nie są publiczne, więc to wybór, nie rachunek dostawcy.
- **Które sesje należą do zadania.** Sesje agenta zadania, których katalog roboczy to worktree zadania (albo folder pod nim) i które zaczęły się po starcie zadania (minuta zapasu), a przed jego końcem: startem zadania, które je kontynuuje po `move` (dzielącym worktree), jego `close` lub `cancel`. Z kilku zadań, które mogłyby być właścicielem sesji, wygrywa to, które wystartowało ostatnie przed nią. `<state_dir>/<task>/sessions.json` wymienia sesje, które nazwały zdarzenia agenta i statusLine; liczą się bez względu na to, co mówi katalog. `CLAUDE_CONFIG_DIR` i `CODEX_HOME` w `env` specu przenoszą wyszukiwanie do tego katalogu domowego. Sesje, które uruchamiasz ręcznie, nie są liczone, a sesja Codexa wznowiona lub rozwidlona z innej liczy całą jej historię jeszcze raz.
- **Cache.** `<config dir>/usage-cache.json` trzyma na plik logu dotychczas przeczytany offset i sumy na dzień i model. Log tylko rośnie, więc następny odczyt zaczyna od offsetu (krótszy plik jest czytany od początku); niedopisana ostatnia linia czeka. `watch`, board i linia tmux mogą więc pytać co kilka sekund. Usuń plik, żeby wszystko przeczytać od nowa.
- **Plan Claude: tap.** `new` wstawia `statusLine` do pliku ustawień okna Claude (`--settings`, ten sam plik co hooki zdarzeń): `agentctl usage-tap --task <ID> [--forward '<your command>']`. Przy każdej aktualizacji linii stanu zapisuje okna w `<config dir>/usage/claude-plan.json`, zapamiętuje sesję, po czym uruchamia Twój własny `statusLine` (z `.claude/settings.local.json` albo `settings.json` worktree, a w ostateczności z `~/.claude/settings.json`) z tym samym wejściem i drukuje jego wyjście, więc to, co widzisz, się nie zmienia. `statusLine` innego typu niż `command` zostaje nietknięty i tap nie jest ustawiany. Limity należą do konta, więc karmi je dowolne okno; plik jest tak świeży, jak ostatnia odpowiedź okna Claude uruchomionego przez agentctl. Żeby karmić go także z własnych sesji, ustaw swój globalny `statusLine` na `agentctl usage-tap --task none --forward '<your command>'` (nieznane zadanie tylko pomija zapamiętywanie sesji). `usage.claude_tap: false` zostawia linie stanu w spokoju.
- **n/d.** Limity Claude są n/d, dopóki okno zadania nie odpowie choć raz, bez subskrypcji claude.ai albo z `usage.claude_tap: false`; Codexa, gdy żaden log z ostatnich trzech dni nie ma okna. Okno, którego czas resetu minął od odczytu, jest odrzucane (jego procent nie jest bieżący). Odczyt starszy niż 30 minut jest pokazywany z czasem.
- **Ostrzeżenia.** `watch` patrzy na plany przy każdym tyknięciu. Gdy okno osiąga `usage.warn` (domyślnie 80), wysyła jedno powiadomienie, a przy `usage.critical` (95) jeszcze jedno; „Codex: 85% limitu 5h (reset 12:07) – blisko limitu; claude ma zapas (62%): --agent claude”. Jedno na próg i na okres okna (dostawca, okno, czas resetu), trzymane w `<config dir>/usage-alerts.json`, więc restart obserwatora go nie powtarza. Oba progi to procenty dla obu dostawców albo na dostawcę (`{claude: 80, codex: 70}`).
- **Podpowiedź przed startem.** Podsumowanie `new --clip` i `queue` ma linię `plan:` na każdego użytego dostawcę oraz, dla każdego zadania, którego dostawca jest na poziomie swojego `usage.warn` lub powyżej, gdy drugi jest poniżej własnego: `hint: NC-42: claude blisko limitu (83%), codex ma zapas (15%): --agent codex`. Zwykłe `new` drukuje te linie, gdy jest coś do powiedzenia. Tylko o tym informuje: `--agent` zostaje Twoją decyzją, a zadaniu z `pin: true` mówi się, że zostaje.
- **Wstrzymanie kolejki.** `usage.queue_hold: 90` (albo na dostawcę): obserwator nie startuje żadnego zadania z kolejki dostawcy, którego plan jest powyżej tego procentu w którymkolwiek oknie; `queue list`, `status` i board pokazują `wstrzymane: codex 96% limitu 5h (reset 12:10) > usage.queue_hold 90%`, a log watch mówi o tym raz. Dostawca z n/d nigdy nie jest wstrzymywany. Domyślnie wyłączone. Config jest czytany przy starcie `watch`: po zmianie uruchom go ponownie.
- **Gdzie.** Wyłącznie skonfigurowane alternatywne ścieżki/globy report, względne do worktree. Wzmianki o plikach nie są przeszukiwane.

## Historia i statystyki

Które modele i efforty sprawdzają się do czego, widać dopiero na wielu zadaniach. agentctl dopisuje po jednym obiekcie JSON na linię do `<config dir>/history.jsonl`:

- gdy **raport zadania jest gotowy** (obserwator albo własne zdarzenie agenta, które zobaczy pierwsze; ten sam raport raz), gdy jest **zamknięte**, **anulowane** lub **przeniesione** i gdy je **oznaczysz**;
- rekord: `event`, `at`, `task`, `cohort`, `project` (folder pierwszego repozytorium), `requested` i `effective` agent/model/effort, `started`, `reportAt`, `closedAt`/`cancelledAt` i `cancelReason`, `durationMs` (od startu do raportu, a w razie braku do zamknięcia lub anulowania), `tokens` (input, output, cacheRead, cacheWrite i `fresh`; `null`, gdy nie znaleziono logu), `progress` (commity i pliki; `null`, gdy git nie potrafił powiedzieć), `verdict` (pierwsza linia, jak w powiadomieniu), `movedFrom` i `movedTo`, `result`, `note`.

`agentctl mark <TASK> ok|partial|fail [--note "…"]` zapisuje Twoją ocenę; wygrywa ostatnie oznaczenie. `agentctl log [--since 7d] [--cohort X] [--json] [--clip]` zwija rekordy do jednej linii na zadanie, od najnowszego (późniejsza pusta wartość nigdy nie zeruje znanej). `agentctl stats [--since 30d] [--cohort X] [--json] [--clip]` grupuje zadania według agent/model/effort: zadania, mediana czasu i mediana tokenów (n/d, gdy brak), udział ok, partial i fail **wśród oznaczonych**, nieoznaczone, anulowane i przeniesione (zadania grupy, które trafiły na limit i zostały przekazane drugiemu dostawcy). Historia jest tak dobra jak oznaczenia: nieoznaczone zadanie liczy się jako nieoznaczone, nigdy jako ok.

Na boardzie **`l`** otwiera log (`↑↓` przewija, `Esc` wraca), a **`o`** / **`p`** / **`f`** oznaczają wybrane zakończone zadanie (zadanie bez okna, zamknięte lub anulowane albo z gotowym raportem); `p` nadal wstrzymuje kolejkę, dopóki żadne zakończone zadanie nie jest wybrane. Menu zakończonego zadania (`Enter`) oferuje te same oznaczenia. Serwer MCP ma `log`, `stats` i `usage` (odczyt) oraz `mark` (zapis; `mcp.allow`, audytowany, wiele zadań wymaga podglądu/potwierdzenia; pojedyncze zadanie jest zapisywane od razu).

## Nawigacja

`agentctl board --tmux` i `agentctl watch --tmux` uruchamiają swoje polecenie **jako proces okna** (`tmux new-window … <command>`), a nie wpisując je do powłoki, i w tym samym wywołaniu tmux ustawiają `remain-on-exit` (`failed` dla boardu, `on` dla watch): nieudany board i każdy zakończony proces watch zostawiają wynik na ekranie, a `~/.agentctl/board.log` / `watch.log` mają początek (rozmiar terminala, `CI`, flagi tty) oraz koniec albo stos błędu. Ponowne uruchomienie `board --tmux` startuje na miejscu okno, którego proces się zakończył. Board czeka na rozmiar terminala (okno bez klienta potrafi przez chwilę raportować 0x0) i rysuje się nawet wtedy, gdy w środowisku jest zmienna `CI` (Ink inaczej nie narysowałby niczego).

W sesji agentctl (opcje sesji, nigdy `-g`) agentctl ustawia:

- **`mouse on`** (`board.mouse`): kliknij nazwę okna na pasku stanu, żeby do niego przejść. Przy włączonej myszy zaznaczanie tekstu w Terminal.app wymaga przytrzymania klawisza **fn** (iTerm2: Option).
- **`F12` wraca do boardu** z dowolnego okna sesji, bez prefiksu tmux (`board.return_key`, nazwa klawisza tmux; `false` oznacza brak). Powiązanie jest w tmux ogólnoserwerowe, więc jest warunkowe względem sesji: w każdej innej sesji F12 trafia do programu w panelu jak dotąd. Dlaczego F12: `⌥b` to „słowo wstecz” w polach wprowadzania Claude Code i Codexa i wymaga „Use Option as Meta” w Terminal.app; mylone są Ctrl i Cmd; żaden z agentów nie używa F12. Na MacBooku to `fn`+F12, chyba że włączono „Use F1, F2, etc. keys as standard function keys”. Jeśli klawisz jest już w tmux powiązany z czymś innym, zostaje nietknięty, a `board --tmux` o tym mówi. `Ctrl-b l` (ostatnie okno) nadal działa.

Stopka boardu mówi `Enter – open the agent · F12 – back to the list`.

## Kolejka

`limits.claude` i `limits.codex` ograniczają liczbę okien na dostawcę. Gdy zlecasz więcej zadań, niż się mieści, nadmiarowych nie trzeba potem startować ręcznie: wstaw je do kolejki, a `agentctl watch` uruchomi każde samo, gdy tylko zwolni się okno jego dostawcy.

```
agentctl queue nc-42.md          # walidacja jak przy "new", podsumowanie, y/N
agentctl queue list              # pozycja, zadanie, agent/model/effort, priorytet, warunek startu, czas oczekiwania
agentctl queue up NC-42          # pierwsze w kolejce
agentctl queue rm NC-42          # wyjmij z kolejki
agentctl queue pause / resume    # wstrzymaj / zezwól na starty (działających zadań to nie dotyka)
agentctl queue retry NC-42       # nieudany start, jeszcze raz
```

- **Dodawanie** przechodzi przez te same kontrole co `new` (`review_of`, `pin`, mapowanie `--agent`, effort Codexa, duplikaty, repozytoria) z wyjątkiem limitu dostawcy: pełny dostawca to właśnie powód, dla którego zadanie trafia do kolejki. Podsumowanie mówi, czy zadanie wystartuje przy najbliższym ticku, czy będzie czekać, a wpis jest zapisywany w `<config dir>/queue/` z kolejnym numerem.
- **`new` przy pełnym limicie** pyta „dodać do kolejki? [y/N]” (po propozycji zmiany dostawcy, jeśli taka jest). Bez terminala zostaje błędem, teraz z podpowiedzią `agentctl queue`.
- **Kolejność**: `priority: high` przed `priority: normal`, w obrębie klasy kto pierwszy, ten pierwszy; `queue up` stawia zadanie na początku jego klasy. Zadanie, którego dostawca jest pełny, nie wstrzymuje zadania drugiego dostawcy.
- **Nigdy nie zmienia dostawcy.** Kolejka uruchamia zadanie na agencie i modelu, na których je zlecono (albo na `--agent` podanym przy dodawaniu do kolejki). Przejście do drugiego dostawcy zostaje jawną decyzją: `--agent`, `agentctl move`.
- **Start** to ta sama ścieżka co `new` (worktree, `setup`, linki, TASK.md, okno, czekanie na agenta, prompt) i działa w tle obserwatora. Gdy agent czeka na dialog zaufania do folderu, `needs-trust` jest ogłaszany jak zwykle, a reszta kolejki idzie dalej; prompt trafia do okna po Twoim potwierdzeniu. Powiadomienie mówi „Uruchomiono TASK z kolejki”.
- **Nieudany start** (setup się nie udał, repozytorium zniknęło, agent nie jest gotowy) odkłada zadanie na koniec kolejki jako `failed`, z błędem w `queue list` i logiem próby w `<config dir>/queue/<n>-<TASK>.log`, i wysyła powiadomienie. Nie jest ponawiany sam; `queue retry` to Twoja decyzja (używa ponownie worktree, który zostawił nieudany start).
- Kolejka rusza tylko, gdy działa `agentctl watch` (`watch --tmux`); `watch` wczytuje config ponownie, gdy plik się zmieni ([limity na żywo](#limity-na-żywo-i-przeładowanie-konfiguracji)), więc zmiana `limits` nie wymaga restartu. `queue.enabled: false` w configu wyłącza starty; `queue.parallel_starts` ogranicza liczbę startów w toku ([konfiguracja](configuration.md#queue), po angielsku).

### Zależności: `after`

```yaml
---
task: NC-42-REVIEW
agent: codex
review_of: NC-42
after: NC-42            # albo lista: [NC-41, NC-42]
repos: [...]
---
```

Zadanie z kolejki z `after` startuje dopiero wtedy, gdy każde wskazane zadanie ma raport: stan `report-ready` albo zamknięte z plikiem raportu nadal na miejscu. Do tego czasu `agentctl status`, `queue list` i board pokazują `czeka na NC-42`; zadanie czekające na zależność nie zajmuje miejsca w kolejce, więc pozostałe idą dalej. Przegląd (`review_of`) bez `after` dostaje w podsumowaniu podpowiedź, bo inaczej wystartowałby, gdy tylko zwolni się okno, zanim autor cokolwiek napisze.

Przy dodawaniu zadanie wskazane w `after` musi istnieć (wystartowane, w kolejce albo w tym samym pliku), zadanie nie może czekać samo na siebie, a zadania nie mogą czekać na siebie nawzajem w kółko; każde z tych naruszeń jest błędem z nazwaną ścieżką. `new` nie ma kolejki, w której mógłby czekać: odmawia zadania, którego `after` nie jest spełnione, i wskazuje `agentctl queue`. Zależność, której start się nie udał, pozostaje niespełniona (`czeka na NC-42 (failed)`), dopóki nie zrobisz `queue retry` albo `queue rm`.

**Zależność, która została anulowana**, nigdy nie dostanie raportu. `queue` i `new` odmawiają `after` wskazującego anulowane zadanie, a zadanie, które już czeka, staje się **zablokowane** (⛓): `status`, `queue list` i board pokazują `⛓ zablokowane – NC-42 anulowane` (`blocked: true` w `queue list --json`, `blocked` w MCP `queue_list`), nigdy nie wystartuje (zadanie czekające na zablokowane jest też zablokowane), a `watch` wysyła jedno powiadomienie na anulowanego autora, `NC-43 zablokowane – NC-42 anulowane`, zapamiętane we wpisie kolejki, żeby restart niczego nie powtórzył. Są dwa wyjścia: `agentctl cancel NC-43` albo `agentctl unblock NC-43 [--drop-after NC-42]`, które usuwa anulowane zadanie (albo tylko to wskazane) z `after`, we wpisie i w jego specu; zadanie wraca do kolejki i czeka na resztę swojego `after` albo startuje.

## Kolizje

Dwa zadania zmieniające te same pliki w tym samym repozytorium spotkają się w konflikcie scalania. agentctl mówi o tym wcześnie.

- **Co jest porównywane.** Dla każdego aktywnego zadania (jego okno działa) pliki zmienione od chwili, gdy jego worktree odeszło od bazy (`git diff --name-only <base>...HEAD`), plus pliki z niezacommitowanymi zmianami, osobno dla każdego repozytorium źródłowego (`repos[].path`). Dwa zadania kolidują, gdy ich zbiory mają wspólne pliki. `collisions.ignore` pomija lockfile i podobne.
- **`agentctl status`** dostaje kolumnę `COLLIDE`, dopóki cokolwiek koliduje: `⚠ LANDING-QS-1: 2` znaczy „2 wspólne pliki z LANDING-QS-1”. `status --json` ma to samo w `collide`.
- **`agentctl watch`** pyta git co `collisions.interval` (300 s) i wysyła jedno powiadomienie na każdą nową parę („⚠ A i B zmieniają te same pliki (2): …”). Para jest zapamiętana w `<config dir>/collisions.json`, więc ani następne sprawdzenie, ani restart watchera jej nie powtórzy; gdy pliki przestaną się pokrywać, a potem znowu się pokryją, para jest znów nowa.
- **`agentctl overlap [TASK]`** wypisuje wspólne pliki każdej pary (albo par z TASK), obliczone w tej chwili.
- **`touches: [globs]`** w specu mówi, co zadanie zamierza zmienić. `queue` i `new` ostrzegają wtedy i pytają y/N, gdy aktywne zadanie już zmienia pasujące pliki (`new -y` nie pyta; bez terminala ostrzeżenie jest tylko wypisywane).
- Board oznacza kolidujące zadanie znakiem `⚠` w pierwszej kolumnie i w podglądzie mówi, z kim koliduje ([board](#board)).

## Board

`agentctl board` to pełnoekranowy przegląd wszystkich zadań, odświeżany co 2 sekundy (co 5 sekund, gdy nic już nie działa). `agentctl board --tmux` otwiera go w oknie `board` sesji agentctl
(tworzonym, jeśli go brak, nigdy dwukrotnie); okna boardu i watcha nie są zadaniami.

```
agentctl board  agentctl-test · 3 tasks · 09:41:03
  TASK       AGENT              STATE          TIME    PROGRESS REPORT │ AC5-C · last 13 lines
  AC5-A      claude opus/high   ⏸ waiting      37s     2c 3f    -      │ bash-3.2$ claude --model sonnet --effort medium
  AC5-B      codex gpt-6.1-sol… ✓ report-ready 37s     1c 1f    ready  │ Claude Code (fake) --model sonnet --effort medium
▸ AC5-C      claude sonnet/med… ? needs-input  36s     2c 2f    -      │
                                                                       │ ● got: Model: sonnet · effort medium
                                                                       │
                                                                       │ ● working on: Third fake task that asks you something. W…
                                                                       │ ● Edited file-1.txt
                                                                       │ ● Edited file-0.txt
                                                                       │ ? Tea or coffee?
                                                                       │   1. Tea
                                                                       │   2. Coffee
                                                                       │   Enter to select · Esc to cancel
                                                                       │ ● you chose: tea please

Enter – open the agent · F12 – back to the list
↑↓ ⏎ m msg M move i int c/r pull x close X cancel k cohort h hide z/a u/d/p ?
```

Poniżej 110 kolumn podgląd jest ukryty, a lista zajmuje całą szerokość (tu 80 kolumn):

```
agentctl board  agentctl-test · 3 tasks · 09:40:39
  TASK       AGENT              STATE          TIME    PROGRESS REPORT
▸ AC5-A      claude opus/high   ⚙ working      13s     2c 3f    -
  AC5-B      codex gpt-6.1-sol… ✓ report-ready 13s     1c 1f    ready
  AC5-C      claude sonnet/med… ? needs-input  12s     2c 2f    -

Enter – open the agent · F12 – back to the list
↑↓ ⏎ m msg M move i int c/r pull x close X cancel k cohort h hide z/a u/d/p ?
```

Lista pokazuje zadanie, agenta/model/effort, ikonę stanu, czas, `PROGRESS` i raport (`-` brak, `ready` jeszcze niepobrany, `pulled`). Od 110 kolumn prawa kolumna
pokazuje ostatnie 30 linii wybranego okna (jak `peek`, bez stopki); poniżej lista zajmuje całą szerokość i działa aż do 80 kolumn.

| Klawisz | Działanie |
|---|---|
| `↑` `↓` (`j`) | wybór zadania (`k` jest teraz filtrem kohorty i już nie przesuwa w górę) |
| `Enter` | przejście do okna zadania (`select-window` + `switch-client`); `F12` (albo `Ctrl-b l`) wraca do boardu. Przy zadaniu bez okna otwiera zamiast tego menu: `c` kopiuj raport, `x` zamknij, `h` ukryj, `Esc` |
| `m` | wpisz wiadomość i wyślij ją agentowi tak jak `send` (`Enter` wysyła, `Esc` anuluje) |
| `M` | przenieś zadanie do drugiego dostawcy po limicie użycia (`agentctl move`), po pytaniu `[y/N]`; odmowa dla zadań z `pin` i już przeniesionych |
| `i` | przerwij bieżącą turę, po pytaniu `[y/N]` |
| `c` | kopiuj raport wybranego zadania (`pull`) |
| `r` | kopiuj wszystkie nowe raporty (`pull --ready`) |
| `x` | zamknij okno, po pytaniu `[y/N]`; jeśli zadanie ma worktree, drugie pytanie dotyczy tego, czy usunąć także jego (`git worktree remove`, nigdy `--force`, gałąź zostaje; `Esc` anuluje) |
| `X` | anuluj wybrane zadanie ([Anulowanie zadań](#anulowanie-zadań)): pyta o powód (opcjonalny; `Enter` idzie dalej, `Esc` zatrzymuje), potem `[y/N]`. Działa też na zadaniu z kolejki; zadanie z `move` jest anulowane razem z drugą połową. Worktree i gałąź zostają |
| `l` | log zadań (`agentctl log`): `↑↓` przewijanie, `Esc` powrót |
| `o` / `p` / `f` | oznacz wybrane zakończone zadanie jako ok / partial / fail ([Historia i statystyki](#historia-i-statystyki)); `p` wstrzymuje kolejkę, gdy nie zaznaczono zakończonego zadania |
| `k` | wybierz kohortę do pokazania: `wszystkie`, kohorta albo `bez kohorty` (zadania bez żadnej kohorty); `↑↓` i `Enter`, albo jej numer. Nagłówek mówi `cohort: <nazwa>`; listy, kolejka i sekcje podążają za filtrem |
| `g` / `E` | zwiń grupę kohorty wybranego zadania / rozwiń wszystkie grupy |
| `L` | limity (`agentctl limits`) |
| `G` | podgląd sprzątania (`agentctl gc`; board niczego nie usuwa) |
| `R` | wznów zadania z sekcji „Do wznowienia” (po y/N) |
| `h` | ukryj wybrane zadanie (albo pokaż ukryte); nic nie jest zamykane ani usuwane |
| `u` | na zadaniu z sekcji **Queue (N)**: przesuń je na początek kolejki |
| `d` | na zadaniu z sekcji **Queue (N)**: usuń je z kolejki, po pytaniu `[y/N]` |
| `p` | wstrzymaj lub wznów kolejkę (`queue pause` / `queue resume`) |
| `z` | otwórz lub zamknij sekcję **Finished (N)** |
| `a` | pokaż także ukryte zadania (przyciemnione, oznaczone `·`) oraz zamknięte i anulowane, w ich własnych sekcjach **Closed (N)** i **Cancelled (N)** |
| `?` / `q` | pomoc / wyjście (agenci dalej działają) |

Sekcja **Queue (N)** stoi pod aktywnymi zadaniami (zob. [kolejka](#kolejka)): każde zadanie z kolejki pokazuje swoje miejsce w kolejce i to, na co czeka (`1. czeka na miejsce: claude 2/2`, `2. czeka na NC-42`, `✗ failed: …`), a podgląd pokazuje jego spec. Zadanie, które zmienia pliki zmieniane też przez inne aktywne zadanie, ma `⚠` w pierwszej kolumnie, a tytuł jego podglądu mówi, z kim (`⚠ LANDING-QS-1: 2`; [kolizje](#kolizje)).

**Kohorty.** Gdy tylko jedno zadanie ma kohortę, aktywna lista jest grupowana: nagłówek na kohortę w kolejności nazw (`- sprint-1 (4) 2⚙ 1✓ 1⧗`: zadania, potem liczba zadań w każdym stanie, zadania z kolejki na końcu jako `⧗`), zadania bez kohorty na końcu pod `- bez kohorty (N)`. `g` zwija grupę (`+` z przodu, jej wiersze wypadają ze ścieżki kursora), `G` otwiera wszystkie. Zadania kohorty z kolejki są liczone w jej nagłówku, ale zostają w sekcji **Queue**. Bez żadnej kohorty lista jest płaska, jak dawniej. Pasek stanu tmux nie jest grupowany: liczy wszystkie zadania.

Zadania, które nadal mają okno, są na początku. Zadania bez okna (i bez `close`: `dead`, `report-ready` po zamknięciu agenta w jego oknie, `superseded`) czekają przyciemnione pod zwiniętym tytułem **Finished (N)**; `z` go otwiera. Enter na jednym z nich nie próbuje przełączać na nieistniejące okno. Zob. [Zamykanie i ukrywanie zadań](#zamykanie-i-ukrywanie-zadań).

Nic destrukcyjnego nie działa na pojedynczy klawisz. Board używa tych samych funkcji rdzenia co polecenia (`sendPrompts`, `interruptTask`, `pullTask`, `pullReady`, `closeTask`, `moveTask`); git jest pytany
o postęp najwyżej co 10 sekund. Board wymaga terminala; bez tmux `Enter` mówi, żeby użyć `agentctl attach`.

> **Dlaczego Ink i dlaczego `React.createElement` zamiast JSX lub `htm`?** Projekt działa na wycinaniu typów przez Node, bez kompilacji w trybie rozwoju, a JSX nie jest
> składnią, którą da się po prostu wymazać, więc nie uruchomi się bez przetworzenia. `htm` (szablony tagowane) pozwoliłby uniknąć budowania, ale dodaje zależność, żeby napisać to, co jest kilkudziesięcioma liniami wywołań `createElement`,
> a jego szablony to zwykłe napisy, których `tsc --noEmit` nie sprawdzi; z `createElement` propsy komponentów są sprawdzane typami jak reszta kodu.
> Ink jest ładowany dopiero przy starcie boardu, więc pozostałe polecenia nie płacą za React.

## Stany zadań

`status` wyprowadza stan każdego zadania z okna (`tmux capture-pane`, wzorce per agent w configu) i z pliku raportu:

| Stan | Znaczenie |
|---|---|
| `working` | trwa tura (`working_pattern`, domyślnie `esc to interrupt`) |
| `background` | agent jest bezczynny przy prompcie, ale działa jego własna praca w tle (`background_patterns`; Claude Code pokazuje w stopce `· 1 shell, 6 monitors`). W międzyczasie kończy turę co kilka minut, więc koniec tury nie jest ogłaszany, a `watch` nie nazywa go oczekiwaniem; pasek stanu tmux liczy go razem z `working`; ikona ⏳. Powiadomienie przychodzi, gdy praca w tle się skończy. Codex ma „background terminals” (`/ps`); jego wzorzec to najlepsze przypuszczenie, tekstu stopki z licznikiem nie widziano na ekranie |
| `waiting` | agent jest bezczynny przy prompcie i nie ma jeszcze raportu |
| `needs-trust` | agent pokazuje dialog zaufania do folderu; musi na niego odpowiedzieć człowiek |
| `needs-input` | agent zadał **Tobie** pytanie lub prosi o zgodę i czeka (`question_pattern`; Codex: `? <pytanie>` z opcjami i `• Waiting for your answer.` albo dialog zatwierdzenia; Claude Code: dialog `Enter to select · Esc to cancel` albo dialog uprawnień; albo [zdarzenie](#zdarzenia) `Notification` Claude'a) |
| `limited` | agent mówi, że jego limit użycia jest wyczerpany (`limit_patterns` albo zdarzenie `StopFailure` Claude'a); zob. [Limity i move](#limity-i-move) |
| `report-ready` | raport bieżącej próby jest kompletny (znacznik końca lub stabilny po końcu tury); agent bezczynny albo okno zniknęło |
| `superseded` | zadanie przeniesiono do drugiego dostawcy przez `agentctl move`; to stare okno, które zamykasz sam |
| `dead` | okno zniknęło i nie ma raportu |
| `closed` | uruchomiono `agentctl close` (albo folder stanu jest w archiwum): widoczne tylko w `status --all` i pod klawiszem `a` na boardzie, zob. [Zamykanie i ukrywanie zadań](#zamykanie-i-ukrywanie-zadań) |
| `cancelled` | uruchomiono `agentctl cancel` (praca została porzucona w trakcie tury albo w kolejce): widoczne tylko w `status --all` i pod klawiszem `a` na boardzie (sekcja **Cancelled**), zob. [Anulowanie zadań](#anulowanie-zadań). Wygrywa z `closed` |
| `orphan` | okno sesji agentctl nie ma pliku stanu (zgubionego albo nigdy nieutworzonego) |

Kolejność dla żywego okna: `needs-trust`, potem `needs-input`, potem `working`, potem `limited`, potem `background`, potem `report-ready`, potem `waiting` (`superseded` nadpisuje wszystkie; `closed` i `cancelled` dotyczą tylko zadania bez okna).
To heurystyki oparte na tekście ekranu; jeśli aktualizacja CLI zmieni jego brzmienie, popraw wzorce w configu.

## Zaufanie do folderu

Świeży worktree gita to nowy korzeń projektu, więc Claude Code (sprawdzone na żywo, 2.1.309) i Codex (0.166.0) pytają o niego „czy ufasz temu folderowi?”, nawet gdy główny checkout albo katalog nadrzędny jest zaufany. agentctl **nigdy nie odpowiada na ten dialog**, ale `new` czeka, aż Ty to zrobisz:

```
NC-42: agent waits for folder trust – attach: tmux attach -t agentctl, confirm in window nc-42
```

`new` dalej odpytuje okno (`tmux capture-pane`). Gdy dialog zniknie, a agent pokaże pole wejściowe, wkleja prompt jak zwykle; agent dostaje wtedy znowu `ready_timeout` na start. Specyfikacje w jednym pliku są obsługiwane jedna po drugiej, więc na każdy dialog czeka się po kolei.

- **Limit czasu:** `agents.<name>.trust_timeout` (sekundy, domyślnie 600). Po jego upływie `new` kończy, zostawia okno otwarte i wypisuje `agentctl send <cache>/<task>/TASK.md`.
- **Ctrl-C** kończy czekanie bez zamykania okna, wypisuje specyfikacje, które nie wystartowały, i to samo polecenie `agentctl send`.
- **`--no-wait-trust`** zachowuje zachowanie z iteracji 1: zatrzymanie od razu przy dialogu, z instrukcją attach.

W każdym przypadku prompt jest wysyłany dopiero po zniknięciu dialogu; dostarcz go ręcznie przez `agentctl send <cache>/<task>/TASK.md`.

**Czy zaufanie do katalogu nadrzędnego pomaga?** Sprawdzone na żywo 2026-10-31 (Claude Code 2.1.309 z zaufanym `~/workspace`, Codex 0.166.0 z zaufanym `~`), w nowych katalogach pod zaufanym:

| Nowy katalog | Claude Code | Codex |
|---|---|---|
| zwykły folder (bez gita) | brak dialogu (dziedziczy) | brak dialogu (dziedziczy) |
| nowe repozytorium git | **dialog** | **dialog** |
| `git worktree add` tego repozytorium | **dialog** | **dialog**; mówi „trusting will apply to the repository root” |

Zatem zaufanie do `worktree_root` (na przykład `~/workspace/wt`) **nie** obejmuje worktree gita, a `doctor` nie ma tu czego sprawdzać. Codex wiąże zaufanie do worktree z korzeniem repozytorium, więc zaufany główny checkout prawdopodobnie obejmuje jego worktree (niesprawdzone na żywo: wymaga to zaufanego repozytorium i nowego worktree na nim, co zmieniłoby Twój config Codexa); Claude Code zapytał także o worktree zaufanego checkoutu (iteracja 1). Stąd czekanie.

## Mirror

Domyślnie wyłączony. Ustaw `mirror_dir`, a `status` i `pull` skopiują każdy raport zadania (nowy lub zmieniony) do
`<mirror_dir>/<task>/` i zapiszą `<mirror_dir>/status.json` (te same wiersze co `status --json`). Wskaż nim zsynchronizowany
folder, żeby czytać raporty i stan floty z innego urządzenia. Nic nie działa w tle: mirror odświeża się,
gdy wywołasz `status` lub `pull`.

## Zasady bezpieczeństwa

- `git` jest wołany tylko z `worktree add`, `worktree remove`, zapytaniami tylko do odczytu (`rev-parse`, `status --porcelain`, `merge-base --is-ancestor`, `worktree list`) i, tylko dla `gc --branches`, `branch -d` na gałęzi, która jest scalona. Bez merge, rebase, push, `--force` ani `branch -D`.
- Brak trybu auto-accept: agentctl nie dodaje takiej flagi i odrzuca configi, które próbują. Twoje własne ustawienia agenta nadal obowiązują (na przykład domyślny tryb uprawnień w `~/.claude/settings.json`); agentctl ich nie nadpisuje.
- Pliki trafiają tylko do `state_dir` (własny stan agentctl) i do katalogu cache (raporty). Nic nie jest zapisywane w `~/.claude` ani `/tmp`.
- Komunikaty, które wskazują cel tmux, ujmują go w cudzysłów (`-t '=agentctl:nc-42'`): zsh rozwija słowo zaczynające się od `=` do ścieżki programu.
- Komunikaty o błędach są krótkie i mówią, co zrobić dalej.

## Limity okien i cross-review

- `limits.<agent>` ogranicza jednoczesne okna tmux na dostawcę; błąd wymienia żywe okna. Okna są przypisywane do dostawcy przez ich `TASK.md`. Zarezerwowane miejsca i (z `limits.count_external`) sesje zewnętrzne też się liczą ([limity na żywo](#limity-na-żywo-i-przeładowanie-konfiguracji)).
- `review_of: NC-6` szuka autora w `<state_dir>/nc-6/TASK.md` (albo w tym samym pliku) i wymaga innego agenta **albo** innego modelu. `default` liczy się jako osobna nazwa modelu.

## Stabilna instalacja i aktualizacje

Zalecane: `npm i -g @setech-pl/agentctl`. `agentctl-update` z paczki wykonuje `npm install -g @setech-pl/agentctl@latest`, bez git i bez restartu tmux. Opcje klonu `--ref`, `--no-watch`, `--no-link` są w tym trybie odrzucane. `doctor` pokazuje źródło instalacji i ostrzega o konflikcie PATH. MCP używa absolutnej ścieżki do zainstalowanego JS. Poniższy tryb klonu pozostaje dla rozwoju.

Do codziennej pracy używaj **stabilnej kopii**, a `~/workspace/agentctl` zostaw wyłącznie do rozwoju. (`npm link` z repo sprawiał, że globalne
`agentctl` uruchamiało dowolną gałąź, która była tam wyciągnięta, skończoną lub nie.) Stabilna kopia to odłączony worktree gita tego repo,
domyślnie `~/workspace/agentctl-stable`; tworzy go i aktualizuje `bin/agentctl-update`.

```sh
~/workspace/agentctl/bin/agentctl-update     # pierwsza instalacja
agentctl-update                             # później, po scaleniu PR
```

Robi to w tej kolejności: `git fetch origin` w repo; `git worktree add --detach <stable> <ref>` (a gdy kopia istnieje, odmowa,
jeśli ma lokalne zmiany, w przeciwnym razie `git checkout --detach <ref>`); `npm ci`, `npm run build` i `npm link` w stabilnej kopii, żeby globalne `agentctl` i
`agentctl-update` wskazywały na nią; `agentctl doctor` (porażka kończy skrypt kodem niezerowym); jeśli w sesji tmux
`agentctl` istnieje okno z `@agentctl-role=watch` (albo starszą nazwą `watch`), zabija je po ID i uruchamia `agentctl watch --tmux` z nowej wersji (żadne inne okno nie jest ruszane); na koniec wypisuje
poprzedni i nowy commit oraz to, czy watch został zrestartowany.

| Opcja / zmienna | Znaczenie |
|---|---|
| `--ref <ref>` | co zainstalować, domyślnie `origin/main` |
| `--dry-run` | wypisz polecenia, żadnego nie uruchamiaj |
| `--no-watch` | nie restartuj okna watch |
| `--no-link` | pomiń `npm link` (do testowania skryptu bez przepinania globalnych poleceń) |
| `AGENTCTL_REPO` | repo; domyślnie katalog powyżej `bin/` skryptu (z rozwiązanymi symlinkami) |
| `AGENTCTL_STABLE_DIR` | stabilna kopia, domyślnie `~/workspace/agentctl-stable` |
| `AGENTCTL_SESSION` | sesja tmux okna watch, domyślnie `agentctl` |

## Rozwój

Zob. [CONTRIBUTING.md](../CONTRIBUTING.md): testy, typecheck, `npm run docs`, jak zorganizowany jest kod i jak zamyka się kamień milowy.

Codex: zwinięte pytania pokazują liczbę i skrót z „to answer”. `needs-input` ma pierwszeństwo także podczas pracy; po odpowiedzi stan wynika ponownie z ekranu. Podgląd board, peek, status/MCP `question` i macOS pokazują pytanie lub instrukcję otwarcia. ntfy domyślnie wysyła tylko instrukcję otwarcia; `notify.ntfy.include_question: true` włącza treść pytania.

Session fallback: a pending `request_user_input` function call can supply its first question when a Codex event has already attributed the session ID to the task. Reads are bounded to 256 KiB per matching session; missing, unowned, completed or code-mode-only calls fall back to the screen instructions. No personal sessions were inspected for this milestone.

## Capacity i agent zlecający

`agentctl capacity` (MCP: `capacity`, board: `C`) odczytuje przy każdym wywołaniu okna planu, wiek, stale, tempo %/h, projekcję wyczerpania, sloty i rezerwy, kolejkę, równoważniki oraz stats model × effort z 7 dni. Nie zwraca historii zamkniętych zadań. Źródła: statusline Claude przez usage-tap i odczyt Codex app-server `account/rateLimits/read` bez tury; przy błędzie pozostaje poprzedni odczyt z prawdziwym wiekiem i pochodzeniem. Brak danych to n/d. `capacity.snapshot: false` wyłącza migawkę obu dostawców przy new/queue.

Dziennik próbek jest ograniczony przez `capacity.sample_limit`. Tempo wymaga dwóch próbek i minuty w tym samym oknie; reset lub spadek procentu przerywa serię. Szacunek tokenów wymaga trzech próbek, pięciu minut, przyrostu co najmniej dwóch punktów procentowych i rejestracji tokenów do 60 s od odczytu. Dzieli przyrost tokenów zadań agentctl (input + output + cache writes) przez przyrost procentu. `estimate` zawsze zawiera basis i confidence. Procent obejmuje także pracę poza agentctl, a udział tokenów agentctl w całym koncie jest n/d. Dlatego wszystkie szacunki 0.17 mają low. Medium wymaga mierzonego udziału >=80%, 10 próbek i 30 min; high >=95%, 30 próbek i 2 h — bez pomiaru mianownika te poziomy pozostają niedostępne. Opóźnione logi, zmiana modeli i wag planu dodatkowo ograniczają porównanie. Szczegóły algorytmu: [EN](details.md#dispatcher-capacity-and-estimates).

[Podręcznik](dispatcher.pl.md) jest wspólnym źródłem dla CLI guide, MCP guide i roli managera. Nakładka `guide:` w `.agentctl.yaml` dodaje zasady projektu; globalne `guide.lang` ustala język. Brak pliku ostrzega, nie zatrzymuje. To agent zlecający wybiera dostawcę, model i effort oraz zleca przegląd innym modelem.

### Stabilne okna usług i własność wysyłki

Okna watch/board mają stabilne `@agentctl-role`. Restartuj `agentctl watch --tmux --restart` i `agentctl board --tmux --restart`; `agentctl up --no-attach` nie blokuje terminala. Watch zachowuje zakończone okno nawet przy kodzie 0, a nieoczekiwany szybki koniec daje komunikat i powiadomienie. Doctor podaje pełne polecenia naprawy MCP i startu watch. Node w MCP korzysta z symlinka poza Cellar; updater klonu wykonuje checkout --detach.

Deduplikację event/watch chroni blokada per zadanie, trzymana od ponownego sprawdzenia ledger do zakończenia lokalnej wysyłki/fallback i zapisu. Osobna blokada chroni odczyt, zmianę i zapis kolejki ponowień ntfy, łącznie z HTTP retry. Zapobiega to równoległej podwójnej wysyłce oraz nadpisaniu nowego wpisu przez retry. Nie da się zagwarantować dokładnie jednej dostawy HTTP przy utracie odpowiedzi po przyjęciu żądania przez serwer albo awarii procesu pomiędzy wysłaniem a zapisem lokalnym; te ograniczenia pozostają jawne.

Od 0.17.1 MCP udostępnia ponawianie i sterowanie kolejką, kohorty, sprzątanie `gc` i diagnostykę. Sprawdź `capacity.disk` przed zleceniem pracy. Przy `failed` przeczytaj powód i zaproponuj naprawę lub `queue_retry`; przy `disk-warn` zaproponuj `gc_preview`, a przy `disk-critical` poproś o zgodę na `gc` albo użyj go w ramach uprawnień użytkownika. Każde usuwanie/start wymaga podglądu i potwierdzenia; samo `mcp.allow` nie zastępuje potwierdzenia. Szczegóły: [MCP](mcp.md).

## 0.17.2: ekonomia i niezawodność

`report-candidate` to flaga raportu, nigdy stan zadania. Pytanie i stan needs-input/working/waiting pozostają widoczne. Kandydat nie spełnia after ani nie kończy kohorty. Jawne zatwierdzenie: `agentctl report TASK --from FILE` / MCP `report_from`. Historyczne report_source inne niż ścieżka kanoniczna wywołuje ostrzeżenie w status/doctor bez zmiany plików.

`overloaded` jest odrębny od `limited`: przeciążenie dostawcy nie przełącza modelu ani dostawcy. Ograniczone ponowienia techniczne wymagają widocznego, pustego, bezczynnego pola wpisywania. Praca monitorów lub powłok w tle blokuje ponowienie. `N monitors/shells still running` oznacza `background`, nie `waiting`. Konfiguracja: `overload.auto_retry: true`, `retry_after: 300` sekund, `max_retries: 3`, `message: kontynuuj`. Próby są trwałe i zapisywane w journal; po wyczerpaniu limitu powiadomienie mówi „wymaga uwagi”.

Historia zachowuje requested, resolved i observed (model/effort z sesji, inaczej unknown) oraz wersję CLI z sesji lub kontroli przy starcie. Różnica observed/requested jest ostrzeżeniem faktograficznym. Codex `reasoning_output_tokens` jest podzbiorem output, bez podwójnego liczenia. `self_verdict` pochodzi wyłącznie z pierwszej niepustej linii `Werdykt:`; jest odrębny od oceny człowieka `mark`. Stats pokazuje oba oraz zadania bez oceny; events_since przypomina o ich liczbie.

Kolejka ponawia wyłącznie jawne błędy przejściowe OS/sieci: ETIMEDOUT, EAGAIN, ECONNRESET, ECONNREFUSED, ENETUNREACH, EAI_AGAIN, chwilowo zajętą blokadę i przejściowy timeout sieci w setup. Opóźnienia: 1, 5, 15 minut, potem failed. Błędy specu, ścieżki i konfliktu gałęzi od razu dają failed. `agentctl queue show TASK` / MCP `queue_show` pokazuje pełny spec, błąd i historię prób. Ponowne użycie worktree przechodzi kontrolę pozostałości jak ręczne queue retry.

W links i env użyj `{worktree:nazwa-repo|~/fallback}`: repozytorium z repos tego zadania wygrywa, a fallback służy tylko przy jego braku. Brak obu daje czytelny błąd; cel linku musi istnieć po utworzeniu worktree i setup. Podgląd new/queue pokazuje rozwiązane ścieżki linków.

Źródła: [błędy API Anthropic](https://platform.claude.com/docs/en/api/errors) potwierdzają 529/overloaded_error; [kod błędów Codexa](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/error.rs) potwierdza komunikat Selected model is at capacity jako ServerOverloaded. Nie uruchamiano rzeczywistych agentów. Dodatkowe warianty monitorów/powłok i surowych kodów błędów przetestowano na atrapach; ich brzmienia w aktualnej zainstalowanej wersji nie zweryfikowano.

0.17.2 review correction / poprawka po przeglądzie: summary_delivered ≠ pulled ≠ mark. Use full report pages or explicit ack; reports require current attempt plus report-end or settled ended turn. Stable client event cursors and bounded pages are described in [mcp.md](mcp.md); report.settle_s and overload.give_up_after in [configuration.md](configuration.md).

Krótka praca lub waiting nie zeruje epizodu overload. Budżet resetuje dopiero 600 s ciągłej pracy (overload.reset_after_s) albo zakończenie/raport. Baner Claude wymaga prefiksu i sąsiedztwa bloku CLI. Sesje MCP mają niezależne kursory; kolejna sesja dziedziczy zapisaną pozycję klienta, jawny client wymusza współdzielenie. Awaria okna sama nie potwierdza kompletności raportu.

Od 0.17.3 kohorta czeka domyślnie 300 s od ostatniej zmiany składu/stanu (`cohort.done_grace_s`). Dodanie zadania anuluje oczekujące powiadomienie. Odpowiedzi MCP: domyślnie 8 KiB (`mcp.max_response_kb`), dalsze fragmenty przez `response_page`. Disk pokazuje sumę, liczbę i największe 5 worktree; pełne ścieżki wymagają detail i stronicowania. Updater restartuje watch i board według roli, także po zmianie nazwy okna. Generowane hooki i notify używają stabilnej ścieżki Node.

## Poprawki po teście na żywo 0.17.3

Pierwszy prompt (także z kolejki lub po move) i instrukcja resume zawierają pełną ścieżkę kanoniczną raportu. TASK.md przechowuje pending_prompt, prompt_delivery i prompt_sent_at. Po zaufaniu folderu new lub watch wysyła prompt raz; blokada między procesami zapobiega duplikacji. Adapter wkleja raz, sprawdza widoczny ekran i ponawia tylko Enter, najwyżej dwukrotnie, wyłącznie przy własnym szkicu. Stan working albo nowa odpowiedź agenta potwierdza wysłanie. Brak potwierdzenia zwraca sukces startu/send z ostrzeżeniem „dostarczenie niepotwierdzone – sprawdzam”. Watch czeka najwyżej delivery_confirm_s (domyślnie 60 s) od wklejenia, potem jednorazowo zgłasza needs-attention. Późniejszy hook, ekran pracy, zakończenie tury albo aktualny raport kanoniczny usuwa attention; raport pozostaje dostępny dla events_since, pull_ready, after i kohort. Najpierw sprawdzane są hooki Claude UserPromptSubmit (zgodny z bieżącym promptem), Stop i Notification oraz notify Codexa; identyfikator dostarczenia wyklucza stare potwierdzenia. Konfigurowalne wzorce adapterów working_pattern rozpoznają spinner Claude 2.1.x bez „esc to interrupt”, a delivery_pattern nową odpowiedź. Echo wysłanego promptu w transkrypcie przed pustym polem wpisywania też potwierdza dostarczenie. Nie odpowiada automatycznie na dialogi.

Jawne report_from zapisuje report_confirmed; źródło pozostaje w detail, ale znika ostrzeżenie o historycznej kopii. Kandydat raportu nie uruchamia lokalnego ani telefonicznego powiadomienia: pozostaje w journal, status i board, aby nie konkurować z pytaniem agenta. Duże pull_ready full ma kontynuację przez response_page i nie oznacza raportu pulled przed pełnym, ciągłym odbiorem. Okna zwykłej powłoki nie są orphan; wymagany jest proces agenta albo rola zadania.

## Workflow NC: raporty, przeglądy i wiadomości

Protokół kompletnego raportu prosi o wersjonowany blok YAML przed `<!-- agentctl:report-end -->`:

```agentctl-outputs
version: 1
verdict: PASS
commits: [{repo: app, branch: feature, sha: aaaaaaa}]
integrate: [{repo: app, branch: feature, sha: aaaaaaa, note: propozycja integracji}]
decisions: [Wybierz termin wdrożenia]
actions: [{title: Wdrożenie po zgodzie, shell: "echo proponowana komenda"}]
checks: [{name: unit tests, result: PASS}]
preview: https://example.invalid/preview
notes: []
```

`outputs`, `outputs_valid` i `outputs_errors` opisują fakty. Gałęzie i SHA muszą istnieć w repozytoriach zadania. Brak/błąd danych ostrzega, lecz kompletny raport nadal jest gotowy. Akcje są propozycjami; agentctl nie wykonuje ich komend, nie ocenia wyniku i nie scala. `status` liczy decyzje/akcje; `pull_ready` i `get_report` pokazują dane. `cohort_show` zbiera propozycje integracji (oznacza duplikaty i różne SHA tej samej gałęzi), decyzje, akcje i sprawdzenia z ID zadań. `events_since` dodaje nowe decyzje/akcje do `needYou` raz na hash raportu. Walidacja jest per sekcja i per wpis: zły wpis odpada z ostrzeżeniem w `outputs_errors`, poprawna reszta zostaje w `outputs` (`outputs_partial: true`, `outputs_valid: false`), a `status` i `cohort_show` liczą zachowane decyzje i akcje. Cały blok odrzuca tylko zła `version`/`verdict`. Wpisy `checks` mają postać `{name, result: PASS|FAIL|WARN|SKIP, note?}` (forma standardowa); sam tekst (`"unit: PASS"`) lub mapa z jednym kluczem (`- unit: PASS`, tak YAML czyta niecytowany zapis) są przyjmowane i normalizowane, bez względu na wielkość liter.

```yaml
review: auto
# Lub w .agentctl.yaml:
# review: {default: auto, rerun: true, template: review.md}
after: [{task: IMPLEMENT, verdict: [PASS, PARTIAL]}]
repos:
  - path: ~/code/app
    worktree: ~/work/app-check
    branch: check
    base: "@IMPLEMENT:app"
```

Automatyczny przegląd dodaje `TASK-REV` po raporcie autora, na jego gałęzi i w tej samej kohorcie. Preferuje innego dostępnego dostawcę z `review.*` lub `equivalents`; w razie niedostępności wymaga innego skonfigurowanego modelu. Brak poprawnej pary daje jawny wpis o oczekującym przeglądzie. Recenzent dostaje własny odłączony worktree (`<worktree_root>/<repo>-<task>-rev`, po jednym na repozytorium autora, przypięty do commita autora) i pisze raport pod `cache/<task-rev>/<TASK-REV>.md`; nigdy nie dzieli checkoutu ani gałęzi z autorem. Startuje dopiero po zakończonej turze autora (report-end, czas settle raportu, brak follow-upu w kolejce lub niepotwierdzonego, brak szkicu, brak git w checkoucie autora); do tego czasu kolejka pokazuje `czeka na autora …`. Jeśli autor zrobi nowy commit przed startem, przegląd przypina się do nowego SHA (delta i heads zaktualizowane, wpis `review-repinned`). `review.rerun: true` tworzy `REV2` po nowym raporcie, z SHA zapisanym dla poprzedniego przeglądu jako bazą delty. Pierwszą bazą jest zapisana baza autora. Szablon znajduje się w `docs/examples/`, a ustawienia opisuje dokument konfiguracji.

`base: "@TASK"` przy starcie wybiera commit z outputs tego zadania, a bez niego HEAD jego gałęzi; przy wielu repozytoriach podaj `:repo-name`. Konkretny commit widać w podglądzie new i w TASK.md. Brak lub niejednoznaczność blokuje start. Warunkowe `after` blokuje przy innym werdykcie albo z powodem `brak werdyktu`; zwykłe `after: TASK` nadal czeka wyłącznie na kompletny raport.

`send` od razu wkleja follow-up pracującemu Claude/Codexowi. Potwierdzenie wymaga przyjęcia, nowego stanu pracy, echa transkryptu/kolejki lub nowego kompletnego raportu. Sam `idle_prompt` ani spóźniony Stop nie potwierdza dostarczenia; zablokowane pole daje `needs-attention` po `delivery_confirm_s`. Adapter wymagający bezczynności (`accepts_busy_prompt: false`) lub niepotwierdzona poprzednia wiadomość zatrzymuje kolejne w trwałej kolejce FIFO. Status/peek pokazują kolejkę, odpowiedź mówi „wklejono”, pozycję w kolejce albo „niepotwierdzone”. Watch wysyła po kolei.

Odpowiedź `send` i `delivery_result` (TASK.md, `status --json`, MCP `status`) mówią, co się stało, w stanach: dostarczono (`delivered`, ze źródłem), `w kolejce agenta – niepotwierdzone` (queued-in-agent: ekran pokazuje wiadomość w kolejce agenta, nic jej nie potwierdziło) , `w kolejce agenta – potwierdzone` (`queued-in-agent-confirmed`: dokładny enqueue, pending zostaje do wstrzyknięcia) albo `nie dostarczono – tekst w polu wpisywania` (not-delivered-in-field: wklejka stoi w polu). **„Dostarczono” padnie tylko z dokładnego źródła**, porównanego dosłownie (jedyna normalizacja to końce linii; żaden ciąg białych znaków nie jest ściskany): hook UserPromptSubmit (jego prompt dla zwiniętej wklejki jest owinięty w `<pasted_content id=…>`; wrapper zdejmuje się tylko z tekstu hooka, parami identyfikatorów, a zagnieżdżone, niezgodne lub luźne znaczniki są niejednoznaczne = brak dowodu; oczekujący prompt porównuje się dosłownie), payload notify Codexa albo transkrypt sesji samego zadania (Claude Code: linia `user`; dla `promptSource:"queued"` wymagana jest jednoznaczna korelacja z nieskonsumowanym enqueue po starcie dostawy; Codex: linia `response_item` / `item_completed`, w starszych wersjach `user_message`) z wiadomością zapisaną po rozpoczęciu dostawy, dokładnie równą oczekującej (dla zwiniętej wklejki pełna treść, nie etykieta). Czytane są tylko pliki transkryptów własnych sesji zadania: sesja wskazana przez hook/statusLine/notify tego attemptu, z przypiętą tożsamością jednego pliku. Brak, podmiana lub rotacja pliku nie przełącza na inną sesję. Sam enqueue potwierdza tylko kolejkę agenta; pending zostaje także po końcu tury i upływie limitu, z jawną notą do chwili wstrzyknięcia albo zgodnego hooka. Tego, co agent sam robi z wiadomością, nie liczy się do treści: białe znaki na końcu są obcinane, nowe linie wokół zwiniętej wklejki to dopełnienie wrappera, Claude Code zapisuje tabulator jako cztery spacje. Ekran nie potwierdza niczego u pracującego agenta: echo Codexa i znak kolejki Claude Code (przyciemnione „Press up to edit queued messages”, wiadomość w kolejce z „ctrl+x ctrl+s to send now”) tylko klasyfikują stan jako `w kolejce agenta – niepotwierdzone` (znak – tylko gdy nie było go na ekranie tuż przed naszym Enter i pojawił się po nim, a nasza wklejka zniknęła z pola); oczekujący prompt zostaje, a dostawa czeka dalej na hook lub transkrypt. Dla bezczynnego agenta, w którego wklejono, zostają starsze sygnały pierwszego promptu każdego zadania (tura ruszyła, zmienił się kanoniczny raport, wiadomość w całości w echu nad pustym polem). **agentctl naciska Enter tylko w wywołaniu, które wkleja**: do trzech razy, a przed każdym robi capture i porównuje cały obszar pola wpisywania bajt w bajt (z pustymi liniami w środku) z obrazem zrobionym zaraz po wklejce, który sam musi być naszą wklejką (jeden placeholder albo linie tekstu); na tym samym capture nie może być dialogu. Pole kończy się na strukturalnej granicy composera (ramki Claude albo znany obszar modelu i skrótów Codexa), nigdy na tekście podobnym do stopki wewnątrz pola; nieczytelna lub ucięta struktura oznacza odmowę Enter. Różnica, zmieniony pierwszy obraz albo otwarty dialog oznaczają brak Enter i `nie dostarczono – tekst w polu wpisywania` (needs-attention przy najbliższym ticku watch, z dwiema drogami wyjścia). `watch` nigdy nie naciska Enter. `agentctl send --enter-only TASK` pokazuje dokładną treść pola, stan ekranu i token dla tych bajtów; `agentctl send --enter-only TASK --confirm TOKEN` robi nowy capture i naciska Enter tylko, gdy obszar jest nadal bajt w bajt tekstem z podglądu i obrazem zapisanym po naszej wklejce (czyli agentctl wkleił go dla tej dostawy), a na ekranie nie ma dialogu; w przeciwnym razie odmawia z przyczyną. MCP: `send` z `enter_only: true`, bez tekstu, wymaga osobnej zgody `send_enter` w `mcp.allow` (samo `send` jej nie daje); bez `confirm: true` tylko pokazuje podgląd (tekst, stan, `token`), z `confirm: true` i tym `token` naciska; odmowa i nieudany klawisz (błąd tmux `send-keys`) to odpowiedzi `isError` z przyczyną, nieudany klawisz trafia do audytu jako `failed` i nigdy nie jest ogłaszany jako wysłany, wciśnięty Enter trafia do audytu jako wykonany (`enter-sent`, z dostawą) i jest ogłaszany, a odpowiedź rozdziela „Enter wysłany” od „dostarczenie potwierdzone”. Przy otwartym pytaniu Codexa nic nie jest wklejane: odpowiedź podaje treść pytania („Codex ma otwarte pytanie „…” (zwinięte, N)”), a wiadomość czeka w kolejce FIFO. Dziennik (`events_since`, rodzaj WIADOMOŚĆ) zapisuje każdą zmianę wyniku wiadomości z id dostawy: w kolejce, nie dostarczono, dostarczono (pierwszy prompt zadania: tylko dwa pierwsze).

Limit dostawcy daje jedno powiadomienie na epizod, z czasem resetu albo `n/d`. Świeży odczyt wolnego limitu powyżej `limited.resume_above_percent` (domyślnie 5) lub upłynięcie znanego resetu dopuszcza wysłanie `limited.message` (`kontynuuj`) do bezczynnego okna z pustym polem. Zabezpieczenia overload sprawdzają warunki przed wklejeniem i Enterem; licznik prób i ograniczenia przeżywają restart. `limited.auto_resume: false` wyłącza wysyłanie. Dostawca i model pozostają te same.

`agentctl mark --cohort NC ok --note "sprawdzone"` pokazuje dokładny zakres; `--yes` go potwierdza. MCP przyjmuje `task`, `tasks` lub `cohort`; więcej niż jedno zadanie wymaga podglądu/potwierdzenia. Przy filtrze kohorty board `o/p/f` pokazuje ID przed oceną. Agentctl zapisuje wynik podany przez człowieka. Zamknięcie wszystkich zadań kohorty daje `gc_suggest` z chronionym planem sprzątania tej kohorty, bez automatycznego usuwania.

Podglądy MCP mają niezależne `preview_token`, ważne dziesięć minut, i odmawiają wykonania po zmianie zakresu. Przekaż token oraz identyczne argumenty z `confirm: true`; bez tokena działa ostatni pasujący podgląd. `gc_preview` dla kohorty podaje tylko liczbę obcych worktree; potwierdzone `gc` zwraca wyniki bez powtarzania planu. `notify.mcp_writes` domyślnie ma `summary`, najwyżej raz na 60 sekund; dostępne też `all` i `off`. Audyt pozostaje pełny. F12 wraca do boarda własnej sesji, także przy równoległym dev. Czas obejmuje checkout/setup przed uruchomieniem agenta; ostrzeżenie o starym odczycie planu pojawia się raz na odczyt.

## Adaptery dostawców

Rejestr rozdziela zarejestrowane ID od aktywnych `providers`. Claude/Codex są obowiązkowe i zachowują działanie 0.17.4. Opcjonalny Kimi Code 2.5.0 obsługuje start/resume, metadane modeli i zgód TOML, wzorce ekranu, pasywny wire protocol 1.5 i usage. Nieznany protokół daje klasyfikację z ekranu i ostrzeżenie doctor. Ścieżki logów/sesji i rekordy interakcji wire Kimi nadal są hipotezami.

Po aktywacji Kimi limity/rezerwacje, capacity, usage, stats, alerty, queue_hold, board i MCP obejmują trzecią kolumnę. Przy więcej niż dwóch aktywnych dostawcach `move` wymaga `--agent`; wybór podaje wolne miejsca i znane procenty. `review.prefer` albo kolejność providers wybiera pierwszego aktywnego, zainstalowanego i mapowalnego recenzenta innego niż autor. Etykiety modeli używają nazw katalogowych i jawnych wersji, bez zgadywania wersji aliasów serwerowych.

Kimi nie ma sandboxa. Agentctl nie edytuje jego configu, nie odpowiada na dialogi trust/login/update i nie włącza auto-akceptacji. Wyłącza aktualizacje per proces i domyślnie telemetrię. Dane zadania (prompt, pliki, wyniki poleceń, diffy) nadal trafiają do Moonshot AI. Reguły Bash dopasowują cały command string; dokładne przykłady są w configuration.md. Opcjonalna sonda `/usage` używa neutralnej sesji z ręcznym trust i `/exit`, nigdy okna zadania, credentials ani API. Brak danych planu to n/d.

## Bramki deweloperskie

Pierwszym poleceniem powłoki wyeksportuj bezwzględny `AGENTCTL_LIVE_CACHE` z promptu. Używaj `npm run gate -- quick` dla poprawek, funkcji i przeglądów, `full` dla integracji oraz `release` dla kandydatów wydania. Nie twórz własnych runnerów ani nie powtarzaj zapisanego PASS dla tego samego SHA i zakresu.

`quick` uruchamia kontrolę typów, build, kontrolę białych znaków diffu i powiązane testy na bieżącym Node. `--base <ref>` zastępuje domyślny merge-base z `agentctl-0181-rc1`. Testy dobierane są przez przechodnie importy względne i dokładne nazwy; niepewne mapowanie uruchamia cały zestaw na jednym Node. `full` wykonuje wszystkie testy kolejno na Node 22.14.0 i Homebrew Node 26. `release` buduje paczkę, wykonuje smoke zainstalowanego tarballa (12 sprawdzeń) i izolowaną macierz doctor (10 przypadków) na obu Node, potem kolejno wszystkie wpisy `scripts/live-*.ts`, zatrzymując się na pierwszym błędzie. `--skip-live` zapisuje pominięcia. Prawdziwa inferencja dostawców nadal wymaga jawnego pozwolenia.

`--dry-run` wypisuje plan bez przygotowywania runtime ani wykonywania sprawdzeń. Full/release odmawiają przy brudnym drzewie bez zapisanego `--allow-dirty`. Ciężkie polecenia używają `nice -n 10` i na macOS `taskpolicy -b`; nie czekają na obciążenie. Full/release czekają na wspólną blokadę `~/Projects/cache-dev/runtimes/.gate.lock`, wypisując właściciela. `AGENTCTL_RUNTIMES_DIR` zmienia ten katalog. Node 22.14.0 (darwin-arm64) jest pobierany tylko przy braku, weryfikowany przez SHASUMS256 z nodejs.org i zachowywany; Node 26 pochodzi z Homebrew. Przed usunięciem osieroconej blokady potwierdź zakończenie jej właściciela.

Wyniki i logi trafiają do `$AGENTCTL_LIVE_CACHE/gate-results/<sha>/`. `<tier>.json` zawiera SHA, stan drzewa i wyjątek, wersje Node, liczniki, ponowienia i czas. Każdy nieudany plik testów jest powtarzany raz; obie próby pozostają w logach i krokach wyniku. Udane ponowienie może zaliczyć bramkę, ale pierwotne błędy pozostają w licznikach. Plan jest jawnie oznaczony i nie zastępuje wykonanej bramki. Pliki robocze są usuwane automatycznie; dowody i wspólne runtime zostają.

Ponowne użycie skrótu raportu zawsze sprawdza bieżącego właściciela zadania, dozwolone katalogi i dowiązania symboliczne w ścieżce; autoryzacja nie jest buforowana.

Wersje cache TASK.md i raportów obejmują urządzenie, inode, rozmiar oraz nanosekundowy czas modyfikacji i zmiany metadanych. Niska rozdzielczość czasu zmian (wyrównanie do milisekundy) wyłącza ponowne użycie; zapis nagłówka i kopiowanie raportu jawnie unieważniają wpisy.

Jeśli identyfikator zadania istnieje w bieżącym stanie i archiwum, postęp oraz worktree na tablicy pochodzą z bieżącego rekordu.
