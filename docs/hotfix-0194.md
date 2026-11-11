# 0.19.4 hotfix

P91: Explicit `get_report` reads return an existing report even when a follow-up is pending, withdrawn, stale, or the task was closed. The `warning` field identifies the message and timestamp and says the report may predate it. Withdraw and close clear the delivery freshness marker, preserving history without acknowledging delivery or releasing dependencies.

P91: Jawne `get_report` zwraca istniejący raport także przy oczekującej, wycofanej lub nieaktualnej wiadomości oraz po zamknięciu zadania. Pole `warning` wskazuje wiadomość i czas, ponieważ raport może ją poprzedzać. Withdraw i close usuwają znacznik świeżości dostawy, zachowując historię bez potwierdzania dostarczenia ani zwalniania zależności.

P90: A busy Codex receives follow-ups only after watch observes idle/turn end. `send` returns `queued_until_turn_end` and `message_id`; the durable FIFO is visible in status, board and events and supports withdraw. Idle delivery still pastes, presses Enter and verifies hook/transcript acceptance. Claude and Kimi retain their prior delivery behavior.

P90: Pracujący Codex otrzymuje follow-up dopiero po wykryciu bezczynności/końca tury przez watch. `send` zwraca `queued_until_turn_end` i `message_id`; trwała kolejka FIFO jest widoczna w status, board i events i obsługuje withdraw. Bezczynny agent nadal dostaje wklejenie z Enter i weryfikacją przyjęcia przez hook/transkrypt. Mechanizm Claude i Kimi pozostaje bez zmian.
