# Kontor

Schlanke Buchhaltung für kleine Unternehmen: Kunden, Ausgangsrechnungen und offene Posten.
Zahlungseingänge werden per Bankabgleich (BANKSapi) automatisch zugeordnet oder von Hand erfasst („Zahlung erfassen“ an der Rechnung).

## Starten

```bash
npm install
npm run seed   # Beispieldaten anlegen (setzt die Datenbank zurück)
npm run dev    # API auf :3001, Oberfläche auf http://localhost:5173
```

Weitere Befehle:

| Befehl          | Zweck                                         |
| --------------- | --------------------------------------------- |
| `npm test`      | Unit-Tests (Node Test Runner)                 |
| `npm run build` | Typprüfung und Frontend-Build nach `dist/`    |
| `npm start`     | API liefert das gebaute Frontend mit aus      |
| `npm run seed:bank` | Nur BANKSapi-Testmandant: Testkonto mit Zahlungseingängen zu den Beispielrechnungen anlegen |

Konfiguration über Umgebungsvariablen oder eine `.env`-Datei, siehe `.env.example`.

## Aufbau

```
server/          Express-API (TypeScript, läuft mit tsx)
  db.ts          SQLite-Schema (node:sqlite)
  domain.ts      Status offener Posten, Beträge, Datumsprüfung
  repository.ts  Datenzugriff
  index.ts       REST-Endpunkte unter /api
  banksapi.ts    Client für BANKSapi (Auth, Bankzugänge, Umsätze, AI/Connect)
  reconcile.ts   Entscheidungslogik des Abgleichs (automatisch buchen oder vorschlagen)
  bank.ts        Abgleichslauf, Vorschläge, Status der Bankverbindung
  seed.ts        Beispieldaten
  seed-bank.ts   Testumsätze im BANKSapi-Testmandanten
src/             Oberfläche (React, Vite)
  pages/         Übersicht, Offene Posten, Rechnung, Kunden, Bankabgleich
  components/    Status-Badge, Dialog „Zahlung erfassen“, REG/Protect-Einbindung
```

## Datenmodell

- `customers`: Kundennummer, Name, IBAN, E-Mail
- `invoices`: Rechnungsnummer (`RE-<Jahr>-<laufende Nr.>`), Kunde, Rechnungsdatum, Fälligkeit, Bruttobetrag in Cent
- `payments`: Zahlungseingänge zu einer Rechnung (Buchungsdatum, Betrag in Cent, Erfassungsart, Notiz, ggf. Verweis auf den Kontoumsatz bei BANKSapi)
- `bank_proposals`: Zuordnungsvorschläge des letzten Abgleichs, die bestätigt werden müssen
- `bank_dismissals`: abgelehnte Zuordnungen (Rechnung ↔ Umsatz), werden nie wieder gebucht oder vorgeschlagen
- `bank_runs`: Protokoll der Abgleichsläufe
- `banksapi_user`: technischer BANKSapi-Benutzer der Firma

Offener Betrag und Status (`offen`, `teilbezahlt`, `ueberfaellig`, `bezahlt`) werden aus Rechnung und Zahlungen berechnet.

## Bankabgleich (BANKSapi)

Unter **Bankabgleich** wird das Geschäftskonto verbunden und mit den offenen Posten abgeglichen.

1. **Bankkonto verbinden** – Kontor startet bei BANKSapi einen Bankzugang (`POST /customer/v2/bankzugaenge`, Antwort `451`)
   und bettet das REG/Protect Web Component aus WEB/Connect ein (`@banksapitechnology/regprotect-web-component`).
   Bankauswahl, Zugangsdaten und TAN gibt der Nutzer direkt bei BANKSapi ein; Kontor sieht sie nie.
   Rücksprünge kommen über `/bank/callback` (Ergebnis `baReentry`) bzw. nach einer Redirect-SCA über `/bank/reentry`.
2. **Abgleich starten** – Kontor lädt die Zahlungseingänge und schickt alle offenen Rechnungen an
   AI/Connect (`POST /customer/v2/ai/invoice-matching/`, `invoiceDirection: receivable`).
   - **Automatisch gebucht** wird nur, wenn AI/Connect `matched` mit mindestens 95 % meldet, kein zweiter Kandidat
     nahe dran ist und der Umsatz centgenau dem offenen Betrag entspricht.
   - Alles andere (Teilzahlung, Skonto, Sammelüberweisung, unsichere Treffer) erscheint unter **Zu prüfende Zuordnungen**
     und wird erst nach „Übernehmen“ gebucht. Skonto wird als Zahlung gebucht; der Skontobetrag bleibt offen.
   - Bereits vollständig zugeordnete Umsätze werden über `excludeTransactions` ausgeschlossen. Verworfene Vorschläge und
     wieder entfernte Abgleichszahlungen werden gemerkt und nicht erneut gebucht.
3. **Zustimmung erneuern** – Läuft die PSD2-Zustimmung ab (Relation `start_sca`), führt der Button erneut durch REG/Protect.

Zum Ausprobieren im Testmandanten: In REG/Protect den „Demo Provider“ mit `demo`/`demo` wählen
(siehe https://docs.banksapi.de/guide/demo-provider.html). Da dessen Umsätze zufällig sind, legt
`npm run seed:bank` zusätzlich ein Testkonto mit Zahlungen zu den Beispielrechnungen an.

Für den Produktivbetrieb: `APP_BASE_URL` setzen und die Adresse bei BANKSapi für Callbacks freigeben lassen;
hinter einem Proxy `TRUST_PROXY` setzen, damit die Nutzer-IP (`Customer-IP-Address`) korrekt übermittelt wird.

Doku: https://docs.banksapi.de/guide/quickstart.html · https://docs.banksapi.de/guide/customer.html ·
https://docs.banksapi.de/guide/webconnect.html · https://docs.banksapi.de/guide/ai-connect.html
