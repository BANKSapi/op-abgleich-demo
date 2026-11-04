# Auswertung der Läufe (04.11.2026)

Alle vier Läufe: derselbe Prompt, Baseline `048f2fb`, frischer Container, keine Nachfrage nötig.
Praxistest je Ergebnis: `npm install`, `npm test`, `npm run build`, frische Datenbank mit Beispieldaten,
Bankverbindung über die Oberfläche mit dem Demo Provider (`demo_buchhaltung` / `demo`), danach Abgleich.

## Übersicht

| | Opus 5.5 + Docs MCP | Opus 5.5 ohne MCP | Sonnet 5.5 + Docs MCP | Codex (gpt-6.1-sol) + Docs MCP |
|---|---|---|---|---|
| Dauer | 12 min | 20 min | 6 min | 20 min |
| Kosten / Umfang | 4,60 $ · 72 Schritte | 6,34 $ · 100 Schritte | 1,37 $ · 46 Schritte | ChatGPT-Abo · 6,5 Mio. Input-Token (fast alles Cache), 42 Tsd. Output |
| Doku-Zugriff | 14× Docs MCP, 1× GitHub | Doku per curl gescrapt, OpenAPI-Specs heruntergeladen | 9× Docs MCP, 4× npm/GitHub | MCP verfügbar, aber nicht genutzt; 4 Websuchen |
| Invoice Matching (AI/Connect) gefunden | ja | ja | ja | ja |
| Tests / Build | 11 grün / ok | 13 grün / ok | 14 grün / ok | 15 grün / ok |
| Bankverbindung in der Oberfläche | REG/Protect-Komponente eingebettet, klappt | REG/Protect-Komponente eingebettet, klappt | REG/Protect-Komponente eingebettet, klappt | Kontoverwaltungs-Widget (EFC) mit REG/Protect, klappt |
| Abgleich nach Verbinden | startet automatisch, zusätzlich alle 6 h | per Knopf | per Knopf | startet automatisch, zusätzlich alle 15 min |
| Automatisch gebucht | RE-0103, 0105, 0107 | RE-0103, 0105, 0107 | RE-0103, 0105, 0107 | RE-0103, 0105, 0107 |
| Zur Prüfung | Skonto, Teilzahlung, Sammelzahlung (aufteilbar), nur Betrag | Skonto, Teilzahlung, Sammelzahlung, nur Betrag | Skonto, Teilzahlung, Sammelzahlung, nur Betrag | Skonto, Teilzahlung, nur Betrag; Sammelzahlung nur „manuell prüfen“ |
| Ohne Treffer (richtig) | RE-0104, 0111, 0113 | RE-0104, 0111, 0113 | RE-0104, 0111, 0113 | RE-0104, 0111, 0113 |
| Auffälligkeiten | Hinweise von AI/Connect auf Englisch | Hinweise auf Englisch | Hinweise auf Englisch | bereits verbuchte Altzahlung (595 €) als Kandidat; Sammelzahlung in der Oberfläche nicht buchbar; Zeit in UTC |

Erwartung laut Testdaten: 3 automatisch (exakt, Restbetrag, anderes Nummernformat), 5 zur Prüfung
(Skonto, Teilzahlung, Sammelzahlung über zwei Rechnungen, Zahlung ohne Referenz), 3 ohne Zahlung.
Alle vier Ergebnisse treffen das. Kein Ergebnis bucht doppelt.

## Beobachtungen

- **Der Docs MCP macht es schneller und günstiger, nicht anders:** Opus mit MCP 12 min / 4,60 $, ohne MCP 20 min / 6,34 $
  bei gleichem Ergebnis. Ohne MCP hat Opus die Doku-Seiten und OpenAPI-Specs per curl geholt und durchsucht.
- **Codex** hatte den Docs MCP, hat ihn aber nicht aufgerufen und stattdessen im Web gesucht.
- **Eigene Tests:** Opus (mit MCP) hat über die Builder-Schnittstelle ein Testkonto mit passenden Umsätzen erzeugt und den
  Abgleich live geprüft. Opus ohne MCP und Codex haben einen Headless-Browser installiert und den REG/Protect-Ablauf durchgeklickt.
- **Lieferkette:** Opus hat bewusst die eine Woche alte Version der Web Component gewählt statt der 20 Minuten alten.
- **Gemeinsam offen gelassen:** Skonto wird nicht ausgebucht (Rest bleibt offen); die Zugangsdaten des technischen
  BANKSapi-Nutzers liegen unverschlüsselt in SQLite; die Kontor-API hat keine Anmeldung. Alle Läufe weisen selbst darauf hin.
- **Screenshots:** In REG/Protect erscheint der Anzeigename des Mandanten („Expertenartikel banksapi.de“).
