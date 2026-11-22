# Ekonomia tokenów

## Trzy różne budżety

Okna planu, lokalna równoległość i tokeny odpowiadają na różne pytania. Procent okna 5-godzinnego lub tygodnia jest odczytem dostawcy, nie stałą liczbą tokenów obiecaną przez agentctl. Niektórzy pokazują inne okna (Kimi także miesięczne); brakujące pozostają `n/d`. Plan może obejmować sesje spoza agentctl. Zasady abonamentu, modele i mnożniki zmieniają się; sprawdzaj oficjalne [strony dostawców](providers.md) dla swojego konta, zamiast traktować przykłady jako ceny.

`limits.<provider>` ogranicza jednoczesne sloty. Brak/0 oznacza bez limitu; `off` wyłącza start. Bezczynne report-ready domyślnie nie zajmuje slotu (`limits.count_report_ready: false`), ale follow-up liczy się ponownie. Rezerwacje zostawiają miejsca na pracę ręczną; `count_external` może liczyć wykryte sesje interaktywne spoza agentctl. Osobny jest limit heavy. Więcej slotów nie zwiększa planu dostawcy.

Kolumny tokenów liczą zaobserwowany świeży input, output, cache read/write i reasoning output, jeśli dostępny. Nieznane to null/n/d, nie zero. Rozliczenia dostawców różnią się; sama suma nie oznacza pieniędzy ani równej pracy. GLM ma osobne tokeny i tożsamość, ale plan n/d: brak zaimplementowanego endpointu/panelu kwoty, więc queue_hold go nie blokuje.

## Capacity i queue_hold

Przed zleceniem czytaj `capacity`: okna, procent użyty/pozostały, reset, źródło, wiek/stale, tempo/projekcję wyczerpania, sloty/rezerwacje, kolejkę, dysk/load, equivalents i statystyki model×effort z siedmiu dni. Estymacje podają podstawę/pewność, nie gwarancję kwoty. Stary odczyt może nie uwzględniać sesji zewnętrznych. Stale nie zmienia braku danych w użyteczną liczbę.

~~~sh
agentctl capacity
agentctl usage --since 7d
agentctl limits
agentctl limits set queue_hold=90
agentctl limits set queue_hold.codex=85
agentctl limits set queue_hold=off
~~~

MCP `set_limits({queue_hold: {claude: 90, codex: "off"}})` domyślnie składa wniosek do właściciela. Zatwierdzenie zachowuje komentarze oraz kopię zapasową. Watch wczytuje zmianę najpóźniej przy następnym ticku. Hold zatrzymuje start kolejki, gdy znane okno osiąga/przekracza próg; nie przerywa agentów i nie wybiera sam innego dostawcy. Brak odczytu nie dowodzi wolnej kwoty. `usage.warn`/`critical` powiadamia niezależnie od hold. Reset/wyczerpanie planu i dostępność lokalnego slotu to różne warunki.

`limited` wynika z odczytu limitu, a nie małej liczby slotów. Można czekać na reset, kontynuować żywe okno po odzyskaniu limitu albo jawnie użyć move/equivalents; resume odtwarza utracone okno. `limited.auto_resume` domyślnie true: gdy znany plan ma więcej niż `limited.resume_above_percent` pozostałego limitu (domyślnie 5), watch może wysłać kontynuację. Ustaw false, jeśli tę decyzję ma podejmować właściciel. Nie ma automatycznego move między dostawcami. Retry overload ma osobne limity odstępu/liczby/czasu.

## Model, effort i cache

Wybieraj z [data/model-matrix.yaml](../../data/model-matrix.yaml) najtańszą klasę wystarczającą do zadania. Ogólny porządek to report/simple/smoke → feature/bugfix/review → hard/sim; visual i escalate mają politykę jawnego wyboru tam, gdzie wskazano. Creative nie ma mapowania Kimi. To domyślne kierowanie, nie zmierzona gwarancja jakości. Plik jest źródłem aliasów/effort; własne equivalents mają pierwszeństwo. Jawny model/effort nadpisuje class z diagnostyką.

Mała ograniczona zmiana zwykle potrzebuje mniej rozumowania niż niepewny błąd, architektura czy przegląd dużego ryzyka. Większy effort może zwiększać reasoning output, czas i zużycie planu; tani pierwszy przebieg może kosztować więcej po wielu poprawkach. Inny recenzent ogranicza ślepe punkty, ale dodaje kontekst i tury. CONSULT kosztuje paneliści × rundy + synteza oraz naprawy/przeglądy: używaj go do decyzji wartych tego kosztu.

Utrzymuj stały model i effort w aktywnej sesji zadania. Zmiana modelu, promptów systemowych/narzędzi i odbudowa sesji/kontekstu może zmienić tożsamość cache lub ograniczyć jego użycie. Zachowanie cache przy zmianie effort zależy od dostawcy; agentctl nie unieważnia, wycenia ani nie gwarantuje cache dostawcy. Zmieniaj zamówienie świadomie dla nowego zadania/próby i zapisz powód, zamiast przełączać w środku sesji. Wąskie follow-upy i stałe instrukcje zwykle lepiej zachowują kontekst niż ponowne wysyłanie całych raportów.

## Koszt przyjętego zadania

Mierz cały łańcuch wyniku:

~~~text
koszt przyjętego zadania =
(wykonanie + poprawki + niezależny przegląd + ponowne gate) / przyjęte wyniki
~~~

Licz osobno tokeny, czas lub udokumentowaną estymację pieniędzy. Nie dodawaj tokenów do minut, nie dziel przez wszystkie starty i nie uznawaj nieprzejrzanego PASS za akceptację człowieka. Przykład: 100k wykonania + 30k poprawek + 40k przeglądu + 10k pracy agenta przy gate = 180k zaobserwowanych tokenów na przyjęty wynik. Lokalne deterministyczne testy same nie zużywają tokenów modelu; agent analizujący/naprawiający błędy może. Cache licz osobno albo zastosuj jawne wagi dostawcy. Podział kosztu abonamentu jest polityką właściciela, nie wynikiem agentctl.

`mark ok/partial/fail` jest oceną człowieka; werdykt raportu samooceną. Połącz autora, kontynuacje, move i review w jeden wynik. Uwzględnij anulowaną/nieudaną pracę w nakładzie i pokaż brak ocen. Porównuj podobne klasy i złożoność repozytoriów; mała próba, różnice requested/observed i braki przypisania ograniczają wnioski.

## Zbiór benchmarku

~~~sh
agentctl dataset export --since 30d --format jsonl --out attempts.jsonl
agentctl dataset export --format csv --out attempts.csv
# Treść wrażliwa tylko po jawnym włączeniu:
agentctl dataset export --include-prompts --include-reports --out content.jsonl
~~~

Lokalny eksport jest tylko do odczytu, bez odpowiednika MCP. Nie kontaktuje tmux, nie potwierdza raportów ani nie tworzy stanu. Nowy plik ma 0600; istniejące pliki/symlinki są odrzucane. JSONL v1 ma nagłówek i wiersz na znaną próbę; CSV jest płaskim podsumowaniem i odrzuca opcje treści. Używaj [schematu](../dataset-schema.json) i [kontraktu eksportu](../dataset.md).

Łącz po instance_id/project/task/attempt_id, zachowuj pochodzenie/braki i trzymaj powiązane kohorty/łańcuchy razem przy podziale trening/ewaluacja. Nie wnioskuj historycznej wersji CLI z dzisiejszego eksportera, nie twórz starych attempt ID, nie dziel zużycia wznowionego zadania na wymyślone próby i nie traktuj obecnego procentu jako kosztu historycznego. Requested/resolved/observed, self_verdict i human_mark są osobne. Opt-in treści eksportuje dostępne raporty, nie pełne rozmowy; maskowanie jest przybliżone, więc sprawdź eksport przed udostępnieniem.
