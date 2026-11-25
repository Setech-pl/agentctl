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

Uruchom `agentctl new remote.md --no-wait-trust`, potem `agentctl attach PC-SMOKE`. Dla zadania na hoście attach wypisuje komendę `ssh -t … 'tmux attach …'`: uruchom ją i sam potwierdź trust folderu. Pozostaw działający watch (`agentctl watch --tmux`). Ctrl-b d odłącza sesję i wraca do lokalnego terminala; F12 to lokalny skrót boardu, bez przeskakiwania między hostami. Enter na boardzie również pokazuje zdalną komendę attach, a zadanie ma znaczek `[pc]`.

`repos[].path` identyfikuje skonfigurowany klon: nazwą albo ścieżką o takiej końcówce. Agentctl robi tam fetch `origin`, nigdy push, a potem tworzy gałąź lub detached worktree według tych samych zasad base/branch co lokalnie. Preferuj `origin/main` zamiast potencjalnie starego lokalnego `main`. Błąd brakującej bazy podaje domyślną gałąź klonu na hoście. Worktree musi być osobnym katalogiem wewnątrz `work_dir`; domyślnie to `<work_dir>/<repo>-<task>`. Setup pochodzi z `.agentctl.yaml` każdego nowego worktree; jawny setup speca go zastępuje, także pustą listą `[]`. Projektowe linki i env wykonują się na hoście; lokalne pliki projektowe i globalne linki nie są tam kopiowane.

Te same adaptery dostawców obsługują gotowość, trust, pytania, wklejenie i potwierdzenie promptu. Claude/GLM dostają powtarzalną instalację hooków/ustawień własnych zadania, opisaną na starcie. Codex zachowuje notify właściciela i potwierdza wiadomość z nazwanego rolloutu; Kimi używa powiązania state/wire z tym zadaniem. Nieznany protokół Kimi daje tylko stan ekranu i nie potwierdza follow-upu. `peek`, `send` (w tym FIFO Codexa do końca tury), `answer` z tokenem menu, `interrupt`, `close` i `cancel` trafiają do zdalnego okna. Jawne `close --rm-worktree` usuwa zarejestrowane zdalne worktree przez Git bez force; gałąź zostaje.

Zdalny raport kanoniczny to `<work_dir>/reports/<task>/<TASK>.md`. Pole speca `report:` wskazuje **lokalną kopię**, zwykle wewnątrz `config.cache`. Watch kopiuje zmienioną treść oraz sprawdza raport przy końcu zadania i jawnym close/cancel. `get_report`, parser outputs i pull czytają kopię lokalną. Walidacja gałęzi/SHA outputs odbywa się w klonie na hoście i ma cache do odczytów offline. Raport nadal wymaga normalnego protokołu attempt/report-end.

Utrata SSH ustawia `host-unreachable`, zachowuje aktywne zadanie i jego slot, generuje zdarzenie/powiadomienie oraz ponawia połączenie po 5 sekundach, z wykładniczo rosnącą przerwą do 5 minut. Po odzyskaniu połączenia śledzenie wraca. Watch sam nie zamyka zdalnych okien. Jawne operacje zgłaszają awarię połączenia i nie oznaczają wtedy żywego zadania jako zamkniętego/anulowanego.

Zadanie zdalne liczy się do limitu konta razem z lokalnymi zadaniami i rezerwacjami; `hosts.<name>.limits` dodaje limit host/dostawca.

## 0.23.0: utrzymanie, limity i restart

`limits`, `capacity`, board `L`/`C` oraz `H` pokazują limity hosta obok limitów konta. Blokada dostawcy obejmuje lokalną i zdalną kolejkę, również starty bezpośrednie; niedostępne zadania zachowują sloty. Watch mierzy wolne miejsce w `work_dir` każdego hosta; capacity/board wskazują nazwę hosta, a zmiana progu dysku generuje zdarzenie. Nieznany lub stary odczyt pozostaje n/d.

`agentctl move TASK --host pc` albo `--host local` zmienia lokalizację wyłącznie nieuruchomionego zadania w kolejce. Podgląd i potwierdzenie y/N zachowują ID, priorytet, pozycję, zależności, prompt i dostawcę. Zadania uruchomione, startujące, retry/reuse oraz automatyczne review nie zmieniają lokalizacji. Pliki nie są przesyłane. Do przejścia w obie strony podaj w oryginalnym specu lokalną bezwzględną `repos[].path`, której końcówka odpowiada klonowi hosta, i skonfiguruj lokalny `worktree_root`. Oryginalna lokalna ścieżka worktree zostaje zachowana; host używa własnej domyślnej.

`gc --preview` mierzy zdalne worktree i pliki własne zakończonych zadań po SSH, z budżetem 5 s/100 000 wpisów i limitem transportu 10 s na hosta. Cache jest ważny 60 s; podgląd z cache pomija brakujące/stare dane z wyjaśnieniem. Jawny podgląd CLI odświeża dane. `gc --apply` i MCP `gc` wymagają zwykłego potwierdzenia właściciela. Przed każdym usunięciem host ponownie sprawdza własność zadania, okna, użycie współdzielone/linki, rejestrację i czystość worktree, chronione main/master oraz wiek cache. Git nigdy nie używa force. Obce katalogi, symlinki i raporty (*.md, również zagnieżdżone) zostają. Zdalne gałęzie oraz lokalne kopie raportów/stanu nie są usuwane przez zdalny GC. Awaria SSH lub przekroczenie budżetu zachowuje cel i wyjaśnia pominięcie.

Po restarcie watch odnajduje zdalne okna po ID zadania, aktualizuje ID tmux i obserwuje istniejącego agenta bez uruchamiania drugiego. `resume TASK` odtwarza rzeczywiście brakujące okno na hoście, z jego hookami i ścieżką raportu; niedostępny host nigdy nie oznacza pustego tmux. Utracony lokalny TASK.md odtwarza `adopt TASK --host pc --report /bezwzgledna/lokalna/kopia/TASK.md --agent claude --model sonnet --effort high`, identyfikując istniejące zdalne okno. Dodaj `--worktree /zdalny/worktree`, jeśli znasz ścieżkę; `--remote-report` zmienia domyślną ścieżkę zdalnego raportu. Adopt nie odzyskuje oryginalnego promptu. Zdalne review zamawiaj osobnym zadaniem (`review: false`).

Jawne `resume` właściciela zachowuje zachowanie 0.22.4: blokada dostawcy zatrzymuje kolejkę, a resume nadal sprawdza sloty konta i hosta.

## Pierwszy rzeczywisty test PC: WSL2 → Windows → Mac

Użyj Ubuntu WSL2 jako **krzet**, adresu Windows **192.168.2.64** i zewnętrznego portu SSH **2222**. Poniższe komendy wykonuje właściciel; uruchamiają jedno rzeczywiste zadanie Claude. Klony i worktree trzymaj w linuksowym systemie plików WSL.

1. **WSL, jednorazowo:** zainstaluj Node >=22.14.0 (sprawdź `node --version`; w razie potrzeby skorzystaj z [instalatora Node](https://nodejs.org/en/download)), a następnie:

   ```sh
   sudo apt-get update
   sudo apt-get install -y openssh-server git tmux
   sudo ssh-keygen -A
   sudo service ssh start
   # Z systemd: sudo systemctl enable --now ssh
   mkdir -p ~/.ssh ~/src ~/agentctl-work
   chmod 700 ~/.ssh
   npm install -g @anthropic-ai/claude-code
   claude
   # Zaloguj się, potem wyjdź z CLI.
   git clone https://github.com/Setech-pl/agentctl.git ~/src/agentctl
   ```

   Wklej publiczny klucz Maca do `~/.ssh/authorized_keys` i ustaw `chmod 600 ~/.ssh/authorized_keys`. `whoami` ma pokazać `krzet`, a `ss -lnt` — SSH na porcie 22. Jeśli potrzebujesz systemd, dopisz `[boot]` / `systemd=true` do `/etc/wsl.conf`, wykonaj `wsl --shutdown` w Windows i otwórz Ubuntu ponownie. Nie zamykaj WSL podczas pracy zadań.

2. **Windows, PowerShell jako administrator, jednorazowo:** zmień `Ubuntu`, jeśli `wsl -l -v` pokazuje inną nazwę dystrybucji.

   ```powershell
   $pcWslIp = ((wsl -d Ubuntu hostname -I).Trim() -split '\s+')[0]
   netsh interface portproxy add v4tov4 listenaddress=192.168.2.64 listenport=2222 connectaddress=$pcWslIp connectport=22
   New-NetFirewallRule -DisplayName 'agentctl WSL SSH 2222' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 2222 -Profile Private -RemoteAddress LocalSubnet
   netsh interface portproxy show v4tov4
   ```

   Po restarcie Windows/WSL otwórz Ubuntu, uruchom SSH, pobierz nowe IP WSL i popraw cel przekierowania:

   ```powershell
   $pcWslIp = ((wsl -d Ubuntu hostname -I).Trim() -split '\s+')[0]
   netsh interface portproxy set v4tov4 listenaddress=192.168.2.64 listenport=2222 connectaddress=$pcWslIp connectport=22
   Test-NetConnection 192.168.2.64 -Port 2222
   ```

   Zarezerwuj LAN IP Windows w DHCP. Jeśli zmieni się również ten adres, popraw `listenaddress` i `hosts.pc.ssh`. Adres NAT WSL różni się od adresu LAN Windows. Źródła: Microsoft [sieć WSL](https://learn.microsoft.com/windows/wsl/networking) i [systemd](https://learn.microsoft.com/windows/wsl/systemd).

3. **Mac, jednorazowo:** jeśli nie masz klucza, wykonaj `ssh-keygen -t ed25519`; jego plik `.pub` zainstaluj w WSL jak wyżej. Uruchom `ssh -p 2222 krzet@192.168.2.64`, porównaj fingerprint z WSL (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`), zaakceptuj i wyjdź. Sprawdź dostęp bez pytań:

   ```sh
   ssh -o BatchMode=yes -p 2222 krzet@192.168.2.64 'whoami; tmux -V; node --version; command -v claude'
   ```

   Dopisz do istniejącego configu Maca, zwykle `~/.agentctl/config.yaml`:

   ```yaml
   hosts:
     pc:
       ssh: krzet@192.168.2.64
       port: 2222
       work_dir: /home/krzet/agentctl-work
       repos: {agentctl: /home/krzet/src/agentctl}
       providers: [claude]
       limits: {claude: 1}
       env: {PATH: /home/krzet/.local/bin:/usr/local/bin:/usr/bin:/bin}
   ```

   Jeśli Node/Claude są w prefiksie nvm/npm, zastąp `env.PATH` wynikiem `printf '%s\n' "$PATH"` z WSL i ponów test nieinteraktywnego SSH. Zapisz `pc-smoke.md`:

   ```yaml
   ---
   task: PC-SMOKE-1
   host: pc
   agent: claude
   model: sonnet
   effort: high
   review: false
   setup: []
   repos: [{path: agentctl, base: origin/main, branch: pc-smoke-1}]
   ---
   Odczytaj package.json i podaj w raporcie nazwę pakietu oraz wersję. Nie zmieniaj plików i nie commituj.
   ```

   Wykonaj `agentctl hosts --refresh`, `agentctl watch --tmux`, potem `agentctl new pc-smoke.md --no-wait-trust`. Uruchom dokładną komendę SSH wypisaną przez `agentctl attach PC-SMOKE-1`, potwierdź trust folderu i odłącz się Ctrl-b d. Sprawdź `[pc]`/`H` na boardzie i `agentctl pull PC-SMOKE-1`. Na koniec zamknij zadanie i obejrzyj plan GC przed jego wykonaniem.

## Rozwiązywanie problemów

| Objaw | Sprawdzenie / naprawa właściciela |
| --- | --- |
| host-key-unknown | Uruchom jednorazową komendę SSH z doctora i porównaj fingerprint na hoście przed akceptacją. |
| HOST KEY CHANGED | Najpierw sprawdź fingerprint i adres; po potwierdzonej reinstalacji usuń wyłącznie stary wpis: `ssh-keygen -R '[192.168.2.64]:2222'`, potem połącz się ręcznie. Nie wyłączaj strict checking. |
| auth-failed / Permission denied | Sprawdź SSH BatchMode, użytkownika krzet, uprawnienia authorized_keys, właściwy klucz/ssh-agent lub lokalne identity_file. Logowanie Windows nie loguje do WSL. |
| Connection refused / timeout po restarcie | Otwórz WSL i uruchom sshd; popraw IP WSL w portproxy, sprawdź LAN IP Windows, regułę Private i port 2222. |
| Brak tmux | Zainstaluj go wewnątrz WSL; sprawdź `ssh -p 2222 krzet@192.168.2.64 'tmux -V'`. |
| Brak CLI / wylogowany dostawca | Zainstaluj i zaloguj jako krzet w WSL, nie w Windows ani jako root. Sprawdź nieinteraktywny PATH, uruchom CLI ręcznie. Plik danych logowania nie dowodzi ważności tokenu. |
| GC pomija cel | Przeczytaj powód; zakończ/zamknij zadanie, commituj zamierzone zmiany, rozwiąż linki albo poczekaj na wymagany wiek. Bez force. |
| Zadanie nie startuje | Sprawdź blokadę/limit konta i limit hosta w `limits`/`capacity`; hold dostawcy obejmuje także zdalną kolejkę. |

## 0.23.1: bezpieczeństwo i dopuszczanie startów

Zachowanie 0.22.5–0.22.8 obejmuje także hosty: pin/unpin i GC `--keep TASK`, zachowanie cache domyślnie (usuwanie wymaga `--include-cache`), `keep_cache`, referencje artefaktów raportu i kontrolę niewysłanych commitów w każdym zdalnym worktree. Zdalny GC nigdy nie wymusza usunięcia zmian/commitów, także przy lokalnym force. Pin i keep są ponownie sprawdzane przy wykonaniu planu. Referencje cache są sprawdzane zachowawczo w raporcie hosta i lokalnej kopii; niejednoznaczność chroni dane.

Podgląd kolejki korzysta z pomiaru zdrowia hosta nie starszego niż 60 sekund dla jego `work_dir`; brak/stary/nieznany pomiar blokuje start. Przed zmianami worktree/setup start bezpośredni i z kolejki odczytuje świeże liczniki systemu plików hosta (najbliższego istniejącego rodzica, jeśli work_dir jest nowy). Dyspozytor nie sprawdza zdalnej ścieżki lokalnie. Harmonogram szczytu i globalne blokady działają przed zdalnym setupem; działające zadania i jawne wznowienie właściciela zachowują opisane reguły. Przewinięcie menu nie unieważnia tokena answer przy niezmienionym pytaniu i wybranej opcji. Snapshot status/capacity zachowuje host i zapisany pomiar jego dysku, bez SSH i skanowania zadań.

Zdalne linki domyślne projektu mają tę samą kontrolę zamkniętych zadań i wyłączenie przez `links: []` co lokalne; `{worktree:repo}` wskazuje repo ze specyfikacji.

## Dwie maszyny: Mac + PC/WSL

Na Macu działa jeden dyspozytor, watch, tablica, WALL i MCP dla wszystkich czatów. PC uruchamia zadania i ich drzewa robocze w Ubuntu WSL. Na Macu:

```sh
cd ~
agentctl hosts add pc --ssh krzet@192.168.2.64 --port 2222
agentctl hosts doctor pc
```

W WSL uruchom sshd, zainstaluj tmux, Git, Node i rsync, utwórz `work_dir`, sklonuj repozytoria i zaloguj Claude oraz Codex. Doctor sprawdza BatchMode, nieinteraktywny PATH, dyski WSL i Windows, PowerShell, Windows Node oraz Chrome/Edge. W Windows wykonaj polecenia portproxy i zapory podane przez doctor. Odśwież portproxy po zmianie adresu WSL. Do pobierania z Maca włącz na nim Zdalne logowanie oraz sprawdź połączenie SSH z WSL w BatchMode. Użyj rsync 3 po obu stronach.

```yaml
placement: {default: auto, prefer: [pc, local], failover_after: 10m}
hosts:
  local:
    repos: {hems: ~/Projects/hems}
  pc:
    ssh: krzet@192.168.2.64
    port: 2222
    work_dir: ~/agentctl-work
    repos: {hems: ~/src/hems}
    providers: [claude, codex]
    limits: {claude: 1, codex: 1}
    max_total: 2
    load_threshold: 25
    sync: fetch-back
    mac_ssh: owner@macbook.local
    trust_work_dir: true
    availability:
      windows: ["mon 01:00-08:00", "tue 01:00-08:00", "wed 01:00-08:00", "thu 01:00-08:00", "fri 01:00-08:00", "sat 01:00-08:00", "sun 01:00-08:00"]
      processes: [ComfyUI, ExampleGame.exe]
      gpu_busy_pct: 70
      yield: stop-new
perf: {wait_max: 30m, max_artifact_mb: 2048}
```

- `host: auto` sprawdza globalne miejsce na koncie, limity hosta, klon, zainstalowany i zalogowany CLI, próbkę z ostatniej minuty, dysk, obciążenie i dostępność. Preferuje host powiązanego worktree, potem wybiera najmniej zajęty host i rozstrzyga remis przez `placement.prefer`. Przy niedostępnym PC kolejka czeka na lokalny start do upływu `failover_after`. Uruchomione zadanie zostaje na swoim hoście.
- Bez pola `host` pierwszeństwo ma `placement.chats` (np. `{"chat:mac-tools": local}`), potem `placement.cohorts`, potem `placement.default` (początkowo `local`). Przypnij `pc` do Windows/GPU i `local` do Keychain. `reuse_worktree: TASK` wymaga zamknięcia zadania źródłowego i korzysta z jego hosta oraz katalogu.
- Watch pobiera gałąź zadania na Maca przy raporcie i zamknięciu. Rozbieżna lub aktualnie używana gałąź Maca zostaje zachowana, a gałąź PC jest w `refs/remotes/pc/<gałąź>`. Zdarzenie wskazuje konflikt. Opcjonalne `fetch_remote: pc` wskazuje istniejący remote Git. `mac_ssh` pozwala PC pobrać bazę z Maca, także przy `base_task`. `sync: off` wyłącza oba kierunki.
- `agentctl hosts pause pc --until 18:00` (również ISO lub `3h`) rezerwuje PC. `agentctl hosts resume pc` zwalnia ręczną rezerwację. Klawisz `H` i numer hosta przełączają rezerwację na tablicy. W MCP dodaj `hosts_pause` i `hosts_resume` do `mcp.allow` i użyj podglądu oraz potwierdzenia. Mac ma tę samą politykę pod `hosts.local.availability`. Okna używają czasu lokalnego Maca. `stop-new` zostawia pracujące zadania, a `pause-all` wstrzymuje ich drzewa procesów i wznawia po zwolnieniu hosta.
- Po sprawdzeniu katalogu włącz `trust_work_dir: true` dla Codexa. Dla Claude zdarzenie `needs-trust` podaje polecenie SSH/tmux potrzebne do potwierdzenia w oknie.

### Pomiary wydajności Windows

```sh
cd ~
agentctl queue ~/specs/PERF-HEMS.md
```

```yaml
---
task: PERF-HEMS
agent: codex
class: perf
host: pc
repos: []
at: "03:00"
on_pass: HEMS-INTEGRATE-*
artifacts: [{from_task: HEMS-BUILD, path: dist, dest: dist}]
results: results
---
Uruchom pomiar HEMS w Windows przez ~/src/hems/scripts/perf/win/measure.ps1 na przesłanym dist/.
Zapisz wyniki w results/ oraz werdykt wydajności w raporcie.
```

Zlecenie czeka na najbliższą 03:00 czasu Maca oraz raport integracji z werdyktem PASS dla wskazanej kohorty lub wzorca zadania. `start_after` przyjmuje datę ISO. Gotowy perf rezerwuje cały PC do końca pomiaru. Po `perf.wait_max` zlecenie jest wstrzymane do `agentctl queue retry PERF-HEMS`. Rsync z weryfikacją sum kontrolnych przenosi katalog z buildem, z worktree zadania Maca lub ze ścieżki absolutnej. Wyniki trafiają do `PERF-HEMS.results/` obok raportu, po czym PC usuwa przesłany build. Dyspozytor transportuje wyniki, a zadanie ocenia regresję.
