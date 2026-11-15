# Dostawcy

Strona opisuje adaptery agentctl, a nie gwarancję dostępu konta do każdego aliasu modelu. Sprawdź wersję/logowanie CLI i `agentctl doctor`. Fixture’y bazują na Claude Code 2.1.309/2.1.311, Codex 0.166/0.167 i Kimi Code 2.5.x; nowe CLI mogą zmienić format ekranu.

## Włączenie i konfiguracja

~~~yaml
providers: [claude, codex, kimi, glm]
limits: {claude: 2, codex: 2, kimi: 2, glm: 2}
defaults: {agent: codex, model: default, effort: medium}
capacity:
  codex_refresh: true
  claude_usage_probe: false
  kimi_usage_probe: false
~~~

Claude i Codex są obowiązkowe w `providers`; Kimi i GLM są opcjonalne. Po włączeniu dostawców restartuj MCP, aby rozszerzyć enumy. `agents.<provider>` ustawia flagi, środowisko, effort i wzorce; `usage.<provider>_dir` wskazuje transkrypty. `limits` liczy lokalną równoległość, nie uprawnienia planu. Adaptery odrzucają niebezpieczne opcje auto-approve. Worktree nie jest piaskownicą OS; Codex startuje z `--sandbox danger-full-access`, lecz obchodzenie zgód jest zabronione.

| Adapter | Start/model | Effort akceptowany przez agentctl | Źródło planu/tokenów |
|---|---|---|---|
| `claude` | `claude --model MODEL`; default pomija model | low, medium, high, xhigh, max przez `--effort` | statusLine, opcjonalne neutralne /usage; tokeny/subagenci JSONL |
| `codex` | `codex -m MODEL`; default pomija model | low, medium, high, xhigh przez `-c model_reasoning_effort=…` | app-server account/rateLimits/read i logi sesji; input/cache/output |
| `kimi` | `kimi -m` z kwalifikowanym aliasem; default pomija | low, high, max; konfiguracja thinking; katalog może ograniczyć poziomy | pasywne wire/stan sesji usage.record; opcjonalna sonda /usage |
| `glm` | `claude-glm --model`, tylko glm-5.3 / glm-5.3-flash lub default | jak Claude | osobne transkrypty/statusLine Claude; plan zwykle n/d |

[Macierz](../../data/model-matrix.yaml) jest polityką zlecania, nie benchmarkiem ani kontrolą dostępu. Board pokazuje skrót rodziny/wersji/effort, jeśli są znane; ustawienia zamówione i zaobserwowane pozostają osobne.

## Claude Code (Anthropic)

[Produkt](https://claude.com/product/claude-code) · [Instalacja CLI](https://code.claude.com/docs/en/setup) · [Logowanie](https://code.claude.com/docs/en/authentication).

Zainstaluj `npm install -g @anthropic-ai/claude-code` (oficjalna instrukcja oferuje też instalację natywną). Uruchom `claude`, przejdź logowanie w przeglądarce i onboarding. Hooki agentctl używają pliku ustawień zadania i przekazują obsługiwane istniejące hooki/statusLine; nie zastępują globalnych ustawień auto-accept. `remote_control: true` działa tylko dla Claude i tworzy interaktywną sesję Remote Control; pierwsza zgoda jest ręczna.

Plan zwykle pochodzi z `usage.claude_tap: true`. Opcjonalne `capacity.claude_usage_probe: true` otwiera osobny neutralny TUI, wysyła tylko `/usage` i zamyka go; odstęp minimum 15 minut. Nie wysyła promptu inference. Trust/logowanie neutralnego katalogu przechodzi się ręcznie; doctor nie uruchamia sondy. Parser wymaga tygodniowego panelu wszystkich modeli, zachowuje nieznane resety i poprzedni odczyt po błędzie. Tygodniowych paneli poszczególnych modeli nie sumuje do wspólnej kwoty.

## OpenAI Codex CLI

[Produkt](https://chatgpt.com/features/codex) · [Dokumentacja CLI](https://developers.openai.com/codex/cli) · [Oficjalny kod](https://github.com/openai/codex).

Zainstaluj `npm install -g @openai/codex`, uruchom `codex` i przejdź logowanie. Agentctl przekazuje model/effort i wyłącza sprawdzanie aktualizacji przy starcie zadania. Jeśli modal aktualizacji się pojawi, odpowiedz w oknie; to nie gotowe pole wpisywania. Trust jest ręczny. Notify/transkrypt pozwala odróżnić turę od szkicu.

`capacity.codex_refresh: true` czyta `account/rateLimits/read` krótkim RPC app-server (deadline 3 s), bez tworzenia wątku ani tury inference. Błąd zachowuje czas i pochodzenie ostatniego odczytu. Tokeny logów oddzielają cache od świeżego input. Wiadomości do zajętego Codexa czekają w trwałej kolejce do potwierdzonego idle/końca tury; status/peek pokazuje ID, `send` pozwala wycofać. Nie powtarzaj send tylko dlatego, że dostarczenie oczekuje.

## Kimi Code CLI (Moonshot AI)

[Produkt](https://www.kimi.com/code) · [Dokumentacja CLI](https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started).

Dla bazowej wersji adaptera zainstaluj `npm install -g @moonshot-ai/kimi-code@2.5.0`. Bieżąca instrukcja npm wymaga Node ≥22.19.0; użyj zgodnego Node 22/26. Uruchom `kimi`, wpisz `/login`, zaloguj się i sprawdź katalog modeli. Stary Python kimi-cli nie jest tym adapterem. Config domyślnie to `~/.kimi-code/config.toml`; katalog wynika kolejno z `agents.kimi.env.KIMI_CODE_HOME`, jawnego `usage.kimi_dir`, środowiska `KIMI_CODE_HOME` i wartości domyślnej.

Aliasy zależą od serwera; macierz używa k3-256k/k3 oraz k3.1-pro tylko na jawne zamówienie. Polityka agentctl rezerwuje ostatni do kosztownej pracy; historyczne ~10× limitu jest obserwacją z okresu adaptera, nie gwarancją bieżącego rozliczenia. display_name/support_efforts z katalogu i pasywne llm.request ustalają efektywną wersję/effort; nieznanych wersji nie zgaduje. Resume kontynuuje sesję bez wymuszania modelu.

Tryb `auto` (Never Ask) jest odrzucany. `manual` lub `yolo` wymaga `permission.dangerous_command_guard=true`; ta nazwa w configu nie zezwala na zabronioną flagę `--yolo`. Wyłączony guard, środowiskowe obejście trust, -p/--prompt i auto-approval nie przechodzą walidacji. Agentctl nie edytuje configu Kimi. Dokładne sprawdzone reguły Bash są bezpieczniejsze niż szerokie wildcardy; uprawnienia nie są sandboxem.

Każde kanoniczne worktree wymaga własnego trust. Dostarczenie wymaga pełnego stabilnego composera, bracketed paste i osobno sprawdzonego Enter; zwinięte wklejenie nadal jest szkicem. Busy delivery domyślnie jest wyłączone. Pasywny protokół 1.5 jest rozpoznawany, z fallbackiem ekranu i ostrzeżeniem dla innych wersji. Część wzorców limit/overload/background i stopki busy pozostaje hipotezą syntetyczną. Tokeny pochodzą z usage.record, nie estymacji token_counting. Opcjonalna `capacity.kimi_usage_probe` uruchamia neutralne /usage najwyżej co pięć minut (domyślnie model k3, nigdy Highspeed); brak okien weekly/monthly to n/d.

## GLM Coding Plan (Z.ai)

[Produkt](https://z.ai/subscribe) · [Integracja z Claude Code](https://docs.z.ai/devpack/tool/claude).

Zainstaluj Claude Code i uzyskaj klucz Coding Plan na koncie Z.ai. Agentctl oczekuje lokalnego pliku wykonywalnego `claude-glm` w PATH lub `providers_config.glm.command` (jedna nazwa/ścieżka bez argumentów). Wrapper jest lokalną integracją, nie dołączonym oficjalnym CLI. Zapisz klucz przez macOS Keychain Access jako generic password z service `neon-city-zai`; doctor sprawdza istnienie wpisu bez odczytu wartości.

Przykład wrappera właściciela (chmod 700; odczyt Keychain wyłącznie w procesie wrappera):

~~~sh
#!/bin/sh
export CLAUDE_CONFIG_DIR="$HOME/.claude-glm"
export ANTHROPIC_BASE_URL="https://api.z.ai/api/anthropic"
ANTHROPIC_AUTH_TOKEN="$(security find-generic-password -s neon-city-zai -w)" || exit 1\nexport ANTHROPIC_AUTH_TOKEN
unset ANTHROPIC_API_KEY
exec claude "$@"
~~~

Uruchom raz `claude-glm`, ukończ wybór motywu/security/onboarding, potem trust folderów. `usage.glm_dir` powinno wskazywać osobny katalog configu Claude, jeśli wykrywanie go nie rozwiąże. Adapter używa hooków, promptów/raportów i skills/subagentów Claude. Domyślnie dodaje `CLAUDE_CODE_AUTO_MODE_SERVER=0` do środowiska GLM (do nadpisania przez providers_config.glm.env; agents.glm.env/spec env wygrywa). Nie ustawia tego dla Claude ani w globalnym configu. Onboarding ma needs-input; informacyjny banner auto-mode i ostrzeżenie MCP auth nie blokują gotowości.

Zmienne endpointu/tokenów są odrzucane w providers_config.glm.env, usuwane ze spec env GLM z ostrzeżeniem i maskowane w zapisanych zrzutach. Należą do wrappera. Nie przestawiaj globalnego konta Anthropic na Z.ai. GLM ma osobny domyślny limit równoległości 2 i osobne tokeny/benchmark. Wydanie nie ma udokumentowanego odczytu kwoty Z.ai API/CLI: plan 5 h/weekly to `n/d` i queue_hold nigdy nie wstrzymuje GLM. warn/critical nie zadziała bez odczytu. Remote Control jest nieobsługiwane.

## Wspólna obsługa trust i błędów

Agentctl nie odpowiada na trust ani onboarding. Otwórz okno zadania, odpowiedz i wróć F12; watch raz dostarczy oczekujący pierwszy prompt po gotowości. Zmieniony układ CLI może zamknąć ścieżkę dostarczenia: nierozpoznane pole oznacza brak Enter. `start_failure.keep_window: true` zachowuje okno i zapis ekranu; sprawdź je przed queue_retry. Zobacz [Problemy](troubleshooting.md), [Konfigurację](configuration.md) i [Ekonomię](token-economics.md).

Oficjalne linki produktu/CLI sprawdzono curl HEAD z przekierowaniami 2026-11-15; openai.com/codex zwrócił tu 403, więc użyto dostępnej oficjalnej strony ChatGPT. Dokumentacja zewnętrzna zmienia się niezależnie od tego wydania.
