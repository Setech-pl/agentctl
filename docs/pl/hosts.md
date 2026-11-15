# Hosty: zadania zdalne po SSH

Spec z `host: pc` tworzy worktree, wykonuje setup repozytorium i uruchamia interaktywnego agenta na hoście. Dispatcher trzyma lokalnie stan zadania i kopię raportu. Na hoście potrzebne są Git, tmux, Node, zainstalowane CLI dostawców z wykonanym logowaniem oraz osobne klony repozytoriów. Zdalna instalacja agentctl nie jest potrzebna. Zakładamy konto właściciela: wygenerowane hooki i ustawienia powstają w plikach własnych zadania, bez edycji ustawień użytkownika dostawcy.

Dopisz do istniejącego globalnego configu dispatchera, zachowując pozostałe klucze:

```yaml
hosts:
  pc:
    ssh: owner@pc.local
    port: 22
    work_dir: ~/agentctl-work
    repos:
      app: ~/src/app
    providers: [claude, codex, kimi, glm]
    limits: {claude: 1, codex: 1, kimi: 1, glm: 1}
    # env: {PATH: /home/owner/.local/bin:/usr/local/bin:/usr/bin:/bin}
```

Wpisz tylko dostawców zainstalowanych i zalogowanych na hoście. `env.PATH` udostępnia CLI spoza PATH nieinteraktywnej powłoki SSH. Opcjonalne `identity_file` wskazuje **lokalny** plik klucza. Nie zapisuj tu danych logowania; logowanie dostawcy zostaje na hoście. Dla Windows/WSL podaj adres i przekierowany port SSH WSL, np. `ssh: owner@192.168.2.64`, `port: 2222`.

Pierwszy klucz zaakceptuj raz we własnym terminalu — `agentctl doctor` wypisuje dokładną komendę — potem sprawdź `agentctl hosts --refresh`. Stałe opcje `BatchMode=yes` i `StrictHostKeyChecking=yes` wykluczają pytania SSH i automatyczne akceptowanie kluczy. Połączenia na hosta są multipleksowane. Każde wywołanie przekazuje skonfigurowaną nazwę hosta; agentctl nie pamięta starego IP.

Zapisz `remote.md`:

```yaml
---
task: PC-SMOKE
host: pc
agent: claude
model: sonnet
effort: high
review: false
repos:
  - path: app
    base: origin/main
    branch: pc-smoke
---
Obejrzyj repozytorium i napisz krótki raport. Nie zmieniaj plików i nie commituj.
```

Uruchom `agentctl new remote.md --no-wait-trust`, potem `agentctl attach PC-SMOKE`. Dla zadania na hoście attach wypisuje komendę `ssh -t … 'tmux attach-session …'`: uruchom ją i sam potwierdź trust folderu. Pozostaw działający watch (`agentctl watch --tmux`). Ctrl-b d odłącza sesję i wraca do lokalnego terminala; F12 to lokalny skrót boardu, bez przeskakiwania między hostami. Enter na boardzie również pokazuje zdalną komendę attach, a zadanie ma znaczek `[pc]`.

`repos[].path` identyfikuje skonfigurowany klon: nazwą albo ścieżką o takiej końcówce. Agentctl robi tam fetch `origin`, nigdy push, a potem tworzy gałąź lub detached worktree według tych samych zasad base/branch co lokalnie. Preferuj `origin/main` zamiast potencjalnie starego lokalnego `main`. Błąd brakującej bazy podaje domyślną gałąź klonu na hoście. Worktree musi być osobnym katalogiem wewnątrz `work_dir`; domyślnie to `<work_dir>/<repo>-<task>`. Setup pochodzi z `.agentctl.yaml` każdego nowego worktree; jawny setup speca go zastępuje, także pustą listą `[]`. Projektowe linki i env wykonują się na hoście; lokalne pliki projektowe i globalne linki nie są tam kopiowane.

Te same adaptery dostawców obsługują gotowość, trust, pytania, wklejenie i potwierdzenie promptu. Claude/GLM dostają powtarzalną instalację hooków/ustawień własnych zadania, opisaną na starcie. Codex zachowuje notify właściciela i potwierdza wiadomość z nazwanego rolloutu; Kimi używa powiązania state/wire z tym zadaniem. Nieznany protokół Kimi daje tylko stan ekranu i nie potwierdza follow-upu. `peek`, `send` (w tym FIFO Codexa do końca tury), `answer` z tokenem menu, `interrupt`, `close` i `cancel` trafiają do zdalnego okna. Jawne `close --rm-worktree` usuwa zarejestrowane zdalne worktree przez Git bez force; gałąź zostaje.

Zdalny raport kanoniczny to `<work_dir>/reports/<task>/<TASK>.md`. Pole speca `report:` wskazuje **lokalną kopię**, zwykle wewnątrz `config.cache`. Watch kopiuje zmienioną treść oraz sprawdza raport przy końcu zadania i jawnym close/cancel. `get_report`, parser outputs i pull czytają kopię lokalną. Walidacja gałęzi/SHA outputs odbywa się w klonie na hoście i ma cache do odczytów offline. Raport nadal wymaga normalnego protokołu attempt/report-end.

Utrata SSH ustawia `host-unreachable`, zachowuje aktywne zadanie i jego slot, generuje zdarzenie/powiadomienie oraz ponawia połączenie po 5 sekundach, z wykładniczo rosnącą przerwą do 5 minut. Po odzyskaniu połączenia śledzenie wraca. Watch sam nie zamyka zdalnych okien. Jawne operacje zgłaszają awarię połączenia i nie oznaczają wtedy żywego zadania jako zamkniętego/anulowanego.

Zadanie zdalne liczy się do limitu konta dostawcy razem z lokalnymi zadaniami i rezerwacjami; `hosts.<name>.limits` dodaje limit host/dostawca. Kolejka i follow-upy respektują oba. HOST-0C obejmuje dalsze GC, prezentację limitów i dopracowanie boardu. Lokalne GC, sprzątanie cache i pomiary dysku pomijają zdalne worktree. Ta część nie obsługuje zdalnych `move`, `resume` ani automatycznych review; użyj nowego speca/osobnego zadania review, a `review: false` wyłącza odziedziczone auto-review. Rzeczywisty test hosta z inference pozostaje do wykonania przez właściciela.
