/** Generate bilingual inventories from the runtime registry. No provider process, network or user home access. */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { MCP_TOOLS, providerToolInput, DEFERRED_TOOLS } from '../src/core/mcp-tools.ts';
import { MCP_ALLOW_GROUPS } from '../src/core/config.ts';
import type { GlobalConfig } from '../src/core/config.ts';
const root = path.resolve(import.meta.dirname, '..');
const bt = String.fromCharCode(96);
const code = (s: string) => bt + s + bt;
const pl: Record<string, string> = {
 hosts: 'Stan hostów, wybór miejsca, dostępność właściciela i rezerwacje perf.',
 hosts_pause: 'Zarezerwuj host dla właściciela, opcjonalnie do określonej godziny.',
 hosts_resume: 'Zwolnij ręczną rezerwację hosta.',
 status: 'Stan zadań i raportów; cache podaje wiek, po 5 min krótki fallback kolejki/dziennika.',
 events_since: 'Przyrost według as czatu (client nadpisuje), otwarta skrzynka WALL; peek zachowuje kursor.',
 gc_preview: 'Chroniony plan sprzątania z rozmiarami i powodami pominięcia; bez usuwania.',
 limits: 'Limity slotów, zajętość, rezerwacje, kolejka i obowiązujący queue_hold.',
 set_limits: 'Złóż właścicielowi wniosek o zmianę limitów, progu kolejki, kwot lub profilu. Czasowy hold działa bezpośrednio po potwierdzeniu.',
 reserve: 'Zarezerwuj sloty dla agentów uruchamianych ręcznie.',
 version: 'Wersja procesu MCP, skrypt, PID, czas startu i wersja stabilnej kopii na dysku.',
 peek: 'Ostatnie linie okna bez stopki, pytanie, stan kolejki promptów lub zapis błędu startu.',
 list_reports: 'Lista raportów, rozmiar/czas, źródło i informacja o odebraniu.',
 get_report: 'Raport; podsumowanie/pierwsza pełna strona domyślnie pulled, mark_pulled steruje potwierdzeniem.',
 pull_ready: 'Nowe raporty: domyślnie podsumowanie; full/ack oznacza pełne odebranie.',
 task_spec: 'Zapisany nagłówek i prompt zadania.',
 queue_list: 'Pozycja, stan i warunek startu zadań w kolejce.',
 cohort_list: 'Kohorty i liczby zadań według stanu.',
 cohort_show: 'Zadania, kolejka i zagregowane outputs kohorty z ostrzeżeniami o referencjach.',
 guide: 'Wspólny przewodnik zlecającego i opcjonalny zaufany przewodnik projektu.',
 capacity: 'Plan, źródło/wiek, tempo, estymacje, sloty, kolejka, dysk/load i statystyki.',
 usage: 'Zaobserwowane tokeny oraz okna planów aktywnych dostawców; braki to n/d.',
 log: 'Historia prób, raportów, ocen, anulowania i przeniesienia.',
 stats: 'Statystyki model/effort, mediany, oceny i liczebność próby.',
 overlap: 'Aktywne zadania zmieniające te same pliki; to ostrzeżenia, nie blokady.',
 resume: 'Wznów znane sesje po utracie okien, bez ponownego pierwszego promptu.',
 answer: 'Podgląd i wybór numerowanej opcji z tokenem dokładnego menu; trust zawsze ręcznie.',
 send: 'Pokaż dokładny tekst i stan okna przed wysłaniem lub wycofaniem. Zajęty agent odbierze wiadomość z kolejki. enter_only wymaga send_enter.',
 consult: 'Kosztowny panel wielu dostawców: podgląd liczby/usage, Accepted, rundy i synteza przez watch.',
 new: 'Podgląd specyfikacji, potem trwała rejestracja Accepted do walidacji/startu przez watch.',
 queue: 'Podgląd specyfikacji, potem Accepted do walidacji i kolejki przez watch.',
 queue_rm: 'Usuń oczekujące zadanie z kolejki.',
 cancel: 'Przerwij i porzuć zadania; zachowaj gałęzie/worktree, zapisz powód.',
 mark: 'Zapisz ocenę człowieka ok/partial/fail, osobną od werdyktu autora.',
 away: 'Przełącz tryb powiadomień na telefon.',
 interrupt: 'Przerwij bieżącą turę, pozostawiając okno.',
 close: 'Zamknij okno; usuwanie worktree wymaga dodatkowo allow_rm_worktree i jawnej opcji.',
 move: 'Przenieś zadanie do innego aktywnego dostawcy przez equivalents w tym samym worktree; pin blokuje.',
 queue_show: 'Pełny spec kolejki, błąd i historia prób.',
 mcp_check: 'Znajdź stare procesy MCP bez ich zatrzymywania.',
 spec_example: 'Wzorcowa specyfikacja przed napisaniem nowego zlecenia.',
 doctor: 'Diagnoza instalacji, uprawnień i dysku; budżetowany odczyt z cache.',
 equivalents: 'Tabela mapowań model/effort aktywnych dostawców.',
 config_show: 'Efektywny config z maskowaniem sekretów; queue_hold jako pierwszy klucz.',
 manager_status: 'Stan lokalnej sesji manager.',
 away_status: 'Stan away i telefonu.',
 report: 'Kanoniczna ścieżka raportu i kandydaci.',
 queue_retry: 'Ponów nieudany start po sprawdzeniu błędu; zamknij pozostawione okno diagnostyczne.',
 queue_up: 'Przesuń oczekujące zadanie na początek jego klasy priorytetu; oceń zwalniane zależności.',
 queue_pause: 'Wstrzymaj automatyczne starty kolejki.',
 queue_resume: 'Wznów automatyczne starty kolejki.',
 unblock: 'Wznów start po zamontowaniu woluminu albo usuń zablokowaną zależność z after.',
 cohort_add: 'Przypisz istniejące zadania do kohorty.',
 cohort_remove: 'Usuń przypisanie do kohorty.',
 cohort_archive: 'Ukryj zakończone kohorty z wyboru; aktywne/kolejkowane są chronione, historia zostaje.',
 cohort_note: 'Zmień notatkę kohorty.',
 pin: 'Przypnij zadania: ochrona worktree i cache przed GC oraz przed zmianą providera.',
 unpin: 'Usuń przypięcie zadania; pozostałe zabezpieczenia GC nadal obowiązują.',
 hide: 'Ukryj zadania w domyślnym widoku, bez zamykania.',
 unhide: 'Pokaż ukryte zadania.',
 archive: 'Przenieś stan zamkniętych zadań do archiwum.',
 adopt: 'Odtwórz brakujące metadane z faktów dostarczonych przez właściciela.',
 report_from: 'Skopiuj zwykły dozwolony raport do ścieżki kanonicznej; force nie omija granic/symlinków.',
 limits_release: 'Zwolnij zarezerwowane miejsca dostawców.',
 manager_start: 'Uruchom sesję nadzorczą Claude z Remote Control.',
 manager_stop: 'Zatrzymaj sesję manager.',
 notify_test: 'Test powiadomienia lokalnego; phone jawnie wysyła do ntfy.',
 gc: 'Zastosuj chroniony plan sprzątania po podglądzie; opcjonalne scalone lokalne gałęzie.',
 wall_read: 'Kanały, nagłówki z filtrami albo wiadomość z treścią, refs, historią i wątkiem.',
 wall_post: 'Opublikuj dozwoloną wiadomość po kontroli autora, refs, rozmiaru i sekretów.',
 wall_reply: 'Odpowiedz w kanale rodzica; answer oznacza otwarte pytanie jako answered.',
 wall_set_status: 'Dopisz status; decyzje/kontrakty wymagają właściciela lub owner_confirmed po jego decyzji.',
 response_page: 'Kontynuuj zapisaną odpowiedź, bez ponownego zapisu/odczytu zdarzeń.',
};
const config = { providers: ['claude', 'codex', 'kimi', 'glm'] } as GlobalConfig;
const schemas = MCP_TOOLS.map(t => ({ name: t.name, kind: t.kind, title: t.title, description: t.description, input: z.toJSONSchema(z.object(providerToolInput(t, config))) }));
fs.mkdirSync(path.join(root, 'docs/reference'), { recursive: true });
fs.writeFileSync(path.join(root, 'docs/reference/mcp-tools.json'), JSON.stringify({ version: 1, providers: config.providers, groups: MCP_ALLOW_GROUPS, deferred_with_watch: [...DEFERRED_TOOLS], tools: schemas }, null, 2) + '\n');
for (const lang of ['en', 'pl']) {
 const lines = ['<!-- BEGIN GENERATED TOOL INVENTORY -->', '', lang === 'en' ? 'Arguments marked ? are optional. Provider fields below include enabled optional providers; the running server exposes only active ones. Full types, enums, ranges and descriptions: [JSON Schema inventory](../reference/mcp-tools.json). CLI options: [commands](../commands.md).' : 'Argumenty z ? są opcjonalne. Pola dostawców obejmują opcjonalnych; uruchomiony serwer pokazuje tylko aktywnych. Pełne typy, enumy, zakresy i opisy: [inwentarz JSON Schema](../reference/mcp-tools.json). Opcje CLI: [polecenia](../commands.md).', '', '| Tool | ' + (lang === 'en' ? 'Kind | Arguments | Purpose' : 'Rodzaj | Argumenty | Zastosowanie') + ' |', '|---|---|---|---|'];
 for (const t of MCP_TOOLS) {
  if (!pl[t.name]) throw new Error('Missing Polish description: ' + t.name);
  const args = Object.entries(providerToolInput(t, config)).map(([key,value]) => code(key + (value.isOptional() ? '?' : ''))).join(', ');
  lines.push('| ' + code(t.name) + ' | ' + (t.kind === 'read' ? (lang === 'en' ? 'read' : 'odczyt') : (lang === 'en' ? 'write' : 'zapis')) + ' | ' + args + ' | ' + (lang === 'en' ? t.title : pl[t.name]) + ' |');
 }
 lines.push('', lang === 'en' ? '### Permission groups' : '### Grupy uprawnień', '', '| Group | Tools |', '|---|---|');
 for (const [group,names] of Object.entries(MCP_ALLOW_GROUPS)) lines.push('| ' + code(group) + ' | ' + names.map(code).join(', ') + ' |');
 lines.push('', 'send_enter: ' + (lang === 'en' ? 'additional permission for send enter_only; it does not grant ordinary send.' : 'dodatkowe uprawnienie send enter_only; nie przyznaje zwykłego send.'), '', '<!-- END GENERATED TOOL INVENTORY -->');
 const file = path.join(root, 'docs', lang, 'mcp-tools.md');
 const prior = fs.readFileSync(file, 'utf8');
 const block = lines.join('\n');
 fs.writeFileSync(file, prior.includes('<!-- BEGIN GENERATED TOOL INVENTORY -->') ? prior.replace(/<!-- BEGIN GENERATED TOOL INVENTORY -->[\s\S]*?<!-- END GENERATED TOOL INVENTORY -->/, block) : prior + '\n' + block + '\n');
}
console.log('Generated ' + schemas.length + ' tools and ' + Object.keys(MCP_ALLOW_GROUPS).length + ' permission groups in EN/PL.');
