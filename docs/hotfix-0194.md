# 0.19.4 hotfix

P91: Explicit `get_report` reads return an existing report even when a follow-up is pending, withdrawn, stale, or the task was closed. The `warning` field identifies the message and timestamp and says the report may predate it. Withdraw and close clear the delivery freshness marker, preserving history without acknowledging delivery or releasing dependencies.

P91: Jawne `get_report` zwraca istniejący raport także przy oczekującej, wycofanej lub nieaktualnej wiadomości oraz po zamknięciu zadania. Pole `warning` wskazuje wiadomość i czas, ponieważ raport może ją poprzedzać. Withdraw i close usuwają znacznik świeżości dostawy, zachowując historię bez potwierdzania dostarczenia ani zwalniania zależności.

P90: A busy Codex receives follow-ups only after watch confirms idle/turn end, including when a report already exists; a resumed working frame resets confirmation. `send` returns `queued_until_turn_end` and `message_id`; the durable FIFO is visible in status, board and events and supports withdraw. Idle delivery still pastes, presses Enter and verifies hook/transcript acceptance. Claude and Kimi retain their prior delivery behavior.

P90: Pracujący Codex otrzymuje follow-up dopiero po potwierdzeniu bezczynności/końca tury przez watch, także przy istniejącym raporcie; wznowienie pracy zeruje potwierdzanie. `send` zwraca `queued_until_turn_end` i `message_id`; trwała kolejka FIFO jest widoczna w status, board i events i obsługuje withdraw. Bezczynny agent nadal dostaje wklejenie z Enter i weryfikacją przyjęcia przez hook/transkrypt. Mechanizm Claude i Kimi pozostaje bez zmian.

P89: Bare `after` accepts first-line `Verdict:`/`Werdykt:` PASS, PASS with findings, PARTIAL or GO, case-insensitively. BLOCKED, FAIL, NO-GO or a missing/unparsable verdict keeps dependents queued with a verdict reason, event and desktop notification. `after_verdict: [BLOCKED]` overrides the allowed list per task; `queue up` or `unblock` releases a rejected dependency manually. Spec-level links apply to the first repository; `spec example` includes a concrete `{from, to}` link.

P89: Zwykłe `after` akceptuje PASS, PASS with findings, PARTIAL lub GO z pierwszej linii `Verdict:`/`Werdykt:`, bez rozróżniania wielkości liter. BLOCKED, FAIL, NO-GO oraz brak lub niezrozumiały werdykt zatrzymują zależne zadania, zapisują zdarzenie i wysyłają powiadomienie. `after_verdict: [BLOCKED]` nadpisuje listę dla zadania; `queue up` lub `unblock` ręcznie zwalnia odrzuconą zależność. Linki spec dotyczą pierwszego repozytorium; `spec example` zawiera konkretny link `{from, to}`.

P85: MCP doctor reads cached worktree sizes, avoids worktree discovery and returns a task inventory instead of per-task report/link/settings probes. Ordinary CLI doctor retains link ancestry validation. `doctor --timings` includes cached doctor section wall times alongside the existing five read checks, so a slow section is named.

P85: MCP doctor czyta zapisane rozmiary worktree, pomija przeszukiwanie worktree i bieżące sprawdzanie historii Git dla celów linków. Zwykły CLI doctor zachowuje walidację historii linków. `doctor --timings` oprócz pięciu dotychczasowych odczytów podaje czas sekcji zapisanej diagnostyki, wskazując wolną sekcję.
