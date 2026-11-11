# 0.19.4 hotfix

P91: Explicit `get_report` reads return an existing report even when a follow-up is pending, withdrawn, stale, or the task was closed. The `warning` field identifies the message and timestamp and says the report may predate it. Withdraw and close clear the delivery freshness marker, preserving history without acknowledging delivery or releasing dependencies.

P91: Jawne `get_report` zwraca istniejący raport także przy oczekującej, wycofanej lub nieaktualnej wiadomości oraz po zamknięciu zadania. Pole `warning` wskazuje wiadomość i czas, ponieważ raport może ją poprzedzać. Withdraw i close usuwają znacznik świeżości dostawy, zachowując historię bez potwierdzania dostarczenia ani zwalniania zależności.
